import { describe, expect, it } from "vitest";
import { createForgeSnapshot } from "@/lib/mock/seed";
import type { AgentRun, ForgeSnapshot, RuntimeEvent } from "@/lib/runtime/types";
import { buildAssetGroups, deriveActiveAgentCards, deriveLauncherPanelState, deriveOperatorQuestionState, filterAssetsForSearch, getPendingDangerousReviewEvents } from "./forge-pages";

describe("LaunchProjectPanel state", () => {
  it("reports disabled launcher affordances when package.json is missing", () => {
    const state = deriveLauncherPanelState(createForgeSnapshot({ id: "ui-forge", slug: "ui-forge", name: "UI Forge" }));

    expect(state.hasPackageJson).toBe(false);
    expect(state.developmentScripts).toEqual([]);
    expect(state.acceptanceScripts).toEqual([]);
    expect(state.previewScripts).toEqual([]);
    expect(state.statusLabel).toBe("Local runtime");
  });

  it("detects scripts and derives preview URL plus sanitized log history", () => {
    const snapshot = withPackageAndEvents(
      JSON.stringify({
        scripts: {
          test: "vitest",
          build: "next build",
          dev: "next dev"
        }
      }),
      [
        event(1, "launcher.check_completed", { launcherId: "check-one", status: "passed" }),
        event(2, "launcher.preview_ready", { launcherId: "preview-one", url: "http://127.0.0.1:4111" }),
        event(3, "launcher.log", { launcherId: "preview-one", output: "ok [redacted]" })
      ]
    );

    const state = deriveLauncherPanelState(snapshot);

    expect(state.hasPackageJson).toBe(true);
    expect(state.developmentScripts).toEqual(["test", "build"]);
    expect(state.acceptanceScripts).toEqual(["test", "build"]);
    expect(state.previewScripts).toEqual(["dev"]);
    expect(state.latestCheckLabel).toBe("passed");
    expect(state.previewUrl).toBe("http://127.0.0.1:4111");
    expect(state.activePreviewLauncherId).toBe("preview-one");
    expect(state.logTail).toBe("ok [redacted]");
  });

  it("clears the active preview after a persisted stop event", () => {
    const snapshot = withPackageAndEvents(
      JSON.stringify({ scripts: { dev: "next dev" } }),
      [
        event(1, "launcher.preview_ready", { launcherId: "preview-one", url: "http://127.0.0.1:4111" }),
        event(2, "launcher.preview_stopped", { launcherId: "preview-one", stopReason: "operator_requested" })
      ]
    );

    const state = deriveLauncherPanelState(snapshot);

    expect(state.previewUrl).toBeUndefined();
    expect(state.activePreviewLauncherId).toBeUndefined();
  });
});

