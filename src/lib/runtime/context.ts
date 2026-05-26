import { RuntimeCommandError } from "./errors";
import { routeArtifactContext } from "./artifact-context-router";
import type {
  Artifact,
  ArtifactContextRouterResult,
  ForgeRepositorySnapshot,
  ForgeSnapshot,
  Handoff,
  Operation,
  ProviderPromptPackage,
  RunContextArtifact,
  RunContextAssemblyOptions,
  RunContextDependency,
  RunContextEvent,
  RunContextFile,
  RunContextHandoff,
  RunContextMessage,
  RunContextPackage,
  RunContextSectionKey,
  RunContextSectionUsage,
  VirtualFile
} from "./types";

const MAX_FILES = 10;
const MAX_FILE_EXCERPT_CHARS = 2000;
const MAX_TOTAL_FILE_EXCERPT_CHARS = 12000;
const MAX_VALIDATION_FILE_EXCERPT_CHARS = 20000;
const MAX_VALIDATION_TOTAL_FILE_EXCERPT_CHARS = 40000;
const MAX_ARTIFACTS = 8;
const MAX_ARTIFACT_SUMMARY_CHARS = 500;
const MAX_HANDOFFS = 5;
const MAX_EVENTS = 20;
const MAX_MESSAGES = 5;
const MAX_MESSAGE_SUMMARY_CHARS = 240;
const DEFAULT_ESTIMATED_TOKEN_BUDGET = 24000;
const CHARS_PER_ESTIMATED_TOKEN = 4;
const MIN_ESTIMATED_TOKEN_BUDGET = 400;

const SECTION_WEIGHTS = {
  dependencies: 0.12,
  artifacts: 0.15,
  files: 0.43,
  handoffs: 0.08,
  events: 0.12,
  messages: 0.1
} as const;

type BudgetedSectionName = keyof typeof SECTION_WEIGHTS;

