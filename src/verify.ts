export type Verdict = "pass" | "steer";

export interface VerdictResult {
  verdict: Verdict;
  confidence: number;
  message: string | null;
}

export interface VerifyRequest {
  tool_call: string;
  goal: string;
  result: string;
}

export interface Env {
  JIMMY_URL: string;
  JIMMY_SERVICE?: Fetcher;
}

const JIMMY_MODEL = "llama3.1-8B";

export function buildChatVerificationPrompt(
  requestMessages: Array<{ role: string; content: string }>,
  responseContent: string,
): string {
  const formatted = requestMessages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
  return `You verify tool results. Restate, check systematically, then decide.

Goal: ${formatted}
Result: ${responseContent}

=== Step 1: Restate ===
What the goal actually requires:
What the result actually says:

=== Step 2: Systematic Checks ===
Check each. If ANY fails, verdict is STEER.

[ ] MATCH: Does the result directly satisfy the goal?
[ ] ENV: Wrong environment? (dev/staging vs production)
[ ] DATA: Wrong content? (wrong values, file, target, credentials)
[ ] SECURITY: Weak password, secrets exposed, excessive permissions, unsafe ops
[ ] FAILURE: Command failed, file not found, build broke, 0 tests ran
[ ] DRIFT: Result contradicts the goal or goes in wrong direction

=== Step 3: Verdict ===
VERDICT: PASS (all checks pass) or STEER (any check failed)
CONFIDENCE: 0.0-1.0
MESSAGE: If STEER, list which checks failed and how to fix`;
}

export function buildToolVerificationPrompt(req: VerifyRequest): string {
  return `You verify tool results. Restate, check systematically, then decide.

Goal: ${req.goal}
Result: ${req.result}

=== Step 1: Restate ===
What the goal actually requires:
What the result actually says:

=== Step 2: Systematic Checks ===
Check each. If ANY fails, verdict is STEER.

[ ] MATCH: Does the result directly satisfy the goal?
[ ] ENV: Wrong environment? (dev/staging vs production)
[ ] DATA: Wrong content? (wrong values, file, target, credentials)
[ ] SECURITY: Weak password, secrets exposed, excessive permissions, unsafe ops
[ ] FAILURE: Command failed, file not found, build broke, 0 tests ran
[ ] DRIFT: Result contradicts the goal or goes in wrong direction

=== Step 3: Verdict ===
VERDICT: PASS (all checks pass) or STEER (any check failed)
CONFIDENCE: 0.0-1.0
MESSAGE: If STEER, list which checks failed and how to fix`;
}

export function parseVerdict(text: string): VerdictResult {
  const verdictMatch = text.match(/VERDICT:\s*(PASS|STEER)/i);
  const confidenceMatch = text.match(/CONFIDENCE:\s*([\d.]+)/i);
  const messageMatch = text.match(/MESSAGE:\s*(.+)/is);

  const rawVerdict = verdictMatch?.[1]?.toUpperCase() ?? "PASS";
  const verdict: Verdict = rawVerdict === "STEER" ? "steer" : "pass";

  let confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5;
  if (!Number.isFinite(confidence)) {
    confidence = 0.5;
  }
  confidence = Math.min(1, Math.max(0, confidence));

  let message: string | null = null;
  if (verdict === "steer" && messageMatch?.[1]) {
    message = messageMatch[1].trim();
    if (!message.startsWith("[LexVerdict]")) {
      message = `[LexVerdict] ${message}`;
    }
  }

  return { verdict, confidence, message };
}

const JIMMY_TIMEOUT_MS = 15_000;

async function callJimmy(jimmyUrl: string, prompt: string, serviceBinding?: Fetcher): Promise<string> {
  const body = JSON.stringify({
    model: JIMMY_MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 150,
    temperature: 0,
  });

  let response: Response;

  if (serviceBinding) {
    response = await serviceBinding.fetch("https://jimcf/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(JIMMY_TIMEOUT_MS),
    });
  } else {
    response = await fetch(jimmyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(JIMMY_TIMEOUT_MS),
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Jimmy verification failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Jimmy returned an empty verification response");
  }

  return content;
}

export async function verifyChatResponse(
  env: Env,
  requestMessages: Array<{ role: string; content: string }>,
  responseContent: string,
): Promise<VerdictResult> {
  const prompt = buildChatVerificationPrompt(requestMessages, responseContent);
  const jimmyText = await callJimmy(env.JIMMY_URL, prompt, env.JIMMY_SERVICE);
  return parseVerdict(jimmyText);
}

export async function verifyToolResult(
  env: Env,
  req: VerifyRequest,
): Promise<VerdictResult> {
  const prompt = buildToolVerificationPrompt(req);
  const jimmyText = await callJimmy(env.JIMMY_URL, prompt, env.JIMMY_SERVICE);
  return parseVerdict(jimmyText);
}
