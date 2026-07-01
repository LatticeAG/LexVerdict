import { handleChatCompletions } from "./proxy";
import { verifyToolResult, type VerifyRequest } from "./verify";

export interface Env {
  UPSTREAM_URL: string;
  UPSTREAM_API_KEY: string;
  JIMMY_URL: string;
  JIMMY_SERVICE?: Fetcher;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

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

function jsonError(status: number, message: string): Response {
  return withCors(
    new Response(JSON.stringify({ error: { message, type: "lexverdict_error" } }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function isValidVerifyRequest(body: unknown): body is VerifyRequest {
  if (!body || typeof body !== "object") {
    return false;
  }
  const req = body as Record<string, unknown>;
  return (
    typeof req.tool_call === "string" &&
    typeof req.goal === "string" &&
    typeof req.result === "string"
  );
}

async function handleVerify(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  if (!isValidVerifyRequest(body)) {
    return jsonError(400, "Request must include tool_call, goal, and result strings");
  }

  try {
    const result = await verifyToolResult(env, body);
    return withCors(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verification failed";
    return jsonError(502, message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && path === "/") {
      return withCors(
        new Response(
          JSON.stringify({
            service: "lexverdict",
            version: "0.1.0",
            endpoints: ["POST /v1/chat/completions", "POST /v1/verify"],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (request.method !== "POST") {
      return jsonError(405, "Method not allowed");
    }

    if (path === "/v1/chat/completions") {
      const response = await handleChatCompletions(request, env);
      return withCors(response);
    }

    if (path === "/v1/verify") {
      return handleVerify(request, env);
    }

    return jsonError(404, "Not found");
  },
};