export function assembleRunContext(snapshot: ForgeSnapshot, operationId: string, options: RunContextAssemblyOptions = {}): RunContextPackage {
  const operation = snapshot.operations.find((candidate) => candidate.id === operationId);
  if (!operation) {
    throw new RuntimeCommandError("No operation selected.", 400);
  }
  const estimatedTokenBudget = normalizeEstimatedTokenBudget(options.budget?.totalTokens ?? options.estimatedTokenBudget);

  const worker = operation.workerId ? snapshot.workers.find((candidate) => candidate.id === operation.workerId) : undefined;
  const division = snapshot.divisions.find((candidate) => candidate.id === operation.divisionId);
  const dependencyOperations = getDependencyOperations(snapshot, operation.id);
  const relevantOperationIds = new Set([operation.id, operation.escalatedFromOperationId, ...dependencyOperations.map((candidate) => candidate.id)].filter(Boolean) as string[]);
  const relevantDivisionIds = new Set([operation.divisionId, ...dependencyOperations.map((candidate) => candidate.divisionId)]);
  const relevantWorkerIds = new Set([operation.workerId, worker?.id, ...dependencyOperations.map((candidate) => candidate.workerId)].filter(Boolean) as string[]);
  const selectedHandoffs = selectRelevantHandoffs(snapshot, operation.id, operation.divisionId, dependencyOperations.map((candidate) => candidate.divisionId));
  const routing = routeArtifactContext({
    snapshot,
    operation,
    dependencyOperations,
    handoffs: selectedHandoffs,
    workerManifestArtifactRefs: worker?.contextManifest.artifactRefs ?? [],
    workerManifestFileRefs: worker?.contextManifest.virtualFileRefs ?? []
  });
  const baseContext = {
    forge: {
      id: snapshot.forge.id,
      slug: snapshot.forge.slug,
      name: snapshot.forge.name,
      activePhase: snapshot.forge.activePhase,
      status: snapshot.forge.status,
      repository: snapshot.repository ? toContextRepository(snapshot.repository) : undefined
    },
    operation: {
      id: operation.id,
        divisionId: operation.divisionId,
        workerId: operation.workerId,
        title: operation.title,
        description: operation.description,
        status: operation.status,
        priority: operation.priority,
        retryCount: operation.retryCount,
        blockedReason: operation.blockedReason,
        blockers: operation.blockedReason ? [operation.blockedReason] : [],
        outputArtifactIds: operation.outputArtifactIds,
        routingStage: operation.routingStage,
        webAccessPolicy: operation.webAccessPolicy,
        webAccessPurpose: operation.webAccessPurpose,
        allowedDomains: operation.allowedDomains,
        escalatedFromOperationId: operation.escalatedFromOperationId,
        escalationRunId: operation.escalationRunId,
        escalationFailureCategory: operation.escalationFailureCategory
      },
    worker: worker
      ? {
          id: worker.id,
          divisionId: worker.divisionId,
          name: worker.name,
          role: worker.role,
          kind: worker.kind,
          managerWorkerId: worker.managerWorkerId,
          status: worker.status,
          currentTask: worker.currentTask,
          provider: worker.provider,
          contextManifest: worker.contextManifest
        }
      : undefined,
    division: division
      ? {
          id: division.id,
          name: division.name,
          objective: division.objective,
          status: division.status,
          progress: division.progress,
          order: division.order,
          leadWorkerId: division.leadWorkerId
        }
      : undefined,
    redactions: [
      ...(worker?.contextManifest.redactions ?? []),
      "Provider raw prompts, external agent identifiers, provider metadata, OAuth tokens, and encrypted secrets are omitted.",
      "Virtual file excerpts are sourced only from Forge snapshot files."
    ]
  };
  const sectionBudgets = createSectionBudgets(estimatedTokenBudget, baseContext, options);

  const omittedContextReasons: string[] = [];
  const dependencies = fitItemsToSectionBudget(
    "dependencies",
    dependencyOperations.map((dependencyOperation) => toDependencyContext(snapshot, operation.id, dependencyOperation)),
    sectionBudgets.dependencies,
    omittedContextReasons
  );
  const routedArtifactIds = new Set(routing.selectedArtifactIds);
  const selectedArtifacts = selectRelevantArtifacts(snapshot, relevantOperationIds, relevantDivisionIds, relevantWorkerIds, routedArtifactIds, routing);
  const artifacts = fitItemsToSectionBudget("artifacts", selectedArtifacts.slice(0, MAX_ARTIFACTS).map(toContextArtifact), sectionBudgets.artifacts, omittedContextReasons);
  if (selectedArtifacts.length > MAX_ARTIFACTS) {
    omittedContextReasons.push(`${selectedArtifacts.length - MAX_ARTIFACTS} artifact summaries omitted after deterministic cap.`);
  }

  const handoffs = fitItemsToSectionBudget("handoffs", selectedHandoffs.slice(0, MAX_HANDOFFS).map(toContextHandoff), sectionBudgets.handoffs, omittedContextReasons);
  if (selectedHandoffs.length > MAX_HANDOFFS) {
    omittedContextReasons.push(`${selectedHandoffs.length - MAX_HANDOFFS} handoffs omitted after deterministic cap.`);
  }

  const routedFileIds = new Set(routing.selectedFileIds);
  const selectedFiles = selectRelevantFiles(snapshot, operation, worker?.contextManifest.virtualFileRefs ?? [], routedArtifactIds, routedFileIds, relevantOperationIds, relevantDivisionIds, relevantWorkerIds, routing);
  const files = buildFileContexts(selectedFiles.slice(0, MAX_FILES), sectionBudgets.files, omittedContextReasons, getFileContextLimits(operation, division?.name));
  if (selectedFiles.length > MAX_FILES) {
    omittedContextReasons.push(`${selectedFiles.length - MAX_FILES} virtual files omitted after deterministic cap.`);
  }

  const selectedEvents = selectRelevantEvents(snapshot, operation, relevantDivisionIds, relevantWorkerIds);
  const events = fitItemsToSectionBudget("events", selectedEvents.slice(-MAX_EVENTS).map(toContextEvent), sectionBudgets.events, omittedContextReasons);
  if (selectedEvents.length > MAX_EVENTS) {
    omittedContextReasons.push(`${selectedEvents.length - MAX_EVENTS} events omitted after deterministic cap.`);
  }

  const selectedMessages = snapshot.messages.slice().sort(compareCreatedThenId).slice(0, MAX_MESSAGES);
  const messages = fitItemsToSectionBudget("messages", selectedMessages.map(toContextMessage), sectionBudgets.messages, omittedContextReasons);
  if (snapshot.messages.length > MAX_MESSAGES) {
    omittedContextReasons.push(`${snapshot.messages.length - MAX_MESSAGES} executive messages omitted after deterministic cap.`);
  }

  const context: RunContextPackage = {
    ...baseContext,
    dependencies,
    artifacts,
    files,
    handoffs,
    events,
    messages,
    routing,
    omittedContextReasons: dedupeStrings(omittedContextReasons),
    instructionEnvelope: {
      role: worker?.role ?? "Unassigned Forge worker",
      objective: buildWorkerObjective(operation.description, worker?.contextManifest.objective),
      operationId: operation.id,
      workerId: operation.workerId,
      divisionId: operation.divisionId,
      allowedActions: ["declare_artifact", "declare_virtual_file", "declare_handoff", "declare_blocker", "request_file", "emit_progress"],
      outputSchema: {
        artifacts: "Array of { title, type, content, tags? } declarations for runtime-owned artifact projection.",
        files: "Array of { path, content } virtual workspace declarations for new files or complete rewrites. Paths must be relative virtual paths.",
        filePatches: "Array of { path, find, replace } exact text replacements for small edits to existing virtual files. Prefer patches over full-file rewrites when changing a small existing section. Runtime applies only if the file exists and find matches exactly once.",
        requestedFiles: "Array of { path?, id?, reason? } requests for additional virtual workspace files needed before final output. Runtime will provide bounded excerpts and rerun the same operation.",
        requestedSearches: "Array of { query, glob?, reason? } project file searches needed before final output. Runtime will provide bounded matching paths/snippets and rerun the same operation.",
        requestedArtifacts: "Array of { id?, title?, type?, reason? } requests for additional runtime artifact summaries needed before final output. Runtime decides what bounded artifact context is supplied.",
        handoffs: "Array of { toDivisionId, targetOperationId?, summary, deliverables?, blockers?, requiredContext?, confidence? } team handoff declarations.",
        blockers: "Array of { reason, severity?, attemptsMade?, whySelfSolveInsufficient? } blocker declarations for actionable conditions that prevent this operation from completing after in-scope self-solve attempts.",
        dangerousActions: "Array of { action, reason, command? } declarations for blocked non-allowlisted shell, write, publish, deploy, credential, or external side-effect requests. Runtime will route these to Executive review.",
        dependencyRequests: "Array of { packageName, versionRange?, dependencyType, reason, usedByFiles?, alternativesConsidered?, requiresExecutive? } requests for new npm packages. Explain why built-in APIs or existing dependencies are insufficient. Do not add install commands to scripts or dangerousActions.",
        recoveryActions: "Lead triage only: Array of { type, targetOperationId, title?, description?, workerId?, reason?, recommendedNextAction? } recovery decisions for the escalated operation.",
        progress: "Sanitized lifecycle/progress events only; do not include raw prompts, secrets, or provider payloads.",
        verificationEvidence: "{ commands?, expectedScripts?, summary?, knownGaps? } describing what the worker made runnable and expects ForgeOS to verify. This is required when producing implementation files, package scripts, tests, or file patches.",
        verification: "Implementation outputs must include runnable package scripts for sandbox verification. Development work must support fast test/typecheck/smoke checks; QA and release work must support broader acceptance checks such as test, typecheck, lint, build, smoke, or e2e when applicable. If verification cannot be made runnable, declare an actionable blocker instead of completing."
      },
      communicationObligations: [
        "Declare handoffs when downstream divisions need context.",
        "Workers must solve independently first: use assigned context, bounded requestedFiles/requestedSearches/requestedArtifacts, existing dependencies, built-in APIs, exact patches, tests, and verification evidence before asking for help.",
        "Create or update runnable tests and package scripts when producing project files so ForgeOS can execute and iterate on results.",
        "When producing code, declare verificationEvidence with the scripts or commands you expect ForgeOS to run; worker-reported evidence is not a substitute for runtime verification.",
        "If new packages are needed, declare dependencyRequests for division lead review instead of running install commands or adding install commands to generated scripts.",
        "Use questionRequests only for scope_approval, product_decision, policy_exception, external_authority, or upstream_dependency decisions. Do not ask leads or Executive for ordinary debugging, implementation strategy, runtime logs, test output, or what to try next.",
        "Every non-legacy questionRequest must include category, attemptsMade, and whySelfSolveInsufficient. Every blocker should include attemptsMade and whySelfSolveInsufficient when self-solve was attempted.",
        "If you need to read, patch, rewrite, or create files outside the assigned operation scope, ask the division lead for approval first and wait for that approval before touching those files.",
        "For QA, validation, or release work, do not stop at 'verification failed' or 'readiness cannot be confirmed'; name the failed checks, likely repair target, and concrete upstream repair needed.",
        "Declare blockers only when work cannot continue without operator or upstream action; do not use blockers for informational coordination status after routing handoffs.",
        "Keep generated outputs bounded and free of secrets or raw provider internals."
      ],
      stopConditions: [
        "Stop after declaring completed outputs with verificationEvidence, handoffs, blockers, or failure state.",
        "Do not touch files outside the assigned operation scope unless division lead approval has been requested and granted.",
        "Do not write to connected repositories or external systems.",
        "Do not request raw secrets or expose provider-private payloads."
      ]
    }
  };

  const budgetedContext = fitPackageToTokenBudget(context, estimatedTokenBudget);
  const finalRouting = finalizeRoutingForContext(routing, budgetedContext.artifacts.map((artifact) => artifact.id), budgetedContext.files.map((file) => file.id));
  const finalContext = { ...budgetedContext, routing: finalRouting };
  return {
    ...finalContext,
    accounting: buildAccounting(finalContext, estimatedTokenBudget, sectionBudgets)
  };
}

