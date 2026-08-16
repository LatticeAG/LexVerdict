import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JIMMY_TIMEOUT_MS,
  VerifierOutputError,
  VerifierTimeoutError,
  buildChatVerificationPrompt,
  buildToolVerificationPrompt,
  isVerificationText,
  parseVerdict,
  readResponseText,
  verifyChatResponse,
  verifyToolResult,
  type Env,
  type VerifyRequest,
} from "./verify";

const env: Env = {
  JIMMY_URL: "https://jimmy.example/v1/chat/completions",
};

const toolRequest: VerifyRequest = {
  tool_call: "kubectl apply -f production.yaml",
  goal: "Deploy the API to production",
  result: "deployment/api configured in namespace production",
};

function jimmyResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("verification prompts", () => {
  it("includes the tool call, goal, result, and every verification check", () => {
    const prompt = buildToolVerificationPrompt(toolRequest);

    expect(prompt).toContain(toolRequest.tool_call);
    expect(prompt).toContain(toolRequest.goal);
    expect(prompt).toContain(toolRequest.result);
    expect(prompt).toMatch(/match/i);
    expect(prompt).toMatch(/environment/i);
    expect(prompt).toMatch(/data/i);
    expect(prompt).toMatch(/security/i);
    expect(prompt).toMatch(/failure/i);
    expect(prompt).toMatch(/drift/i);
    expect(prompt).toContain("VERDICT: PASS");
  });

  it("preserves chat history and the candidate response in a chat prompt", () => {
    const prompt = buildChatVerificationPrompt(
      [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Deploy the API to production." },
      ],
      "The API was deployed to staging.",
    );

    expect(prompt).toContain("Be concise.");
    expect(prompt).toContain("Deploy the API to production.");
    expect(prompt).toContain("The API was deployed to staging.");
  });
});

describe("verification request text", () => {
  it("applies the field limit after trimming transport whitespace", () => {
    expect(isVerificationText(`  ${"x".repeat(8_000)}  `)).toBe(true);
    expect(isVerificationText("x".repeat(8_001))).toBe(false);
  });
});

describe("parseVerdict", () => {
  it("parses a steer verdict, bounds confidence, and brands the message", () => {
    expect(
      parseVerdict(`
        VERDICT: STEER
        CONFIDENCE: 1.4
        MESSAGE: The result targets staging. Deploy to production instead.
      `),
    ).toEqual({
      verdict: "steer",
      confidence: 1,
      message: "[LexVerdict] The result targets staging. Deploy to production instead.",
    });
  });

  it("uses a safe branded message when a steer verdict has no message", () => {
    const verdict = parseVerdict("VERDICT: STEER\nCONFIDENCE: 0.72");

    expect(verdict.verdict).toBe("steer");
    expect(verdict.confidence).toBe(0.72);
    expect(verdict.message).toEqual(expect.stringMatching(/^\[LexVerdict\]/));
  });

  it("rejects missing, malformed, or contradictory verdict labels", () => {
    for (const text of [
      "CONFIDENCE: 0.9\nMESSAGE: Everything looks good.",
      "VERDICT: MAYBE\nCONFIDENCE: 0.9",
      "VERDICT: PASS\nVERDICT: STEER\nCONFIDENCE: 0.9",
    ]) {
      expect(() => parseVerdict(text), text).toThrow();
    }
  });
});

