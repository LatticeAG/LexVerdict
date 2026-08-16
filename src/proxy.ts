import {
  VerifierConfigurationError,
  verifyChatResponse,
  type VerificationMessage,
  type VerdictResult,
} from "./verify";

export interface ProxyEnv {
  UPSTREAM_URL: string;
  UPSTREAM_API_KEY?: string;
  JIMMY_URL?: string;
  JIMMY_MODEL?: string;
  JIMMY_SERVICE?: Fetcher;
}

export interface ChatMessage extends VerificationMessage {}

interface ChatCompletionBody {
  model?: string;
  messages?: unknown;
  stream?: boolean;
  [key: string]: unknown;
}

interface ChatChoice {
  index?: number;
  message?: { role?: string; content?: string; [key: string]: unknown };
  delta?: { role?: string; content?: string; [key: string]: unknown };
  finish_reason?: string | null;
  [key: string]: unknown;
}

interface ChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: ChatChoice[];
  [key: string]: unknown;
}

type JsonRecord = Record<string, unknown>;

export const UPSTREAM_TIMEOUT_MS = 120_000;
export const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROXY_REQUEST_BYTES = 1024 * 1024;
const MAX_VERIFICATION_MESSAGES = 64;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_INITIAL_OPEN_MS = 30_000;
const CIRCUIT_MAX_OPEN_MS = 5 * 60_000;
const CIRCUIT_IDLE_TTL_MS = 10 * 60_000;
const MAX_CIRCUIT_ENTRIES = 128;

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeded the size limit");
    this.name = "RequestBodyTooLargeError";
  }
}

export class UpstreamResponseTooLargeError extends Error {
  constructor() {
    super("Upstream response exceeded the size limit");
    this.name = "UpstreamResponseTooLargeError";
  }
}

export class UpstreamResponseTimeoutError extends Error {
  constructor() {
    super("Upstream response timed out");
    this.name = "UpstreamResponseTimeoutError";
  }
}

interface CircuitState {
  consecutiveFailures: number;
  openCount: number;
  openUntil: number;
  probeInFlight: boolean;
  lastTouchedAt: number;
}

/**
 * Cloudflare Workers do not offer a shared mutable process across isolates, so
 * this is intentionally a small, best-effort per-isolate breaker. It protects
 * a warm isolate from repeatedly spending its request budget on a known-bad
 * upstream without presenting itself as durable global state.
 */
class UpstreamCircuitBreaker {
  private readonly states = new Map<string, CircuitState>();

  allowRequest(key: string, now = Date.now()): boolean {
    this.prune(now);
    const state = this.states.get(key);
    if (!state) {
      return true;
    }

    state.lastTouchedAt = now;
    if (state.openUntil > now) {
      return false;
    }

    if (state.openUntil > 0) {
      if (state.probeInFlight) {
        return false;
      }
      state.probeInFlight = true;
    }

    return true;
  }

  recordSuccess(key: string, now = Date.now()): void {
    const state = this.states.get(key);
    if (!state) {
      return;
    }

    state.lastTouchedAt = now;
    this.states.delete(key);
  }

  recordFailure(key: string, now = Date.now()): void {
    const state = this.getOrCreateState(key, now);
    state.lastTouchedAt = now;

    if (state.probeInFlight) {
      state.probeInFlight = false;
      this.open(state, now);
      return;
    }

    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.open(state, now);
    }
  }

  reset(): void {
    this.states.clear();
  }

  private getOrCreateState(key: string, now: number): CircuitState {
    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }

    this.prune(now);
    while (this.states.size >= MAX_CIRCUIT_ENTRIES) {
      const oldestKey = this.oldestKey();
      if (!oldestKey) {
        break;
      }
      this.states.delete(oldestKey);
    }

    const state: CircuitState = {
      consecutiveFailures: 0,
      openCount: 0,
      openUntil: 0,
      probeInFlight: false,
      lastTouchedAt: now,
    };
    this.states.set(key, state);
    return state;
  }

  private open(state: CircuitState, now: number): void {
    state.openCount = Math.min(state.openCount + 1, 5);
    const multiplier = 2 ** (state.openCount - 1);
    const cooldown = Math.min(CIRCUIT_INITIAL_OPEN_MS * multiplier, CIRCUIT_MAX_OPEN_MS);

    state.consecutiveFailures = 0;
    state.openUntil = now + cooldown;
    state.probeInFlight = false;
  }

  private prune(now: number): void {
    for (const [key, state] of this.states) {
      if (now - state.lastTouchedAt > CIRCUIT_IDLE_TTL_MS) {
        this.states.delete(key);
      }
    }
  }

  private oldestKey(): string | undefined {
    let oldestKey: string | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;

    for (const [key, state] of this.states) {
      if (state.lastTouchedAt < oldestTime) {
        oldestKey = key;
        oldestTime = state.lastTouchedAt;
      }
    }

    return oldestKey;
  }
}

