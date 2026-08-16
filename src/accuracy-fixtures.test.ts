import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildToolVerificationPrompt } from "./verify";

interface AccuracyFixture {
  name: string;
  toolCall: string;
  goal: string;
  result: string;
  expected: "pass" | "steer";
}

function readFixtureField(line: string, field: string): string {
  const fieldMatch = new RegExp(`"${field}":\\s*`).exec(line);
  if (!fieldMatch || fieldMatch.index === undefined) {
    throw new Error(`Could not read ${field} from accuracy fixture`);
  }

  const valueStart = fieldMatch.index + fieldMatch[0].length;
  const quote = line[valueStart];
  if (quote !== '"' && quote !== "'") {
    throw new Error(`Could not read ${field} from accuracy fixture`);
  }

  let consecutiveBackslashes = 0;
  for (let index = valueStart + 1; index < line.length; index += 1) {
    const character = line[index];
    if (character === quote && consecutiveBackslashes % 2 === 0) {
      const value = line.slice(valueStart + 1, index);
      return quote === '"'
        ? (JSON.parse(`"${value}"`) as string)
        : value.replaceAll("\\n", "\n").replaceAll("\\'", "'");
    }
    consecutiveBackslashes = character === "\\" ? consecutiveBackslashes + 1 : 0;
  }

  throw new Error(`Could not read ${field} from accuracy fixture`);
}

function loadAccuracyFixtures(source: string): AccuracyFixture[] {
  return source
    .split("\n")
    .filter((line) => line.trimStart().startsWith('{"n":'))
    .map((line) => ({
      name: readFixtureField(line, "n"),
      toolCall: readFixtureField(line, "tc"),
      goal: readFixtureField(line, "g"),
      result: readFixtureField(line, "r"),
      expected: readFixtureField(line, "e") as AccuracyFixture["expected"],
    }));
}

const canonicalAccuracySource = readFileSync(
  new URL("../test/accuracy_test.py", import.meta.url),
  "utf8",
);
const rootAccuracySource = readFileSync(new URL("../accuracy_test.py", import.meta.url), "utf8");
const fixtures = loadAccuracyFixtures(canonicalAccuracySource);

describe("Python accuracy fixture parity", () => {
  it("keeps the root and test copies of the Python accuracy suite identical", () => {
    expect(rootAccuracySource).toBe(canonicalAccuracySource);
  });

  it("preserves the 60-case pass and steer corpus", () => {
    const summary = {
      total: fixtures.length,
      expected: {
        pass: fixtures.filter((fixture) => fixture.expected === "pass").length,
        steer: fixtures.filter((fixture) => fixture.expected === "steer").length,
      },
      anchors: [fixtures[0], fixtures[20], fixtures[36], fixtures.at(-1)].map((fixture) => ({
        name: fixture?.name,
        expected: fixture?.expected,
      })),
    };

    expect(summary).toMatchInlineSnapshot(`
      {
        "anchors": [
          {
            "expected": "pass",
            "name": "k8s deploy prod",
          },
          {
            "expected": "steer",
            "name": "migrate staging not prod",
          },
          {
            "expected": "steer",
            "name": "secrets in git",
          },
          {
            "expected": "steer",
            "name": "wrong port",
          },
        ],
        "expected": {
          "pass": 20,
          "steer": 40,
        },
        "total": 60,
      }
    `);
  });

  it("feeds every Python fixture field into the TypeScript verifier prompt", () => {
    expect(fixtures).toHaveLength(60);

    for (const fixture of fixtures) {
      const prompt = buildToolVerificationPrompt({
        tool_call: fixture.toolCall,
        goal: fixture.goal,
        result: fixture.result,
      });

      expect(prompt, fixture.name).toContain(fixture.toolCall);
      expect(prompt, fixture.name).toContain(fixture.goal);
      expect(prompt, fixture.name).toContain(fixture.result);
    }
  });
});