describe("deriveActiveAgentCards", () => {
  it("returns compact active-agent cards with latest heartbeat activity", () => {
    const snapshot = createForgeSnapshot({ id: "ui-forge", slug: "ui-forge", name: "UI Forge" });
    const activeRun = run({ id: "run-dashboard", operationId: "op-dashboard", workerId: "frontend-worker", status: "streaming" });
    activeRun.providerMetadata = {
      traceSummary: {
        checkpoint: {
          checkpointNumber: 1,
          activeDurationMs: 125000,
          summary: "Build Forge Command Center has been active for 2m 5s.",
          latestActivity: "Checkpoint says the UI shell is being finalized.",
          nextAction: "Continue Build Forge Command Center and emit bounded outputs.",
          risk: "No new runtime risk detected.",
          sourceEventSequenceStart: 6,
          sourceEventSequenceEnd: 7,
          createdAt: new Date(0).toISOString()
        }
      }
    };
    const queuedRun = run({ id: "run-release", operationId: "op-release", workerId: "release-director", status: "queued" });
    const completedRun = run({ id: "run-runtime", operationId: "op-runtime", workerId: "backend-worker", status: "completed" });
    const activeSnapshot: ForgeSnapshot = {
      ...snapshot,
      runs: [completedRun, activeRun, queuedRun],
      events: [
        ...snapshot.events,
        event(6, "run.progress", { runId: activeRun.id, operationId: activeRun.operationId, latestProgressMessage: "Rendering compact agent cards.", activeDurationMs: 91000, modelTier: "fast" }),
        event(7, "run.progress", { runId: activeRun.id, operationId: activeRun.operationId, latestProgressMessage: "Polishing active state.", activeDurationMs: 121000, model: "gpt-test" })
      ]
    };

    expect(deriveActiveAgentCards(activeSnapshot)).toEqual([
      expect.objectContaining({
        id: "run-dashboard",
        workerName: "Frontend Worker",
        operationTitle: "Build Forge Command Center",
        activity: "Checkpoint says the UI shell is being finalized.",
        durationLabel: "2m 1s",
        model: "gpt-test"
      }),
      expect.objectContaining({
        id: "run-release",
        workerName: "Release Director",
        operationTitle: "Prepare release pass",
        activity: "Waiting for QA pass",
        durationLabel: "Queued"
      })
    ]);
  });

  it("falls back safely when active runs have missing worker or operation references", () => {
    const snapshot = createForgeSnapshot({ id: "ui-forge", slug: "ui-forge", name: "UI Forge" });
    const activeRun = run({ id: "run-orphan", operationId: "missing-op", workerId: undefined, status: "running" });

    expect(deriveActiveAgentCards({ ...snapshot, runs: [activeRun] })).toEqual([
      expect.objectContaining({
        id: "run-orphan",
        workerName: "Unassigned agent",
        operationTitle: "missing-op",
        activity: "Operation is active.",
        durationLabel: "In progress"
      })
    ]);
  });
});

describe("deriveOperatorQuestionState", () => {
  it("derives pending and answered Executive questions from persisted events", () => {
    const snapshot = {
      ...createForgeSnapshot({ id: "ui-forge", slug: "ui-forge", name: "UI Forge" }),
      events: [
        event(1, "executive.user_input_requested", {
          questionId: "question-one",
          loopId: "loop-one",
          reason: "Audience changes scope.",
          question: "Who is this project for?",
          options: [{ id: "founders", label: "Startup founders" }],
          allowNotes: true
        }),
        event(2, "executive.user_input_requested", {
          questionId: "question-two",
          loopId: "loop-one",
          reason: "Visual style changes implementation.",
          question: "Which style should the UI use?",
          options: [{ id: "calm", label: "Calm workspace" }],
          allowNotes: true
        }),
        event(3, "executive.user_input_answered", {
          questionId: "question-one",
          selectedOptionIds: ["founders"],
          selectedLabels: ["Startup founders"],
          notes: "Keep it practical."
        })
      ]
    };

    const state = deriveOperatorQuestionState(snapshot);

    expect(state.pending).toEqual([
      expect.objectContaining({
        id: "question-two",
        question: "Which style should the UI use?",
        options: [{ id: "calm", label: "Calm workspace" }]
      })
    ]);
    expect(state.answered).toEqual([
      expect.objectContaining({
        id: "question-one",
        selectedLabels: ["Startup founders"],
        notes: "Keep it practical."
      })
    ]);
  });

  it("deduplicates equivalent pending Executive questions", () => {
    const snapshot = {
      ...createForgeSnapshot({ id: "ui-forge", slug: "ui-forge", name: "UI Forge" }),
      events: [
        event(1, "executive.user_input_requested", {
          questionId: "question-one",
          loopId: "loop-one",
          reason: "Audience changes scope.",
          question: "Who is this project for?",
          options: [{ id: "founders", label: "Startup founders" }],
          allowNotes: true
        }),
        event(2, "executive.user_input_requested", {
          questionId: "question-two",
          loopId: "loop-one",
          reason: "Audience changes scope.",
          question: "Who is this project for?",
          options: [{ id: "founders", label: "Startup founders" }],
          allowNotes: true
        })
      ]
    };

    const state = deriveOperatorQuestionState(snapshot);

    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({ id: "question-two", question: "Who is this project for?" });
  });
});