const upstreamCircuitBreaker = new UpstreamCircuitBreaker();

/** Test-only reset hook so mocked failures cannot leak between test cases. */
export function resetUpstreamCircuitBreakerForTests(): void {
  upstreamCircuitBreaker.reset();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "lexverdict_error" } }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Normalizes a root, /v1, or full OpenAI-compatible endpoint URL. */
export function upstreamCompletionsUrl(baseUrl: string): string {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new Error("UPSTREAM_URL is not configured");
  }

  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error("UPSTREAM_URL must be an absolute URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("UPSTREAM_URL must use HTTPS");
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1/chat/completions")) {
    url.pathname = path;
  } else if (!path || path === "/") {
    url.pathname = "/v1/chat/completions";
  } else if (path.endsWith("/v1")) {
    url.pathname = `${path}/chat/completions`;
  } else {
    url.pathname = `${path}/v1/chat/completions`;
  }

  url.hash = "";
  return url.toString();
}

function buildUpstreamHeaders(env: ProxyEnv, clientAuth: string | null): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const configuredKey = typeof env.UPSTREAM_API_KEY === "string" ? env.UPSTREAM_API_KEY.trim() : "";

  if (configuredKey) {
    headers.set("Authorization", `Bearer ${configuredKey}`);
  } else if (clientAuth) {
    headers.set("Authorization", clientAuth);
  }

  return headers;
}

function verificationTextFromContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const textParts = value.flatMap((part) => {
      if (!isRecord(part)) {
        return [];
      }
      if (typeof part.text === "string") {
        return [part.text];
      }
      if (typeof part.content === "string") {
        return [part.content];
      }
      return [];
    });

    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  return "[Non-text content omitted from verification context]";
}

function extractMessages(body: ChatCompletionBody): ChatMessage[] {
  if (!Array.isArray(body.messages)) {
    return [];
  }

  return body.messages
    .slice(-MAX_VERIFICATION_MESSAGES)
    .filter((message): message is JsonRecord => isRecord(message) && typeof message.role === "string")
    .map((message) => ({
      role: (message.role as string).trim(),
      content: verificationTextFromContent(message.content),
    }))
    .filter((message) => message.role.length > 0);
}

function isChatCompletionResponse(value: unknown): value is ChatCompletionResponse {
  return isRecord(value) && Array.isArray(value.choices);
}

function extractContentFromJson(data: ChatCompletionResponse): string {
  const choice = data.choices?.[0];
  const messageContent = choice?.message?.content;
  const deltaContent = choice?.delta?.content;
  return typeof messageContent === "string"
    ? messageContent
    : typeof deltaContent === "string"
      ? deltaContent
      : "";
}

function parseSsePayloads(sseBody: string): string[] {
  const events = sseBody.replace(/\r\n?/g, "\n").split(/\n\n+/);
  const payloads: string[] = [];

  for (const event of events) {
    const dataLines = event
      .split("\n")
      .map((line) => line.trimStart())
      .filter((line) => line.startsWith("data:"))
      .map((line) => {
        const value = line.slice("data:".length);
        return value.startsWith(" ") ? value.slice(1) : value;
      });

    if (dataLines.length > 0) {
      payloads.push(dataLines.join("\n"));
    }
  }

  return payloads;
}

export function extractContentFromSse(sseBody: string): string {
  const parts: string[] = [];

  for (const payload of parseSsePayloads(sseBody)) {
    if (!payload || payload === "[DONE]") {
      continue;
    }

    try {
      const chunk: unknown = JSON.parse(payload);
      if (isChatCompletionResponse(chunk)) {
        const content = extractContentFromJson(chunk);
        if (content) {
          parts.push(content);
        }
      }
    } catch {
      // A malformed event is ignored while valid events are still replayed.
    }
  }

  return parts.join("");
}

function firstSseChunk(sseBody: string): ChatCompletionResponse | undefined {
  for (const payload of parseSsePayloads(sseBody)) {
    if (!payload || payload === "[DONE]") {
      continue;
    }

    try {
      const chunk: unknown = JSON.parse(payload);
      if (isChatCompletionResponse(chunk)) {
        return chunk;
      }
    } catch {
      // Keep looking for the first valid chunk.
    }
  }

  return undefined;
}

