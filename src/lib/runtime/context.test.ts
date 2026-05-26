import { describe, expect, it } from "vitest";
import { createDemoSnapshot, createEmptyForgeSnapshot } from "@/lib/mock/seed";
import { RuntimeCommandError } from "./errors";
import { assembleRunContext, buildProviderPromptPackage } from "./context";
import { routeArtifactContext } from "./artifact-context-router";
import type { ForgeSnapshot } from "./types";

describe("assembleRunContext", () => {
  it("assembles operation, worker, division, file excerpts, artifacts, handoffs, and events", () => {
    const context = assembleRunContext(createDemoSnapshot(), "op-runtime");

    expect(context.forge).toMatchObject({
      id: "demo-forge",
      slug: "demo",
      activePhase: "Autonomous Development"
    });
    expect(context.operation).toMatchObject({
      id: "op-runtime",
      title: "Implement runtime contracts",
      status: "ready",
      priority: "high",
      retryCount: 0
    });
    expect(context.worker).toMatchObject({
      id: "backend-worker",
      divisionId: "engineering",
      role: "Runtime and API specialist"
    });
    expect(context.division).toMatchObject({
      id: "engineering",
      name: "Engineering Division"
    });
    expect(context.files.map((file) => file.path)).toContain("docs/project-plan.md");
    expect(context.files.find((file) => file.path === "docs/project-plan.md")?.excerpt).toContain("ForgeOS command center");
    expect(context.artifacts.map((artifact) => artifact.id)).toContain("artifact-architecture");
    expect(context.handoffs.map((handoff) => handoff.id)).toContain("handoff-ops-eng");
    expect(context.events.map((event) => event.targetId)).toEqual(expect.arrayContaining(["demo-forge", "op-tests"]));
    expect(context.accounting).toMatchObject({
      budget: { totalTokens: 24000 }
    });
    expect(context.instructionEnvelope).toMatchObject({
      operationId: "op-runtime",
      workerId: "backend-worker",
      allowedActions: expect.arrayContaining(["declare_artifact", "declare_virtual_file", "declare_handoff", "declare_blocker", "emit_progress"])
    });
    expect(context.instructionEnvelope?.communicationObligations).toEqual(expect.arrayContaining([expect.stringContaining("division lead for approval")]));
    expect(context.instructionEnvelope?.stopConditions).toEqual(expect.arrayContaining([expect.stringContaining("outside the assigned operation scope")]));
  });

  it("includes bounded launcher diagnostics from runtime event payloads", () => {
    const base = createDemoSnapshot();
    const snapshot = {
      ...base,
      events: [
        ...base.events,
        {
          id: "event-launcher-check",
          sequence: base.lastEventSequence + 1,
          forgeId: base.forge.id,
          type: "launcher.check_completed" as const,
          actorType: "runtime" as const,
          targetType: "forge" as const,
          targetId: base.forge.id,
          message: "Project launcher check failed.",
          severity: "error" as const,
          payload: { launcherId: "launcher-one", status: "failed", command: "npm run build", exitCode: 1, timedOut: false },
          createdAt: "2026-05-26T10:00:00.000Z"
        },
        {
          id: "event-launcher-log",
          sequence: base.lastEventSequence + 2,
          forgeId: base.forge.id,
          type: "launcher.log" as const,
          actorType: "runtime" as const,
          targetType: "forge" as const,
          targetId: base.forge.id,
          message: "Launcher log tail captured.",
          severity: "info" as const,
          payload: { launcherId: "launcher-one", output: "Chrome extension runtime check failed with exit code 1\nbackground.ts missing manifest permission" },
          createdAt: "2026-05-26T10:00:01.000Z"
        }
      ],
      lastEventSequence: base.lastEventSequence + 2
    };

    const prompt = buildProviderPromptPackage(assembleRunContext(snapshot, "op-tests"));

    expect(JSON.stringify(prompt.context.recentEvents)).toContain("exitCode");
    expect(JSON.stringify(prompt.context.recentEvents)).toContain("background.ts missing manifest permission");
  });

  it("includes dependency status and completed upstream outputs", () => {
    const context = assembleRunContext(createDemoSnapshot(), "op-runtime");

    expect(context.dependencies).toEqual([
      expect.objectContaining({
        id: "dep-runtime-handoff",
        type: "blocks",
        operation: expect.objectContaining({
          id: "op-handoff-eng",
          status: "completed"
        }),
        outputArtifacts: [
          expect.objectContaining({
            id: "artifact-strategy",
            contentSummary: expect.stringContaining("AI organization runtime")
          })
        ]
      })
    ]);
  });

  it("enforces deterministic bounds for selected context", () => {
    const snapshot = withLargeContext(createDemoSnapshot());
    const context = assembleRunContext(snapshot, "op-runtime");

    expect(context.files).toHaveLength(10);
    expect(context.files.every((file) => file.excerpt.length <= 2000)).toBe(true);
    expect(context.files.reduce((total, file) => total + file.excerpt.length, 0)).toBeLessThanOrEqual(12000);
    expect(context.artifacts).toHaveLength(8);
    expect(context.handoffs).toHaveLength(5);
    expect(context.events).toHaveLength(20);
    expect(context.messages).toHaveLength(5);
    expect(context.omittedContextReasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("virtual files omitted"),
        expect.stringContaining("file excerpt truncated"),
        expect.stringContaining("artifact summaries omitted"),
        expect.stringContaining("handoffs omitted"),
        expect.stringContaining("events omitted"),
        expect.stringContaining("executive messages omitted")
      ])
    );
  });

  it("accepts an optional estimated token budget and records budget omissions", () => {
    const snapshot = withLargeContext(createDemoSnapshot());
    const context = assembleRunContext(snapshot, "op-runtime", { estimatedTokenBudget: 2600 });

    expect(context.accounting?.estimatedTokens).toBeLessThanOrEqual(2600);
    expect(context.accounting).toMatchObject({
      budget: { totalTokens: 2600 }
    });
    expect(context.accounting?.omittedReasons).toEqual(expect.arrayContaining([expect.stringContaining("token budget")]));
    expect(context.files.length).toBeLessThan(10);
    expect(context.omittedContextReasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("token budget"),
        expect.stringContaining("section")
      ])
    );
  });

  it("prioritizes operation-owned files under tight budgets", () => {
    const snapshot = withPeerFilePressure(createDemoSnapshot());
    const context = assembleRunContext(snapshot, "op-runtime", { estimatedTokenBudget: 3200 });

    expect(context.files.map((file) => file.path)).toContain("zzzz/current-operation.ts");
    expect(context.files.some((file) => file.path.startsWith("aaaa/peer-"))).toBe(false);
    expect(context.omittedContextReasons).toEqual(expect.arrayContaining([expect.stringContaining("virtual files omitted")]));
  });

  it("gives QA and release validation larger dependency implementation file excerpts", () => {
    const snapshot = createDemoSnapshot();
    const appContent = `export default function App() {\n${"  console.log('render check');\n".repeat(260)}}\n`;
    const context = assembleRunContext(
      {
        ...snapshot,
        files: [
          ...snapshot.files,
          {
            id: "file-app-tsx",
            path: "src/App.tsx",
            content: appContent,
            status: "generated",
            version: 1,
            divisionId: "engineering",
            workerId: "backend-worker",
            operationId: "op-runtime",
            artifactIds: [],
            updatedAt: "2026-05-26T12:00:00.000Z"
          }
        ]
      },
      "op-tests"
    );

    const appFile = context.files.find((file) => file.path === "src/App.tsx");
    expect(appFile).toMatchObject({
      path: "src/App.tsx",
      truncated: false
    });
    expect(appFile?.excerpt).toBe(appContent);
  });

  it("prioritizes targeted handoffs and includes linked artifacts and files", () => {
    const snapshot = createDemoSnapshot();
    const context = assembleRunContext(
      {
        ...snapshot,
        artifacts: [
          ...snapshot.artifacts,
          {
            id: "artifact-targeted-handoff",
            title: "Targeted QA Artifact",
            type: "qa_input",
            divisionId: "engineering",
            workerId: "backend-worker",
            operationId: "op-runtime",
            content: "Targeted handoff artifact content.",
            status: "generated",
            version: 1,
            tags: ["handoff"],
            fileIds: ["file-targeted-handoff"],
            createdAt: "2026-05-17T23:00:00.000Z",
            updatedAt: "2026-05-17T23:00:00.000Z"
          }
        ],
        files: [
          ...snapshot.files,
          {
            id: "file-targeted-handoff",
            path: "notes/targeted-handoff.md",
            content: "# Targeted Handoff\n\nQA-specific runtime notes.",
            status: "generated",
            version: 1,
            divisionId: "engineering",
            workerId: "backend-worker",
            operationId: "op-runtime",
            artifactIds: ["artifact-targeted-handoff"],
            updatedAt: "2026-05-17T23:00:00.000Z"
          }
        ],
        handoffs: [
          ...snapshot.handoffs,
          {
            id: "handoff-targeted-qa",
            fromDivisionId: "engineering",
            toDivisionId: "qa",
            fromOperationId: "op-runtime",
            fromRunId: "run-runtime",
            targetOperationId: "op-tests",
            summary: "QA should consume the targeted runtime output.",
            deliverables: ["Targeted QA Artifact"],
            blockers: [],
            requiredContext: ["Read notes/targeted-handoff.md"],
            artifactIds: ["artifact-targeted-handoff"],
            fileIds: ["file-targeted-handoff"],
            status: "open",
            confidence: 93,
            createdAt: "2026-05-17T23:00:00.000Z"
          }
        ]
      },
      "op-tests"
    );

    expect(context.handoffs[0]).toMatchObject({ id: "handoff-targeted-qa", targetOperationId: "op-tests", status: "open" });
    expect(context.artifacts.map((artifact) => artifact.id)).toContain("artifact-targeted-handoff");
    expect(context.files.map((file) => file.id)).toContain("file-targeted-handoff");
    expect(context.routing?.selectedArtifactIds).toContain("artifact-targeted-handoff");
    expect(context.routing?.routingReasons["artifact-targeted-handoff"]).toContain("targeted handoff");
  });

  it("routes targeted handoff artifacts ahead of dependency and same-division context", () => {
    const snapshot = withRoutingPressure(createDemoSnapshot());
    const operation = snapshot.operations.find((candidate) => candidate.id === "op-tests");
    const dependencyOperations = snapshot.dependencies
      .filter((dependency) => dependency.operationId === "op-tests")
      .flatMap((dependency) => snapshot.operations.filter((candidate) => candidate.id === dependency.dependsOnOperationId));
    const handoffs = snapshot.handoffs.filter((handoff) => handoff.targetOperationId === "op-tests" || handoff.toDivisionId === operation?.divisionId);
    const result = routeArtifactContext({
      snapshot,
      operation: operation!,
      dependencyOperations,
      handoffs,
      workerManifestArtifactRefs: ["artifact-manifest-route"],
      workerManifestFileRefs: ["manifest/context.md"]
    });

    const artifactOrder = result.artifacts.map((decision) => decision.id);
    expect(artifactOrder.indexOf("artifact-target-route")).toBeLessThan(artifactOrder.indexOf("artifact-dependency-route"));
    expect(artifactOrder.indexOf("artifact-dependency-route")).toBeLessThan(artifactOrder.indexOf("artifact-same-division-route"));
    expect(artifactOrder.indexOf("artifact-manifest-route")).toBeLessThan(artifactOrder.indexOf("artifact-same-division-route"));
    expect(result.artifacts.find((decision) => decision.id === "artifact-unrelated-route")).toMatchObject({ route: "omitted", reason: "unrelated" });
    expect(result.files.find((decision) => decision.id === "file-manifest-route")).toMatchObject({ route: "required", reason: "worker_manifest" });
  });

  it("keeps required routed artifacts ahead of optional artifacts under tight budgets", () => {
    const context = assembleRunContext(withRoutingPressure(createDemoSnapshot()), "op-tests", {
      budget: {
        totalTokens: 5200,
        sections: {
          artifacts: { maxTokens: 80 }
        }
      }
    });

    expect(context.artifacts.map((artifact) => artifact.id)).toContain("artifact-target-route");
    expect(context.artifacts.some((artifact) => artifact.id === "artifact-same-division-route")).toBe(false);
    expect(context.routing?.omittedArtifactIds).toContain("artifact-same-division-route");
  });

  it("honors explicit total and per-section budget options", () => {
    const snapshot = withLargeContext(createDemoSnapshot());
    const context = assembleRunContext(snapshot, "op-runtime", {
      budget: {
        totalTokens: 3200,
        sections: {
          files: { maxTokens: 180 },
          events: { maxTokens: 20 }
        }
      }
    });

    expect(context.accounting?.budget.totalTokens).toBe(3200);
    expect(context.accounting?.budget.sections.files.maxTokens).toBe(180);
    expect(context.accounting?.budget.sections.events.maxTokens).toBe(20);
    expect(context.events.length).toBeLessThan(20);
  });

  it("builds a compact provider prompt package without runtime accounting overhead", () => {
    const context = assembleRunContext(withLargeContext(createDemoSnapshot()), "op-runtime", { estimatedTokenBudget: 5200 });
    const providerPrompt = buildProviderPromptPackage(context);
    const serializedPrompt = JSON.stringify(providerPrompt);

    expect(providerPrompt.version).toBe("forgeos-provider-prompt-v1");
    expect(providerPrompt.instructions.responseFormat).toContain("outputs");
    expect(providerPrompt.instructions.responseFormat).toContain("verificationEvidence");
    expect(providerPrompt.instructions.responseFormat).toContain("dependencyRequests");
    expect(providerPrompt.instructions.responseFormat).toContain("npm install");
    expect(providerPrompt.instructions.responseFormat).toContain("Workers must solve independently first");
    expect(providerPrompt.instructions.responseFormat).toContain("attemptsMade");
    expect(providerPrompt.instructions.responseFormat).toContain("ForgeOS will run the real sandbox checks");
    expect(providerPrompt.context.files[0]).toEqual(expect.not.objectContaining({ excerptRange: expect.anything() }));
    expect(serializedPrompt).not.toContain("accounting");
    expect(serializedPrompt).not.toContain("outputSchema");
    expect(serializedPrompt).not.toContain("communicationObligations");
    expect(serializedPrompt).not.toContain("Provider raw prompts");
    expect(providerPrompt.estimatedTokens).toBeLessThan(context.accounting?.estimatedTokens ?? Number.POSITIVE_INFINITY);
  });

  it("includes worker expertise manifest in the compact provider prompt", () => {
    const snapshot: ForgeSnapshot = {
      ...createDemoSnapshot(),
      workers: createDemoSnapshot().workers.map((worker) =>
        worker.id === "backend-worker"
          ? {
              ...worker,
              role: "external source data integration specialist",
              currentTask: "Implement the source feed ingestion layer.",
              contextManifest: {
                ...worker.contextManifest,
                objective: "Focus on source feed parsing, normalization, and user-facing search filters.",
                instructionSources: ["Executive AI staffing proposal", "operator source constraint"],
                memorySnippets: ["Use the operator-provided source link as the authoritative source."],
                recentEventSummary: ["Spawned to implement data fetching and normalization."]
              }
            }
          : worker
      )
    };

    const context = assembleRunContext(snapshot, "op-runtime");
    const providerPrompt = buildProviderPromptPackage(context);

    expect(providerPrompt.instructions.role).toBe("external source data integration specialist");
    expect(providerPrompt.instructions.objective).toContain("Worker specialization: Focus on source feed parsing");
    expect(providerPrompt.context.worker?.expertise).toMatchObject({
      objective: "Focus on source feed parsing, normalization, and user-facing search filters.",
      instructionSources: ["Executive AI staffing proposal", "operator source constraint"],
      memorySnippets: ["Use the operator-provided source link as the authoritative source."],
      recentEventSummary: ["Spawned to implement data fetching and normalization."]
    });
    expect(JSON.stringify(providerPrompt)).not.toContain("contextManifest");
  });

  it("seeds default workers with role-specific expertise manifests", () => {
    const snapshot = createEmptyForgeSnapshot({ id: "fresh-forge", slug: "fresh", name: "Fresh Forge", prefixEntityIds: true });
    const frontend = snapshot.workers.find((worker) => worker.id === "fresh-frontend-worker");
    const backend = snapshot.workers.find((worker) => worker.id === "fresh-backend-worker");

    expect(frontend?.contextManifest.objective).toContain("mobile-first");
    expect(frontend?.contextManifest.memorySnippets.join(" ")).toContain("concrete UI files");
    expect(backend?.contextManifest.objective).toContain("APIs");
    expect(backend?.contextManifest.memorySnippets.join(" ")).toContain("typed contracts");
  });

  it("throws a runtime command error for missing operations", () => {
    expect(() => assembleRunContext(createDemoSnapshot(), "missing-operation")).toThrow(RuntimeCommandError);
  });

  it("excludes secrets, raw provider internals, and filesystem content outside snapshot files", () => {
    const snapshot: ForgeSnapshot = {
      ...createDemoSnapshot(),
      repository: {
        id: "repo-demo",
        provider: "github",
        owner: "BottoGrotto",
        repo: "ForgeOS",
        defaultBranch: "main",
        workingBranch: "main",
        installationId: "install-secret",
        accountRef: "account-secret",
        connectedAt: "2026-05-17T20:00:00.000Z",
        authenticatedAccountLogin: "octocat"
      },
      workers: createDemoSnapshot().workers.map((worker) =>
        worker.id === "backend-worker"
          ? {
              ...worker,
              externalAgentId: "external-secret",
              providerMetadata: { rawPrompt: "hidden provider prompt", ["to" + "ken"]: "test-provider-token" }
            }
          : worker
      ),
      files: [
        ...createDemoSnapshot().files,
        {
          id: "secret-file",
          path: "repo/secret.txt",
          content: "gho_secret should stay only if it is actual synced file context",
          status: "draft",
          version: 1,
          operationId: "op-runtime",
          artifactIds: [],
          updatedAt: "2026-05-17T20:00:00.000Z"
        }
      ]
    };

    const serialized = JSON.stringify(assembleRunContext(snapshot, "op-runtime"));

    expect(serialized).not.toContain("install-secret");
    expect(serialized).not.toContain("account-secret");
    expect(serialized).not.toContain("external-secret");
    expect(serialized).not.toContain("test-provider-token");
    expect(serialized).not.toContain("hidden provider prompt");
    expect(serialized).not.toContain("FORGEOS_OPERATOR_PASSWORD");
  });
});