export function buildProviderPromptPackage(context: RunContextPackage): ProviderPromptPackage {
  const prompt = {
    version: "forgeos-provider-prompt-v1" as const,
    estimatedTokens: 0,
    instructions: {
      role: context.instructionEnvelope?.role ?? context.worker?.role ?? "Forge worker",
      objective: context.instructionEnvelope?.objective ?? context.operation.description,
      operationId: context.operation.id,
      workerId: context.operation.workerId,
      divisionId: context.operation.divisionId,
      allowedActions: context.instructionEnvelope?.allowedActions ?? ["declare_artifact", "declare_virtual_file", "declare_handoff", "declare_blocker", "request_file", "emit_progress"],
      responseFormat: "Emit sanitized runtime events. Complete with outputs: { artifacts?, files?, filePatches?, requestedFiles?, requestedSearches?, requestedArtifacts?, handoffs?, blockers?, questionRequests?, dependencyRequests?, verificationEvidence?, dangerousActions?, recoveryActions? }. Workers must solve independently first: use assigned context, bounded requestedFiles/requestedSearches/requestedArtifacts, existing dependencies, built-in APIs, exact patches, tests, and verification evidence before asking for help. Use filePatches with exact { path, find, replace } for small edits to existing files; use files only for new files or complete rewrites. Use requestedSearches/requestedFiles/requestedArtifacts when more bounded runtime context is required before final output. Use questionRequests only for scope_approval, product_decision, policy_exception, external_authority, or upstream_dependency decisions; include category, attemptsMade, and whySelfSolveInsufficient. Do not ask leads or Executive for ordinary debugging, implementation strategy, runtime logs, test output, or what to try next. Set needsExecutive only when the lead should escalate a valid question to Executive. Use dependencyRequests for new packages with a reason explaining why built-in APIs or existing dependencies are insufficient; do not put npm install, pnpm add, yarn add, bun add, or similar install commands in package scripts or dangerousActions unless explicitly requesting escalation. Include runnable tests and package scripts for project files so ForgeOS can run development checks and broader acceptance checks. If you produce code, tests, package scripts, or file patches, include verificationEvidence naming expected scripts/commands and known gaps; ForgeOS will run the real sandbox checks. If verification cannot be made runnable, declare an actionable blocker with attemptsMade and whySelfSolveInsufficient instead of completing. Stay within the assigned operation scope; if you need files outside that scope, ask for division lead approval before reading, patching, rewriting, or creating them. For QA, validation, or release work, blockers about failed verification or unconfirmed readiness must identify the failed checks, likely repair target, concrete upstream repair needed, attemptsMade, and whySelfSolveInsufficient. Use blockers only for actionable conditions that prevent this operation from completing, not informational coordination status. Only division leads handling lead triage operations may emit recoveryActions. Never include raw prompts, secrets, full context, credentials, or provider-private payloads.",
      stopConditions: [
        "Stop after one completed, failed, canceled, or blocker declaration.",
        "Do not touch files outside the assigned operation scope unless division lead approval has been requested and granted.",
        "Do not write to repositories or external systems.",
        "Keep outputs bounded and runtime-owned."
      ]
    },
    context: {
      forge: {
        id: context.forge.id,
        slug: context.forge.slug,
        name: context.forge.name,
        activePhase: context.forge.activePhase,
        status: context.forge.status,
        repository: context.forge.repository
      },
      operation: {
        id: context.operation.id,
        title: context.operation.title,
        description: context.operation.description,
        status: context.operation.status,
        priority: context.operation.priority,
        retryCount: context.operation.retryCount,
        blockedReason: context.operation.blockedReason,
        routingStage: context.operation.routingStage,
        webAccessPolicy: context.operation.webAccessPolicy,
        webAccessPurpose: context.operation.webAccessPurpose,
        allowedDomains: context.operation.allowedDomains,
        escalatedFromOperationId: context.operation.escalatedFromOperationId,
        escalationRunId: context.operation.escalationRunId,
        escalationFailureCategory: context.operation.escalationFailureCategory
      },
      worker: context.worker
        ? {
            id: context.worker.id,
            divisionId: context.worker.divisionId,
            name: context.worker.name,
            role: context.worker.role,
            kind: context.worker.kind,
            managerWorkerId: context.worker.managerWorkerId,
            status: context.worker.status,
            currentTask: context.worker.currentTask,
            expertise: {
              objective: context.worker.contextManifest.objective,
              instructionSources: context.worker.contextManifest.instructionSources.slice(0, 8),
              memorySnippets: context.worker.contextManifest.memorySnippets.slice(0, 8),
              recentEventSummary: context.worker.contextManifest.recentEventSummary.slice(0, 8)
            }
          }
        : undefined,
      division: context.division
        ? {
            id: context.division.id,
            name: context.division.name,
            objective: context.division.objective,
            status: context.division.status,
            progress: context.division.progress,
            leadWorkerId: context.division.leadWorkerId
          }
        : undefined,
      dependencies: context.dependencies.map((dependency) => ({
        id: dependency.id,
        type: dependency.type,
        operation: {
          id: dependency.operation.id,
          title: dependency.operation.title,
          status: dependency.operation.status,
          priority: dependency.operation.priority,
          progress: dependency.operation.progress,
          blockedReason: dependency.operation.blockedReason
        }
      })),
      files: context.files.map((file) => ({
        id: file.id,
        path: file.path,
        status: file.status,
        version: file.version,
        excerpt: file.excerpt,
        truncated: file.truncated
      })),
      artifacts: context.artifacts.map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        type: artifact.type,
        status: artifact.status,
        contentSummary: artifact.contentSummary,
        tags: artifact.tags
      })),
      handoffs: context.handoffs.map((handoff) => ({
        id: handoff.id,
        fromDivisionId: handoff.fromDivisionId,
        toDivisionId: handoff.toDivisionId,
        targetOperationId: handoff.targetOperationId,
        summary: handoff.summary,
        deliverables: handoff.deliverables,
        blockers: handoff.blockers,
        requiredContext: handoff.requiredContext,
        status: handoff.status,
        confidence: handoff.confidence
      })),
      recentEvents: context.events.map((event) => ({
        type: event.type,
        actorType: event.actorType,
        targetType: event.targetType,
        targetId: event.targetId,
        message: event.message,
        payloadSummary: event.payloadSummary,
        severity: event.severity,
        createdAt: event.createdAt
      })),
      recentMessages: context.messages.map((message) => ({
        role: message.role,
        summary: message.summary,
        createdAt: message.createdAt
      })),
      omittedReasons: context.omittedContextReasons,
      redactions: [
        "No raw prompts, credentials, provider payloads, OAuth tokens, or encrypted secrets.",
        "Use only the bounded excerpts and summaries in this package."
      ]
    }
  } satisfies ProviderPromptPackage;

  return {
    ...prompt,
    estimatedTokens: estimateTokens(prompt)
  };
}

