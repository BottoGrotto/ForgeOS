import type {
  Artifact,
  ArtifactContextRoute,
  ArtifactContextRouteReason,
  ArtifactContextRouterInput,
  ArtifactContextRouterResult,
  ArtifactContextRoutingDecision,
  Operation,
  VirtualFile
} from "./types";

interface RouteCandidate {
  route: ArtifactContextRoute;
  reason: ArtifactContextRouteReason;
  score: number;
  explanation: string;
}

export function routeArtifactContext(input: ArtifactContextRouterInput): ArtifactContextRouterResult {
  const dependencyOperationIds = new Set(input.dependencyOperations.map((operation) => operation.id));
  const dependencyArtifactIds = new Set(input.dependencyOperations.flatMap((operation) => operation.outputArtifactIds));
  const targetedHandoffArtifactIds = new Set(input.handoffs.filter((handoff) => handoff.targetOperationId === input.operation.id).flatMap((handoff) => handoff.artifactIds));
  const acceptedHandoffArtifactIds = new Set(input.handoffs.filter((handoff) => handoff.acceptedByOperationId === input.operation.id).flatMap((handoff) => handoff.artifactIds));
  const targetedHandoffFileIds = new Set(input.handoffs.filter((handoff) => handoff.targetOperationId === input.operation.id).flatMap((handoff) => handoff.fileIds));
  const acceptedHandoffFileIds = new Set(input.handoffs.filter((handoff) => handoff.acceptedByOperationId === input.operation.id).flatMap((handoff) => handoff.fileIds));
  const manifestArtifactRefs = new Set(input.workerManifestArtifactRefs);
  const manifestFileRefs = new Set(input.workerManifestFileRefs);

  const artifactDecisions = input.snapshot.artifacts
    .map((artifact) =>
      toArtifactDecision(
        artifact,
        input.operation,
        dependencyOperationIds,
        dependencyArtifactIds,
        targetedHandoffArtifactIds,
        acceptedHandoffArtifactIds,
        manifestArtifactRefs
      )
    )
    .sort(compareDecision);

  const selectedArtifactIds = new Set(artifactDecisions.filter((decision) => decision.route !== "omitted").map((decision) => decision.id));
  const fileDecisions = input.snapshot.files
    .map((file) =>
      toFileDecision(
        file,
        input.operation,
        dependencyOperationIds,
        selectedArtifactIds,
        targetedHandoffFileIds,
        acceptedHandoffFileIds,
        manifestFileRefs
      )
    )
    .sort(compareDecision);

  const decisions = [...artifactDecisions, ...fileDecisions];
  return {
    artifacts: artifactDecisions,
    files: fileDecisions,
    selectedArtifactIds: artifactDecisions.filter((decision) => decision.route !== "omitted").map((decision) => decision.id),
    selectedFileIds: fileDecisions.filter((decision) => decision.route !== "omitted").map((decision) => decision.id),
    omittedArtifactIds: artifactDecisions.filter((decision) => decision.route === "omitted").map((decision) => decision.id),
    omittedFileIds: fileDecisions.filter((decision) => decision.route === "omitted").map((decision) => decision.id),
    routingReasons: Object.fromEntries(decisions.map((decision) => [decision.id, decision.explanation]))
  };
}

function toArtifactDecision(
  artifact: Artifact,
  operation: Operation,
  dependencyOperationIds: Set<string>,
  dependencyArtifactIds: Set<string>,
  targetedHandoffArtifactIds: Set<string>,
  acceptedHandoffArtifactIds: Set<string>,
  manifestArtifactRefs: Set<string>
): ArtifactContextRoutingDecision {
  const candidate = bestCandidate([
    targetedHandoffArtifactIds.has(artifact.id) ? required("targeted_handoff", 5000, "Required by a targeted handoff for this operation.") : undefined,
    acceptedHandoffArtifactIds.has(artifact.id) ? required("accepted_handoff", 4800, "Required by an accepted handoff for this operation.") : undefined,
    dependencyArtifactIds.has(artifact.id) || (artifact.operationId ? dependencyOperationIds.has(artifact.operationId) : false)
      ? required("dependency_output", 4400, "Required because it is output from an upstream dependency.")
      : undefined,
    manifestArtifactRefs.has(artifact.id) || manifestArtifactRefs.has(artifact.title) || manifestArtifactRefs.has(artifact.type)
      ? required("worker_manifest", 4200, "Required by the worker context manifest.")
      : undefined,
    operation.outputArtifactIds.includes(artifact.id) ? recommended("operation_output", 3600, "Recommended because this operation already references it as output.") : undefined,
    artifact.operationId === operation.id ? recommended("operation_owned", 3400, "Recommended because it belongs to the current operation.") : undefined,
    artifact.workerId && artifact.workerId === operation.workerId ? recommended("same_worker", 2400, "Recommended because it belongs to the assigned worker.") : undefined,
    artifact.divisionId === operation.divisionId ? optional("same_division", 1400, "Optional same-division artifact.") : undefined
  ]);

  return toDecision(artifact.id, "artifact", candidate);
}