function withLargeContext(snapshot: ForgeSnapshot): ForgeSnapshot {
  const extraFiles = Array.from({ length: 14 }, (_, index) => ({
    id: `extra-file-${index}`,
    path: `repo/file-${index.toString().padStart(2, "0")}.ts`,
    content: `${index}-`.repeat(2500),
    status: "draft" as const,
    version: 1,
    divisionId: "engineering",
    workerId: "backend-worker",
    operationId: "op-runtime",
    artifactIds: [],
    updatedAt: "2026-05-17T20:00:00.000Z"
  }));
  const extraArtifacts = Array.from({ length: 10 }, (_, index) => ({
    id: `extra-artifact-${index}`,
    title: `Extra Artifact ${index}`,
    type: "note",
    divisionId: "engineering",
    workerId: "backend-worker",
    operationId: "op-runtime",
    content: "artifact content ".repeat(80),
    status: "generated" as const,
    version: 1,
    tags: ["runtime"],
    fileIds: [],
    createdAt: `2026-05-17T20:${index.toString().padStart(2, "0")}:00.000Z`,
    updatedAt: `2026-05-17T20:${index.toString().padStart(2, "0")}:00.000Z`
  }));
  const extraHandoffs = Array.from({ length: 8 }, (_, index) => ({
    id: `extra-handoff-${index}`,
    fromDivisionId: "operations",
    toDivisionId: "engineering",
    summary: `Extra handoff ${index}`,
    deliverables: ["Runtime note"],
    blockers: [],
    requiredContext: ["Use virtual files"],
    artifactIds: [],
    fileIds: [],
    status: "open" as const,
    confidence: 80,
    createdAt: `2026-05-17T20:${index.toString().padStart(2, "0")}:00.000Z`
  }));
  const extraEvents = Array.from({ length: 24 }, (_, index) => ({
    id: `extra-event-${index}`,
    forgeId: snapshot.forge.id,
    sequence: snapshot.lastEventSequence + index + 1,
    type: "operation.started" as const,
    actorType: "runtime" as const,
    targetType: "operation" as const,
    targetId: "op-runtime",
    message: `Runtime event ${index}`,
    severity: "info" as const,
    payload: {},
    createdAt: `2026-05-17T21:${index.toString().padStart(2, "0")}:00.000Z`
  }));
  const extraMessages = Array.from({ length: 8 }, (_, index) => ({
    id: `extra-message-${index}`,
    role: index % 2 === 0 ? ("executive" as const) : ("operator" as const),
    content: `Executive message ${index} `.repeat(30),
    createdAt: `2026-05-17T22:${index.toString().padStart(2, "0")}:00.000Z`
  }));

  return {
    ...snapshot,
    files: [...snapshot.files, ...extraFiles],
    artifacts: [...snapshot.artifacts, ...extraArtifacts],
    handoffs: [...snapshot.handoffs, ...extraHandoffs],
    messages: [...snapshot.messages, ...extraMessages],
    events: [...snapshot.events, ...extraEvents],
    lastEventSequence: snapshot.lastEventSequence + extraEvents.length
  };
}

