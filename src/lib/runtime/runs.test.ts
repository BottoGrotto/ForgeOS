import { describe, expect, it } from "vitest";
import { getActiveRunForOperation, getLatestRunForOperation, getRunEvents, getRunDurationLabel, getRunTraceSummaryRows } from "./runs";
import type { AgentRun, AgentRunStatus, RuntimeEvent } from "./types";

describe("run lifecycle helpers", () => {
  it("returns the newest run for an operation", () => {
    const older = run({ id: "run-older", operationId: "op-runtime", queuedAt: "2026-05-21T10:00:00.000Z" });
    const newer = run({ id: "run-newer", operationId: "op-runtime", queuedAt: "2026-05-21T10:05:00.000Z" });

    expect(getLatestRunForOperation([older, newer], "op-runtime")?.id).toBe("run-newer");
  });

  it("finds active runs only for active lifecycle statuses", () => {
    const completed = run({ id: "run-completed", operationId: "op-runtime", status: "completed" });
    const running = run({ id: "run-running", operationId: "op-runtime", status: "running" });

    expect(getActiveRunForOperation([completed, running], "op-runtime")?.id).toBe("run-running");
    expect(getActiveRunForOperation([completed], "op-runtime")).toBeUndefined();
  });

  it("treats queued, starting, running, streaming, and resumed as active statuses", () => {
    const statuses: AgentRunStatus[] = ["queued", "starting", "running", "streaming", "resumed", "completed", "failed", "canceled"];
    const active = statuses
      .map((status) => run({ id: `run-${status}`, operationId: `op-${status}`, status }))
      .filter((candidate) => getActiveRunForOperation([candidate], candidate.operationId))
      .map((candidate) => candidate.status);

    expect(active).toEqual(["queued", "starting", "running", "streaming", "resumed"]);
  });

  it("builds a concise duration label", () => {
    expect(getRunDurationLabel(run({
      id: "run-duration",
      operationId: "op-runtime",
      startedAt: "2026-05-21T10:00:00.000Z",
      completedAt: "2026-05-21T10:01:35.000Z"
    }))).toBe("1m 35s");
  });

  it("filters run events by direct target or payload runId", () => {
    const events = [
      event({ id: "event-run", sequence: 1, type: "run.started", targetType: "run", targetId: "run-1", payload: {} }),
      event({ id: "event-operation", sequence: 2, type: "operation.completed", targetType: "operation", targetId: "op-runtime", payload: { runId: "run-1" } }),
      event({ id: "event-other", sequence: 3, type: "run.started", targetType: "run", targetId: "run-2", payload: {} })
    ];

    expect(getRunEvents(events, "run-1").map((item) => item.id)).toEqual(["event-run", "event-operation"]);
  });

  it("formats sanitized run trace summary rows", () => {
    const rows = getRunTraceSummaryRows(
      run({
        id: "run-trace",
        operationId: "op-runtime",
        providerMetadata: {
          traceSummary: {
            context: {
              estimatedTokens: 1200,
              budgetTokens: 24000,
              sections: [
                { section: "files", allocatedTokens: 1000, usedTokens: 800, selectedItems: 3, omittedItems: 1, truncatedItems: 1 }
              ],
              omittedReasons: ["file omitted"]
            },
            outputs: {
              artifactCount: 1,
              fileCount: 2,
              handoffCount: 1,
              blockerCount: 0,
              verificationEvidence: {
                commands: ["npm test"],
                expectedScripts: ["test"],
                knownGaps: []
              },
              omittedCount: 3,
              omissionReasons: ["raw payload omitted"]
            },
            lifecycle: {
              provider: "mock",
              status: "completed"
            }
          }
        }
      })
    );

    expect(rows).toEqual(
      expect.arrayContaining([
        { label: "Context", value: "1200/24000 tokens" },
        { label: "Outputs", value: "1 artifacts / 2 files" },
        { label: "Team Effects", value: "1 handoffs / 0 blockers" },
        { label: "Worker Evidence", value: "1 commands / 1 scripts" },
        { label: "Validation Omits", value: "3 omitted" },
        { label: "Lifecycle", value: "mock completed" }
      ])
    );
  });
});

function run(input: Partial<AgentRun> & { id: string; operationId: string }): AgentRun {
  return {
    forgeId: "forge-1",
    workerId: "worker-1",
    provider: "mock",
    status: "queued",
    capabilities: {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    },
    queuedAt: "2026-05-21T10:00:00.000Z",
    providerMetadata: {},
    ...input
  };
}

function event(input: Partial<RuntimeEvent> & { id: string; sequence: number; type: RuntimeEvent["type"] }): RuntimeEvent {
  return {
    forgeId: "forge-1",
    actorType: "runtime",
    message: "event",
    severity: "info",
    payload: {},
    createdAt: "2026-05-21T10:00:00.000Z",
    ...input
  };
}
