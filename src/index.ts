import { handleChatCompletions, type ProxyEnv } from "./proxy";
import {
  isVerificationText,
  VerifierConfigurationError,
  verifyToolResult,
  type VerifyRequest,
} from "./verify";

export interface Env extends ProxyEnv {
  ENVIRONMENT?: string;
  JIMMY_MODEL?: string;
  REQUEST_LOGGING_ENABLED?: string;
}

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const VERIFY_FIELDS = ["tool_call", "goal", "result"] as const;
const ALIAS_FIELDS = ["decision", "context"] as const;
const MAX_VERIFY_REQUEST_BYTES = 128 * 1024;
const SERVICE_NAME = "lexverdict";
const SERVICE_VERSION = "0.1.0";

type JsonRecord = Record<string, unknown>;
type RouteName = "root" | "health" | "verify" | "chat_completions" | "unknown";

interface RoutedResponse {
  response: Response;
  route: RouteName;
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeded the size limit");
    this.name = "RequestBodyTooLargeError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function jsonError(status: number, message: string): Response {
  return jsonResponse(status, { error: { message, type: "lexverdict_error" } });
}

async function readRequestJson(request: Request, maxBytes: number): Promise<unknown> {
  const declaredLength = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyTooLargeError();
  }

  if (!request.body) {
    throw new SyntaxError("Request body is empty");
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }

      text += decoder.decode(value, { stream: true });
    }

    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

function normalizeAlias(value: JsonRecord): VerifyRequest | null {
  const context = value["context"];
  if (!isRecord(context)) {
    return null;
  }

  const decision = value["decision"];
  const toolCall = context["tool_call"];
  const goal = context["goal"];
  const contextKeys = Object.keys(context);
  if (
    contextKeys.length !== 2 ||
    !hasOwn(context, "tool_call") ||
    !hasOwn(context, "goal") ||
    !isVerificationText(decision) ||
    !isVerificationText(toolCall) ||
    !isVerificationText(goal)
  ) {
    return null;
  }

  return {
    tool_call: toolCall.trim(),
    goal: goal.trim(),
    result: decision.trim(),
  };
}

/**
 * Accepts one documented direct-verification form and returns its canonical
 * tool_call, goal, result representation. Unknown top-level fields are ignored
 * for forward compatibility, but alias context is intentionally exact.
 */
export function normalizeVerifyRequest(body: unknown): VerifyRequest | null {
  if (!isRecord(body)) {
    return null;
  }

  const hasCanonicalField = VERIFY_FIELDS.some((field) => hasOwn(body, field));
  const hasAliasField = ALIAS_FIELDS.some((field) => hasOwn(body, field));
  if (hasCanonicalField === hasAliasField) {
    return null;
  }

  if (hasAliasField) {
    return normalizeAlias(body);
  }

  const toolCall = body["tool_call"];
  const goal = body["goal"];
  const result = body["result"];
  if (
    !isVerificationText(toolCall) ||
    !isVerificationText(goal) ||
    !isVerificationText(result)
  ) {
    return null;
  }

  return {
    tool_call: toolCall.trim(),
    goal: goal.trim(),
    result: result.trim(),
  };
}

async function handleVerify(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await readRequestJson(request, MAX_VERIFY_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonError(413, "Request body is too large");
    }
    return jsonError(400, "Invalid JSON body");
  }

  const verificationRequest = normalizeVerifyRequest(body);
  if (!verificationRequest) {
    return jsonError(400, "Request must include tool_call, goal, and result strings");
  }

  try {
    const result = await verifyToolResult(env, verificationRequest);
    return jsonResponse(200, result);
  } catch (error) {
    if (error instanceof VerifierConfigurationError) {
      return jsonError(502, "Verification provider is not configured");
    }
    return jsonError(502, "Verification service unavailable");
  }
}

