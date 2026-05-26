import { runtimeStore } from "@/lib/runtime/store";
import type { AgentRun, ForgeSnapshot } from "@/lib/runtime/types";
import { apiJson } from "@/lib/security/request";

const OPENAI_COSTS_URL = "https://api.openai.com/v1/organization/costs";
const OPENAI_COSTS_TIMEOUT_MS = 2500;

export async function GET() {
  const forges = await runtimeStore.listForges();
  const snapshots = await Promise.all(forges.map((forge) => runtimeStore.getSnapshot(forge.slug)));
  const local = summarizeLocalUsage(snapshots);
  const openai = await fetchOpenAICosts();

  return apiJson({ local, openai });
}

function summarizeLocalUsage(snapshots: ForgeSnapshot[]) {
  const runs = snapshots.flatMap((snapshot) =>
    snapshot.runs.map((run) => ({
      ...run,
      forgeSlug: snapshot.forge.slug,
      forgeName: snapshot.forge.name
    }))
  );
  const totals = runs.reduce(
    (summary, run) => ({
      requestCount: summary.requestCount + (run.usage?.requestCount ?? 0),
      inputTokens: summary.inputTokens + (run.usage?.inputTokens ?? 0),
      outputTokens: summary.outputTokens + (run.usage?.outputTokens ?? 0),
      cachedInputTokens: summary.cachedInputTokens + (run.usage?.cachedInputTokens ?? 0),
      costMicros: summary.costMicros + (run.usage?.costMicros ?? 0),
      webEnabledRuns: summary.webEnabledRuns + (run.providerMetadata.webEnabled === true ? 1 : 0),
      webSourceCount: summary.webSourceCount + readMetadataNumber(run.providerMetadata.webSourceCount),
      omittedContextCount: summary.omittedContextCount + readTraceOmittedCount(run),
      truncatedContextCount: summary.truncatedContextCount + readTraceTruncatedCount(run),
      totalRuns: summary.totalRuns + 1,
      completedRuns: summary.completedRuns + (run.status === "completed" ? 1 : 0),
      failedRuns: summary.failedRuns + (run.status === "failed" ? 1 : 0),
      activeRuns: summary.activeRuns + (isActiveStatus(run.status) ? 1 : 0)
    }),
    {
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costMicros: 0,
      webEnabledRuns: 0,
      webSourceCount: 0,
      omittedContextCount: 0,
      truncatedContextCount: 0,
      totalRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      activeRuns: 0
    }
  );

  return {
    totals,
    openai: summarizeLocalOpenAIUsage(runs),
    byProvider: groupRuns(runs, (run) => run.provider),
    byForge: groupForgeUsage(snapshots, runs),
    recentRuns: runs
      .slice()
      .sort((left, right) => (Date.parse(right.startedAt ?? right.queuedAt) || 0) - (Date.parse(left.startedAt ?? left.queuedAt) || 0))
      .slice(0, 12)
      .map((run) => ({
        id: run.id,
        forgeSlug: run.forgeSlug,
        forgeName: run.forgeName,
        operationId: run.operationId,
        provider: run.provider,
        status: run.status,
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        failedAt: run.failedAt,
        usage: run.usage,
        rateLimit: run.rateLimit,
        web: {
          enabled: run.providerMetadata.webEnabled === true,
          used: run.providerMetadata.webUsed === true,
          sourceCount: readMetadataNumber(run.providerMetadata.webSourceCount)
        },
        error: run.error
      }))
  };
}

function summarizeLocalOpenAIUsage(runs: Array<AgentRun & { forgeSlug: string; forgeName: string }>) {
  const openAIRuns = runs.filter(isOpenAIBackedRun);
  return {
    trackedCostMicros: openAIRuns.reduce((total, run) => total + (run.usage?.costMicros ?? 0), 0),
    runs: openAIRuns.length,
    runsWithEstimatedCost: openAIRuns.filter((run) => typeof run.usage?.costMicros === "number").length,
    runsWithoutEstimatedCost: openAIRuns.filter((run) => typeof run.usage?.costMicros !== "number").length,
    requestCount: openAIRuns.reduce((total, run) => total + (run.usage?.requestCount ?? 0), 0),
    inputTokens: openAIRuns.reduce((total, run) => total + (run.usage?.inputTokens ?? 0), 0),
    outputTokens: openAIRuns.reduce((total, run) => total + (run.usage?.outputTokens ?? 0), 0)
  };
}