function buildSteeringSseEvent(
  steerMessage: string,
  templateChunk?: ChatCompletionResponse,
): string {
  const chunk: ChatCompletionResponse = {
    id: templateChunk?.id ?? "lexverdict-steer",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: steerMessage,
        },
        finish_reason: null,
      },
    ],
  };

  if (typeof templateChunk?.model === "string") {
    chunk.model = templateChunk.model;
  }

  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function applySteerToSse(sseBody: string, steerMessage: string): string {
  return buildSteeringSseEvent(steerMessage, firstSseChunk(sseBody)) + sseBody;
}

function applySteerToJson(
  data: ChatCompletionResponse,
  steerMessage: string,
): ChatCompletionResponse {
  const choices = data.choices ?? [];
  const firstChoice = choices[0];

  if (!firstChoice) {
    return {
      ...data,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: steerMessage },
          finish_reason: "stop",
        },
      ],
    };
  }

  const existingMessage = firstChoice.message ?? {};
  const existingContent =
    typeof existingMessage.content === "string" ? existingMessage.content : "";
  const modifiedChoice: ChatChoice = {
    ...firstChoice,
    message: {
      ...existingMessage,
      role: typeof existingMessage.role === "string" ? existingMessage.role : "assistant",
      content: existingContent ? `${steerMessage}\n\n${existingContent}` : steerMessage,
    },
  };

  return { ...data, choices: [modifiedChoice, ...choices.slice(1)] };
}

function assertByteLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Byte limit must be a non-negative safe integer");
  }
}

function contentLengthExceedsLimit(contentLength: string | null, maxBytes: number): boolean {
  const trimmed = contentLength?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return false;
  }

  const actualDigits = trimmed.replace(/^0+/, "") || "0";
  const limitDigits = String(maxBytes);
  return (
    actualDigits.length > limitDigits.length ||
    (actualDigits.length === limitDigits.length && actualDigits > limitDigits)
  );
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body) {
    void body.cancel().catch(() => undefined);
  }
}

