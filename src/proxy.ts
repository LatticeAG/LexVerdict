import { verifyChatResponse, type VerdictResult } from "./verify";

export interface ProxyEnv {
  UPSTREAM_URL: string;
  UPSTREAM_API_KEY: string;
  JIMMY_URL: string;
  JIMMY_SERVICE?: Fetcher;
}

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatCompletionBody {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

const UPSTREAM_TIMEOUT_MS = 120_000;

interface ChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { role?: string; content?: string };
    delta?: { role?: string; content?: string };
    finish_reason?: string | null;
  }>;
  [key: string]: unknown;
}

function upstreamCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/chat/completions")) {
    return trimmed;
  }
  return `${trimmed}/v1/chat/completions`;
}

function buildUpstreamHeaders(
  env: ProxyEnv,
  clientAuth: string | null,
): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });

  if (env.UPSTREAM_API_KEY) {
    headers.set("Authorization", `Bearer ${env.UPSTREAM_API_KEY}`);
  } else if (clientAuth) {
    headers.set("Authorization", clientAuth);
  }

  return headers;
}

function extractMessages(body: ChatCompletionBody): ChatMessage[] {
  if (!Array.isArray(body.messages)) {
    return [];
  }
  return body.messages
    .filter((m): m is ChatMessage => typeof m?.role === "string" && typeof m?.content === "string")
    .map((m) => ({ role: m.role, content: m.content }));
}

function extractContentFromJson(data: ChatCompletionResponse): string {
  const choice = data.choices?.[0];
  return choice?.message?.content ?? choice?.delta?.content ?? "";
}

function extractContentFromSse(sseBody: string): string {
  const parts: string[] = [];

  for (const line of sseBody.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }

    try {
      const chunk = JSON.parse(payload) as ChatCompletionResponse;
      const content = extractContentFromJson(chunk);
      if (content) {
        parts.push(content);
      }
    } catch {
      // Skip malformed SSE lines.
    }
  }

  return parts.join("");
}

function buildSteeringSseEvent(steerMessage: string, templateChunk?: ChatCompletionResponse): string {
  const chunk: ChatCompletionResponse = {
    id: templateChunk?.id ?? "lexverdict-steer",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: templateChunk?.model,
    choices: [
      {
        index: 0,
        delta: {
          role: "system",
          content: steerMessage,
        },
        finish_reason: null,
      },
    ],
  };

  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function applySteerToSse(sseBody: string, steerMessage: string): string {
  let templateChunk: ChatCompletionResponse | undefined;

  for (const line of sseBody.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      templateChunk = JSON.parse(payload) as ChatCompletionResponse;
      break;
    } catch {
      // Keep scanning.
    }
  }

  const steeringEvent = buildSteeringSseEvent(steerMessage, templateChunk);
  return steeringEvent + sseBody;
}

function applySteerToJson(
  data: ChatCompletionResponse,
  steerMessage: string,
): ChatCompletionResponse {
  const modified = structuredClone(data);
  const choice = modified.choices?.[0];

  if (!choice) {
    modified.choices = [
      {
        index: 0,
        message: {
          role: "assistant",
          content: steerMessage,
        },
        finish_reason: "stop",
      },
    ];
    return modified;
  }

  if (!choice.message) {
    choice.message = { role: "assistant", content: "" };
  }

  const existing = choice.message.content ?? "";
  choice.message.content = existing
    ? `${steerMessage}\n\n${existing}`
    : steerMessage;

  return modified;
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

export async function handleChatCompletions(
  request: Request,
  env: ProxyEnv,
): Promise<Response> {
  let body: ChatCompletionBody;
  try {
    body = (await request.json()) as ChatCompletionBody;
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const messages = extractMessages(body);
  const isStreaming = body.stream === true;
  const upstreamUrl = upstreamCompletionsUrl(env.UPSTREAM_URL);
  const clientAuth = request.headers.get("Authorization");

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: buildUpstreamHeaders(env, clientAuth),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upstream request failed";
    return jsonError(502, `Upstream unreachable: ${message}`);
  }

  if (!upstreamResponse.ok) {
    const errorBody = await upstreamResponse.text();
    return new Response(errorBody, {
      status: upstreamResponse.status,
      headers: pickHeaders(upstreamResponse.headers, ["content-type"]),
    });
  }

  const rawBody = await upstreamResponse.text();

  try {
    if (isStreaming) {
      const responseContent = extractContentFromSse(rawBody);
      const verdict = await verifyAndMaybeSteer(env, messages, responseContent);

      if (verdict.verdict === "steer" && verdict.message) {
        const modified = applySteerToSse(rawBody, verdict.message);
        return new Response(modified, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      return new Response(rawBody, {
        status: 200,
        headers: {
          "Content-Type": upstreamResponse.headers.get("Content-Type") ?? "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    let data: ChatCompletionResponse;
    try {
      data = JSON.parse(rawBody) as ChatCompletionResponse;
    } catch {
      return jsonError(502, "Upstream returned invalid JSON");
    }

    const responseContent = extractContentFromJson(data);
    const verdict = await verifyAndMaybeSteer(env, messages, responseContent);

    if (verdict.verdict === "steer" && verdict.message) {
      const modified = applySteerToJson(data, verdict.message);
      return new Response(JSON.stringify(modified), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(rawBody, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verification failed";
    return jsonError(502, message);
  }
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "lexverdict_error" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pickHeaders(source: Headers, names: string[]): Headers {
  const headers = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return headers;
}
