import { describe, expect, it } from "vitest";
import { createDemoSnapshot } from "@/lib/mock/seed";
import type { ForgeSnapshot } from "./types";
import { getBlockingDependencyIds, resolveReadyOperations } from "./scheduler";

describe("scheduler", () => {
  it("models blocking dependencies with explicit edges", () => {
    const snapshot = createDemoSnapshot();

    expect(getBlockingDependencyIds(snapshot, "op-release")).toEqual(["op-qa"]);
  });

  it("does not mark operations ready when blocking dependencies are incomplete", () => {
    const snapshot = createDemoSnapshot();
    const ready = resolveReadyOperations(snapshot).map((operation) => operation.id);

    expect(ready).not.toContain("op-release");
    expect(ready).toContain("op-runtime");
  });

  it("returns only eligible ready operations for active forges without active operation or worker runs", () => {
    const snapshot = withSchedulerOperations({
      forgeStatus: "active",
      operations: [
        operation("op-ready", "worker-a", "ready"),
        operation("op-planning", "worker-b", "planning"),
        operation("op-blocked", "worker-c", "blocked"),
        operation("op-running", "worker-d", "running"),
        operation("op-active-run", "worker-e", "ready"),
        operation("op-active-worker", "worker-f", "ready"),
        operation("op-completed-run", "worker-g", "ready")
      ],
      runs: [
        run("run-active-operation", "op-active-run", "worker-e", "running"),
        run("run-active-worker", "op-other", "worker-f", "streaming"),
        run("run-completed", "op-completed-run", "worker-g", "completed")
      ]
    });

    expect(resolveReadyOperations(snapshot).map((operation) => operation.id)).toEqual(["op-completed-run", "op-ready"]);
  });

  it("returns no ready operations for paused or archived forges", () => {
    const paused = withSchedulerOperations({
      forgeStatus: "paused",
      operations: [operation("op-ready", "worker-a", "ready")]
    });
    const archived = withSchedulerOperations({
      forgeStatus: "archived",
      operations: [operation("op-ready", "worker-a", "ready")]
    });

    expect(resolveReadyOperations(paused)).toEqual([]);
    expect(resolveReadyOperations(archived)).toEqual([]);
  });

  it("does not schedule worker operations until lead triage marks them worker-ready", () => {
    const untriaged = operation("op-untriaged", "worker-a", "ready");
    const ready = operation("op-worker-ready", "worker-b", "ready");
    const lead = operation("op-lead", "lead-a", "ready");
    const snapshot = withSchedulerOperations({
      operations: [
        { ...untriaged, routingStage: "executive_planned" },
        { ...ready, routingStage: "worker_ready" },
        { ...lead, routingStage: "lead_triaged" }
      ]
    });

    expect(resolveReadyOperations(snapshot).map((candidate) => candidate.id)).toEqual(["op-lead", "op-worker-ready"]);
  });

  it("orders ready operations by priority, dependency depth, and operation id", () => {
    const operations = [
      operation("op-low", "worker-a", "ready", "low"),
      operation("op-normal", "worker-b", "ready", "normal"),
      operation("op-critical-deep", "worker-c", "ready", "critical"),
      operation("op-critical-shallow-b", "worker-d", "ready", "critical"),
      operation("op-critical-shallow-a", "worker-e", "ready", "critical"),
      operation("op-high", "worker-f", "ready", "high"),
      operation("op-root", "worker-g", "completed", "critical"),
      operation("op-mid", "worker-h", "completed", "critical")
    ];
    const snapshot = withSchedulerOperations({
      operations,
      dependencies: [
        dependency("dep-critical-shallow-b-root", "op-critical-shallow-b", "op-root"),
        dependency("dep-critical-shallow-a-root", "op-critical-shallow-a", "op-root"),
        dependency("dep-critical-deep-mid", "op-critical-deep", "op-mid"),
        dependency("dep-mid-root", "op-mid", "op-root")
      ]
    });

    expect(resolveReadyOperations(snapshot).map((operation) => operation.id)).toEqual([
      "op-critical-shallow-a",
      "op-critical-shallow-b",
      "op-critical-deep",
      "op-high",
      "op-normal",
      "op-low"
    ]);
  });

  it("holds QA and release work until completed dependencies have implementation files", () => {
    const qaOperation = {
      ...operation("op-qa", "worker-b", "ready"),
      divisionId: "qa",
      title: "Run QA validation",
      description: "Validate completed implementation output."
    };
    const snapshotWithoutOutputs = withSchedulerOperations({
      operations: [
        { ...operation("op-build", "worker-a", "completed"), title: "Build implementation" },
        qaOperation
      ],
      dependencies: [dependency("dep-qa-build", "op-qa", "op-build")]
    });
    const snapshotWithArtifactOnly = {
      ...snapshotWithoutOutputs,
      artifacts: [
        {
          ...createDemoSnapshot().artifacts[0],
          id: "artifact-build",
          operationId: "op-build"
        }
      ]
    };
    const snapshotWithFiles = {
      ...snapshotWithoutOutputs,
      files: [
        {
          ...createDemoSnapshot().files[0],
          id: "file-build-output",
          operationId: "op-build",
          path: "app/page.tsx"
        }
      ]
    };

    expect(resolveReadyOperations(snapshotWithoutOutputs).map((candidate) => candidate.id)).not.toContain("op-qa");
    expect(resolveReadyOperations(snapshotWithArtifactOnly).map((candidate) => candidate.id)).not.toContain("op-qa");
    expect(resolveReadyOperations(snapshotWithFiles).map((candidate) => candidate.id)).toContain("op-qa");
  });

  it("holds app implementation work until a project scaffold exists", () => {
    const uiOperation = {
      ...operation("op-ui", "worker-a", "ready"),
      title: "Build mobile-first menu browsing and filtering UI",
      description: "Implement the app page and reusable components for browsing menu data."
    };
    const scaffoldOperation = {
      ...operation("op-scaffold", "worker-a", "ready"),
      title: "Create project scaffold",
      description: "Create package.json, app shell, and component directories for the project."
    };
    const withoutScaffold = withSchedulerOperations({ operations: [uiOperation, scaffoldOperation] });
    const withScaffold = {
      ...withoutScaffold,
      files: [
        {
          ...createDemoSnapshot().files[0],
          id: "file-package-json",
          operationId: "op-scaffold",
          path: "package.json"
        },
        {
          ...createDemoSnapshot().files[0],
          id: "file-app-page",
          operationId: "op-scaffold",
          path: "app/page.tsx"
        }
      ]
    };

    expect(resolveReadyOperations(withoutScaffold).map((candidate) => candidate.id)).toEqual(["op-scaffold"]);
    expect(resolveReadyOperations(withScaffold).map((candidate) => candidate.id)).toContain("op-ui");
  });

  it("holds validation and release work until implementation files exist even without explicit dependencies", () => {
    const qaOperation = {
      ...operation("op-qa", "worker-b", "ready"),
      divisionId: "qa",
      title: "Validate project implementation",
      description: "Run QA validation against the built project."
    };
    const withoutImplementation = withSchedulerOperations({ operations: [qaOperation] });
    const withImplementation = {
      ...withoutImplementation,
      files: [
        {
          ...createDemoSnapshot().files[0],
          id: "file-implementation",
          operationId: "op-build",
          path: "app/page.tsx"
        }
      ],
      operations: [{ ...operation("op-build", "worker-a", "completed"), title: "Build project implementation" }, qaOperation]
    };

    expect(resolveReadyOperations(withoutImplementation).map((candidate) => candidate.id)).not.toContain("op-qa");
    expect(resolveReadyOperations(withImplementation).map((candidate) => candidate.id)).toContain("op-qa");
  });

  it("does not classify operations as validation work because a prefixed division id contains test", () => {
    const strategyOperation = {
      ...operation("test-op-strategy", "strategy-lead", "ready", "high"),
      divisionId: "test-strategy",
      title: "Choose the website concept and define success criteria",
      description: "Select the website concept, target audience, feature scope, acceptance criteria, and implementation decisions."
    };
    const snapshot = withSchedulerOperations({
      operations: [strategyOperation],
      workers: [
        {
          ...createDemoSnapshot().workers[0],
          id: "strategy-lead",
          divisionId: "test-strategy",
          kind: "lead"
        }
      ],
      divisions: [
        {
          ...createDemoSnapshot().divisions[0],
          id: "test-strategy",
          name: "Strategy Division"
        }
      ]
    });

    expect(resolveReadyOperations(snapshot).map((candidate) => candidate.id)).toEqual(["test-op-strategy"]);
  });
});

