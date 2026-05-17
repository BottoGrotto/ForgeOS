import type { ForgeSnapshot, Operation, RuntimeEventDraft, RuntimeStatus } from "./types";
import { calculateOperationReadiness } from "./metrics";
import { getBlockingDependencyIds } from "./scheduler";

export function projectOrganizationalState(snapshot: ForgeSnapshot): ForgeSnapshot {
  const allOperationsComplete = snapshot.operations.every((operation) => operation.status === "completed");

  const workers = snapshot.workers.map((worker) => {
    const operations = snapshot.operations.filter((operation) => operation.workerId === worker.id);
    if (operations.length === 0) {
      return allOperationsComplete ? { ...worker, status: "completed" as const } : worker;
    }

    return {
      ...worker,
      status: deriveAggregateStatus(operations.map((operation) => operation.status))
    };
  });

  const divisions = snapshot.divisions.map((division) => {
    const operations = snapshot.operations.filter((operation) => operation.divisionId === division.id);
    if (operations.length === 0) {
      return division;
    }

    const progress = Math.round(operations.reduce((sum, operation) => sum + operation.progress, 0) / operations.length);

    return {
      ...division,
      progress,
      status: deriveAggregateStatus(operations.map((operation) => operation.status))
    };
  });

  const hasBlockedOperation = snapshot.operations.some((operation) => ["blocked", "failed"].includes(operation.status));
  const hasRunningOperation = snapshot.operations.some((operation) => ["running", "ready", "reviewing"].includes(operation.status));

  const activePhase = allOperationsComplete
    ? "Deployment Ready"
    : hasBlockedOperation
      ? "Blocked Review"
      : hasRunningOperation
        ? "Autonomous Development"
        : "Strategic Planning";

  return {
    ...snapshot,
    forge: {
      ...snapshot.forge,
      activePhase
    },
    divisions,
    workers
  };
}

export function unlockReadyOperations(snapshot: ForgeSnapshot): { snapshot: ForgeSnapshot; events: RuntimeEventDraft[] } {
  const readyOperationIds = new Set(
    snapshot.operations
      .filter((operation) => ["planning", "blocked"].includes(operation.status))
      .filter((operation) =>
        calculateOperationReadiness(operation, snapshot.operations, getBlockingDependencyIds(snapshot, operation.id)).ready
      )
      .map((operation) => operation.id)
  );

  if (readyOperationIds.size === 0) {
    return { snapshot, events: [] };
  }

  const operations = snapshot.operations.map((operation) =>
    readyOperationIds.has(operation.id)
      ? {
          ...operation,
          status: "ready" as const,
          blockedReason: undefined
        }
      : operation
  );

  const events = operations
    .filter((operation) => readyOperationIds.has(operation.id))
    .map((operation) => createOperationReadyEvent(snapshot, operation));

  return {
    snapshot: {
      ...snapshot,
      operations
    },
    events
  };
}

function createOperationReadyEvent(snapshot: ForgeSnapshot, operation: Operation): RuntimeEventDraft {
  return {
    forgeId: snapshot.forge.id,
    type: "operation.ready",
    actorType: "runtime",
    targetType: "operation",
    targetId: operation.id,
    message: `${operation.title} is ready for assignment.`,
    severity: "info",
    payload: { operationId: operation.id }
  };
}

function deriveAggregateStatus(statuses: RuntimeStatus[]): RuntimeStatus {
  if (statuses.every((status) => status === "completed")) {
    return "completed";
  }

  if (statuses.some((status) => status === "failed")) {
    return "failed";
  }

  if (statuses.some((status) => status === "blocked")) {
    return "blocked";
  }

  if (statuses.some((status) => status === "running")) {
    return "running";
  }

  if (statuses.some((status) => status === "reviewing")) {
    return "reviewing";
  }

  if (statuses.some((status) => status === "ready")) {
    return "ready";
  }

  if (statuses.some((status) => status === "planning")) {
    return "planning";
  }

  return "idle";
}