function serviceDescriptor(): Response {
  return jsonResponse(200, {
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    endpoints: ["GET /health", "POST /v1/chat/completions", "POST /v1/verify"],
  });
}

function isVerifierConfigured(env: Env): boolean {
  return Boolean(env.JIMMY_SERVICE) ||
    (typeof env.JIMMY_URL === "string" && env.JIMMY_URL.trim().length > 0);
}

/**
 * This is a configuration and process health check. It intentionally does not
 * make a provider request: health probes must not spend verifier capacity or
 * expose provider latency as Worker liveness.
 */
function healthResponse(env: Env): Response {
  const verifierConfigured = isVerifierConfigured(env);
  return jsonResponse(200, {
    service: SERVICE_NAME,
    status: verifierConfigured ? "ok" : "degraded",
    version: SERVICE_VERSION,
    environment:
      typeof env.ENVIRONMENT === "string" && env.ENVIRONMENT.trim()
        ? env.ENVIRONMENT.trim()
        : "unknown",
    checks: {
      verifier: verifierConfigured ? "configured" : "unconfigured",
    },
  });
}

function normalizedPath(request: Request): string {
  return new URL(request.url).pathname.replace(/\/+$/, "") || "/";
}

function routeName(path: string): RouteName {
  switch (path) {
    case "/":
      return "root";
    case "/health":
      return "health";
    case "/v1/verify":
      return "verify";
    case "/v1/chat/completions":
      return "chat_completions";
    default:
      return "unknown";
  }
}

function requestLoggingEnabled(env: Env): boolean {
  if (typeof env.REQUEST_LOGGING_ENABLED !== "string") {
    return true;
  }

  return !["0", "false", "no", "off"].includes(
    env.REQUEST_LOGGING_ENABLED.trim().toLowerCase(),
  );
}

function logRequest(
  request: Request,
  route: RouteName,
  response: Response,
  startedAt: number,
  env: Env,
): void {
  if (!requestLoggingEnabled(env)) {
    return;
  }

  // Do not log bodies, headers, query strings, or raw paths. Any of them can
  // contain customer content, credentials, or provider tokens.
  const event = {
    event: "lexverdict.request",
    method: request.method,
    route,
    status: response.status,
    duration_ms: Math.max(0, Date.now() - startedAt),
  };

  try {
    console.info(JSON.stringify(event));
  } catch {
    // Logging must never affect an API response.
  }
}

async function dispatchRequest(request: Request, env: Env): Promise<RoutedResponse> {
  const path = normalizedPath(request);
  const route = routeName(path);

  if (request.method === "OPTIONS") {
    return { response: new Response(null, { status: 204, headers: CORS_HEADERS }), route };
  }

  if (path === "/") {
    return {
      response: request.method === "GET" ? serviceDescriptor() : jsonError(405, "Method not allowed"),
      route,
    };
  }

  if (path === "/health") {
    return {
      response: request.method === "GET" ? healthResponse(env) : jsonError(405, "Method not allowed"),
      route,
    };
  }

  if (path === "/v1/verify") {
    return {
      response: request.method === "POST"
        ? await handleVerify(request, env)
        : jsonError(405, "Method not allowed"),
      route,
    };
  }

  if (path === "/v1/chat/completions") {
    return {
      response: request.method === "POST"
        ? await handleChatCompletions(request, env)
        : jsonError(405, "Method not allowed"),
      route,
    };
  }

  return { response: jsonError(404, "Not found"), route };
}

async function withRequestLogging(request: Request, env: Env): Promise<Response> {
  const startedAt = Date.now();
  let route: RouteName = "unknown";
  let response: Response;

  try {
    const routed = await dispatchRequest(request, env);
    route = routed.route;
    response = routed.response;
  } catch {
    response = jsonError(500, "Internal server error");
  }

  const corsResponse = withCors(response);
  logRequest(request, route, corsResponse, startedAt, env);
  return corsResponse;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return withRequestLogging(request, env);
  },
};
