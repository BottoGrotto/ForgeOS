export type RuntimeStatus =
  | "idle"
  | "planning"
  | "ready"
  | "running"
  | "blocked"
  | "reviewing"
  | "paused"
  | "completed"
  | "failed"
  | "canceled"
  | "archived";

export type ArtifactStatus = "draft" | "generated" | "reviewed" | "finalized";
export type OperationPriority = "low" | "normal" | "high" | "critical";
export type DependencyType = "blocks" | "informs" | "reviews" | "produces_input_for";
export type WorkerKind = "executive" | "lead" | "worker";
export type OperationRoutingStage = "executive_planned" | "lead_triaged" | "worker_ready" | "running" | "done";
export type OperationWebAccessPolicy = "none" | "allowed" | "required";

export type RuntimeActorType = "operator" | "executive" | "division" | "worker" | "runtime";
export type RuntimeTargetType =
  | "forge"
  | "operation"
  | "run"
  | "repository"
  | "artifact"
  | "worker"
  | "division"
  | "file"
  | "handoff"
  | "chat";

export type RuntimeEventType =
  | "forge.initialized"
  | "division.status_changed"
  | "operation.created"
  | "operation.ready"
  | "operation.started"
  | "operation.blocked"
  | "operation.completed"
  | "operation.failed"
  | "operation.escalated"
  | "operation.deleted"
  | "operation.archived"
  | "worker.created"
  | "run.queued"
  | "run.started"
  | "run.progress"
  | "run.completed"
  | "run.failed"
  | "run.canceled"
  | "run.resumed"
  | "run.retry_requested"
  | "run.retry_started"
  | "run.retry_exhausted"
  | "run.context_checkpointed"
  | "context.routed"
  | "artifact.created"
  | "file.updated"
  | "handoff.created"
  | "handoff.accepted"
  | "handoff.consumed"
  | "worker.question_requested"
  | "worker.question_answered"
  | "worker.question_escalated"
  | "dependency.requested"
  | "dependency.approved"
  | "dependency.rejected"
  | "dependency.escalated"
  | "cycle.started"
  | "cycle.progress"
  | "cycle.completed"
  | "chat.message_added"
  | "executive.summary_created"
  | "executive.proposal_created"
  | "executive.proposal_applied"
  | "executive.proposal_rejected"
  | "executive.proposal_superseded"
  | "executive.proposal_failed"
  | "executive.review_requested"
  | "executive.review_approved"
  | "executive.review_rejected"
  | "executive.loop_started"
  | "executive.cycle_started"
  | "executive.plan_created"
  | "executive.plan_updated"
  | "executive.work_dispatched"
  | "executive.progress_reported"
  | "executive.user_input_requested"
  | "executive.user_input_answered"
  | "executive.loop_blocked"
  | "executive.loop_completed"
  | "repository.connected"
  | "repository.disconnected"
  | "repository.refreshed"
  | "repository.synced"
  | "github.connected"
  | "github.disconnected"
  | "launcher.materialized"
  | "launcher.check_started"
  | "launcher.check_completed"
  | "launcher.preview_started"
  | "launcher.preview_ready"
  | "launcher.preview_stopped"
  | "launcher.preview_failed"
  | "launcher.log"
  | "runtime.paused"
  | "runtime.resumed"
  | "runtime.spend_limit_updated"
  | "runtime.reset";

export type RuntimeCommandType =
  | "initialize_forge"
  | "start_phase"
  | "run_operation"
  | "scheduler_tick"
  | "run_bounded_cycle"
  | "run_full_flow"
  | "connect_repository"
  | "disconnect_repository"
  | "refresh_repository_context"
  | "sync_repository"
  | "pause_forge"
  | "resume_forge"
  | "shutdown_forge"
  | "set_openai_spend_limit"
  | "reset_demo_state"
  | "operator_message"
  | "propose_operation_changes"
  | "apply_operation_proposal"
  | "reject_operation_proposal"
  | "approve_executive_review"
  | "reject_executive_review"
  | "answer_worker_question"
  | "escalate_worker_question"
  | "approve_dependency_request"
  | "reject_dependency_request"
  | "escalate_dependency_request"
  | "start_executive_loop"
  | "continue_executive_loop"
  | "pause_executive_loop"
  | "resume_executive_loop"
  | "answer_executive_question"
  | "run_project_check"
  | "start_project_preview"
  | "stop_project_preview";