function withSchedulerOperations(input: {
  forgeStatus?: ForgeSnapshot["forge"]["status"];
  operations: ForgeSnapshot["operations"];
  dependencies?: ForgeSnapshot["dependencies"];
  runs?: ForgeSnapshot["runs"];
  workers?: ForgeSnapshot["workers"];
  divisions?: ForgeSnapshot["divisions"];
}): ForgeSnapshot {
  const snapshot = createDemoSnapshot();
  return {
    ...snapshot,
    forge: { ...snapshot.forge, status: input.forgeStatus ?? "active" },
    operations: input.operations,
    dependencies: input.dependencies ?? [],
    runs: input.runs ?? [],
    workers: input.workers ?? [
      { ...snapshot.workers[0], id: "lead-a", divisionId: "division-a", kind: "lead" },
      { ...snapshot.workers[0], id: "worker-a", divisionId: "division-a", kind: "worker", managerWorkerId: "lead-a" },
      { ...snapshot.workers[0], id: "worker-b", divisionId: "qa", kind: "worker", managerWorkerId: "lead-a" }
    ],
    divisions: input.divisions ?? [
      { ...snapshot.divisions[0], id: "division-a", name: "Engineering Division" },
      { ...snapshot.divisions[0], id: "qa", name: "QA Division" }
    ]
  };
}

function operation(
  id: string,
  workerId: string,
  status: ForgeSnapshot["operations"][number]["status"],
  priority: ForgeSnapshot["operations"][number]["priority"] = "normal"
): ForgeSnapshot["operations"][number] {
  return {
    id,
    divisionId: "division-a",
    workerId,
    title: id,
    description: id,
    status,
    priority,
    progress: status === "completed" ? 100 : 0,
    retryCount: 0,
    outputArtifactIds: [],
    routingStage: "worker_ready",
    webAccessPolicy: "none"
  };
}

function dependency(id: string, operationId: string, dependsOnOperationId: string): ForgeSnapshot["dependencies"][number] {
  return {
    id,
    operationId,
    dependsOnOperationId,
    type: "blocks"
  };
}

function run(
  id: string,
  operationId: string,
  workerId: string,
  status: ForgeSnapshot["runs"][number]["status"]
): ForgeSnapshot["runs"][number] {
  return {
    id,
    forgeId: "demo-forge",
    operationId,
    workerId,
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
    queuedAt: "2026-05-17T20:00:00.000Z",
    providerMetadata: {}
  };
}