function groupForgeUsage(snapshots: ForgeSnapshot[], runs: Array<AgentRun & { forgeSlug: string; forgeName: string }>) {
  const runGroups = new Map(groupRuns(runs, (run) => run.forgeSlug, (run) => run.forgeName).map((group) => [group.key, group]));
  return snapshots
    .map((snapshot) => {
      const current = runGroups.get(snapshot.forge.slug) ?? emptyGroup();
      const openaiSpendMicros = snapshot.runs
        .filter(isOpenAIBackedRun)
        .reduce((total, run) => total + (run.usage?.costMicros ?? 0), 0);
      const openaiSpendLimitMicros = readSpendLimitMicros(snapshot.forge.openaiSpendLimitMicros);
      return {
        ...current,
        key: snapshot.forge.slug,
        label: snapshot.forge.name,
        openaiSpendMicros,
        openaiSpendLimitMicros,
        openaiSpendRemainingMicros: openaiSpendLimitMicros === undefined ? undefined : Math.max(0, openaiSpendLimitMicros - openaiSpendMicros),
        openaiSpendLimitReached: openaiSpendLimitMicros !== undefined && openaiSpendMicros >= openaiSpendLimitMicros
      };
    })
    .sort((left, right) => right.costMicros - left.costMicros || left.label.localeCompare(right.label));
}

function groupRuns<T extends AgentRun & { forgeSlug: string }>(runs: T[], keyFor: (run: T) => string, labelFor?: (run: T) => string) {
  const groups = new Map<string, ReturnType<typeof emptyGroup>>();
  for (const run of runs) {
    const key = keyFor(run);
    const current = groups.get(key) ?? emptyGroup();
    groups.set(key, {
      ...current,
      key,
      label: labelFor?.(run) ?? current.label ?? key,
      runs: current.runs + 1,
      completedRuns: current.completedRuns + (run.status === "completed" ? 1 : 0),
      failedRuns: current.failedRuns + (run.status === "failed" ? 1 : 0),
      activeRuns: current.activeRuns + (isActiveStatus(run.status) ? 1 : 0),
      requestCount: current.requestCount + (run.usage?.requestCount ?? 0),
      inputTokens: current.inputTokens + (run.usage?.inputTokens ?? 0),
      outputTokens: current.outputTokens + (run.usage?.outputTokens ?? 0),
      cachedInputTokens: current.cachedInputTokens + (run.usage?.cachedInputTokens ?? 0),
      costMicros: current.costMicros + (run.usage?.costMicros ?? 0),
      webEnabledRuns: current.webEnabledRuns + (run.providerMetadata.webEnabled === true ? 1 : 0),
      webSourceCount: current.webSourceCount + readMetadataNumber(run.providerMetadata.webSourceCount),
      omittedContextCount: current.omittedContextCount + readTraceOmittedCount(run),
      truncatedContextCount: current.truncatedContextCount + readTraceTruncatedCount(run)
    });
  }
  return Array.from(groups.values()).sort((left, right) => right.costMicros - left.costMicros || right.runs - left.runs);
}

function emptyGroup() {
  return {
    key: "",
    label: "",
    runs: 0,
    completedRuns: 0,
    failedRuns: 0,
    activeRuns: 0,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costMicros: 0,
    webEnabledRuns: 0,
    webSourceCount: 0,
    omittedContextCount: 0,
    truncatedContextCount: 0
  };
}

function readMetadataNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readSpendLimitMicros(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readTraceOmittedCount(run: AgentRun) {
  const traceSummary = run.providerMetadata.traceSummary;
  if (!traceSummary || typeof traceSummary !== "object" || Array.isArray(traceSummary)) {
    return 0;
  }
  const context = (traceSummary as Record<string, unknown>).context;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return 0;
  }
  const reasons = (context as Record<string, unknown>).omittedReasons;
  return Array.isArray(reasons) ? reasons.length : 0;
}

function readTraceTruncatedCount(run: AgentRun) {
  const traceSummary = run.providerMetadata.traceSummary;
  if (!traceSummary || typeof traceSummary !== "object" || Array.isArray(traceSummary)) {
    return 0;
  }
  const context = (traceSummary as Record<string, unknown>).context;
  const sections = context && typeof context === "object" && !Array.isArray(context) ? (context as Record<string, unknown>).sections : undefined;
  if (!Array.isArray(sections)) {
    return 0;
  }
  return sections.reduce((count, section) => {
    const record = section && typeof section === "object" && !Array.isArray(section) ? (section as Record<string, unknown>) : {};
    return count + readMetadataNumber(record.truncatedItems);
  }, 0);
}