export interface RuntimeCommand {
  type: RuntimeCommandType;
  forgeId?: string;
  operationId?: string;
  phase?: string;
  message?: string;
  promptFileId?: string;
  promptFilePath?: string;
  proposalId?: string;
  reviewId?: string;
  dependencyRequestId?: string;
  workerQuestionId?: string;
  questionId?: string;
  selectedOptionIds?: string[];
  notes?: string;
  maxRuns?: number;
  dispatchPolicy?: "single_ready";
  repositoryUrl?: string;
  provider?: "github";
  agentProvider?: AgentProviderName;
  owner?: string;
  repo?: string;
  defaultBranch?: string;
  workingBranch?: string;
  ref?: string;
  installationId?: string;
  accountRef?: string;
  idempotencyKey?: string;
  openaiSpendLimitUsd?: number | null;
  launcherTier?: "development" | "acceptance";
  launcherScript?: "auto" | "test" | "typecheck" | "lint" | "build" | "smoke" | "e2e";
  previewScript?: "auto" | "dev" | "start" | "preview";
  launcherId?: string;
}

export interface RuntimeEvent {
  id: string;
  forgeId: string;
  sequence: number;
  type: RuntimeEventType;
  actorType: RuntimeActorType;
  actorId?: string;
  targetType?: RuntimeTargetType;
  targetId?: string;
  message: string;
  severity: "info" | "success" | "warning" | "error";
  payload: Record<string, unknown>;
  createdAt: string;
}

export type RuntimeEventDraft = Omit<RuntimeEvent, "id" | "sequence" | "createdAt">;

export interface Division {
  id: string;
  name: string;
  objective: string;
  status: RuntimeStatus;
  progress: number;
  order: number;
  leadWorkerId?: string;
}

export interface WorkerContextManifest {
  objective: string;
  instructionSources: string[];
  virtualFileRefs: string[];
  artifactRefs: string[];
  memorySnippets: string[];
  recentEventSummary: string[];
  redactions: string[];
}

export interface Worker {
  id: string;
  divisionId: string;
  name: string;
  role: string;
  kind: WorkerKind;
  managerWorkerId?: string;
  status: RuntimeStatus;
  currentTask?: string;
  contextManifest: WorkerContextManifest;
  externalAgentId?: string;
  provider?: AgentProviderName;
  providerMetadata?: Record<string, unknown>;
}

export interface Operation {
  id: string;
  divisionId: string;
  workerId?: string;
  title: string;
  description: string;
  status: RuntimeStatus;
  priority: OperationPriority;
  progress: number;
  blockedReason?: string;
  retryCount: number;
  outputArtifactIds: string[];
  routingStage: OperationRoutingStage;
  webAccessPolicy: OperationWebAccessPolicy;
  webAccessPurpose?: string;
  allowedDomains?: string[];
  escalatedFromOperationId?: string;
  escalationRunId?: string;
  escalationFailureCategory?: AgentFailureCategory;
}

export type AgentRunStatus = "queued" | "starting" | "running" | "streaming" | "completed" | "failed" | "canceled" | "resumed";
export type AgentProviderName = "mock" | "openclaw" | "codex" | "nemoclaw";

export interface AgentRunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  requestCount: number;
  costMicros?: number;
  costSource?: "provider" | "estimated" | "unknown";
  contextCompressionRatio?: number;
  cachedTokenRatio?: number;
  outputArtifactsPerInputToken?: number;
  outputFilesPerInputToken?: number;
  retryOverhead?: number;
  webEstimatedTokenImpact?: number;
}

export interface AgentRunRateLimit {
  quotaSource?: string;
  limit?: number;
  remaining?: number;
  resetAt?: string;
  retryAfterMs?: number;
  attempts?: number;
  terminalReason?: string;
}

export type AgentFailureCategory =
  | "schema_validation_failed"
  | "invalid_json"
  | "provider_timeout"
  | "provider_failed"
  | "network_error"
  | "rate_limited"
  | "provider_http_error"
  | "lead_triage_failed"
  | "runtime_exception"
  | "missing_requested_context"
  | "verification_failed"
  | "blocked_by_policy"
  | "empty_or_unusable_output";

export interface AgentRepairBrief {
  operationGoal: string;
  failureCategory: AgentFailureCategory;
  whatFailed: string;
  sanitizedErrors: string[];
  relevantOutputOmissions: string[];
  previousAttemptSummary?: string;
  projectedFileRefs?: string[];
  allowedNextActions: string[];
}

export interface AgentRunAttempt {
  attemptNumber: number;
  triggerReason: "initial" | "self_repair" | "lead_triage" | "executive_escalation";
  failureCategory?: AgentFailureCategory;
  retryBrief?: AgentRepairBrief;
  providerMetadata?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
}