describe("getPendingDangerousReviewEvents", () => {
  it("only returns actionable unresolved review requests with review ids", () => {
    const snapshot = {
      ...createForgeSnapshot({ id: "ui-forge", slug: "ui-forge", name: "UI Forge" }),
      events: [
        event(1, "executive.review_requested", { operationId: "op-runtime", category: "missing_context" }),
        event(2, "executive.review_requested", { reviewId: "review-open", operationId: "op-runtime", category: "missing_context" }),
        event(3, "executive.review_requested", { reviewId: "review-closed", operationId: "op-tests", category: "dangerous_action" }),
        event(4, "executive.review_approved", { reviewId: "review-closed" })
      ]
    };

    expect(getPendingDangerousReviewEvents(snapshot).map((candidate) => candidate.payload.reviewId)).toEqual(["review-open"]);
  });
});

describe("AssetsPage helpers", () => {
  it("searches assets across artifact, feature, division, worker, and tag metadata", () => {
    const snapshot = createForgeSnapshot({ id: "ui-forge", slug: "ui-forge", name: "UI Forge" });

    expect(filterAssetsForSearch(snapshot.artifacts, snapshot, "append-only")).toEqual([
      expect.objectContaining({ title: "Runtime Architecture Proposal" })
    ]);
    expect(filterAssetsForSearch(snapshot.artifacts, snapshot, "story strategist")).toEqual([
      expect.objectContaining({ title: "Presentation Outline" })
    ]);
    expect(filterAssetsForSearch(snapshot.artifacts, snapshot, "not-present")).toEqual([]);
  });

  it("groups assets by owning feature with stable labels and tag fallback", () => {
    const snapshot = createForgeSnapshot({ id: "ui-forge", slug: "ui-forge", name: "UI Forge" });
    const orphanArtifact: ForgeSnapshot["artifacts"][number] = {
      ...snapshot.artifacts[0],
      id: "orphan-artifact",
      operationId: "missing-operation",
      tags: ["research"],
      title: "Research Brief"
    };
    const groups = buildAssetGroups([...snapshot.artifacts, orphanArtifact], snapshot, "feature");

    expect(groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Draft demo narrative", artifacts: [expect.objectContaining({ title: "Presentation Outline" })] }),
      expect.objectContaining({ label: "Finalize Forge strategy", artifacts: [expect.objectContaining({ title: "ForgeOS Project Plan" })] }),
      expect.objectContaining({ label: "Implement runtime contracts", artifacts: [expect.objectContaining({ title: "Runtime Architecture Proposal" })] }),
      expect.objectContaining({ label: "Run organizational review", artifacts: [expect.objectContaining({ title: "QA Risk Register" })] }),
      expect.objectContaining({ label: "#research", artifacts: [expect.objectContaining({ title: "Research Brief" })] })
    ]));
  });
});

function withPackageAndEvents(packageContent: string, events: RuntimeEvent[]): ForgeSnapshot {
  const snapshot = createForgeSnapshot({ id: "ui-forge", slug: "ui-forge", name: "UI Forge" });
  return {
    ...snapshot,
    files: [
      {
        id: "package",
        path: "package.json",
        content: packageContent,
        status: "generated",
        version: 1,
        artifactIds: [],
        updatedAt: new Date(0).toISOString()
      }
    ],
    events,
    lastEventSequence: events.at(-1)?.sequence ?? 0
  };
}

function event(sequence: number, type: RuntimeEvent["type"], payload: Record<string, unknown>): RuntimeEvent {
  return {
    id: `event-${sequence}`,
    forgeId: "ui-forge",
    sequence,
    type,
    actorType: "runtime",
    targetType: "forge",
    targetId: "ui-forge",
    message: type,
    severity: "info",
    payload,
    createdAt: new Date(sequence).toISOString()
  };
}

function run(input: Partial<AgentRun> & { id: string; operationId: string }): AgentRun {
  return {
    forgeId: "ui-forge",
    workerId: "frontend-worker",
    provider: "mock",
    status: "running",
    capabilities: {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: true,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    },
    queuedAt: new Date(0).toISOString(),
    startedAt: new Date(1000).toISOString(),
    providerMetadata: {},
    ...input
  };
}