function buildWorkerObjective(operationDescription: string, workerObjective?: string) {
  if (!workerObjective || workerObjective === operationDescription) {
    return operationDescription;
  }

  return `${operationDescription}\n\nWorker specialization: ${workerObjective}`;
}

function getDependencyOperations(snapshot: ForgeSnapshot, operationId: string) {
  return snapshot.dependencies
    .filter((dependency) => dependency.operationId === operationId)
    .slice()
    .sort((left, right) => left.dependsOnOperationId.localeCompare(right.dependsOnOperationId))
    .flatMap((dependency) => {
      const operation = snapshot.operations.find((candidate) => candidate.id === dependency.dependsOnOperationId);
      return operation ? [operation] : [];
    });
}

function toDependencyContext(snapshot: ForgeSnapshot, operationId: string, dependencyOperation: Operation): RunContextDependency {
  const dependency = snapshot.dependencies.find(
    (candidate) => candidate.operationId === operationId && candidate.dependsOnOperationId === dependencyOperation.id
  );

  return {
    id: dependency?.id ?? dependencyOperation.id,
    type: dependency?.type ?? "blocks",
    operation: {
      id: dependencyOperation.id,
      title: dependencyOperation.title,
      status: dependencyOperation.status,
      priority: dependencyOperation.priority,
      progress: dependencyOperation.progress,
      blockedReason: dependencyOperation.blockedReason
    },
    outputArtifacts: dependencyOperation.outputArtifactIds
      .flatMap((artifactId) => {
        const artifact = snapshot.artifacts.find((candidate) => candidate.id === artifactId);
        return artifact ? [artifact] : [];
      })
      .map(toContextArtifact)
  };
}

