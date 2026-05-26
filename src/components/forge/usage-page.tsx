"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, AlertTriangle, BarChart3, CheckCircle2, Database, DollarSign, RefreshCw } from "lucide-react";

interface UsagePayload {
  local: {
    totals: {
      requestCount: number;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      costMicros: number;
      totalRuns: number;
      completedRuns: number;
      failedRuns: number;
      activeRuns: number;
    };
    openai: {
      trackedCostMicros: number;
      runs: number;
      runsWithEstimatedCost: number;
      runsWithoutEstimatedCost: number;
      requestCount: number;
      inputTokens: number;
      outputTokens: number;
    };
    byProvider: UsageGroup[];
    byForge: UsageGroup[];
    recentRuns: Array<{
      id: string;
      forgeSlug: string;
      forgeName: string;
      operationId: string;
      provider: string;
      status: string;
      queuedAt: string;
      startedAt?: string;
      completedAt?: string;
      failedAt?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        requestCount: number;
        costMicros?: number;
        costSource?: string;
      };
      rateLimit?: {
        terminalReason?: string;
      };
      error?: string;
    }>;
  };
  openai: {
    configured: boolean;
    status: string;
    statusCode?: number;
    totalUsd: number | null;
    totalMicros?: number;
    error?: string;
    byLineItem?: Array<{ key: string; amountUsd: number; amountMicros: number }>;
    byProject?: Array<{ key: string; amountUsd: number; amountMicros: number }>;
    buckets: Array<{
      startTime: number;
      endTime: number;
      results: Array<{
        amountUsd: number;
        currency: string;
        lineItem: string;
        projectId?: string | null;
      }>;
    }>;
  };
}

interface UsageGroup {
  key: string;
  label: string;
  runs: number;
  completedRuns: number;
  failedRuns: number;
  activeRuns: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costMicros: number;
  openaiSpendMicros?: number;
  openaiSpendLimitMicros?: number;
  openaiSpendRemainingMicros?: number;
  openaiSpendLimitReached?: boolean;
}

