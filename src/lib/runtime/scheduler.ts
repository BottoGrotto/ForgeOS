import type { ForgeSnapshot, Operation, OperationPriority, RuntimeEventDraft } from "./types";
import { calculateOperationReadiness } from "./metrics";
import { isActiveRun } from "./runs";

const priorityRank: Record<OperationPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3
};

export function getBlockingDependencyIds(snapshot: ForgeSnapshot, operationId: string) {
  return snapshot.dependencies
    .filter((dependency) => dependency.operationId === operationId && dependency.type === "blocks")
    .map((dependency) => dependency.dependsOnOperationId);
}

export function resolveReadyOperations(snapshot: ForgeSnapshot): Operation[] {
  if (snapshot.forge.status !== "active") {
    return [];
  }

  const activeRuns = snapshot.runs.filter((run) => isActiveRun(run));
  const activeOperationIds = new Set(activeRuns.map((run) => run.operationId));
  const activeWorkerIds = new Set(activeRuns.flatMap((run) => (run.workerId ? [run.workerId] : [])));

  return snapshot.operations
    .filter((operation) => isEligibleReadyOperation(snapshot, operation, activeOperationIds, activeWorkerIds))
    .slice()
    .sort((left, right) => compareScheduledOperations(snapshot, left, right));
}

export function createReadinessEvents(snapshot: ForgeSnapshot): RuntimeEventDraft[] {
  return resolveReadyOperations(snapshot).map((operation) => ({
    forgeId: snapshot.forge.id,
    type: "operation.ready",
    actorType: "runtime",
    targetType: "operation",
    targetId: operation.id,
    message: `${operation.title} is ready for assignment.`,
    severity: "info",
    payload: { operationId: operation.id }
  }));
}

export function calculateSnapshotOperationReadiness(snapshot: ForgeSnapshot, operation: Operation) {
  const dependencyIds = getBlockingDependencyIds(snapshot, operation.id);
  const dependencyReadiness = calculateOperationReadiness(operation, snapshot.operations, dependencyIds);
  if (!dependencyReadiness.ready) {
    return dependencyReadiness;
  }

  if (requiresProjectScaffold(snapshot, operation) && !hasProjectScaffold(snapshot)) {
    return {
      ready: false,
      reason: "Waiting for project scaffold files before implementation work can run."
    };
  }

  if (dependencyIds.length === 0 && requiresCompletedUpstreamDeliverables(snapshot, operation) && !hasCompletedImplementationFiles(snapshot)) {
    return {
      ready: false,
      reason: "Waiting for implementation files before validation, QA, release, or deployment work can run."
    };
  }

  if (!requiresCompletedUpstreamDeliverables(snapshot, operation)) {
    return { ready: true };
  }

  const missingOutputDependencies = dependencyIds
    .map((id) => snapshot.operations.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Operation => Boolean(candidate))
    .filter((dependency) => !hasOperationDeliverablesFor(snapshot, dependency, operation));

  if (missingOutputDependencies.length === 0) {
    return { ready: true };
  }

  return {
    ready: false,
    reason: `Waiting for deliverables from ${missingOutputDependencies.map((dependency) => dependency.title).join(", ")}`
  };
}

function isEligibleReadyOperation(
  snapshot: ForgeSnapshot,
  operation: Operation,
  activeOperationIds: Set<string>,
  activeWorkerIds: Set<string>
) {
  if (operation.status !== "ready") {
    return false;
  }

  if (!isRoutingStageRunnable(snapshot, operation)) {
    return false;
  }

  if (activeOperationIds.has(operation.id)) {
    return false;
  }

  if (operation.workerId && activeWorkerIds.has(operation.workerId)) {
    return false;
  }

  return calculateSnapshotOperationReadiness(snapshot, operation).ready;
}

function isRoutingStageRunnable(snapshot: ForgeSnapshot, operation: Operation) {
  const worker = operation.workerId ? snapshot.workers.find((candidate) => candidate.id === operation.workerId) : undefined;
  if (worker?.kind === "lead" || worker?.kind === "executive") {
    return operation.routingStage === "lead_triaged" || operation.routingStage === "worker_ready";
  }
  return operation.routingStage === "worker_ready";
}

function compareScheduledOperations(snapshot: ForgeSnapshot, left: Operation, right: Operation) {
  const priority = priorityRank[left.priority] - priorityRank[right.priority];
  if (priority !== 0) {
    return priority;
  }

  const depth = getBlockingDependencyDepth(snapshot, left.id) - getBlockingDependencyDepth(snapshot, right.id);
  if (depth !== 0) {
    return depth;
  }

  return left.id.localeCompare(right.id);
}