function isOpenAIBackedRun(run: AgentRun) {
  return run.provider === "codex";
}

async function fetchOpenAICosts() {
  const key = process.env.FORGEOS_OPENAI_ADMIN_KEY ?? process.env.OPENAI_ADMIN_KEY;
  if (!key) {
    return {
      configured: false,
      status: "missing_admin_key",
      totalUsd: null,
      buckets: []
    };
  }

  const startTime = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const url = new URL(OPENAI_COSTS_URL);
  url.searchParams.set("start_time", String(startTime));
  url.searchParams.set("limit", "30");
  url.searchParams.append("group_by[]", "line_item");
  url.searchParams.append("group_by[]", "project_id");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), readPositiveInteger(process.env.FORGEOS_OPENAI_COSTS_TIMEOUT_MS, OPENAI_COSTS_TIMEOUT_MS));

  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json"
      },
      cache: "no-store",
      signal: controller.signal
    });
    const body = (await response.json().catch(() => ({}))) as OpenAICostsResponse;
    if (!response.ok) {
      const errorMessage =
        response.status === 403
          ? "OpenAI costs request was forbidden. Use an organization Admin API key from the OpenAI API Platform organization settings."
          : body.error?.message ?? `OpenAI costs request failed with HTTP ${response.status}.`;
      return {
        configured: true,
        status: "failed",
        statusCode: response.status,
        totalUsd: null,
        error: sanitizeError(errorMessage),
        buckets: []
      };
    }

    const buckets = (body.data ?? []).map((bucket) => ({
      startTime: bucket.start_time,
      endTime: bucket.end_time,
      results: (bucket.results ?? []).map((result) => ({
        amountUsd: result.amount?.currency === "usd" ? result.amount.value : 0,
        currency: result.amount?.currency ?? "usd",
        lineItem: result.line_item ?? "Uncategorized",
        projectId: result.project_id
      }))
    }));
    const totalUsd = buckets.reduce((sum, bucket) => sum + bucket.results.reduce((bucketSum, result) => bucketSum + result.amountUsd, 0), 0);
    return {
      configured: true,
      status: "ok",
      totalUsd,
      totalMicros: Math.round(totalUsd * 1_000_000),
      byLineItem: groupOpenAICosts(buckets, (result) => result.lineItem),
      byProject: groupOpenAICosts(buckets, (result) => result.projectId ?? "Unassigned project"),
      buckets
    };
  } catch (error) {
    return {
      configured: true,
      status: "failed",
      totalUsd: null,
      error: isAbortError(error) ? "OpenAI costs request timed out." : "OpenAI costs request failed.",
      buckets: []
    };
  } finally {
    clearTimeout(timeout);
  }
}

function groupOpenAICosts(
  buckets: Array<{ results: Array<{ amountUsd: number; lineItem: string; projectId?: string | null }> }>,
  keyFor: (result: { amountUsd: number; lineItem: string; projectId?: string | null }) => string
) {
  const groups = new Map<string, { key: string; amountUsd: number; amountMicros: number }>();
  for (const result of buckets.flatMap((bucket) => bucket.results)) {
    const key = keyFor(result) || "Uncategorized";
    const current = groups.get(key) ?? { key, amountUsd: 0, amountMicros: 0 };
    const amountUsd = current.amountUsd + result.amountUsd;
    groups.set(key, {
      key,
      amountUsd,
      amountMicros: Math.round(amountUsd * 1_000_000)
    });
  }
  return Array.from(groups.values()).sort((left, right) => right.amountMicros - left.amountMicros);
}

function isActiveStatus(status: AgentRun["status"]) {
  return status === "queued" || status === "starting" || status === "running" || status === "streaming" || status === "resumed";
}

function sanitizeError(message: string) {
  return message.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

interface OpenAICostsResponse {
  data?: Array<{
    start_time: number;
    end_time: number;
    results?: Array<{
      amount?: {
        value: number;
        currency: string;
      };
      line_item?: string | null;
      project_id?: string | null;
    }>;
  }>;
  error?: {
    message?: string;
  };
}
