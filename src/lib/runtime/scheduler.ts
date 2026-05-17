import type { ForgeSnapshot, Operation, RuntimeEventDraft } from "./types";
import { calculateOperationReadiness } from "./metrics";

export function getBlockingDependencyIds(snapshot: ForgeSnapshot, operationId: string) {
  return snapshot.dependencies
    .filter((dependency) => dependency.operationId === operationId && dependency.type === "blocks")
    .map((dependency) => dependency.dependsOnOperationId);
}

export function resolveReadyOperations(snapshot: ForgeSnapshot): Operation[] {
  return snapshot.operations.filter((operation) => {
    if (!["planning", "blocked", "ready"].includes(operation.status)) {
      return false;
    }

    return calculateOperationReadiness(
      operation,
      snapshot.operations,
      getBlockingDependencyIds(snapshot, operation.id)
    ).ready;
  });
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
