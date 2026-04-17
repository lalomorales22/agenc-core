import { describe, expect, it } from "vitest";
import type { ChatExecutorResult } from "../llm/chat-executor.js";
import {
  applyZeroToolCompletionGuard,
  buildFallbackContract,
  parseContract,
} from "./background-run-supervisor-helpers.js";
import type {
  ActiveBackgroundRun,
  BackgroundRunDecision,
} from "./background-run-supervisor-types.js";

function makeActorResult(
  overrides: Partial<ChatExecutorResult> = {},
): ChatExecutorResult {
  return {
    content: "",
    provider: "grok",
    model: "grok-test",
    usedFallback: false,
    toolCalls: [],
    tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    callUsage: [],
    durationMs: 10,
    compacted: false,
    stopReason: "completed",
    completionState: "completed",
    ...overrides,
  };
}

function makeRun(overrides: Partial<ActiveBackgroundRun> = {}): ActiveBackgroundRun {
  return {
    lastToolEvidence: undefined,
    ...overrides,
  } as unknown as ActiveBackgroundRun;
}

describe("applyZeroToolCompletionGuard", () => {
  const baseDecision: BackgroundRunDecision = {
    state: "completed",
    userUpdate: "done",
    internalSummary: "done",
    shouldNotifyUser: true,
  };

  it("passes through decisions that are not 'completed'", () => {
    const run = makeRun({ lastToolEvidence: "evidence" });
    const workingDecision: BackgroundRunDecision = {
      ...baseDecision,
      state: "working",
    };
    const out = applyZeroToolCompletionGuard(run, makeActorResult(), workingDecision);
    expect(out).toBe(workingDecision);
  });

  it("passes through when the cycle has successful tool calls", () => {
    const run = makeRun({ lastToolEvidence: "evidence" });
    const result = makeActorResult({
      toolCalls: [
        {
          callId: "call-1",
          name: "system.bash",
          arguments: "{}",
          result: "ok",
          isError: false,
        },
      ],
    });
    const out = applyZeroToolCompletionGuard(run, result, baseDecision);
    expect(out).toBe(baseDecision);
  });

  it("passes through when there is no prior tool evidence (groundDecision owns the never-started path)", () => {
    const run = makeRun({ lastToolEvidence: undefined });
    const out = applyZeroToolCompletionGuard(run, makeActorResult(), baseDecision);
    expect(out).toBe(baseDecision);
  });

  it("downgrades 'completed' to 'working' when the zero-tool cycle has prior evidence and no explicit completion signal", () => {
    const run = makeRun({ lastToolEvidence: "evidence" });
    const out = applyZeroToolCompletionGuard(
      run,
      makeActorResult({ content: "M1 progress: still compiling" }),
      baseDecision,
    );
    expect(out.state).toBe("working");
    expect(out.internalSummary).toContain("Downgraded premature completion");
    expect(out.userUpdate).toContain("M1 progress");
  });

  it("accepts 'completed' when completionProgress explicitly says completed with no remaining requirements", () => {
    const run = makeRun({ lastToolEvidence: "evidence" });
    const out = applyZeroToolCompletionGuard(
      run,
      makeActorResult({
        completionProgress: {
          completionState: "completed",
          stopReason: "completed",
          requiredRequirements: ["verifier_pass"],
          satisfiedRequirements: ["verifier_pass"],
          remainingRequirements: [],
          reusableEvidence: [],
          updatedAt: 10,
        },
      }),
      baseDecision,
    );
    expect(out).toBe(baseDecision);
  });

  it("downgrades when completionProgress claims completed but remaining requirements exist", () => {
    const run = makeRun({ lastToolEvidence: "evidence" });
    const out = applyZeroToolCompletionGuard(
      run,
      makeActorResult({
        completionProgress: {
          completionState: "completed",
          stopReason: "completed",
          requiredRequirements: ["a", "b"],
          satisfiedRequirements: ["a"],
          remainingRequirements: ["b"],
          reusableEvidence: [],
          updatedAt: 10,
        },
      }),
      baseDecision,
    );
    expect(out.state).toBe("working");
  });
});

describe("exhaustive-intent override for requiresUserStop", () => {
  const plannedContractJson = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      domain: "workspace",
      kind: "finite",
      successCriteria: ["make progress"],
      completionCriteria: ["objective satisfied"],
      blockedCriteria: ["missing inputs"],
      nextCheckMs: 5_000,
      heartbeatMs: 10_000,
      requiresUserStop: false,
      ...overrides,
    });

  it("parseContract: forces requiresUserStop=true when objective contains 'in full'", () => {
    const contract = parseContract(
      plannedContractJson(),
      "Implement all of PLAN.md in full.",
    );
    expect(contract?.requiresUserStop).toBe(true);
  });

  it("parseContract: forces requiresUserStop=true for 'before you stop'", () => {
    const contract = parseContract(
      plannedContractJson(),
      "Finish the refactor before you stop.",
    );
    expect(contract?.requiresUserStop).toBe(true);
  });

  it("parseContract: forces requiresUserStop=true for 'do not move on'", () => {
    const contract = parseContract(
      plannedContractJson(),
      "Do not move on until the tests pass.",
    );
    expect(contract?.requiresUserStop).toBe(true);
  });

  it("parseContract: leaves requiresUserStop=false for plain objectives", () => {
    const contract = parseContract(
      plannedContractJson(),
      "Update the README.",
    );
    expect(contract?.requiresUserStop).toBe(false);
  });

  it("parseContract: preserves planner-set requiresUserStop=true even without the regex match", () => {
    const contract = parseContract(
      plannedContractJson({ requiresUserStop: true }),
      "Update the README.",
    );
    expect(contract?.requiresUserStop).toBe(true);
  });

  it("buildFallbackContract: forces requiresUserStop=true for exhaustive-intent objectives", () => {
    const contract = buildFallbackContract(
      "Implement all of the plan in full and do not stop.",
    );
    expect(contract.requiresUserStop).toBe(true);
  });

  it("buildFallbackContract: leaves requiresUserStop=false for plain objectives", () => {
    const contract = buildFallbackContract("Run npm test");
    expect(contract.requiresUserStop).toBe(false);
  });
});