function selectRelevantArtifacts(
  snapshot: ForgeSnapshot,
  operationIds: Set<string>,
  divisionIds: Set<string>,
  workerIds: Set<string>,
  artifactIds: Set<string>,
  routing: ArtifactContextRouterResult
) {
  const decisionById = new Map(routing.artifacts.map((decision) => [decision.id, decision]));
  return snapshot.artifacts
    .filter(
      (artifact) =>
        artifactIds.has(artifact.id) ||
        (artifact.operationId ? operationIds.has(artifact.operationId) : false) ||
        (artifact.workerId ? workerIds.has(artifact.workerId) : false) ||
        divisionIds.has(artifact.divisionId)
    )
    .slice()
    .sort((left, right) => compareRoutedIds(left.id, right.id, decisionById) || compareArtifactRelevance(left, right));
}

function selectRelevantHandoffs(snapshot: ForgeSnapshot, operationId: string, operationDivisionId: string, dependencyDivisionIds: string[]) {
  const divisionIds = new Set([operationDivisionId, ...dependencyDivisionIds]);
  return snapshot.handoffs
    .filter((handoff) => handoff.targetOperationId === operationId || handoff.acceptedByOperationId === operationId || divisionIds.has(handoff.fromDivisionId) || divisionIds.has(handoff.toDivisionId))
    .slice()
    .sort((left, right) => handoffRelevanceScore(right, operationId, operationDivisionId) - handoffRelevanceScore(left, operationId, operationDivisionId) || compareCreatedThenId(left, right));
}

function selectRelevantFiles(
  snapshot: ForgeSnapshot,
  operation: Operation,
  manifestFileRefs: string[],
  artifactIds: Set<string>,
  routedFileIds: Set<string>,
  operationIds: Set<string>,
  divisionIds: Set<string>,
  workerIds: Set<string>,
  routing: ArtifactContextRouterResult
) {
  const manifestRefs = new Set(manifestFileRefs);
  const decisionById = new Map(routing.files.map((decision) => [decision.id, decision]));
  return snapshot.files
    .filter(
      (file) =>
        file.operationId === operation.id ||
        (file.operationId ? operationIds.has(file.operationId) : false) ||
        (file.workerId ? workerIds.has(file.workerId) : false) ||
        (file.divisionId ? divisionIds.has(file.divisionId) : false) ||
        file.artifactIds.some((artifactId) => artifactIds.has(artifactId)) ||
        routedFileIds.has(file.id) ||
        manifestRefs.has(file.path) ||
        manifestRefs.has(file.id)
    )
    .slice()
    .sort((left, right) => compareRoutedIds(left.id, right.id, decisionById) || compareFileRelevance(operation, manifestRefs, artifactIds, routedFileIds, divisionIds, workerIds)(left, right));
}

function buildFileContexts(
  files: VirtualFile[],
  sectionBudgetTokens: number,
  omittedContextReasons: string[],
  limits: { maxFileExcerptChars: number; maxTotalFileExcerptChars: number } = {
    maxFileExcerptChars: MAX_FILE_EXCERPT_CHARS,
    maxTotalFileExcerptChars: MAX_TOTAL_FILE_EXCERPT_CHARS
  }
): RunContextFile[] {
  let remainingTotal = Math.min(limits.maxTotalFileExcerptChars, sectionBudgetTokens * CHARS_PER_ESTIMATED_TOKEN);
  let remainingSectionTokens = sectionBudgetTokens;
  const contexts: RunContextFile[] = [];

  for (const file of files) {
    const emptyContext = toContextFile(file, 0);
    const emptyContextTokens = estimateTokens(emptyContext);
    if (emptyContextTokens > remainingSectionTokens && contexts.length > 0) {
      omittedContextReasons.push("virtual files omitted from files section because the estimated token budget was exhausted.");
      continue;
    }

    const budgetedExcerptLength = Math.max(0, (remainingSectionTokens - emptyContextTokens) * CHARS_PER_ESTIMATED_TOKEN);
    const allowedLength = Math.max(0, Math.min(limits.maxFileExcerptChars, remainingTotal, budgetedExcerptLength));
    const context = toContextFile(file, allowedLength);

    if (estimateTokens(context) > remainingSectionTokens && contexts.length > 0) {
      omittedContextReasons.push("virtual files omitted from files section because the estimated token budget was exhausted.");
      continue;
    }

    contexts.push(context);
    remainingTotal = Math.max(0, remainingTotal - context.excerpt.length);
    remainingSectionTokens = Math.max(0, remainingSectionTokens - estimateTokens(context));

    if (context.truncated) {
      omittedContextReasons.push(`file excerpt truncated for ${file.path}.`);
    }
  }

  return contexts;
}

function getFileContextLimits(operation: Operation, divisionName?: string) {
  if (!isValidationOrReleaseOperation(operation, divisionName)) {
    return {
      maxFileExcerptChars: MAX_FILE_EXCERPT_CHARS,
      maxTotalFileExcerptChars: MAX_TOTAL_FILE_EXCERPT_CHARS
    };
  }

  return {
    maxFileExcerptChars: MAX_VALIDATION_FILE_EXCERPT_CHARS,
    maxTotalFileExcerptChars: MAX_VALIDATION_TOTAL_FILE_EXCERPT_CHARS
  };
}

