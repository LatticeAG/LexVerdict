import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleChatCompletions,
  readResponseText,
  resetUpstreamCircuitBreakerForTests,
  UPSTREAM_TIMEOUT_MS,
  UpstreamResponseTimeoutError,
  UpstreamResponseTooLargeError,
  type ProxyEnv,
} from "./proxy";

const env: ProxyEnv = {
  UPSTREAM_URL: "https://upstream.example",
  UPSTREAM_API_KEY: "",
  JIMMY_URL: "https://jimmy.example/v1/chat/completions",
};

function chatRequest(body: Record<string, unknown>, authorization?: string): Request {
  return new Request("https://lexverdict.example/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

function upstreamCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1,
      model: "upstream-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function jimmyVerdict(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetUpstreamCircuitBreakerForTests();
});

describe("handleChatCompletions", () => {
  it("forwards a non-streaming completion and preserves a passing response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upstreamCompletion("Deployment succeeded in production."))
      .mockResolvedValueOnce(jimmyVerdict("VERDICT: PASS\nCONFIDENCE: 0.94"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatCompletions(
      chatRequest(
        {
          model: "upstream-model",
          messages: [{ role: "user", content: "Deploy to production." }],
        },
        "Bearer client-token",
      ),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "Deployment succeeded in production." } }],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://upstream.example/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );

    const upstreamInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(upstreamInit.headers).get("Authorization")).toBe("Bearer client-token");
    expect(JSON.parse(String(upstreamInit.body))).toMatchObject({
      model: "upstream-model",
      messages: [{ role: "user", content: "Deploy to production." }],
    });
  });

  it("prefers the configured upstream API key over a client authorization header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upstreamCompletion("All clear."))
      .mockResolvedValueOnce(jimmyVerdict("VERDICT: PASS"));
    vi.stubGlobal("fetch", fetchMock);

    await handleChatCompletions(
      chatRequest(
        { messages: [{ role: "user", content: "Check the deployment." }] },
        "Bearer client-token",
      ),
      { ...env, UPSTREAM_API_KEY: "server-token" },
    );

    const upstreamInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(upstreamInit.headers).get("Authorization")).toBe("Bearer server-token");
  });

  it("does not duplicate the chat completions path when the upstream URL is already complete", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upstreamCompletion("All clear."))
      .mockResolvedValueOnce(jimmyVerdict("VERDICT: PASS"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatCompletions(
      chatRequest({ messages: [{ role: "user", content: "Check the deployment." }] }),
      { ...env, UPSTREAM_URL: "https://upstream.example/v1/chat/completions" },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://upstream.example/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("injects a steering message ahead of a non-streaming assistant response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upstreamCompletion("Deployment succeeded in staging."))
      .mockResolvedValueOnce(
        jimmyVerdict(
          "VERDICT: STEER\nCONFIDENCE: 0.92\nMESSAGE: The goal requires production, not staging.",
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatCompletions(
      chatRequest({ messages: [{ role: "user", content: "Deploy to production." }] }),
      env,
    );
    const payload = (await response.json()) as {
      choices: Array<{ message?: { role?: string; content?: string } }>;
    };

    expect(response.status).toBe(200);
    expect(payload.choices[0]?.message?.content).toBe(
      "[LexVerdict] The goal requires production, not staging.\n\nDeployment succeeded in staging.",
    );
  });

  it("sanitizes upstream errors without exposing provider response bodies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatCompletions(
      chatRequest({ messages: [{ role: "user", content: "Hello" }] }),
      env,
    );

    const payload = (await response.json()) as {
      error: { message: string; type: string };
    };

    expect(response.status).toBe(429);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(payload.error.type).toBe("lexverdict_error");
    expect(payload.error.message).not.toContain("rate limited");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out an upstream fetch that does not honor its abort signal", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      receivedSignal = init?.signal;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = handleChatCompletions(
      chatRequest({ messages: [{ role: "user", content: "Check the deployment." }] }),
      env,
    );
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS);

    const response = await pending;
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Upstream request timed out", type: "lexverdict_error" },
    });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns a safe error for an invalid non-streaming upstream completion", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("not a JSON completion", {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatCompletions(
      chatRequest({ messages: [{ role: "user", content: "Check the deployment." }] }),
      env,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "lexverdict_error", message: expect.any(String) },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Jimmy returns an unparseable verdict for a proxy response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upstreamCompletion("Deployment completed in production."))
      .mockResolvedValueOnce(jimmyVerdict("The answer seems correct."));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatCompletions(
      chatRequest({ messages: [{ role: "user", content: "Deploy to production." }] }),
      env,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "lexverdict_error", message: expect.any(String) },
    });
  });

  it("reports an unconfigured verifier with the standard safe error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(upstreamCompletion("Deployment completed."));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatCompletions(
      chatRequest({ messages: [{ role: "user", content: "Deploy to production." }] }),
      {
        UPSTREAM_URL: "https://upstream.example",
      },
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Verification provider is not configured",
        type: "lexverdict_error",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed client JSON before calling the upstream service", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatCompletions(
      new Request("https://lexverdict.example/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Invalid JSON body", type: "lexverdict_error" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a null chat completion payload before calling the upstream service", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatCompletions(
      new Request("https://lexverdict.example/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "null",
      }),
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "lexverdict_error", message: expect.any(String) },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes through an empty JSON completion without calling Jimmy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(upstreamCompletion(""));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatCompletions(
      chatRequest({ messages: [{ role: "user", content: "Check the deployment." }] }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "" } }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed SSE events and passes through an empty stream", async () => {
    const malformedSse = "data: {not valid JSON}\n\ndata: [DONE]\n\n";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(malformedSse, { headers: { "Content-Type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatCompletions(
      chatRequest({
        stream: true,
        messages: [{ role: "user", content: "Check the deployment." }],
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    await expect(response.text()).resolves.toBe(malformedSse);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a safe error when a streaming request receives a non-SSE upstream response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(upstreamCompletion("This is JSON, not SSE."));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatCompletions(
      chatRequest({
        stream: true,
        messages: [{ role: "user", content: "Check the deployment." }],
      }),
      env,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "lexverdict_error", message: expect.any(String) },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not open the upstream circuit for client-selected streaming protocol mismatches", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(upstreamCompletion("This response is JSON."))
      .mockResolvedValueOnce(upstreamCompletion("This response is JSON."))
      .mockResolvedValueOnce(upstreamCompletion("This response is JSON."))
      .mockResolvedValueOnce(upstreamCompletion("Deployment completed in production."))
      .mockResolvedValueOnce(jimmyVerdict("VERDICT: PASS\nCONFIDENCE: 0.9"));
    vi.stubGlobal("fetch", fetchMock);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await handleChatCompletions(
        chatRequest({
          stream: true,
          messages: [{ role: "user", content: "Check the deployment." }],
        }),
        env,
      );
      expect(response.status).toBe(502);
    }

    const healthyResponse = await handleChatCompletions(
      chatRequest({ messages: [{ role: "user", content: "Check the deployment." }] }),
      env,
    );
    expect(healthyResponse.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("preserves a valid streaming response when Jimmy passes it", async () => {
    const sse = [
      'data: {"id":"chatcmpl-pass","object":"chat.completion.chunk","created":1,"model":"upstream-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Deployment "},"finish_reason":null}]}',
      "",
      'data: {"id":"chatcmpl-pass","object":"chat.completion.chunk","created":1,"model":"upstream-model","choices":[{"index":0,"delta":{"content":"succeeded."},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
      )
      .mockResolvedValueOnce(jimmyVerdict("VERDICT: PASS\nCONFIDENCE: 0.97"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatCompletions(
      chatRequest({
        stream: true,
        messages: [{ role: "user", content: "Deploy to production." }],
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-transform");
    await expect(response.text()).resolves.toBe(sse);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const jimmyInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const jimmyRequest = JSON.parse(String(jimmyInit.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(jimmyRequest.messages[0]?.content).toContain("Deployment succeeded.");
  });

  it("extracts streaming content and prepends a steering SSE event", async () => {
    const sse = [
      'data: {"id":"chatcmpl-456","object":"chat.completion.chunk","created":1,"model":"upstream-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Deployed to staging."},"finish_reason":null}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
      )
      .mockResolvedValueOnce(
        jimmyVerdict("VERDICT: STEER\nCONFIDENCE: 0.9\nMESSAGE: Use production."),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleChatCompletions(
      chatRequest({
        stream: true,
        messages: [{ role: "user", content: "Deploy to production." }],
      }),
      env,
    );
    const responseBody = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(responseBody).toContain('"role":"assistant","content":"[LexVerdict] Use production."');
    expect(responseBody).toContain("Deployed to staging.");
    expect(responseBody.indexOf("[LexVerdict] Use production.")).toBeLessThan(
      responseBody.indexOf("Deployed to staging."),
    );
  });

  it("opens a bounded circuit after repeated upstream provider failures", async () => {
    const fetchMock = vi.fn().mockImplementation(
      () => new Response("provider unavailable", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await handleChatCompletions(
        chatRequest({ messages: [{ role: "user", content: "Check the deployment." }] }),
        env,
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: { message: "Upstream request failed", type: "lexverdict_error" },
      });
    }

    const openedResponse = await handleChatCompletions(
      chatRequest({ messages: [{ role: "user", content: "Check the deployment." }] }),
      env,
    );

    expect(openedResponse.status).toBe(502);
    await expect(openedResponse.json()).resolves.toEqual({
      error: {
        message: "Upstream service is temporarily unavailable",
        type: "lexverdict_error",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("releases a half-open probe after a client-specific protocol mismatch", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("provider unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("provider unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("provider unavailable", { status: 503 }))
      .mockResolvedValueOnce(upstreamCompletion("This response is JSON."))
      .mockResolvedValueOnce(upstreamCompletion("Deployment completed in production."))
      .mockResolvedValueOnce(jimmyVerdict("VERDICT: PASS\nCONFIDENCE: 0.9"));
    vi.stubGlobal("fetch", fetchMock);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await handleChatCompletions(
        chatRequest({ messages: [{ role: "user", content: "Check the deployment." }] }),
        env,
      );
      expect(response.status).toBe(503);
    }

    await vi.advanceTimersByTimeAsync(30_000);
    const probeResponse = await handleChatCompletions(
      chatRequest({
        stream: true,
        messages: [{ role: "user", content: "Check the deployment." }],
      }),
      env,
    );
    expect(probeResponse.status).toBe(502);

    const healthyResponse = await handleChatCompletions(
      chatRequest({ messages: [{ role: "user", content: "Check the deployment." }] }),
      env,
    );
    expect(healthyResponse.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

describe("readResponseText", () => {
  it("enforces declared and observed byte limits while cancelling an oversized body", async () => {
    await expect(
      readResponseText(
        new Response("ignored", { headers: { "Content-Length": "999999999999999999999" } }),
        8,
      ),
    ).rejects.toBeInstanceOf(UpstreamResponseTooLargeError);

    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("abc"));
          controller.enqueue(new TextEncoder().encode("def"));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(readResponseText(response, 5)).rejects.toBeInstanceOf(
      UpstreamResponseTooLargeError,
    );
    expect(cancelled).toBe(true);
  });

  it("decodes split UTF-8 chunks and aborts a stalled body read", async () => {
    const encoded = new TextEncoder().encode("A€B");
    const splitResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.slice(0, 2));
          controller.enqueue(encoded.slice(2));
          controller.close();
        },
      }),
    );
    await expect(readResponseText(splitResponse, 32)).resolves.toBe("A€B");

    let cancelled = false;
    const stalledResponse = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    );
    const controller = new AbortController();
    const reading = readResponseText(stalledResponse, 32, controller.signal);
    controller.abort();

    await expect(reading).rejects.toBeInstanceOf(UpstreamResponseTimeoutError);
    expect(cancelled).toBe(true);
  });
});
