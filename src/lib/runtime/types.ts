export type RuntimeStatus =
  | "idle"
  | "planning"
  | "ready"
  | "running"
  | "blocked"
  | "reviewing"
  | "completed"
  | "failed"
  | "canceled";

export type ArtifactStatus = "draft" | "generated" | "reviewed" | "finalized";
export type OperationPriority = "low" | "normal" | "high" | "critical";
export type DependencyType = "blocks" | "informs" | "reviews" | "produces_input_for";

export type RuntimeActorType = "operator" | "executive" | "division" | "worker" | "runtime";
export type RuntimeTargetType =
  | "forge"
  | "operation"
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
  | "artifact.created"
  | "file.updated"
  | "handoff.created"
  | "chat.message_added"
  | "runtime.reset";

export type RuntimeCommandType =
  | "initialize_forge"
  | "start_phase"
  | "run_operation"
  | "run_full_flow"
  | "reset_demo_state"
  | "operator_message";

export interface RuntimeCommand {
  type: RuntimeCommandType;
  forgeId?: string;
  operationId?: string;
  phase?: string;
  message?: string;
  idempotencyKey?: string;
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
  status: RuntimeStatus;
  currentTask?: string;
  contextManifest: WorkerContextManifest;
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
}

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
  summary: string;
  deliverables: string[];
  blockers: string[];
  requiredContext: string[];
  confidence: number;
  createdAt: string;
}

export interface ExecutiveMessage {
  id: string;
  role: "operator" | "executive";
  content: string;
  createdAt: string;
}

export interface ForgeSnapshot {
  forge: {
    id: string;
    slug: string;
    name: string;
    tagline: string;
    activePhase: string;
    status: "active" | "archived";
  };
  lastEventSequence: number;
  schemaVersion: number;
  divisions: Division[];
  workers: Worker[];
  operations: Operation[];
  dependencies: OperationDependency[];
  artifacts: Artifact[];
  files: VirtualFile[];
  handoffs: Handoff[];
  messages: ExecutiveMessage[];
  events: RuntimeEvent[];
}

export interface ProviderCapabilities {
  streamsEvents: boolean;
  supportsCancel: boolean;
  supportsResume: boolean;
  supportsRetries: boolean;
  supportsWorkspaceRefs: boolean;
}

export interface RunOperationInput {
  forgeId: string;
  operationId: string;
}

export interface RunHandle {
  runId: string;
  provider: "mock" | "nemoclaw";
  capabilities: ProviderCapabilities;
}

export interface AgentRuntime {
  runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft>;
  cancelOperation(operationId: string): Promise<void>;
  capabilities(): ProviderCapabilities;
}

export interface WorkspaceAdapter {
  readVirtualFile(fileId: string): Promise<VirtualFile | null>;
  listVirtualFiles(forgeId: string): Promise<VirtualFile[]>;
  syncToWorkspace?(forgeId: string): Promise<RuntimeEventDraft[]>;
}