function isValidationOrReleaseOperation(operation: Operation, divisionName?: string) {
  const searchable = `${operation.divisionId} ${divisionName ?? ""} ${operation.title} ${operation.description}`.toLowerCase();
  return /\b(qa|quality|validate|validation|verify|verification|test|review|release|readiness|launch|deploy|deployment|acceptance)\b/.test(searchable);
}

function toContextFile(file: VirtualFile, excerptLimit: number): RunContextFile {
  const excerpt = file.content.slice(0, excerptLimit);

  return {
    id: file.id,
    path: file.path,
    status: file.status,
    version: file.version,
    divisionId: file.divisionId,
    workerId: file.workerId,
    operationId: file.operationId,
    artifactIds: file.artifactIds,
    updatedAt: file.updatedAt,
    excerpt,
    excerptRange: {
      start: 0,
      end: excerpt.length,
      total: file.content.length
    },
    truncated: excerpt.length < file.content.length
  };
}

function selectRelevantEvents(snapshot: ForgeSnapshot, operation: Operation, divisionIds: Set<string>, workerIds: Set<string>) {
  const operationIdsInDivisions = new Set(snapshot.operations.filter((candidate) => divisionIds.has(candidate.divisionId)).map((candidate) => candidate.id));

  return snapshot.events
    .filter((event) => {
      if (event.targetType === "forge" && event.targetId === snapshot.forge.id) {
        return true;
      }
      if (event.targetType === "repository") {
        return true;
      }
      if (event.targetType === "operation" && event.targetId && (event.targetId === operation.id || operationIdsInDivisions.has(event.targetId))) {
        return true;
      }
      if (event.targetType === "division" && event.targetId && divisionIds.has(event.targetId)) {
        return true;
      }
      if (event.targetType === "worker" && event.targetId && workerIds.has(event.targetId)) {
        return true;
      }
      return event.actorType === "worker" && Boolean(event.actorId && workerIds.has(event.actorId));
    })
    .slice()
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function toContextRepository(repository: ForgeRepositorySnapshot) {
  return {
    provider: repository.provider,
    owner: repository.owner,
    repo: repository.repo,
    defaultBranch: repository.defaultBranch,
    workingBranch: repository.workingBranch,
    syncStatus: repository.syncStatus,
    syncedFileCount: repository.syncedFileCount
  };
}

function toContextArtifact(artifact: Artifact): RunContextArtifact {
  return {
    id: artifact.id,
    title: artifact.title,
    type: artifact.type,
    divisionId: artifact.divisionId,
    workerId: artifact.workerId,
    operationId: artifact.operationId,
    status: artifact.status,
    version: artifact.version,
    tags: artifact.tags,
    fileIds: artifact.fileIds,
    contentSummary: summarize(artifact.content, MAX_ARTIFACT_SUMMARY_CHARS),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt
  };
}

function toContextHandoff(handoff: Handoff): RunContextHandoff {
  return {
    id: handoff.id,
    fromDivisionId: handoff.fromDivisionId,
    toDivisionId: handoff.toDivisionId,
    summary: handoff.summary,
    deliverables: handoff.deliverables,
    blockers: handoff.blockers,
    requiredContext: handoff.requiredContext,
    fromOperationId: handoff.fromOperationId,
    fromRunId: handoff.fromRunId,
    targetOperationId: handoff.targetOperationId,
    artifactIds: handoff.artifactIds,
    fileIds: handoff.fileIds,
    contextAttachmentSource: handoff.contextAttachmentSource,
    status: handoff.status,
    acceptedByOperationId: handoff.acceptedByOperationId,
    acceptedAt: handoff.acceptedAt,
    consumedAt: handoff.consumedAt,
    confidence: handoff.confidence,
    createdAt: handoff.createdAt
  };
}

function toContextEvent(event: ForgeSnapshot["events"][number]): RunContextEvent {
  return {
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    actorType: event.actorType,
    actorId: event.actorId,
    targetType: event.targetType,
    targetId: event.targetId,
    message: event.message,
    payloadSummary: summarizeRuntimeDiagnosticPayload(event),
    severity: event.severity,
    createdAt: event.createdAt
  };
}

function summarizeRuntimeDiagnosticPayload(event: ForgeSnapshot["events"][number]) {
  if (event.type === "launcher.log") {
    const output = typeof event.payload.output === "string" ? event.payload.output : "";
    return output ? `launcher log tail: ${summarize(output, 1200)}` : undefined;
  }
  if (event.type === "launcher.check_completed") {
    return compactObjectSummary({
      launcherId: event.payload.launcherId,
      status: event.payload.status,
      tier: event.payload.tier,
      command: event.payload.command,
      exitCode: event.payload.exitCode,
      timedOut: event.payload.timedOut,
      reason: event.payload.reason,
      availableScripts: event.payload.availableScripts
    });
  }
  if (event.type === "launcher.preview_failed") {
    return compactObjectSummary({
      launcherId: event.payload.launcherId,
      reason: event.payload.reason,
      command: event.payload.command,
      exitCode: event.payload.exitCode,
      timedOut: event.payload.timedOut
    });
  }
  return undefined;
}

function compactObjectSummary(value: Record<string, unknown>) {
  const compact = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ""));
  return Object.keys(compact).length > 0 ? summarize(JSON.stringify(compact), 1200) : undefined;
}

function toContextMessage(message: ForgeSnapshot["messages"][number]): RunContextMessage {
  return {
    id: message.id,
    role: message.role,
    summary: summarize(message.content, MAX_MESSAGE_SUMMARY_CHARS),
    createdAt: message.createdAt
  };
}