export interface AgentRun {
  id: string;
  forgeId: string;
  operationId: string;
  workerId?: string;
  provider: AgentProviderName;
  externalRunId?: string;
  status: AgentRunStatus;
  capabilities: ProviderCapabilities;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  canceledAt?: string;
  error?: string;
  usage?: AgentRunUsage;
  rateLimit?: AgentRunRateLimit;
  providerMetadata: Record<string, unknown>;
}

export type RuntimeVerificationStatus = "passed" | "failed" | "skipped" | "error";

export interface RuntimeVerificationCheckSummary {
  name: string;
  status: RuntimeVerificationStatus;
  message?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  outputTail?: string;
}

export type RuntimeVerificationTier = "development" | "acceptance";

export interface RuntimeVerificationSummary {
  source: "runtime";
  status: RuntimeVerificationStatus;
  tier?: RuntimeVerificationTier;
  checkedAt: string;
  providerShellAccess: false;
  projectedArtifactIds: string[];
  projectedFileIds: string[];
  projectedHandoffIds: string[];
  blockerCount: number;
  checks?: RuntimeVerificationCheckSummary[];
  omittedReasons?: string[];
}

export interface RuntimeVerificationHookInput {
  snapshot: ForgeSnapshot;
  run: AgentRun;
  completedAt: string;
  projectedArtifactIds: string[];
  projectedFileIds: string[];
  projectedHandoffIds: string[];
  blockerCount: number;
}

export type RuntimeVerificationHook = (input: RuntimeVerificationHookInput) => RuntimeVerificationSummary | Promise<RuntimeVerificationSummary>;

export interface OperationDependency {
  id: string;
  operationId: string;
  dependsOnOperationId: string;
  type: DependencyType;
}

