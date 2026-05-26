import type { AgentRun, RunTraceSummary, RuntimeEvent } from "./types";

const ACTIVE_RUN_STATUSES = new Set<AgentRun["status"]>(["queued", "starting", "running", "streaming", "resumed"]);

export function getRunsForOperation(runs: AgentRun[], operationId: string) {
  return runs
    .filter((run) => run.operationId === operationId)
    .slice()
    .sort((left, right) => runTime(right) - runTime(left));
}

export function getLatestRunForOperation(runs: AgentRun[], operationId: string) {
  return getRunsForOperation(runs, operationId)[0];
}

export function getActiveRunForOperation(runs: AgentRun[], operationId: string) {
  return getRunsForOperation(runs, operationId).find((run) => isActiveRun(run));
}

export function isActiveRun(run: AgentRun) {
  return ACTIVE_RUN_STATUSES.has(run.status);
}

export function getRunEvents(events: RuntimeEvent[], runId: string) {
  return events.filter((event) => (event.targetType === "run" && event.targetId === runId) || event.payload.runId === runId);
}

export function getRunDurationLabel(run: AgentRun) {
  const start = parseRunDate(run.startedAt ?? run.queuedAt);
  const end = parseRunDate(run.completedAt ?? run.failedAt ?? run.canceledAt);
  if (!start || !end || end < start) {
    return "In progress";
  }

  const totalSeconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

export interface RunTraceSummaryRow {
  label: string;
  value: string;
}

export function getRunTraceSummaryRows(run: AgentRun | undefined): RunTraceSummaryRow[] {
  const traceSummary = getRunTraceSummary(run);
  if (!traceSummary && !run?.usage && !run?.rateLimit) {
    return [];
  }

  return [
    ...usageRows(run),
    ...rateLimitRows(run),
    ...recoveryRows(run),
    ...checkpointRows(traceSummary),
    ...contextRows(traceSummary),
    ...outputRows(traceSummary),
    ...lifecycleRows(traceSummary)
  ].slice(0, 12);
}

function runTime(run: AgentRun) {
  return parseRunDate(run.queuedAt)?.getTime() ?? 0;
}

function parseRunDate(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function getRunTraceSummary(run: AgentRun | undefined): RunTraceSummary | undefined {
  const value = run?.providerMetadata.traceSummary;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RunTraceSummary) : undefined;
}

function usageRows(run: AgentRun | undefined): RunTraceSummaryRow[] {
  if (!run?.usage) {
    return [];
  }

  const tokens = [run.usage.inputTokens ?? 0, run.usage.outputTokens ?? 0].join("/");
  return [
    {
      label: "Usage",
      value: `${tokens} tokens`
    },
    ...(typeof run.usage.costMicros === "number"
      ? [
          {
            label: "Cost",
            value: `$${(run.usage.costMicros / 1_000_000).toFixed(4)}`
          }
        ]
      : [])
  ];
}

function rateLimitRows(run: AgentRun | undefined): RunTraceSummaryRow[] {
  if (!run?.rateLimit) {
    return [];
  }

  return [
    {
      label: "Rate Limit",
      value: run.rateLimit.terminalReason ?? `${run.rateLimit.attempts ?? 1} attempt${run.rateLimit.attempts === 1 ? "" : "s"}`
    }
  ];
}

function contextRows(summary: RunTraceSummary | undefined): RunTraceSummaryRow[] {
  const context = summary?.context;
  if (!context) {
    return [];
  }

  return [
    {
      label: "Context",
      value: `${context.estimatedTokens}/${context.budgetTokens} tokens`
    },
    {
      label: "Sections",
      value: `${context.sections.length} budgeted`
    },
    ...(context.routedArtifacts || context.routedFiles
      ? [
          {
            label: "Routed Context",
            value: `${context.routedArtifacts?.length ?? 0} artifacts / ${context.routedFiles?.length ?? 0} files`
          }
        ]
      : []),
    ...(context.omittedArtifacts?.length || context.omittedFiles?.length
      ? [
          {
            label: "Routing Omits",
            value: `${(context.omittedArtifacts?.length ?? 0) + (context.omittedFiles?.length ?? 0)} omitted`
          }
        ]
      : []),
    ...(context.omittedReasons.length > 0
      ? [
          {
            label: "Context Omits",
            value: `${context.omittedReasons.length} reasons`
          }
        ]
      : [])
  ];
}

function checkpointRows(summary: RunTraceSummary | undefined): RunTraceSummaryRow[] {
  const checkpoint = summary?.checkpoint;
  if (!checkpoint) {
    return [];
  }

  return [
    {
      label: "Checkpoint",
      value: `#${checkpoint.checkpointNumber} at ${formatDuration(checkpoint.activeDurationMs)}`
    },
    {
      label: "Latest Activity",
      value: checkpoint.latestActivity
    }
  ];
}

function outputRows(summary: RunTraceSummary | undefined): RunTraceSummaryRow[] {
  const outputs = summary?.outputs;
  if (!outputs) {
    return [];
  }

  return [
    {
      label: "Outputs",
      value: `${outputs.artifactCount} artifacts / ${outputs.fileCount} files`
    },
    {
      label: "Team Effects",
      value: `${outputs.handoffCount} handoffs / ${outputs.blockerCount} blockers`
    },
    ...(outputs.verificationEvidence
      ? [
          {
            label: "Worker Evidence",
            value: `${outputs.verificationEvidence.commands.length} commands / ${outputs.verificationEvidence.expectedScripts.length} scripts`
          }
        ]
      : []),
    ...(outputs.omittedCount > 0
      ? [
          {
            label: "Validation Omits",
            value: `${outputs.omittedCount} omitted`
          }
        ]
      : [])
    ,
    ...(outputs.recoveryActionCount
      ? [
          {
            label: "Recovery Actions",
            value: `${outputs.recoveryActionCount} declared`
          }
        ]
      : [])
  ];
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function lifecycleRows(summary: RunTraceSummary | undefined): RunTraceSummaryRow[] {
  const lifecycle = summary?.lifecycle;
  if (!lifecycle) {
    return [];
  }

  return [
    {
      label: "Lifecycle",
      value: `${lifecycle.provider} ${lifecycle.status}`
    },
    ...(lifecycle.selfRepairAttemptCount
      ? [
          {
            label: "Self Repair",
            value: `${lifecycle.selfRepairAttemptCount} attempt${lifecycle.selfRepairAttemptCount === 1 ? "" : "s"}`
          }
        ]
      : [])
    ,
    ...(lifecycle.finalFailureCategory
      ? [
          {
            label: "Final Failure",
            value: lifecycle.finalFailureCategory
          }
        ]
      : []),
    ...(lifecycle.escalationCount
      ? [
          {
            label: "Escalations",
            value: String(lifecycle.escalationCount)
          }
        ]
      : [])
  ];
}

function recoveryRows(run: AgentRun | undefined): RunTraceSummaryRow[] {
  const metadata = run?.providerMetadata ?? {};
  const repairBrief = metadata.repairBriefSummary;
  const rows: RunTraceSummaryRow[] = [];
  if (repairBrief && typeof repairBrief === "object" && !Array.isArray(repairBrief)) {
    const failureCategory = (repairBrief as { failureCategory?: unknown }).failureCategory;
    const whatFailed = (repairBrief as { whatFailed?: unknown }).whatFailed;
    if (typeof failureCategory === "string") {
      rows.push({ label: "Repair Brief", value: failureCategory });
    }
    if (typeof whatFailed === "string" && whatFailed.trim()) {
      rows.push({ label: "Repair Summary", value: whatFailed });
    }
  }
  return rows;
}
