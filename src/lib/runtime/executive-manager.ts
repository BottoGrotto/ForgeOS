import type { AgentRun, Artifact, ForgeSnapshot, Operation, VirtualFile } from "./types";

export type ExecutiveLoopStatusRecommendation =
  | "planning"
  | "dispatching"
  | "observing"
  | "waiting_for_user"
  | "blocked"
  | "ready_for_test"
  | "completed";

export interface ExecutiveBlockerSummary {
  operationId: string;
  title: string;
  reason: string;
}

export interface ExecutiveObservationInput {
  forge?: Pick<ForgeSnapshot["forge"], "status">;
  operations: readonly Operation[];
  runs: readonly AgentRun[];
  files?: readonly VirtualFile[];
  artifacts?: readonly Artifact[];
}

export interface ExecutiveObservationSummary {
  totalOperations: number;
  activeRunCount: number;
  activeRunIds: string[];
  readyOperationIds: string[];
  blockerCount: number;
  blockers: ExecutiveBlockerSummary[];
  completedOperationCount: number;
  criticalOperationCount: number;
  completedCriticalOperationCount: number;
  fileCount: number;
  artifactCount: number;
}

export interface ExecutiveReportInput {
  operations: readonly Operation[];
  runs: readonly AgentRun[];
  files: readonly VirtualFile[];
  artifacts: readonly Artifact[];
  blockers?: readonly ExecutiveBlockerSummary[];
}

export interface ExecutiveReportSummary {
  status: ExecutiveLoopStatusRecommendation;
  headline: string;
  sections: readonly string[];
  text: string;
}

const activeRunStatuses = new Set<AgentRun["status"]>(["queued", "starting", "running", "streaming", "resumed"]);

export function buildExecutiveObservationSummary(input: ExecutiveObservationInput): ExecutiveObservationSummary {
  const activeRunIds = input.runs.filter(isActiveRun).map((run) => run.id);
  const readyOperationIds = input.operations.filter((operation) => operation.status === "ready").map((operation) => operation.id);
  const blockers = deriveBlockers(input.operations);
  const criticalOperations = input.operations.filter((operation) => operation.priority === "critical");

  return {
    totalOperations: input.operations.length,
    activeRunCount: activeRunIds.length,
    activeRunIds,
    readyOperationIds,
    blockerCount: blockers.length,
    blockers,
    completedOperationCount: input.operations.filter((operation) => operation.status === "completed").length,
    criticalOperationCount: criticalOperations.length,
    completedCriticalOperationCount: criticalOperations.filter((operation) => operation.status === "completed").length,
    fileCount: input.files?.length ?? 0,
    artifactCount: input.artifacts?.length ?? 0
  };
}

export function deriveLoopStatusRecommendation(input: ExecutiveObservationInput): ExecutiveLoopStatusRecommendation {
  const summary = buildExecutiveObservationSummary(input);

  if (input.forge?.status === "paused") {
    return "waiting_for_user";
  }

  if (summary.totalOperations === 0) {
    return "planning";
  }

  if (summary.completedOperationCount === summary.totalOperations) {
    return "completed";
  }

  if (summary.activeRunCount > 0) {
    return "observing";
  }

  if (summary.blockerCount > 0) {
    return "blocked";
  }

  if (summary.criticalOperationCount > 0 && summary.completedCriticalOperationCount === summary.criticalOperationCount) {
    return "ready_for_test";
  }

  if (summary.readyOperationIds.length > 0) {
    return "dispatching";
  }

  return "planning";
}

export function createExecutiveReportSummary(input: ExecutiveReportInput): ExecutiveReportSummary {
  const blockers = input.blockers ?? deriveBlockers(input.operations);
  const status = deriveLoopStatusRecommendation({
    operations: input.operations,
    runs: input.runs,
    files: input.files,
    artifacts: input.artifacts
  });
  const completedOperations = input.operations.filter((operation) => operation.status === "completed");
  const activeRuns = input.runs.filter(isActiveRun);
  const sections = [
    `Operations: ${completedOperations.length}/${input.operations.length} completed${formatNamedList(input.operations.map((operation) => operation.title))}.`,
    `Runs: ${activeRuns.length} active, ${input.runs.length} total.`,
    `Files: ${input.files.length}${formatNamedList(input.files.map((file) => file.path))}.`,
    `Artifacts: ${input.artifacts.length}${formatNamedList(input.artifacts.map((artifact) => artifact.title))}.`,
    blockers.length > 0
      ? `Blockers: ${blockers.map((blocker) => `${blocker.title}: ${blocker.reason}`).join("; ")}.`
      : "Blockers: none."
  ];
  const headline = `Executive status: ${status}.`;

  return {
    status,
    headline,
    sections,
    text: [headline, ...sections].join("\n")
  };
}

export function chooseConservativeDispatchMax(input: { runs: readonly AgentRun[]; maxRuns: number }): number {
  const maxRuns = Math.max(0, Math.floor(input.maxRuns));
  const activeRunCount = input.runs.filter(isActiveRun).length;

  return Math.max(0, maxRuns - activeRunCount);
}

function isActiveRun(run: AgentRun) {
  return activeRunStatuses.has(run.status);
}

function deriveBlockers(operations: readonly Operation[]): ExecutiveBlockerSummary[] {
  return operations
    .filter((operation) => operation.status === "blocked" || operation.status === "failed")
    .map((operation) => ({
      operationId: operation.id,
      title: operation.title,
      reason: operation.blockedReason ?? (operation.status === "failed" ? "Operation failed." : "Operation is blocked.")
    }));
}

function formatNamedList(values: readonly string[]) {
  if (values.length === 0) {
    return "";
  }

  return ` (${values.join(", ")})`;
}
