import type { ForgeSnapshot, Operation, RuntimeStatus } from "./types";

const blockingStatuses: RuntimeStatus[] = ["blocked", "failed"];

export function calculateOperationReadiness(operation: Operation, operations: Operation[], dependencyIds: string[]) {
  const blockers = dependencyIds
    .map((id) => operations.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Operation => Boolean(candidate))
    .filter((candidate) => candidate.status !== "completed");

  if (blockers.length > 0) {
    return {
      ready: false,
      reason: `Waiting for ${blockers.map((blocker) => blocker.title).join(", ")}`
    };
  }

  return { ready: true };
}

export function deriveDivisionProgress(snapshot: Pick<ForgeSnapshot, "divisions" | "operations">) {
  return snapshot.divisions.map((division) => {
    const operations = snapshot.operations.filter((operation) => operation.divisionId === division.id);
    const progress =
      operations.length === 0
        ? division.progress
        : Math.round(operations.reduce((sum, operation) => sum + operation.progress, 0) / operations.length);

    return { ...division, progress };
  });
}

export function deriveForgeMetrics(snapshot: ForgeSnapshot) {
  const operations = snapshot.operations;
  const completed = operations.filter((operation) => operation.status === "completed").length;
  const blocked = operations.filter((operation) => blockingStatuses.includes(operation.status)).length;
  const running = operations.filter((operation) => operation.status === "running").length;
  const activeWorkers = snapshot.workers.filter((worker) => worker.status === "running").length;
  const progress =
    operations.length === 0
      ? 0
      : Math.round(operations.reduce((sum, operation) => sum + operation.progress, 0) / operations.length);
  const readiness = Math.min(100, Math.max(0, progress - blocked * 8 + snapshot.handoffs.length * 3));
  const confidence = Math.min(99, Math.max(40, 68 + completed * 3 - blocked * 7));
  const runtimeStability = Math.min(100, Math.max(55, 92 - blocked * 10 - running * 2));

  return {
    progress,
    completedOperations: completed,
    blockedOperations: blocked,
    runningOperations: running,
    activeWorkers,
    activeOperations: operations.filter((operation) => ["ready", "running", "reviewing"].includes(operation.status)).length,
    generatedAssets: snapshot.artifacts.length,
    deploymentReadiness: readiness,
    confidence,
    runtimeStability,
    estimatedCompletion: progress >= 95 ? "Ready" : progress >= 70 ? "Final review" : progress >= 40 ? "Under construction" : "Planning"
  };
}