function withPeerFilePressure(snapshot: ForgeSnapshot): ForgeSnapshot {
  const peerFiles = Array.from({ length: 12 }, (_, index) => ({
    id: `peer-file-${index}`,
    path: `aaaa/peer-${index.toString().padStart(2, "0")}.ts`,
    content: `peer ${index} `.repeat(400),
    status: "draft" as const,
    version: 1,
    divisionId: "engineering",
    workerId: "backend-worker",
    artifactIds: [],
    updatedAt: "2026-05-17T20:00:00.000Z"
  }));
  const operationFile = {
    id: "operation-owned-file",
    path: "zzzz/current-operation.ts",
    content: "operation owned context ".repeat(400),
    status: "draft" as const,
    version: 1,
    divisionId: "engineering",
    workerId: "backend-worker",
    operationId: "op-runtime",
    artifactIds: [],
    updatedAt: "2026-05-17T20:00:00.000Z"
  };

  return {
    ...snapshot,
    files: [...snapshot.files.filter((file) => file.path !== "docs/project-plan.md"), ...peerFiles, operationFile]
  };
}

function withRoutingPressure(snapshot: ForgeSnapshot): ForgeSnapshot {
  const timestamp = "2026-05-17T23:30:00.000Z";
  const routedArtifacts = [
    artifact("artifact-target-route", "Target Route", "engineering", "op-runtime", "target handoff content ".repeat(200)),
    artifact("artifact-dependency-route", "Dependency Route", "engineering", "op-runtime", "dependency content ".repeat(200)),
    artifact("artifact-manifest-route", "Manifest Route", "qa", "op-tests", "manifest content ".repeat(200)),
    artifact("artifact-same-division-route", "Same Division Route", "qa", "op-qa", "same division content ".repeat(200)),
    artifact("artifact-unrelated-route", "Unrelated Route", "presentation", "op-pitch", "unrelated content ".repeat(200))
  ];
  const routedFiles = [
    {
      id: "file-manifest-route",
      path: "manifest/context.md",
      content: "# Manifest context\n\nUse this.",
      status: "generated" as const,
      version: 1,
      divisionId: "qa",
      workerId: "qa-runner-alpha",
      operationId: "op-tests",
      artifactIds: ["artifact-manifest-route"],
      updatedAt: timestamp
    }
  ];

  return {
    ...snapshot,
    operations: snapshot.operations.map((operation) =>
      operation.id === "op-runtime"
        ? {
            ...operation,
            outputArtifactIds: [...operation.outputArtifactIds, "artifact-dependency-route"]
          }
        : operation
    ),
    artifacts: [...snapshot.artifacts, ...routedArtifacts],
    files: [...snapshot.files, ...routedFiles],
    handoffs: [
      ...snapshot.handoffs,
      {
        id: "handoff-target-route",
        fromDivisionId: "engineering",
        toDivisionId: "qa",
        fromOperationId: "op-runtime",
        targetOperationId: "op-tests",
        summary: "Targeted route handoff.",
        deliverables: ["Target Route"],
        blockers: [],
        requiredContext: [],
        artifactIds: ["artifact-target-route"],
        fileIds: [],
        status: "open" as const,
        confidence: 95,
        createdAt: timestamp
      }
    ]
  };
}

function artifact(id: string, title: string, divisionId: string, operationId: string, content: string) {
  return {
    id,
    title,
    type: "note",
    divisionId,
    workerId: operationId === "op-tests" ? "qa-runner-alpha" : "backend-worker",
    operationId,
    content,
    status: "generated" as const,
    version: 1,
    tags: ["routing"],
    fileIds: [],
    createdAt: "2026-05-17T23:30:00.000Z",
    updatedAt: "2026-05-17T23:30:00.000Z"
  };
}