export interface Artifact {
  id: string;
  title: string;
  type: string;
  divisionId: string;
  workerId?: string;
  operationId?: string;
  content: string;
  status: ArtifactStatus;
  version: number;
  tags: string[];
  fileIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VirtualFile {
  id: string;
  path: string;
  content: string;
  status: ArtifactStatus;
  version: number;
  divisionId?: string;
  workerId?: string;
  operationId?: string;
  artifactIds: string[];
  updatedAt: string;
}

export interface Handoff {
  id: string;
  fromDivisionId: string;
  toDivisionId: string;
  fromOperationId?: string;
  fromRunId?: string;
  targetOperationId?: string;
  summary: string;
  deliverables: string[];
  blockers: string[];
  requiredContext: string[];
  artifactIds: string[];
  fileIds: string[];
  contextAttachmentSource?: "explicit" | "inferred";
  status: "open" | "accepted" | "consumed";
  acceptedByOperationId?: string;
  acceptedAt?: string;
  consumedAt?: string;
  confidence: number;
  createdAt: string;
}

export interface ExecutiveSummaryPayload {
  scope: "run" | "cycle" | "full_flow";
  status: string;
  runId?: string;
  operationId?: string;
  cycleId?: string;
  eventStartSequence?: number;
  eventEndSequence?: number;
  blockers: string[];
  handoffIds: string[];
  artifactIds: string[];
  fileIds: string[];
  metricDeltas: Record<string, number>;
}

export interface ExecutiveMessage {
  id: string;
  role: "operator" | "executive";
  kind?: "operator_prompt" | "executive_reply" | "executive_summary";
  source?: "manual" | "run_terminal" | "cycle_terminal" | "full_flow_terminal" | "executive_loop";
  content: string;
  runId?: string;
  operationId?: string;
  cycleId?: string;
  eventStartSequence?: number;
  eventEndSequence?: number;
  status?: string;
  summary?: ExecutiveSummaryPayload;
  createdAt: string;
}

export type ExecutiveProposalStatus = "pending" | "applied" | "rejected" | "superseded";

export type ExecutiveProposalAction =
  | {
      type: "create_worker";
      name: string;
      role: string;
      divisionId: string;
      currentTask?: string;
      status?: RuntimeStatus;
    }
  | {
      type: "create_operation";
      operationKey?: string;
      title: string;
      description: string;
      divisionId: string;
      workerId?: string;
      workerName?: string;
      priority?: OperationPriority;
      status?: RuntimeStatus;
      routingStage?: OperationRoutingStage;
      webAccessPolicy?: OperationWebAccessPolicy;
      webAccessPurpose?: string;
      allowedDomains?: string[];
      dependsOnOperationIds?: string[];
      dependsOnOperationKeys?: string[];
    }
  | {
      type: "update_operation";
      operationId: string;
      title?: string;
      description?: string;
      divisionId?: string;
      workerId?: string;
      priority?: OperationPriority;
      status?: RuntimeStatus;
      blockedReason?: string;
      routingStage?: OperationRoutingStage;
      webAccessPolicy?: OperationWebAccessPolicy;
      webAccessPurpose?: string;
      allowedDomains?: string[];
    }
  | {
      type: "delete_operation";
      operationId: string;
      reason: string;
    }
  | {
      type: "create_handoff";
      fromDivisionId: string;
      toDivisionId: string;
      targetOperationId?: string;
      summary: string;
      deliverables?: string[];
      blockers?: string[];
      requiredContext?: string[];
      confidence?: number;
    }
  | {
      type: "create_blocker";
      operationId: string;
      reason: string;
      severity?: RuntimeEvent["severity"];
    };

export interface ExecutiveProposalDraft {
  summary: string;
  actions: ExecutiveProposalAction[];
  supersedesProposalIds?: string[];
  userQuestion?: ExecutiveUserQuestion;
}

export interface ExecutiveProposal extends ExecutiveProposalDraft {
  id: string;
  status: ExecutiveProposalStatus;
  sourceMessageId: string;
  provider: "mock" | "openai";
  model?: string;
  createdAt: string;
  updatedAt?: string;
}

export type ExecutiveLoopStatus = "idle" | "planning" | "dispatching" | "observing" | "replanning" | "waiting_for_user" | "blocked" | "ready_for_test" | "completed" | "failed" | "paused";

export interface ExecutiveLoop {
  id: string;
  forgeId: string;
  status: ExecutiveLoopStatus;
  userGoal: string;
  sourcePromptFileId?: string;
  sourcePromptFilePath?: string;
  activePlanId?: string;
  cycleCount: number;
  maxCycles: number;
  lastReportId?: string;
  blockerReason?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ExecutiveCycle {
  id: string;
  loopId: string;
  forgeId: string;
  sequence: number;
  status: "started" | "dispatched" | "observed" | "replanned" | "blocked" | "completed";
  startedAt: string;
  completedAt?: string;
  summary?: string;
  dispatchedRunIds: string[];
  observedRunIds: string[];
  createdOperationIds: string[];
  blockerReasons?: string[];
}

export interface ExecutivePlanPhase {
  id: string;
  title: string;
  objective: string;
  divisionIds: string[];
  operationIds: string[];
  status: "pending" | "running" | "blocked" | "completed";
}

export interface ExecutiveProjectPlan {
  id: string;
  forgeId: string;
  loopId: string;
  status: "draft" | "active" | "superseded" | "completed";
  goal: string;
  successCriteria: string[];
  assumptions: string[];
  phases: ExecutivePlanPhase[];
  risks: string[];
  testStrategy: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExecutiveReport {
  id: string;
  loopId: string;
  forgeId: string;
  kind: "initial_plan" | "progress" | "blocker" | "ready_for_test" | "final";
  summary: string;
  completed: string[];
  inProgress: string[];
  blocked: string[];
  nextActions: string[];
  filesChanged: string[];
  testsRun: string[];
  createdAt: string;
}

export interface ExecutiveManagerDecision {
  summary: string;
  projectStatus: "planning" | "running" | "blocked" | "ready_for_test" | "completed";
  userReport: string;
  planPatch?: {
    successCriteria?: string[];
    assumptions?: string[];
    phases?: Array<{
      title: string;
      objective: string;
      divisionIds?: string[];
    }>;
    risks?: string[];
    testStrategy?: string[];
  };
  operationActions: ExecutiveProposalAction[];
  dispatchPolicy: {
    maxRuns: number;
    targetDivisionIds?: string[];
    priority?: "critical_first" | "balanced" | "qa_first";
  };
  userQuestion?: ExecutiveUserQuestion;
}

export interface ExecutiveQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface ExecutiveUserQuestion {
  reason: string;
  question: string;
  options?: ExecutiveQuestionOption[];
  allowNotes?: boolean;
}

export interface ExecutiveIntentInput {
  forgeId: string;
  message: string;
  snapshot: ForgeSnapshot;
}

export interface ExecutiveIntentProvider {
  proposeOperationChanges(input: ExecutiveIntentInput): Promise<ExecutiveProposalDraft>;
  decideNextExecutiveAction?(input: ExecutiveIntentInput & { loop?: ExecutiveLoop; plan?: ExecutiveProjectPlan }): Promise<ExecutiveManagerDecision>;
  getProviderInfo(): { provider: ExecutiveProposal["provider"]; model?: string };
}

export interface ForgeRepositorySnapshot {
  id: string;
  provider: "github";
  owner: string;
  repo: string;
  defaultBranch: string;
  workingBranch: string;
  installationId?: string;
  accountRef?: string;
  connectedAt: string;
  lastRefreshedAt?: string;
  syncStatus?: "idle" | "syncing" | "completed" | "failed";
  syncError?: string;
  lastSyncStartedAt?: string;
  lastSyncCompletedAt?: string;
  syncedFileCount?: number;
  authenticatedAccountLogin?: string;
}

export interface ForgeSnapshot {
  forge: {
    id: string;
    slug: string;
    name: string;
    tagline: string;
    activePhase: string;
    status: "active" | "paused" | "archived";
    openaiSpendLimitMicros?: number;
  };
  repository?: ForgeRepositorySnapshot;
  lastEventSequence: number;
  schemaVersion: number;
  divisions: Division[];
  workers: Worker[];
  operations: Operation[];
  runs: AgentRun[];
  dependencies: OperationDependency[];
  artifacts: Artifact[];
  files: VirtualFile[];
  handoffs: Handoff[];
  messages: ExecutiveMessage[];
  proposals: ExecutiveProposal[];
  executiveLoops: ExecutiveLoop[];
  executiveCycles: ExecutiveCycle[];
  executivePlans: ExecutiveProjectPlan[];
  executiveReports: ExecutiveReport[];
  events: RuntimeEvent[];
}

export interface RunContextForge {
  id: string;
  slug: string;
  name: string;
  activePhase: string;
  status: ForgeSnapshot["forge"]["status"];
  repository?: {
    provider: "github";
    owner: string;
    repo: string;
    defaultBranch: string;
    workingBranch: string;
    syncStatus?: ForgeRepositorySnapshot["syncStatus"];
    syncedFileCount?: number;
  };
}

export interface RunContextOperation {
  id: string;
  divisionId: string;
  workerId?: string;
  title: string;
  description: string;
  status: RuntimeStatus;
  priority: OperationPriority;
  retryCount: number;
  blockedReason?: string;
  blockers: string[];
  outputArtifactIds: string[];
  routingStage: OperationRoutingStage;
  webAccessPolicy: OperationWebAccessPolicy;
  webAccessPurpose?: string;
  allowedDomains?: string[];
  escalatedFromOperationId?: string;
  escalationRunId?: string;
  escalationFailureCategory?: AgentFailureCategory;
}

export interface RunContextWorker {
  id: string;
  divisionId: string;
  name: string;
  role: string;
  kind: WorkerKind;
  managerWorkerId?: string;
  status: RuntimeStatus;
  currentTask?: string;
  provider?: AgentProviderName;
  contextManifest: WorkerContextManifest;
}

export interface RunContextDivision {
  id: string;
  name: string;
  objective: string;
  status: RuntimeStatus;
  progress: number;
  order: number;
  leadWorkerId?: string;
}

export interface RunContextArtifact {
  id: string;
  title: string;
  type: string;
  divisionId: string;
  workerId?: string;
  operationId?: string;
  status: ArtifactStatus;
  version: number;
  tags: string[];
  fileIds: string[];
  contentSummary: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunContextDependency {
  id: string;
  type: DependencyType;
  operation: {
    id: string;
    title: string;
    status: RuntimeStatus;
    priority: OperationPriority;
    progress: number;
    blockedReason?: string;
  };
  outputArtifacts: RunContextArtifact[];
}

export interface RunContextFile {
  id: string;
  path: string;
  status: ArtifactStatus;
  version: number;
  divisionId?: string;
  workerId?: string;
  operationId?: string;
  artifactIds: string[];
  updatedAt: string;
  excerpt: string;
  excerptRange: {
    start: number;
    end: number;
    total: number;
  };
  truncated: boolean;
}

export interface RunContextHandoff {
  id: string;
  fromDivisionId: string;
  toDivisionId: string;
  fromOperationId?: string;
  fromRunId?: string;
  targetOperationId?: string;
  summary: string;
  deliverables: string[];
  blockers: string[];
  requiredContext: string[];
  artifactIds: string[];
  fileIds: string[];
  contextAttachmentSource?: Handoff["contextAttachmentSource"];
  status: Handoff["status"];
  acceptedByOperationId?: string;
  acceptedAt?: string;
  consumedAt?: string;
  confidence: number;
  createdAt: string;
}

export interface RunContextEvent {
  id: string;
  sequence: number;
  type: RuntimeEventType;
  actorType: RuntimeActorType;
  actorId?: string;
  targetType?: RuntimeTargetType;
  targetId?: string;
  message: string;
  payloadSummary?: string;
  severity: RuntimeEvent["severity"];
  createdAt: string;
}

export interface RunContextMessage {
  id: string;
  role: ExecutiveMessage["role"];
  summary: string;
  createdAt: string;
}

export type RunContextSectionKey =
  | "operation"
  | "worker"
  | "division"
  | "dependencies"
  | "files"
  | "artifacts"
  | "handoffs"
  | "events"
  | "messages"
  | "redactions";

export type WorkerAllowedAction = "declare_artifact" | "declare_virtual_file" | "declare_handoff" | "declare_blocker" | "request_file" | "emit_progress";

export interface RunContextSectionBudget {
  maxTokens: number;
}

export interface RunContextBudget {
  totalTokens: number;
  sections: Record<RunContextSectionKey, RunContextSectionBudget>;
}

export interface RunContextAssemblyOptions {
  estimatedTokenBudget?: number;
  budget?: {
    totalTokens?: number;
    sections?: Partial<Record<RunContextSectionKey, Partial<RunContextSectionBudget>>>;
  };
}

export interface RunContextSectionUsage {
  section: RunContextSectionKey;
  allocatedTokens: number;
  usedTokens: number;
  selectedItems: number;
  truncatedItems: number;
  omittedItems: number;
  reasons: string[];
}

export interface RunContextAccounting {
  estimatedTokens: number;
  budget: RunContextBudget;
  sections: Record<RunContextSectionKey, RunContextSectionUsage>;
  omittedReasons: string[];
  routing?: ArtifactContextRouterResult;
}

export type ArtifactContextRoute = "required" | "recommended" | "optional" | "omitted";

export type ArtifactContextRouteReason =
  | "targeted_handoff"
  | "accepted_handoff"
  | "dependency_output"
  | "worker_manifest"
  | "operation_output"
  | "operation_owned"
  | "same_worker"
  | "same_division"
  | "linked_artifact"
  | "unrelated"
  | "missing_reference";

export interface ArtifactContextRoutingDecision {
  id: string;
  kind: "artifact" | "file";
  route: ArtifactContextRoute;
  reason: ArtifactContextRouteReason;
  score: number;
  explanation: string;
}

export interface ArtifactContextRouterInput {
  snapshot: ForgeSnapshot;
  operation: Operation;
  dependencyOperations: Operation[];
  handoffs: Handoff[];
  workerManifestArtifactRefs: string[];
  workerManifestFileRefs: string[];
}

export interface ArtifactContextRouterResult {
  artifacts: ArtifactContextRoutingDecision[];
  files: ArtifactContextRoutingDecision[];
  selectedArtifactIds: string[];
  selectedFileIds: string[];
  omittedArtifactIds: string[];
  omittedFileIds: string[];
  routingReasons: Record<string, string>;
}

export interface WorkerInstructionEnvelope {
  role: string;
  objective: string;
  operationId: string;
  workerId?: string;
  divisionId: string;
  allowedActions: WorkerAllowedAction[];
    outputSchema: {
      artifacts: string;
      files: string;
      filePatches?: string;
      requestedFiles?: string;
      requestedSearches?: string;
      requestedArtifacts?: string;
      handoffs: string;
      blockers: string;
      dangerousActions?: string;
      dependencyRequests?: string;
      recoveryActions?: string;
      progress: string;
      verificationEvidence?: string;
      verification?: string;
  };
  communicationObligations: string[];
  stopConditions: string[];
}

export interface ProviderPromptPackage {
  version: "forgeos-provider-prompt-v1";
  estimatedTokens: number;
  instructions: {
    role: string;
    objective: string;
    operationId: string;
    workerId?: string;
    divisionId: string;
    allowedActions: WorkerAllowedAction[];
    responseFormat: string;
    stopConditions: string[];
  };
  context: {
    forge: Pick<RunContextForge, "id" | "slug" | "name" | "activePhase" | "status"> & {
      repository?: RunContextForge["repository"];
    };
    operation: Pick<
      RunContextOperation,
      | "id"
      | "title"
      | "description"
      | "status"
      | "priority"
      | "retryCount"
      | "blockedReason"
      | "routingStage"
      | "webAccessPolicy"
      | "webAccessPurpose"
      | "allowedDomains"
      | "escalatedFromOperationId"
      | "escalationRunId"
      | "escalationFailureCategory"
    >;
    worker?: Pick<RunContextWorker, "id" | "divisionId" | "name" | "role" | "status" | "currentTask"> & {
      kind?: WorkerKind;
      managerWorkerId?: string;
      expertise?: {
        objective: string;
        instructionSources: string[];
        memorySnippets: string[];
        recentEventSummary: string[];
      };
    };
    division?: Pick<RunContextDivision, "id" | "name" | "objective" | "status" | "progress" | "leadWorkerId">;
    dependencies: Array<{
      id: string;
      type: RunContextDependency["type"];
      operation: Pick<RunContextDependency["operation"], "id" | "title" | "status" | "priority" | "progress" | "blockedReason">;
    }>;
    files: Array<Pick<RunContextFile, "id" | "path" | "status" | "version" | "excerpt" | "truncated">>;
    artifacts: Array<Pick<RunContextArtifact, "id" | "title" | "type" | "status" | "contentSummary" | "tags">>;
    handoffs: Array<Pick<RunContextHandoff, "id" | "fromDivisionId" | "toDivisionId" | "targetOperationId" | "summary" | "deliverables" | "blockers" | "requiredContext" | "status" | "confidence">>;
    recentEvents: Array<Pick<RunContextEvent, "type" | "actorType" | "targetType" | "targetId" | "message" | "payloadSummary" | "severity" | "createdAt">>;
    recentMessages: Array<Pick<RunContextMessage, "role" | "summary" | "createdAt">>;
    omittedReasons: string[];
    redactions: string[];
    longRunCheckpoint?: RunContextCheckpoint;
  };
  repairBrief?: AgentRepairBrief;
}

export interface RunContextPackage {
  forge: RunContextForge;
  operation: RunContextOperation;
  worker?: RunContextWorker;
  division?: RunContextDivision;
  dependencies: RunContextDependency[];
  artifacts: RunContextArtifact[];
  files: RunContextFile[];
  handoffs: RunContextHandoff[];
  events: RunContextEvent[];
  messages: RunContextMessage[];
  redactions: string[];
  omittedContextReasons: string[];
  accounting?: RunContextAccounting;
  routing?: ArtifactContextRouterResult;
  instructionEnvelope?: WorkerInstructionEnvelope;
}

export interface ProviderCapabilities {
  streamsEvents: boolean;
  supportsCancel: boolean;
  supportsResume: boolean;
  supportsRetries: boolean;
  supportsWorkspaceRefs: boolean;
  supportsWebSearch: boolean;
}

export interface RunOperationInput {
  forgeId: string;
  operationId: string;
  context: RunContextPackage;
  providerPrompt: ProviderPromptPackage;
  instructions?: WorkerInstructionEnvelope;
}

export interface ProviderArtifactDeclaration {
  title: string;
  type: string;
  content: string;
  tags?: string[];
}

export interface ProviderFileDeclaration {
  path: string;
  content: string;
}

export interface ProviderFilePatchDeclaration {
  path: string;
  find: string;
  replace: string;
}

export interface ProviderHandoffDeclaration {
  toDivisionId: string;
  targetOperationId?: string;
  summary: string;
  deliverables?: string[];
  blockers?: string[];
  requiredContext?: string[];
  artifactIds?: string[];
  fileIds?: string[];
  confidence?: number;
}

export interface ProviderBlockerDeclaration {
  reason: string;
  severity?: RuntimeEvent["severity"];
  attemptsMade?: string[];
  whySelfSolveInsufficient?: string;
}

export interface ProviderDangerousActionDeclaration {
  action: string;
  reason: string;
  command?: string;
}

export type ProviderDependencyRequestType = "dependency" | "devDependency" | "optionalDependency";

export interface ProviderDependencyRequestDeclaration {
  packageName: string;
  versionRange?: string;
  dependencyType: ProviderDependencyRequestType;
  reason: string;
  usedByFiles?: string[];
  alternativesConsidered?: string[];
  requiresExecutive?: boolean;
}

export interface ProviderFileReadRequestDeclaration {
  id?: string;
  path?: string;
  reason?: string;
}

export interface ProviderFileSearchRequestDeclaration {
  query: string;
  glob?: string;
  reason?: string;
}

export interface ProviderArtifactRequestDeclaration {
  id?: string;
  title?: string;
  type?: string;
  reason?: string;
}

export type ProviderWorkerQuestionCategory = "scope_approval" | "product_decision" | "policy_exception" | "external_authority" | "upstream_dependency";

export interface ProviderWorkerQuestionRequestDeclaration {
  question: string;
  reason: string;
  category?: ProviderWorkerQuestionCategory;
  scope?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  needsExecutive?: boolean;
  recommendedDefault?: string;
  attemptsMade?: string[];
  whySelfSolveInsufficient?: string;
}

export interface ProviderVerificationEvidenceDeclaration {
  commands: string[];
  expectedScripts: string[];
  summary?: string;
  knownGaps: string[];
}

export type ProviderRecoveryActionDeclaration =
  | {
      type: "revise_operation";
      targetOperationId: string;
      title?: string;
      description?: string;
      workerId?: string;
      reason?: string;
    }
  | {
      type: "create_replacement_operation";
      title: string;
      description: string;
      workerId?: string;
      priority?: OperationPriority;
      reason?: string;
    }
  | {
      type: "request_more_context";
      targetOperationId: string;
      reason: string;
    }
  | {
      type: "escalate_to_executive";
      targetOperationId: string;
      reason: string;
      recommendedNextAction?: string;
    };

export interface ProviderRunOutputDeclarations {
  artifacts: ProviderArtifactDeclaration[];
  files: ProviderFileDeclaration[];
  filePatches: ProviderFilePatchDeclaration[];
  requestedFiles: ProviderFileReadRequestDeclaration[];
  requestedSearches: ProviderFileSearchRequestDeclaration[];
  requestedArtifacts: ProviderArtifactRequestDeclaration[];
  handoffs: ProviderHandoffDeclaration[];
  blockers: ProviderBlockerDeclaration[];
  questionRequests: ProviderWorkerQuestionRequestDeclaration[];
  verificationEvidence?: ProviderVerificationEvidenceDeclaration;
  dangerousActions: ProviderDangerousActionDeclaration[];
  dependencyRequests: ProviderDependencyRequestDeclaration[];
  recoveryActions: ProviderRecoveryActionDeclaration[];
}

export interface RunTraceSummary {
  context?: {
    estimatedTokens: number;
    providerEstimatedTokens?: number;
    budgetTokens: number;
    compressionRatio?: number;
    sections: Array<{
      section: RunContextSectionKey;
      allocatedTokens: number;
      usedTokens: number;
      selectedItems: number;
      omittedItems: number;
      truncatedItems: number;
    }>;
    omittedReasons: string[];
    routedArtifacts?: string[];
    routedFiles?: string[];
    omittedArtifacts?: string[];
    omittedFiles?: string[];
    routingReasons?: Record<string, string>;
  };
  outputs?: {
    artifactCount: number;
    fileCount: number;
    filePatchCount?: number;
    handoffCount: number;
    blockerCount: number;
    questionRequestCount?: number;
    dangerousActionCount?: number;
    dependencyRequestCount?: number;
    recoveryActionCount?: number;
    requestedFileCount?: number;
    requestedSearchCount?: number;
    requestedArtifactCount?: number;
    verificationEvidence?: ProviderVerificationEvidenceDeclaration;
    omittedCount: number;
    omissionReasons: string[];
  };
  lifecycle?: {
    provider: AgentProviderName;
    status: AgentRunStatus;
    completedAt?: string;
    failedAt?: string;
    canceledAt?: string;
    selfRepairAttemptCount?: number;
    schemaRepairAttemptCount?: number;
    escalationCount?: number;
    finalFailureCategory?: AgentFailureCategory;
  };
  checkpoint?: RunContextCheckpoint;
}

export interface RunContextCheckpoint {
  checkpointNumber: number;
  activeDurationMs: number;
  summary: string;
  latestActivity: string;
  nextAction: string;
  risk: string;
  sourceEventSequenceStart: number;
  sourceEventSequenceEnd: number;
  createdAt: string;
}

export interface RunHandle {
  runId: string;
  externalRunId?: string;
  provider: AgentProviderName;
  capabilities: ProviderCapabilities;
}

export interface AgentRuntime {
  provider(): AgentProviderName;
  runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft>;
  cancelOperation(operationId: string): Promise<void>;
  capabilities(): ProviderCapabilities;
}

export interface WorkspaceAdapter {
  readVirtualFile(fileId: string): Promise<VirtualFile | null>;
  listVirtualFiles(forgeId: string): Promise<VirtualFile[]>;
  syncToWorkspace?(forgeId: string): Promise<RuntimeEventDraft[]>;
}