function compareArtifactRelevance(left: Artifact, right: Artifact) {
  return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
}

function compareRoutedIds<T extends { score: number; route: string }>(leftId: string, rightId: string, decisionById: Map<string, T>) {
  const left = decisionById.get(leftId);
  const right = decisionById.get(rightId);
  if (!left || !right) {
    return left ? -1 : right ? 1 : 0;
  }
  return routeRank(right.route) - routeRank(left.route) || right.score - left.score;
}

function routeRank(route: string) {
  switch (route) {
    case "required":
      return 3;
    case "recommended":
      return 2;
    case "optional":
      return 1;
    default:
      return 0;
  }
}

function compareFileRelevance(
  operation: Operation,
  manifestRefs: Set<string>,
  artifactIds: Set<string>,
  handoffFileIds: Set<string>,
  divisionIds: Set<string>,
  workerIds: Set<string>
) {
  return (left: VirtualFile, right: VirtualFile) => {
    const scoreDifference =
      fileRelevanceScore(right, operation, manifestRefs, artifactIds, handoffFileIds, divisionIds, workerIds) -
      fileRelevanceScore(left, operation, manifestRefs, artifactIds, handoffFileIds, divisionIds, workerIds);

    return scoreDifference || right.updatedAt.localeCompare(left.updatedAt) || left.path.localeCompare(right.path) || left.id.localeCompare(right.id);
  };
}

function fileRelevanceScore(
  file: VirtualFile,
  operation: Operation,
  manifestRefs: Set<string>,
  artifactIds: Set<string>,
  handoffFileIds: Set<string>,
  divisionIds: Set<string>,
  workerIds: Set<string>
) {
  return (
    (file.operationId === operation.id ? 1000 : 0) +
    (handoffFileIds.has(file.id) ? 900 : 0) +
    (manifestRefs.has(file.path) || manifestRefs.has(file.id) ? 600 : 0) +
    (file.artifactIds.some((artifactId) => artifactIds.has(artifactId)) ? 300 : 0) +
    (file.workerId && workerIds.has(file.workerId) ? 150 : 0) +
    (file.divisionId && divisionIds.has(file.divisionId) ? 75 : 0)
  );
}

function handoffRelevanceScore(handoff: Handoff, operationId: string, operationDivisionId: string) {
  return (
    (handoff.targetOperationId === operationId ? 1000 : 0) +
    (handoff.acceptedByOperationId === operationId ? 800 : 0) +
    (handoff.toDivisionId === operationDivisionId ? 400 : 0) +
    (handoff.status === "open" ? 100 : 0)
  );
}

function compareCreatedThenId(left: { id: string; createdAt: string }, right: { id: string; createdAt: string }) {
  return right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
}

function fitItemsToSectionBudget<T>(section: BudgetedSectionName, items: T[], sectionBudgetTokens: number, omittedContextReasons: string[]) {
  const selected: T[] = [];
  let usedTokens = 0;

  for (const item of items) {
    const itemTokens = estimateTokens(item);
    if (selected.length > 0 && usedTokens + itemTokens > sectionBudgetTokens) {
      omittedContextReasons.push(`${section} omitted from ${section} section because the estimated token budget was exhausted.`);
      continue;
    }
    selected.push(item);
    usedTokens += itemTokens;
  }

  return selected;
}

function createSectionBudgets(estimatedTokenBudget: number, baseContext: unknown, options: RunContextAssemblyOptions): Record<BudgetedSectionName, number> {
  const availableTokens = Math.max(0, estimatedTokenBudget - estimateTokens(baseContext));

  const weighted = {
    dependencies: Math.floor(availableTokens * SECTION_WEIGHTS.dependencies),
    artifacts: Math.floor(availableTokens * SECTION_WEIGHTS.artifacts),
    files: Math.floor(availableTokens * SECTION_WEIGHTS.files),
    handoffs: Math.floor(availableTokens * SECTION_WEIGHTS.handoffs),
    events: Math.floor(availableTokens * SECTION_WEIGHTS.events),
    messages: Math.floor(availableTokens * SECTION_WEIGHTS.messages)
  };

  return {
    dependencies: options.budget?.sections?.dependencies?.maxTokens ?? weighted.dependencies,
    artifacts: options.budget?.sections?.artifacts?.maxTokens ?? weighted.artifacts,
    files: options.budget?.sections?.files?.maxTokens ?? weighted.files,
    handoffs: options.budget?.sections?.handoffs?.maxTokens ?? weighted.handoffs,
    events: options.budget?.sections?.events?.maxTokens ?? weighted.events,
    messages: options.budget?.sections?.messages?.maxTokens ?? weighted.messages
  };
}

function fitPackageToTokenBudget(context: RunContextPackage, estimatedTokenBudget: number): RunContextPackage {
  let next = { ...context, omittedContextReasons: dedupeStrings(context.omittedContextReasons) };
  const omittedReasons = [...next.omittedContextReasons];
  const removalOrder: BudgetedSectionName[] = ["messages", "events", "handoffs", "artifacts", "dependencies", "files"];

  for (const section of removalOrder) {
    while (estimateContextTokens({ ...next, omittedContextReasons: dedupeStrings(omittedReasons) }) > estimatedTokenBudget && next[section].length > 0) {
      next = { ...next, [section]: next[section].slice(0, -1), omittedContextReasons: dedupeStrings(omittedReasons) };
      omittedReasons.push(`${section} omitted from ${section} section to fit the total estimated token budget.`);
    }
  }

  if (estimateContextTokens({ ...next, omittedContextReasons: dedupeStrings(omittedReasons) }) > estimatedTokenBudget && next.files.some((file) => file.excerpt.length > 0)) {
    next = {
      ...next,
      files: next.files.map((file) => ({
        ...file,
        excerpt: "",
        excerptRange: { ...file.excerptRange, end: 0 },
        truncated: file.excerptRange.total > 0
      }))
    };
    omittedReasons.push("file excerpts truncated to fit the total estimated token budget.");
  }

  return { ...next, omittedContextReasons: dedupeStrings(omittedReasons) };
}