function withUpstreamDeadline<T>(
  operation: () => T | PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return Promise.resolve(operation());
  }
  if (signal.aborted) {
    return Promise.reject(new UpstreamResponseTimeoutError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      signal.removeEventListener("abort", abortListener);
      callback();
    };
    const abortListener = (): void => finish(() => reject(new UpstreamResponseTimeoutError()));

    signal.addEventListener("abort", abortListener, { once: true });
    try {
      void Promise.resolve(operation()).then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function readChunkWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return withUpstreamDeadline(() => reader.read(), signal);
}

async function readRequestJson(request: Request, maxBytes: number): Promise<unknown> {
  assertByteLimit(maxBytes);
  if (contentLengthExceedsLimit(request.headers.get("Content-Length"), maxBytes)) {
    cancelBody(request.body);
    throw new RequestBodyTooLargeError();
  }

  if (!request.body) {
    throw new SyntaxError("Request body is empty");
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  let cancelReader = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      received += value.byteLength;
      if (received > maxBytes) {
        cancelReader = true;
        throw new RequestBodyTooLargeError();
      }

      text += decoder.decode(value, { stream: true });
    }

    return JSON.parse(text + decoder.decode());
  } catch (error) {
    cancelReader = true;
    throw error;
  } finally {
    if (cancelReader) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

/**
 * Reads a buffered upstream body without trusting Content-Length. The byte cap
 * applies to actual decoded-stream chunks as well as a well-formed length
 * header, and an optional signal interrupts a stalled body read.
 */
export async function readResponseText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  assertByteLimit(maxBytes);
  if (contentLengthExceedsLimit(response.headers.get("Content-Length"), maxBytes)) {
    cancelBody(response.body);
    throw new UpstreamResponseTooLargeError();
  }

  if (!response.body) {
    if (signal?.aborted) {
      throw new UpstreamResponseTimeoutError();
    }
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  let cancelReader = false;

  try {
    while (true) {
      const { done, value } = await readChunkWithSignal(reader, signal);
      if (done) {
        break;
      }

      received += value.byteLength;
      if (received > maxBytes) {
        cancelReader = true;
        throw new UpstreamResponseTooLargeError();
      }

      text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
  } catch (error) {
    cancelReader = true;
    if (signal?.aborted && !(error instanceof UpstreamResponseTimeoutError)) {
      throw new UpstreamResponseTimeoutError();
    }
    throw error;
  } finally {
    if (cancelReader || signal?.aborted) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function isSseContentType(contentType: string | null): boolean {
  return /^\s*text\/event-stream(?:\s*;|\s*$)/i.test(contentType ?? "");
}

function sseHeaders(contentType: string | null): Headers {
  return new Headers({
    "Content-Type": isSseContentType(contentType)
      ? (contentType as string)
      : "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
}

function upstreamStatus(status: number): number {
  return status >= 300 && status <= 599 ? status : 502;
}

function shouldTripCircuitForStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function verifyAndMaybeSteer(
  env: ProxyEnv,
  messages: ChatMessage[],
  responseContent: string,
): Promise<VerdictResult> {
  if (!responseContent.trim()) {
    return { verdict: "pass", confidence: 1, message: null };
  }

  return verifyChatResponse(env, messages, responseContent);
}

function verificationErrorResponse(error: unknown): Response {
  if (error instanceof VerifierConfigurationError) {
    return jsonError(502, "Verification provider is not configured");
  }

  return jsonError(502, "Verification service unavailable");
}

export async function handleChatCompletions(request: Request, env: ProxyEnv): Promise<Response> {
  let parsedBody: unknown;
  try {
    parsedBody = await readRequestJson(request, MAX_PROXY_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonError(413, "Request body is too large");
    }
    return jsonError(400, "Invalid JSON body");
  }

  if (!isRecord(parsedBody)) {
    return jsonError(400, "Request body must be a JSON object");
  }

  const body = parsedBody as ChatCompletionBody;
  const isStreaming = body.stream === true;
  const messages = extractMessages(body);

  let upstreamUrl: string;
  try {
    upstreamUrl = upstreamCompletionsUrl(env.UPSTREAM_URL);
  } catch {
    return jsonError(502, "Upstream configuration is invalid");
  }

  if (!upstreamCircuitBreaker.allowRequest(upstreamUrl)) {
    return jsonError(502, "Upstream service is temporarily unavailable");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstreamResponse: Response;
  let rawBody = "";

  try {
    upstreamResponse = await withUpstreamDeadline(
      () => fetch(upstreamUrl, {
        method: "POST",
        headers: buildUpstreamHeaders(env, request.headers.get("Authorization")),
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      controller.signal,
    );

    if (!upstreamResponse.ok) {
      cancelBody(upstreamResponse.body);
      if (shouldTripCircuitForStatus(upstreamResponse.status)) {
        upstreamCircuitBreaker.recordFailure(upstreamUrl);
      } else {
        upstreamCircuitBreaker.recordSuccess(upstreamUrl);
      }
      return jsonError(upstreamStatus(upstreamResponse.status), "Upstream request failed");
    }

    if (isStreaming && !isSseContentType(upstreamResponse.headers.get("Content-Type"))) {
      cancelBody(upstreamResponse.body);
      upstreamCircuitBreaker.recordSuccess(upstreamUrl);
      return jsonError(502, "Upstream returned a non-streaming response");
    }

    rawBody = await readResponseText(
      upstreamResponse,
      MAX_UPSTREAM_RESPONSE_BYTES,
      controller.signal,
    );
  } catch (error) {
    if (error instanceof UpstreamResponseTooLargeError) {
      upstreamCircuitBreaker.recordSuccess(upstreamUrl);
    } else {
      upstreamCircuitBreaker.recordFailure(upstreamUrl);
    }
    if (error instanceof UpstreamResponseTimeoutError || controller.signal.aborted) {
      return jsonError(502, "Upstream request timed out");
    }
    return jsonError(502, "Upstream request failed");
  } finally {
    clearTimeout(timeout);
  }

  if (isStreaming) {
    try {
      const responseContent = extractContentFromSse(rawBody);
      upstreamCircuitBreaker.recordSuccess(upstreamUrl);
      const verdict = await verifyAndMaybeSteer(env, messages, responseContent);
      const output = verdict.verdict === "steer" && verdict.message
        ? applySteerToSse(rawBody, verdict.message)
        : rawBody;

      return new Response(output, {
        status: upstreamResponse.status,
        headers: sseHeaders(upstreamResponse.headers.get("Content-Type")),
      });
    } catch (error) {
      return verificationErrorResponse(error);
    }
  }

  let data: unknown;
  try {
    data = JSON.parse(rawBody);
  } catch {
    upstreamCircuitBreaker.recordSuccess(upstreamUrl);
    return jsonError(502, "Upstream returned an invalid response");
  }

  if (!isChatCompletionResponse(data)) {
    upstreamCircuitBreaker.recordSuccess(upstreamUrl);
    return jsonError(502, "Upstream returned an invalid response");
  }

  upstreamCircuitBreaker.recordSuccess(upstreamUrl);

  try {
    const responseContent = extractContentFromJson(data);
    const verdict = await verifyAndMaybeSteer(env, messages, responseContent);

    if (verdict.verdict === "steer" && verdict.message) {
      return new Response(JSON.stringify(applySteerToJson(data, verdict.message)), {
        status: upstreamResponse.status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    return new Response(rawBody, {
      status: upstreamResponse.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    return verificationErrorResponse(error);
  }
}