describe("verifier response transport", () => {
  it("counts encoded bytes across chunks while preserving split UTF-8 text", async () => {
    const text = "Verification complete: ✅";
    const bytes = new TextEncoder().encode(text);
    const splitWithinEmoji = bytes.byteLength - 2;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, splitWithinEmoji));
          controller.enqueue(bytes.slice(splitWithinEmoji));
          controller.close();
        },
      }),
    );

    await expect(readResponseText(response, bytes.byteLength)).resolves.toBe(text);

    let cancelled = false;
    const oversizedResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, splitWithinEmoji));
          controller.enqueue(bytes.slice(splitWithinEmoji));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(
      readResponseText(oversizedResponse, bytes.byteLength - 1),
    ).rejects.toBeInstanceOf(VerifierOutputError);
    expect(cancelled).toBe(true);
  });

  it("rejects a declared oversized body before it is read", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "Content-Length": "6" } },
    );

    await expect(readResponseText(response, 5)).rejects.toBeInstanceOf(VerifierOutputError);
    expect(cancelled).toBe(true);
  });

  it("cancels a stalled reader as soon as its deadline aborts", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const controller = new AbortController();
    const pending = readResponseText(response, 1024, controller.signal);
    const rejection = expect(pending).rejects.toBeInstanceOf(VerifierTimeoutError);

    controller.abort();

    await rejection;
    expect(cancelled).toBe(true);
  });
});

describe("verifier calls", () => {
  it("posts a tool verification prompt to the configured Jimmy endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jimmyResponse("VERDICT: PASS\nCONFIDENCE: 0.91"),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyToolResult(env, toolRequest)).resolves.toEqual({
      verdict: "pass",
      confidence: 0.91,
      message: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      env.JIMMY_URL,
      expect.objectContaining({ method: "POST" }),
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
      temperature: number;
    };
    expect(body).toMatchObject({
      model: "llama3.1-8B",
      temperature: 0,
      messages: [{ role: "user" }],
    });
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages[0]?.content).toContain(toolRequest.tool_call);
  });

  it("uses the service binding when configured", async () => {
    const bindingFetch = vi
      .fn()
      .mockResolvedValue(jimmyResponse("VERDICT: PASS\nCONFIDENCE: 0.8"));
    const networkFetch = vi.fn();
    vi.stubGlobal("fetch", networkFetch);

    await expect(
      verifyToolResult(
        { ...env, JIMMY_SERVICE: { fetch: bindingFetch } as unknown as Fetcher },
        toolRequest,
      ),
    ).resolves.toMatchObject({ verdict: "pass", confidence: 0.8 });

    expect(bindingFetch).toHaveBeenCalledWith(
      "https://jimcf/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("builds a chat prompt before calling Jimmy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jimmyResponse("VERDICT: STEER\nCONFIDENCE: 0.67\nMESSAGE: Correct the environment."),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      verifyChatResponse(
        env,
        [{ role: "user", content: "Deploy to production." }],
        "Deployed to staging.",
      ),
    ).resolves.toEqual({
      verdict: "steer",
      confidence: 0.67,
      message: "[LexVerdict] Correct the environment.",
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0]?.content).toContain("Deploy to production.");
    expect(body.messages[0]?.content).toContain("Deployed to staging.");
  });

  it("rejects verifier network and upstream failures", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyToolResult(env, toolRequest)).rejects.toThrow();
    await expect(verifyToolResult(env, toolRequest)).rejects.toThrow();
  });

  it("times out a verifier fetch even when its promise does not settle", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      receivedSignal = init?.signal;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = verifyToolResult(env, toolRequest);
    const rejection = expect(pending).rejects.toBeInstanceOf(VerifierTimeoutError);
    await vi.advanceTimersByTimeAsync(JIMMY_TIMEOUT_MS);

    await rejection;
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("rejects invalid Jimmy JSON and empty completion choices", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("not JSON", { headers: { "Content-Type": "application/json" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [] }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        jimmyResponse("The deployment appears correct, but no structured verdict was returned."),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyToolResult(env, toolRequest)).rejects.toThrow();
    await expect(verifyToolResult(env, toolRequest)).rejects.toThrow();
    await expect(verifyToolResult(env, toolRequest)).rejects.toThrow();
  });

  it("retries once when the verifier returns a transient 5xx, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        jimmyResponse("VERDICT: PASS\nCONFIDENCE: 1.0\nMESSAGE: null"),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyToolResult(env, toolRequest)).resolves.toEqual({
      verdict: "pass",
      confidence: 1,
      message: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed after retry when the verifier stays down (5xx twice)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("temporarily unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyToolResult(env, toolRequest)).rejects.toThrow(
      "Jimmy verification failed (503)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