function finalizeRoutingForContext(routing: ArtifactContextRouterResult, includedArtifactIds: string[], includedFileIds: string[]): ArtifactContextRouterResult {
  const includedArtifacts = new Set(includedArtifactIds);
  const includedFiles = new Set(includedFileIds);
  const routedArtifactIds = routing.artifacts.filter((decision) => decision.route !== "omitted").map((decision) => decision.id);
  const routedFileIds = routing.files.filter((decision) => decision.route !== "omitted").map((decision) => decision.id);
  const budgetOmittedArtifactIds = routedArtifactIds.filter((id) => !includedArtifacts.has(id));
  const budgetOmittedFileIds = routedFileIds.filter((id) => !includedFiles.has(id));

  return {
    ...routing,
    selectedArtifactIds: includedArtifactIds,
    selectedFileIds: includedFileIds,
    omittedArtifactIds: dedupeStrings([...routing.omittedArtifactIds, ...budgetOmittedArtifactIds]),
    omittedFileIds: dedupeStrings([...routing.omittedFileIds, ...budgetOmittedFileIds]),
    routingReasons: {
      ...routing.routingReasons,
      ...Object.fromEntries(budgetOmittedArtifactIds.map((id) => [id, "Omitted after routing because the artifact section cap or token budget was exhausted."])),
      ...Object.fromEntries(budgetOmittedFileIds.map((id) => [id, "Omitted after routing because the file section cap or token budget was exhausted."]))
    }
  };
}

function buildAccounting(context: RunContextPackage, estimatedTokenBudget: number, sectionBudgets: Record<BudgetedSectionName, number>) {
  const sections = {
    operation: usageFor("operation", estimatedTokenBudget, estimateTokens(context.operation), 1, 0, 0, []),
    worker: usageFor("worker", estimatedTokenBudget, estimateTokens(context.worker ?? {}), context.worker ? 1 : 0, 0, 0, []),
    division: usageFor("division", estimatedTokenBudget, estimateTokens(context.division ?? {}), context.division ? 1 : 0, 0, 0, []),
    dependencies: usageFor("dependencies", sectionBudgets.dependencies, estimateTokens(context.dependencies), context.dependencies.length, 0, countReasons(context, "dependencies"), reasonsFor(context, "dependencies")),
    files: usageFor("files", sectionBudgets.files, estimateTokens(context.files), context.files.length, context.files.filter((file) => file.truncated).length, countReasons(context, "file"), reasonsFor(context, "file")),
    artifacts: usageFor("artifacts", sectionBudgets.artifacts, estimateTokens(context.artifacts), context.artifacts.length, 0, countReasons(context, "artifact"), reasonsFor(context, "artifact")),
    handoffs: usageFor("handoffs", sectionBudgets.handoffs, estimateTokens(context.handoffs), context.handoffs.length, 0, countReasons(context, "handoff"), reasonsFor(context, "handoff")),
    events: usageFor("events", sectionBudgets.events, estimateTokens(context.events), context.events.length, 0, countReasons(context, "event"), reasonsFor(context, "event")),
    messages: usageFor("messages", sectionBudgets.messages, estimateTokens(context.messages), context.messages.length, 0, countReasons(context, "message"), reasonsFor(context, "message")),
    redactions: usageFor("redactions", Math.max(0, Math.floor(estimatedTokenBudget * 0.02)), estimateTokens(context.redactions), context.redactions.length, 0, 0, [])
  } satisfies Record<RunContextSectionKey, RunContextSectionUsage>;

  return {
    estimatedTokens: estimateContextTokens(context),
    budget: {
      totalTokens: estimatedTokenBudget,
      sections: Object.fromEntries(
        Object.entries(sections).map(([section, usage]) => [section, { maxTokens: usage.allocatedTokens }])
      ) as Record<RunContextSectionKey, { maxTokens: number }>
    },
    sections,
    omittedReasons: context.omittedContextReasons,
    routing: context.routing
  };
}

function usageFor(
  section: RunContextSectionKey,
  allocatedTokens: number,
  usedTokens: number,
  selectedItems: number,
  truncatedItems: number,
  omittedItems: number,
  reasons: string[]
): RunContextSectionUsage {
  return {
    section,
    allocatedTokens,
    usedTokens,
    selectedItems,
    truncatedItems,
    omittedItems,
    reasons
  };
}

function reasonsFor(context: RunContextPackage, pattern: string) {
  return context.omittedContextReasons.filter((reason) => reason.toLowerCase().includes(pattern));
}

function countReasons(context: RunContextPackage, pattern: string) {
  return reasonsFor(context, pattern).length;
}

function normalizeEstimatedTokenBudget(value: number | undefined) {
  if (value === undefined) {
    return DEFAULT_ESTIMATED_TOKEN_BUDGET;
  }
  return Math.max(MIN_ESTIMATED_TOKEN_BUDGET, Math.floor(value));
}

function estimateTokens(value: unknown) {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_ESTIMATED_TOKEN);
}

function estimateContextTokens(context: RunContextPackage) {
  return estimateTokens({ ...context, accounting: undefined, routing: undefined });
}

function summarize(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function dedupeStrings(values: string[]) {
  return Array.from(new Set(values));
}