function toFileDecision(
  file: VirtualFile,
  operation: Operation,
  dependencyOperationIds: Set<string>,
  selectedArtifactIds: Set<string>,
  targetedHandoffFileIds: Set<string>,
  acceptedHandoffFileIds: Set<string>,
  manifestFileRefs: Set<string>
): ArtifactContextRoutingDecision {
  const candidate = bestCandidate([
    targetedHandoffFileIds.has(file.id) ? required("targeted_handoff", 5000, "Required by a targeted handoff for this operation.") : undefined,
    acceptedHandoffFileIds.has(file.id) ? required("accepted_handoff", 4800, "Required by an accepted handoff for this operation.") : undefined,
    file.operationId && dependencyOperationIds.has(file.operationId) ? required("dependency_output", 4300, "Required because it is linked to an upstream dependency.") : undefined,
    manifestFileRefs.has(file.id) || manifestFileRefs.has(file.path) ? required("worker_manifest", 4200, "Required by the worker context manifest.") : undefined,
    file.operationId === operation.id ? recommended("operation_owned", 3400, "Recommended because it belongs to the current operation.") : undefined,
    file.artifactIds.some((artifactId) => selectedArtifactIds.has(artifactId)) ? recommended("linked_artifact", 3000, "Recommended because it is linked to a routed artifact.") : undefined,
    file.workerId && file.workerId === operation.workerId ? recommended("same_worker", 2200, "Recommended because it belongs to the assigned worker.") : undefined,
    file.divisionId === operation.divisionId ? optional("same_division", 1200, "Optional same-division virtual file.") : undefined
  ]);

  return toDecision(file.id, "file", candidate);
}

function bestCandidate(candidates: Array<RouteCandidate | undefined>): RouteCandidate {
  return (
    candidates
      .filter((candidate): candidate is RouteCandidate => Boolean(candidate))
      .sort((left, right) => right.score - left.score)[0] ?? {
      route: "omitted",
      reason: "unrelated",
      score: 0,
      explanation: "Omitted because it is not linked to this operation, its dependencies, handoffs, worker manifest, worker, or division."
    }
  );
}

function required(reason: ArtifactContextRouteReason, score: number, explanation: string): RouteCandidate {
  return { route: "required", reason, score, explanation };
}

function recommended(reason: ArtifactContextRouteReason, score: number, explanation: string): RouteCandidate {
  return { route: "recommended", reason, score, explanation };
}

function optional(reason: ArtifactContextRouteReason, score: number, explanation: string): RouteCandidate {
  return { route: "optional", reason, score, explanation };
}

function toDecision(id: string, kind: "artifact" | "file", candidate: RouteCandidate): ArtifactContextRoutingDecision {
  return {
    id,
    kind,
    route: candidate.route,
    reason: candidate.reason,
    score: candidate.score,
    explanation: candidate.explanation
  };
}

function compareDecision(left: ArtifactContextRoutingDecision, right: ArtifactContextRoutingDecision) {
  return routeRank(right.route) - routeRank(left.route) || right.score - left.score || left.id.localeCompare(right.id);
}

function routeRank(route: ArtifactContextRoute) {
  switch (route) {
    case "required":
      return 3;
    case "recommended":
      return 2;
    case "optional":
      return 1;
    case "omitted":
      return 0;
  }
}
