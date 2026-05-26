import { describe, expect, it } from "vitest";
import type { ForgeSnapshot } from "./types";
import {
  buildExecutiveObservationSummary,
  chooseConservativeDispatchMax,
  createExecutiveReportSummary,
  deriveLoopStatusRecommendation
} from "./executive-manager";

describe("executive-manager planning helpers", () => {
  it("summarizes an empty start state as planning work", () => {
    const snapshot = snapshotWith({ operations: [], runs: [] });

    expect(buildExecutiveObservationSummary(snapshot)).toMatchObject({
      totalOperations: 0,
      activeRunCount: 0,
      blockerCount: 0,
      readyOperationIds: []
    });
    expect(deriveLoopStatusRecommendation(snapshot)).toBe("planning");
  });

  it("observes active runs and conservatively limits dispatch slots", () => {
    const snapshot = snapshotWith({
      operations: [operation("op-active", "running"), operation("op-ready", "ready")],
      runs: [run("run-active", "op-active", "running"), run("run-done", "op-active", "completed")]
    });

    expect(buildExecutiveObservationSummary(snapshot)).toMatchObject({
      activeRunCount: 1,
      activeRunIds: ["run-active"],
      readyOperationIds: ["op-ready"]
    });
    expect(deriveLoopStatusRecommendation(snapshot)).toBe("observing");
    expect(chooseConservativeDispatchMax({ runs: snapshot.runs, maxRuns: 3 })).toBe(2);
    expect(chooseConservativeDispatchMax({ runs: snapshot.runs, maxRuns: 1 })).toBe(0);
  });

  it("reports blocked operations when no active run can make progress", () => {
    const snapshot = snapshotWith({
      operations: [operation("op-blocked", "blocked", { title: "Blocked operation", blockedReason: "Need operator credentials." })],
      runs: []
    });

    expect(buildExecutiveObservationSummary(snapshot).blockers).toEqual([
      {
        operationId: "op-blocked",
        title: "Blocked operation",
        reason: "Need operator credentials."
      }
    ]);
    expect(deriveLoopStatusRecommendation(snapshot)).toBe("blocked");
  });

  it("marks completed critical operations as ready for test before all work is done", () => {
    const snapshot = snapshotWith({
      operations: [operation("op-critical", "completed", { priority: "critical" }), operation("op-followup", "ready")],
      runs: []
    });

    expect(buildExecutiveObservationSummary(snapshot)).toMatchObject({
      criticalOperationCount: 1,
      completedCriticalOperationCount: 1
    });
    expect(deriveLoopStatusRecommendation(snapshot)).toBe("ready_for_test");
  });

  it("marks all completed operations as completed", () => {
    const snapshot = snapshotWith({
      operations: [operation("op-critical", "completed", { priority: "critical" }), operation("op-normal", "completed")],
      runs: []
    });

    expect(deriveLoopStatusRecommendation(snapshot)).toBe("completed");
  });

  it("creates a user-facing report from runtime outputs and blockers", () => {
    const report = createExecutiveReportSummary({
      operations: [
        operation("op-runtime", "completed", { title: "Runtime contract" }),
        operation("op-qa", "blocked", { title: "QA validation", blockedReason: "Waiting for seeded data." })
      ],
      runs: [run("run-runtime", "op-runtime", "completed")],
      files: [file("file-contract", "docs/runtime-contract.md")],
      artifacts: [artifact("artifact-plan", "Execution plan")],
      blockers: [{ operationId: "op-qa", title: "QA validation", reason: "Waiting for seeded data." }]
    });

    expect(report.status).toBe("blocked");
    expect(report.text).toContain("Runtime contract");
    expect(report.text).toContain("QA validation: Waiting for seeded data.");
    expect(report.text).toContain("docs/runtime-contract.md");
    expect(report.text).toContain("Execution plan");
  });
});

function snapshotWith(input: {
  operations: ForgeSnapshot["operations"];
  runs: ForgeSnapshot["runs"];
  files?: ForgeSnapshot["files"];
  artifacts?: ForgeSnapshot["artifacts"];
  forgeStatus?: ForgeSnapshot["forge"]["status"];
}): ForgeSnapshot {
  return {
    forge: {
      id: "forge-test",
      slug: "test",
      name: "Test Forge",
      tagline: "Test",
      activePhase: "Build",
      status: input.forgeStatus ?? "active"
    },
    lastEventSequence: 0,
    schemaVersion: 1,
    divisions: [],
    workers: [],
    operations: input.operations,
    runs: input.runs,
    dependencies: [],
    artifacts: input.artifacts ?? [],
    files: input.files ?? [],
    handoffs: [],
    messages: [],
    proposals: [],
    executiveLoops: [],
    executiveCycles: [],
    executivePlans: [],
    executiveReports: [],
    events: []
  };
}

function operation(
  id: string,
  status: ForgeSnapshot["operations"][number]["status"],
  overrides: Partial<ForgeSnapshot["operations"][number]> = {}
): ForgeSnapshot["operations"][number] {
  return {
    id,
    divisionId: "division-test",
    title: titleFromId(id),
    description: id,
    status,
    priority: "normal",
    progress: status === "completed" ? 100 : 0,
    retryCount: 0,
    outputArtifactIds: [],
    routingStage: status === "planning" ? "executive_planned" : "worker_ready",
    webAccessPolicy: "none",
    ...overrides
  };
}

function run(id: string, operationId: string, status: ForgeSnapshot["runs"][number]["status"]): ForgeSnapshot["runs"][number] {
  return {
    id,
    forgeId: "forge-test",
    operationId,
    provider: "mock",
    status,
    capabilities: {
      streamsEvents: false,
      supportsCancel: false,
      supportsResume: false,
      supportsRetries: false,
      supportsWorkspaceRefs: false,
      supportsWebSearch: false
    },
    queuedAt: "2026-05-25T12:00:00.000Z",
    providerMetadata: {}
  };
}

function file(id: string, path: string): ForgeSnapshot["files"][number] {
  return {
    id,
    path,
    content: "content",
    status: "generated",
    version: 1,
    artifactIds: [],
    updatedAt: "2026-05-25T12:00:00.000Z"
  };
}

function artifact(id: string, title: string): ForgeSnapshot["artifacts"][number] {
  return {
    id,
    title,
    type: "plan",
    divisionId: "division-test",
    content: "content",
    status: "generated",
    version: 1,
    tags: [],
    fileIds: [],
    createdAt: "2026-05-25T12:00:00.000Z",
    updatedAt: "2026-05-25T12:00:00.000Z"
  };
}

function titleFromId(id: string) {
  return id
    .replace(/^op-/, "")
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