export function UsagePage() {
  const [payload, setPayload] = useState<UsagePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/usage", { cache: "no-store" });
      const body = (await response.json()) as { success: boolean; data?: UsagePayload; error?: string };
      if (!body.success || !body.data) {
        setError(body.error ?? "Usage data failed.");
        return;
      }
      setPayload(body.data);
    } catch {
      setError("Usage data failed.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const local = payload?.local;
  const openai = payload?.openai;

  return (
    <main className="min-h-screen bg-forge-bg text-forge-text">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-4 px-4 py-6 lg:px-6">
        <header className="rounded-lg border border-forge-line bg-forge-panel p-5 shadow-command">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-sm text-forge-muted">ForgeOS</div>
              <h1 className="mt-2 text-3xl font-semibold text-white">Usage</h1>
              <p className="mt-1 text-sm text-forge-muted">Track local run accounting and optional OpenAI organization costs.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/forges" className="rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan">Forges</Link>
              <button type="button" onClick={() => void load()} disabled={loading} className="flex items-center gap-2 rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan disabled:opacity-60">
                <RefreshCw className="h-4 w-4" />
                Refresh
              </button>
            </div>
          </div>
        </header>
        {error ? <div className="rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{error}</div> : null}
        {loading && !payload ? <div className="rounded border border-forge-line bg-forge-panel p-4 text-sm text-forge-muted">Loading usage data.</div> : null}
        {local ? (
          <>
            <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <Metric icon={DollarSign} label="Local Estimated Cost" value={formatDollars(local.totals.costMicros / 1_000_000)} />
              <Metric icon={Activity} label="Requests" value={local.totals.requestCount.toLocaleString()} />
              <Metric icon={BarChart3} label="Tokens" value={`${formatCompact(local.totals.inputTokens)} in / ${formatCompact(local.totals.outputTokens)} out`} />
              <Metric icon={Database} label="Runs" value={`${local.totals.totalRuns} total / ${local.totals.activeRuns} active`} />
            </section>
            <Panel title="Overall Local Usage" action={`${local.totals.totalRuns} runs`}>
              <OverallUsage totals={local.totals} />
            </Panel>
            <Panel title="OpenAI Billing Reconciliation" action={openai?.configured ? openai.status : "not configured"}>
              {openai ? <OpenAIReconciliation local={local.openai} openai={openai} /> : null}
            </Panel>
            <Panel title="OpenAI Budget By Forge" action={`${local.byForge.length} budgets`}>
              <ForgeBudgetControls groups={local.byForge} onUpdated={() => void load()} />
            </Panel>
            <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
              <Panel title="Usage By Forge" action={`${local.byForge.length} forges`}>
                <ForgeUsageTable groups={local.byForge} />
              </Panel>
              <Panel title="Provider Totals" action={`${local.byProvider.length} providers`}>
                <UsageGroupTable groups={local.byProvider} />
              </Panel>
            </section>
            <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
              <Panel title="OpenAI Costs API" action={openai?.configured ? openai.status : "not configured"}>
                {openai ? <OpenAICosts openai={openai} /> : null}
              </Panel>
              <Panel title="Recent Runs" action={`${local.recentRuns.length} shown`}>
                <div className="divide-y divide-forge-line">
                  {local.recentRuns.length > 0 ? local.recentRuns.map((run) => (
                    <Link key={run.id} href={`/forge/${run.forgeSlug}/operations?operation=${run.operationId}`} className="block p-3 hover:bg-forge-cyan/10">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-white">{run.forgeName}</div>
                          <div className="mt-1 truncate text-xs text-forge-muted">{run.id}</div>
                        </div>
                        <div className="text-right text-xs text-forge-muted">
                          <div>{run.provider} / {run.status}</div>
                          <div>{formatDollars((run.usage?.costMicros ?? 0) / 1_000_000)}</div>
                        </div>
                      </div>
                      {run.error || run.rateLimit?.terminalReason ? (
                        <div className="mt-2 flex items-center gap-2 text-xs text-amber-100">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          <span>{run.rateLimit?.terminalReason ?? run.error}</span>
                        </div>
                      ) : null}
                    </Link>
                  )) : <div className="p-4 text-sm text-forge-muted">No runs recorded yet.</div>}
                </div>
              </Panel>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}

function OverallUsage({ totals }: { totals: UsagePayload["local"]["totals"] }) {
  const rows = [
    ["Estimated cost", formatDollars(totals.costMicros / 1_000_000)],
    ["Requests", totals.requestCount.toLocaleString()],
    ["Input tokens", totals.inputTokens.toLocaleString()],
    ["Output tokens", totals.outputTokens.toLocaleString()],
    ["Cached input", totals.cachedInputTokens.toLocaleString()],
    ["Total runs", totals.totalRuns.toLocaleString()],
    ["Completed", totals.completedRuns.toLocaleString()],
    ["Failed", totals.failedRuns.toLocaleString()],
    ["Active", totals.activeRuns.toLocaleString()]
  ];

  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded border border-forge-line bg-black/20 p-3">
          <div className="text-xs uppercase text-forge-muted">{label}</div>
          <div className="mt-1 text-lg font-semibold text-white">{value}</div>
        </div>
      ))}
    </div>
  );
}

function OpenAIReconciliation({ local, openai }: { local: UsagePayload["local"]["openai"]; openai: UsagePayload["openai"] }) {
  const billedMicros = openai.totalMicros ?? (openai.totalUsd === null ? undefined : Math.round(openai.totalUsd * 1_000_000));
  const untrackedMicros = billedMicros === undefined ? undefined : Math.max(0, billedMicros - local.trackedCostMicros);
  const rows = [
    ["Local tracked Codex runs", formatDollars(local.trackedCostMicros / 1_000_000)],
    ["OpenAI billed costs", billedMicros === undefined ? "Unavailable" : formatDollars(billedMicros / 1_000_000)],
    ["Untracked / billing gap", untrackedMicros === undefined ? "Unavailable" : formatDollars(untrackedMicros / 1_000_000)],
    ["OpenAI-backed runs", `${local.runsWithEstimatedCost}/${local.runs} priced`]
  ];

  return (
    <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {rows.map(([label, value]) => (
            <div key={label} className="rounded border border-forge-line bg-black/20 p-3">
              <div className="text-xs uppercase text-forge-muted">{label}</div>
              <div className="mt-1 text-lg font-semibold text-white">{value}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded border border-amber-300/30 bg-amber-500/10 p-3 text-sm leading-6 text-amber-50">
          Forge budgets currently enforce local Codex run estimates. OpenAI billing can be higher when spend comes from Executive AI planning calls, failed requests without usage payloads, web/tool charges, other OpenAI projects, or API usage outside this ForgeOS runtime.
        </div>
        {local.runsWithoutEstimatedCost > 0 ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-amber-100">
            <AlertTriangle className="h-4 w-4" />
            <span>{local.runsWithoutEstimatedCost} OpenAI-backed run{local.runsWithoutEstimatedCost === 1 ? "" : "s"} had no local cost estimate.</span>
          </div>
        ) : null}
      </div>
      <div className="rounded border border-forge-line bg-black/20">
        <div className="border-b border-forge-line px-3 py-2 text-sm font-semibold text-white">OpenAI billed breakdown</div>
        {openai.status === "ok" ? (
          <div className="divide-y divide-forge-line">
            {(openai.byLineItem ?? []).slice(0, 6).map((item) => (
              <div key={item.key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="truncate text-slate-300">{item.key}</span>
                <span className="font-semibold text-white">{formatDollars(item.amountUsd)}</span>
              </div>
            ))}
            {(openai.byLineItem ?? []).length === 0 ? <div className="p-3 text-sm text-forge-muted">No OpenAI billing line items returned.</div> : null}
          </div>
        ) : (
          <div className="p-3 text-sm leading-6 text-forge-muted">{openai.error ?? "OpenAI billed costs are unavailable. Set an organization Admin API key to compare against actual billing."}</div>
        )}
      </div>
    </div>
  );
}

function ForgeBudgetControls({ groups, onUpdated }: { groups: UsageGroup[]; onUpdated: () => void }) {
  if (groups.length === 0) {
    return <div className="p-4 text-sm text-forge-muted">No Forge usage recorded.</div>;
  }

  return (
    <div className="grid gap-4 p-4 xl:grid-cols-2">
      {groups.map((group) => (
        <ForgeBudgetControl key={group.key} group={group} onUpdated={onUpdated} />
      ))}
    </div>
  );
}

function ForgeBudgetControl({ group, onUpdated }: { group: UsageGroup; onUpdated: () => void }) {
  const spendUsd = (group.openaiSpendMicros ?? 0) / 1_000_000;
  const currentLimitUsd = group.openaiSpendLimitMicros === undefined ? undefined : group.openaiSpendLimitMicros / 1_000_000;
  const initialLimit = currentLimitUsd === undefined ? Math.max(10, Math.ceil(spendUsd * 2)) : currentLimitUsd;
  const [draft, setDraft] = useState(formatBudgetInput(initialLimit));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  useEffect(() => {
    setDraft(formatBudgetInput(currentLimitUsd === undefined ? Math.max(10, Math.ceil(spendUsd * 2)) : currentLimitUsd));
  }, [currentLimitUsd, spendUsd]);

  const draftValue = Number(draft);
  const validDraft = Number.isFinite(draftValue) && draftValue >= 0;
  const sliderMax = Math.max(100, validDraft ? draftValue : 0);
  const limitUsd = currentLimitUsd;
  const remainingUsd = limitUsd === undefined ? undefined : Math.max(0, limitUsd - spendUsd);
  const progress = limitUsd === undefined || limitUsd <= 0 ? 0 : Math.min(100, (spendUsd / limitUsd) * 100);

  async function saveLimit(value: number | null) {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/forges/${group.key}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "set_openai_spend_limit",
          openaiSpendLimitUsd: value,
          idempotencyKey: `openai-spend-limit-${group.key}-${Date.now()}`
        })
      });
      const body = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!response.ok || body.success === false) {
        setMessage({ tone: "error", text: body.error ?? "Budget save failed." });
        return;
      }
      setMessage({ tone: "success", text: value === null ? "Budget cleared." : "Budget saved." });
      onUpdated();
    } catch (error) {
      setMessage({ tone: "error", text: readableError(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (validDraft) {
          void saveLimit(draftValue);
        } else {
          setMessage({ tone: "error", text: "Enter a budget of 0 or more." });
        }
      }}
      className={`rounded border p-4 ${group.openaiSpendLimitReached ? "border-amber-300/50 bg-amber-500/10" : "border-forge-line bg-black/20"}`}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <Link href={`/forge/${group.key}`} className="truncate text-lg font-semibold text-white hover:text-forge-cyan">{group.label || group.key}</Link>
          <div className="mt-1 text-xs text-forge-muted">{group.key}</div>
        </div>
        <div className="text-left md:text-right">
          <div className="text-xs uppercase text-forge-muted">Local tracked OpenAI spend</div>
          <div className="text-2xl font-semibold text-white">{formatDollars(spendUsd)}</div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <BudgetMetric label="Current budget" value={limitUsd === undefined ? "No limit" : formatDollars(limitUsd)} />
        <BudgetMetric label="Remaining" value={remainingUsd === undefined ? "Uncapped" : formatDollars(remainingUsd)} />
        <BudgetMetric label="Runs" value={`${group.runs} total`} />
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between text-xs text-forge-muted">
        <span>Local tracked spend</span>
          <span>{limitUsd === undefined ? "No active cap" : `${Math.round(progress)}% of budget`}</span>
        </div>
        <div className="h-3 overflow-hidden rounded bg-black/40">
          <div className={`h-full ${group.openaiSpendLimitReached ? "bg-amber-300" : "bg-forge-cyan"}`} style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_150px_auto_auto] md:items-end">
        <label className="block">
          <span className="text-xs uppercase text-forge-muted">Budget slider</span>
          <input
            type="range"
            min="0"
            max={sliderMax}
            step="0.01"
            value={validDraft ? Math.min(draftValue, sliderMax) : 0}
            onChange={(event) => setDraft(event.currentTarget.value)}
            className="mt-3 h-3 w-full accent-cyan-300"
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase text-forge-muted">USD limit</span>
          <input
            aria-label={`OpenAI spend limit for ${group.label || group.key}`}
            type="number"
            min="0"
            step="0.01"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            className="mt-2 h-10 w-full rounded border border-forge-line bg-black/30 px-3 text-right text-sm text-white outline-none focus:border-forge-cyan"
          />
        </label>
        <button
          type="submit"
          disabled={saving || !validDraft}
          className="h-10 rounded border border-forge-cyan px-4 text-sm font-semibold text-white hover:bg-forge-cyan/10 disabled:border-forge-line disabled:opacity-60"
        >
          {saving ? "Saving" : "Save Budget"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void saveLimit(null)}
          className="h-10 rounded border border-forge-line px-4 text-sm text-slate-200 hover:border-forge-cyan disabled:opacity-60"
        >
          Clear
        </button>
      </div>

      {message ? (
        <div className={`mt-3 flex items-center gap-2 text-sm ${message.tone === "error" ? "text-red-100" : "text-emerald-100"}`}>
          {message.tone === "success" ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          <span>{message.text}</span>
        </div>
      ) : null}
    </form>
  );
}

function BudgetMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-forge-line bg-black/20 p-3">
      <div className="text-xs uppercase text-forge-muted">{label}</div>
      <div className="mt-1 text-base font-semibold text-white">{value}</div>
    </div>
  );
}

function ForgeUsageTable({ groups }: { groups: UsageGroup[] }) {
  if (groups.length === 0) {
    return <div className="p-4 text-sm text-forge-muted">No Forge usage recorded.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="border-b border-forge-line text-xs uppercase text-forge-muted">
          <tr>
            <th className="px-4 py-3 font-medium">Forge</th>
            <th className="px-3 py-3 text-right font-medium">Cost</th>
            <th className="px-3 py-3 text-right font-medium">OpenAI</th>
            <th className="px-3 py-3 text-right font-medium">Budget</th>
            <th className="px-3 py-3 text-right font-medium">Requests</th>
            <th className="px-3 py-3 text-right font-medium">Input</th>
            <th className="px-3 py-3 text-right font-medium">Output</th>
            <th className="px-3 py-3 text-right font-medium">Cached</th>
            <th className="px-3 py-3 text-right font-medium">Runs</th>
            <th className="px-4 py-3 text-right font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-forge-line">
          {groups.map((group) => (
            <tr key={group.key} className="hover:bg-forge-cyan/5">
              <td className="px-4 py-3">
                <Link href={`/forge/${group.key}`} className="font-semibold text-white hover:text-forge-cyan">{group.label || group.key}</Link>
                <div className="mt-1 text-xs text-forge-muted">{group.key}</div>
              </td>
              <td className="px-3 py-3 text-right font-semibold text-white">{formatDollars(group.costMicros / 1_000_000)}</td>
              <td className="px-3 py-3 text-right text-slate-300">{formatDollars((group.openaiSpendMicros ?? 0) / 1_000_000)}</td>
              <td className={`px-3 py-3 text-right ${group.openaiSpendLimitReached ? "text-amber-100" : "text-slate-300"}`}>
                {group.openaiSpendLimitMicros === undefined ? "No limit" : formatDollars(group.openaiSpendLimitMicros / 1_000_000)}
              </td>
              <td className="px-3 py-3 text-right text-slate-300">{group.requestCount.toLocaleString()}</td>
              <td className="px-3 py-3 text-right text-slate-300">{formatCompact(group.inputTokens)}</td>
              <td className="px-3 py-3 text-right text-slate-300">{formatCompact(group.outputTokens)}</td>
              <td className="px-3 py-3 text-right text-slate-300">{formatCompact(group.cachedInputTokens)}</td>
              <td className="px-3 py-3 text-right text-slate-300">{group.runs.toLocaleString()}</td>
              <td className="px-4 py-3 text-right text-xs text-forge-muted">
                {group.completedRuns} done / {group.failedRuns} failed / {group.activeRuns} active
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OpenAICosts({ openai }: { openai: UsagePayload["openai"] }) {
  if (!openai.configured) {
    return (
      <div className="p-4 text-sm leading-6 text-slate-300">
        Set <code className="rounded bg-black/30 px-1 py-0.5">OPENAI_ADMIN_KEY</code> or <code className="rounded bg-black/30 px-1 py-0.5">FORGEOS_OPENAI_ADMIN_KEY</code> to show organization cost buckets.
      </div>
    );
  }
  if (openai.status !== "ok") {
    return (
      <div className="space-y-2 p-4 text-sm leading-6 text-red-100">
        <div>{openai.error ?? "OpenAI costs are unavailable."}</div>
        {openai.statusCode === 403 ? (
          <div className="text-slate-300">
            Normal project API keys cannot read organization costs. Create an Admin API key in OpenAI organization settings and set it as <code className="rounded bg-black/30 px-1 py-0.5">FORGEOS_OPENAI_ADMIN_KEY</code>.
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="p-4">
      <div className="text-3xl font-semibold text-white">{formatDollars(openai.totalUsd ?? 0)}</div>
      <div className="mt-1 text-sm text-forge-muted">Last 30 days from OpenAI organization costs</div>
      <div className="mt-4 space-y-2">
        {openai.buckets.slice(-7).map((bucket) => {
          const total = bucket.results.reduce((sum, result) => sum + result.amountUsd, 0);
          return (
            <div key={bucket.startTime} className="flex items-center justify-between rounded border border-forge-line bg-black/20 p-2 text-sm">
              <span className="text-slate-300">{new Date(bucket.startTime * 1000).toLocaleDateString()}</span>
              <span className="font-semibold text-white">{formatDollars(total)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UsageGroupTable({ groups }: { groups: UsageGroup[] }) {
  return (
    <div className="divide-y divide-forge-line">
      {groups.length > 0 ? groups.map((group) => (
        <div key={group.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 p-3 text-sm">
          <div className="min-w-0">
            <div className="truncate font-semibold text-white">{group.label || group.key}</div>
            <div className="mt-1 text-xs text-forge-muted">{group.runs} runs / {group.requestCount} requests</div>
          </div>
          <div className="text-right">
            <div className="font-semibold text-white">{formatDollars(group.costMicros / 1_000_000)}</div>
            <div className="mt-1 text-xs text-forge-muted">{formatCompact(group.inputTokens + group.outputTokens)} tokens</div>
          </div>
        </div>
      )) : <div className="p-4 text-sm text-forge-muted">No usage recorded.</div>}
    </div>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof DollarSign; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-forge-line bg-forge-panel p-4 shadow-command">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-forge-muted">{label}</div>
        <Icon className="h-5 w-5 text-forge-cyan" />
      </div>
      <div className="mt-2 text-2xl font-semibold text-white">{value}</div>
    </div>
  );
}

function Panel({ title, action, children }: { title: string; action: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-forge-line bg-forge-panel shadow-command">
      <div className="flex min-h-[52px] items-center justify-between border-b border-forge-line px-4">
        <h2 className="font-semibold text-white">{title}</h2>
        <span className="rounded border border-forge-line px-2 py-1 text-xs text-forge-muted">{action}</span>
      </div>
      {children}
    </section>
  );
}

function formatDollars(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(value);
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatBudgetInput(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return "0";
  }
  return Number(value.toFixed(2)).toString();
}

function readableError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return "Budget save failed.";
}