function getBlockingDependencyDepth(snapshot: ForgeSnapshot, operationId: string, seenOperationIds = new Set<string>()): number {
  if (seenOperationIds.has(operationId)) {
    return 0;
  }

  const nextSeenOperationIds = new Set(seenOperationIds).add(operationId);
  const dependencyDepths = getBlockingDependencyIds(snapshot, operationId)
    .filter((dependencyId) => snapshot.operations.some((operation) => operation.id === dependencyId))
    .map((dependencyId) => 1 + getBlockingDependencyDepth(snapshot, dependencyId, nextSeenOperationIds));

  return dependencyDepths.length === 0 ? 0 : Math.max(...dependencyDepths);
}

function requiresCompletedUpstreamDeliverables(snapshot: ForgeSnapshot, operation: Operation) {
  const division = snapshot.divisions.find((candidate) => candidate.id === operation.divisionId);
  const searchable = `${division?.name ?? ""} ${operation.title} ${operation.description}`.toLowerCase();
  if (isProjectScaffoldOperation(searchable)) {
    return false;
  }
  return /\b(qa|quality|review|validate|validation|test|release|launch|deploy|package)\b/.test(searchable);
}

function requiresProjectScaffold(snapshot: ForgeSnapshot, operation: Operation) {
  const division = snapshot.divisions.find((candidate) => candidate.id === operation.divisionId);
  const searchable = `${division?.name ?? ""} ${operation.title} ${operation.description}`.toLowerCase();
  if (requiresCompletedUpstreamDeliverables(snapshot, operation)) {
    return false;
  }
  if (/\b(plan|planning|design|research|requirements|assess|triage|recover|recovery|review)\b/.test(searchable)) {
    return false;
  }
  const isBuildAction = /\b(build|implement|develop|code|create|generate)\b/.test(searchable);
  const isAppImplementation = /\b(frontend|front-end|ui|ux|page|screen|website|web app|component|route|app shell|react|next\.js|nextjs|css|html)\b/.test(searchable);
  return isBuildAction && isAppImplementation && !isProjectScaffoldOperation(searchable);
}

function isProjectScaffoldOperation(searchable: string) {
  return /\b(scaffold|bootstrap|initialize|initialise|set up|setup|create project|project structure|package manifest|package\.json|app shell|starter)\b/.test(searchable);
}

function hasProjectScaffold(snapshot: ForgeSnapshot) {
  const paths = snapshot.files.map((file) => file.path.toLowerCase());
  const hasPackageManifest = paths.some((path) => path === "package.json" || path.endsWith("/package.json"));
  const hasAppShell = paths.some((path) =>
    /(^|\/)(app|pages)\/(page|index)\.(tsx|ts|jsx|js)$/.test(path) ||
    /(^|\/)src\/(app|main|index)\.(tsx|ts|jsx|js)$/.test(path) ||
    /(^|\/)src\/app\.(tsx|ts|jsx|js)$/.test(path) ||
    path === "index.html"
  );
  return hasPackageManifest && hasAppShell;
}

function hasCompletedImplementationFiles(snapshot: ForgeSnapshot) {
  const completedImplementationOperationIds = new Set(
    snapshot.operations
      .filter((operation) => operation.status === "completed" && /\b(build|implement|create|scaffold|develop|code|app|ui|frontend|backend|integration|pipeline)\b/i.test(`${operation.title} ${operation.description}`))
      .map((operation) => operation.id)
  );
  return snapshot.files.some((file) => completedImplementationOperationIds.has(file.operationId ?? "") && isImplementationFilePath(file.path));
}

function isImplementationFilePath(path: string) {
  const normalized = path.toLowerCase();
  if (/^(docs|review|pitch|notes)\//.test(normalized)) {
    return false;
  }
  return (
    normalized === "package.json" ||
    normalized === "index.html" ||
    /(^|\/)(app|pages|components|lib|src|styles)\//.test(normalized) ||
    /\.(tsx|ts|jsx|js|css|json|html)$/.test(normalized)
  );
}

function hasOperationDeliverablesFor(snapshot: ForgeSnapshot, dependency: Operation, operation: Operation) {
  if (requiresCompletedUpstreamDeliverables(snapshot, operation)) {
    return snapshot.files.some((file) => file.operationId === dependency.id && isImplementationFilePath(file.path));
  }

  if (dependency.outputArtifactIds.length > 0) {
    return true;
  }

  if (snapshot.artifacts.some((artifact) => artifact.operationId === dependency.id)) {
    return true;
  }

  if (snapshot.files.some((file) => file.operationId === dependency.id)) {
    return true;
  }

  return snapshot.handoffs.some(
    (handoff) =>
      handoff.fromOperationId === dependency.id &&
      (handoff.targetOperationId === operation.id || handoff.toDivisionId === operation.divisionId) &&
      (handoff.artifactIds.length > 0 || handoff.fileIds.length > 0 || handoff.deliverables.length > 0)
  );
}
