import { describe, expect, it } from "vitest";

import { resolveTurnExecutionContract, deriveActiveTaskContext } from "./turn-execution-contract.js";
import type { GatewayMessage } from "../gateway/message.js";
import type { ActiveTaskContext } from "./turn-execution-contract-types.js";

function createMessage(content: string): GatewayMessage {
  return {
    id: "msg-1",
    channel: "test",
    senderId: "user-1",
    senderName: "Test User",
    sessionId: "session-1",
    content,
    timestamp: Date.now(),
    scope: "dm",
  };
}

describe("turn-execution-contract", () => {
  // Three pre-plan-shortcut tests that previously lived here ("routes
  // explicit single-artifact repair requests to the artifact-update
  // contract", "gives implement-from-artifact requests workspace-wide
  // mutable ownership by default", "derives carryover only for
  // artifact-update and workflow-implementation contracts") were removed
  // on 2026-04-06 alongside the regex pre-call classifier. They asserted
  // that `resolveTurnExecutionContract` could detect plan-artifact intent
  // from the user message text alone (via `classifyPlannerPlanArtifactIntent`)
  // and emit a fully-built artifact-update or workflow-implementation
  // contract before the model had been called. The model now decides intent
  // and emits `plan_intent` on the parsed PlannerPlan; pre-plan contract
  // assembly defaults to dialogue/none and the contract is refined
  // post-plan. End-to-end coverage for the new model-driven path belongs
  // in a planner-pipeline integration test against a recorded model
  // response. The activeTaskContext-based continuation test below is still
  // valid because it does not depend on text classification.

  it("routes implementation continuations to workflow implementation before tool execution", () => {
    const activeTaskContext: ActiveTaskContext = {
      version: 1,
      taskLineageId: "task-phase-0",
      contractFingerprint: "previous-phase-contract",
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      workspaceRoot: "/workspace",
      sourceArtifacts: ["/workspace/PLAN.md"],
      targetArtifacts: ["/workspace/src/main.c"],
      displayArtifact: "PLAN.md",
    };

    const contract = resolveTurnExecutionContract({
      message: createMessage("Implement phase 0"),
      runtimeContext: {
        workspaceRoot: "/workspace",
        activeTaskContext,
      },
    });

    expect(contract.turnClass).toBe("workflow_implementation");
    expect(contract.ownerMode).toBe("workflow_owner");
    expect(contract.sourceArtifacts).toEqual(["/workspace/PLAN.md"]);
    expect(contract.targetArtifacts).toEqual(["/workspace/src/main.c"]);
    expect(contract.invalidReason).toBeUndefined();
  });

});
