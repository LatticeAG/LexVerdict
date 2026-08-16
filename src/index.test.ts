import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { normalizeVerifyRequest, type Env } from "./index";

const env: Env = {
  UPSTREAM_URL: "https://upstream.example",
  UPSTREAM_API_KEY: "",
  JIMMY_URL: "https://jimmy.example/v1/chat/completions",
  REQUEST_LOGGING_ENABLED: "false",
};

function jimmyResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function verifyRequest(body: unknown): Request {
  return new Request("https://lexverdict.example/v1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LexVerdict Worker router", () => {
  it("serves a CORS-enabled service descriptor and preflight response", async () => {
    const rootResponse = await worker.fetch(
      new Request("https://lexverdict.example/"),
      env,
    );
    const rootPayload = (await rootResponse.json()) as {
      service: string;
      endpoints: string[];
    };

    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(rootPayload).toEqual({
      service: "lexverdict",
      version: "0.1.0",
      endpoints: ["GET /health", "POST /v1/chat/completions", "POST /v1/verify"],
    });

    const preflightResponse = await worker.fetch(
      new Request("https://lexverdict.example/v1/verify", { method: "OPTIONS" }),
      env,
    );
    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(preflightResponse.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("reports process health without calling a provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://lexverdict.example/health"),
      { ...env, ENVIRONMENT: "staging" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({
      service: "lexverdict",
      status: "ok",
      version: "0.1.0",
      environment: "staging",
      checks: { verifier: "configured" },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const degradedResponse = await worker.fetch(
      new Request("https://lexverdict.example/health"),
      {
        UPSTREAM_URL: "https://upstream.example",
        UPSTREAM_API_KEY: "",
        REQUEST_LOGGING_ENABLED: "false",
      },
    );
    await expect(degradedResponse.json()).resolves.toMatchObject({
      status: "degraded",
      checks: { verifier: "unconfigured" },
    });
  });

  it("rejects malformed verify payloads with CORS-enabled 400 responses", async () => {
    const invalidJsonResponse = await worker.fetch(
      new Request("https://lexverdict.example/v1/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      env,
    );
    expect(invalidJsonResponse.status).toBe(400);
    expect(invalidJsonResponse.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(invalidJsonResponse.json()).resolves.toEqual({
      error: { message: "Invalid JSON body", type: "lexverdict_error" },
    });

    const missingFieldsResponse = await worker.fetch(
      verifyRequest({ tool_call: "git status", goal: "Inspect the repository" }),
      env,
    );
    expect(missingFieldsResponse.status).toBe(400);
    await expect(missingFieldsResponse.json()).resolves.toEqual({
      error: {
        message: "Request must include tool_call, goal, and result strings",
        type: "lexverdict_error",
      },
    });

    for (const malformedAlias of [
      { tool_call: " ", goal: "Inspect the repository", result: "Repository is clean." },
      { tool_call: "git status", goal: " ", result: "Repository is clean." },
      { tool_call: "git status", goal: "Inspect the repository", result: " " },
      {
        decision: " ",
        context: { tool_call: "git status", goal: "Inspect the repository" },
      },
      {
        decision: "",
        context: { tool_call: "git status", goal: "Inspect the repository" },
      },
      {
        decision: "Repository is clean.",
        context: { tool_call: " ", goal: "Inspect the repository" },
      },
      { decision: "Repository is clean.", context: "freeform context" },
      { decision: "Repository is clean.", context: [] },
      { decision: "Repository is clean.", context: null },
      {
        decision: "Repository is clean.",
        context: {
          tool_call: "git status",
          goal: "Inspect the repository",
          metadata: { unexpected: true },
        },
      },
      {
        tool_call: "git status",
        goal: "Inspect the repository",
        result: "Repository is clean.",
        decision: "A contradictory decision.",
        context: { tool_call: "git diff", goal: "Inspect a different repository state" },
      },
    ]) {
      const response = await worker.fetch(verifyRequest(malformedAlias), env);
      expect(response.status, JSON.stringify(malformedAlias)).toBe(400);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });

  it("trims fields before applying the documented character cap", () => {
    const boundedValue = ` ${"x".repeat(8_000)} `;

    expect(
      normalizeVerifyRequest({
        tool_call: boundedValue,
        goal: "Verify the result",
        result: "Verification completed",
      }),
    ).toMatchObject({ tool_call: "x".repeat(8_000) });
  });

  it("verifies a canonical tool result and returns the verifier verdict", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jimmyResponse(
        "VERDICT: STEER\nCONFIDENCE: 0.92\nMESSAGE: Staging does not satisfy the production goal.",
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      verifyRequest({
        tool_call: "kubectl apply -f prod.yaml",
        goal: "Deploy to production",
        result: "deployment created in staging",
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({
      verdict: "steer",
      confidence: 0.92,
      message: "[LexVerdict] Staging does not satisfy the production goal.",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      env.JIMMY_URL,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("accepts the decision and context alias for a verification request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jimmyResponse("VERDICT: PASS\nCONFIDENCE: 0.88"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      verifyRequest({
        decision: "Configured deployment for production.",
        context: {
          tool_call: "write_file deployment.yaml",
          goal: "Deploy the service to production",
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      verdict: "pass",
      confidence: 0.88,
      message: null,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0]?.content).toContain("write_file deployment.yaml");
    expect(body.messages[0]?.content).toContain("Deploy the service to production");
    expect(body.messages[0]?.content).toContain("Configured deployment for production.");
  });

  it("turns verifier failures into a CORS-enabled 502 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Jimmy unavailable")));

    const response = await worker.fetch(
      verifyRequest({
        tool_call: "npm run deploy",
        goal: "Deploy to production",
        result: "Deploy command ran",
      }),
      env,
    );
    const payload = (await response.json()) as { error: { message: string; type: string } };

    expect(response.status).toBe(502);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(payload.error.type).toBe("lexverdict_error");
    expect(payload.error.message).toBe("Verification service unavailable");
    expect(payload.error.message).not.toContain("Jimmy unavailable");
  });

  it("returns a safe 502 without a fetch when no verifier provider is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      verifyRequest({
        tool_call: "npm run deploy",
        goal: "Deploy to production",
        result: "Deploy command ran",
      }),
      {
        UPSTREAM_URL: "https://upstream.example",
        UPSTREAM_API_KEY: "",
        REQUEST_LOGGING_ENABLED: "false",
      },
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Verification provider is not configured",
        type: "lexverdict_error",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Jimmy returns an unparseable verdict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jimmyResponse("The deployment result looks plausible.")),
    );

    const response = await worker.fetch(
      verifyRequest({
        tool_call: "npm run deploy",
        goal: "Deploy to production",
        result: "Deploy command ran",
      }),
      env,
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "lexverdict_error", message: expect.any(String) },
    });
  });

  it("uses the same CORS-enabled error envelope for method and route errors", async () => {
    for (const [request, status, message] of [
      [new Request("https://lexverdict.example/", { method: "POST" }), 405, "Method not allowed"],
      [new Request("https://lexverdict.example/health", { method: "POST" }), 405, "Method not allowed"],
      [new Request("https://lexverdict.example/v1/verify", { method: "PUT" }), 405, "Method not allowed"],
      [new Request("https://lexverdict.example/v1/chat/completions"), 405, "Method not allowed"],
      [new Request("https://lexverdict.example/v1/not-a-route", { method: "POST" }), 404, "Not found"],
    ] as const) {
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(status);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      await expect(response.json()).resolves.toEqual({
        error: { message, type: "lexverdict_error" },
      });
    }

    const proxyBodyError = await worker.fetch(
      new Request("https://lexverdict.example/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      env,
    );
    expect(proxyBodyError.status).toBe(400);
    expect(proxyBodyError.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(proxyBodyError.json()).resolves.toEqual({
      error: { message: "Invalid JSON body", type: "lexverdict_error" },
    });
  });

  it("logs only safe request metadata", async () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request("https://lexverdict.example/v1/verify?access_token=query-secret", {
        method: "POST",
        headers: {
          Authorization: "Bearer header-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decision: "body-secret" }),
      }),
      { ...env, REQUEST_LOGGING_ENABLED: "true" },
    );

    expect(response.status).toBe(400);
    expect(logSpy).toHaveBeenCalledTimes(1);

    const serializedEvent = String(logSpy.mock.calls[0]?.[0]);
    expect(JSON.parse(serializedEvent)).toMatchObject({
      event: "lexverdict.request",
      method: "POST",
      route: "verify",
      status: 400,
      duration_ms: expect.any(Number),
    });
    expect(serializedEvent).not.toContain("query-secret");
    expect(serializedEvent).not.toContain("header-secret");
    expect(serializedEvent).not.toContain("body-secret");

    logSpy.mockClear();
    await worker.fetch(
      new Request("https://lexverdict.example/health"),
      { ...env, REQUEST_LOGGING_ENABLED: "false" },
    );
    expect(logSpy).not.toHaveBeenCalled();
  });
});
