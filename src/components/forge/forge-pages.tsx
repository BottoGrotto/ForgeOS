"use client";

import { Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { Activity, ArrowRight, Bot, ChevronDown, ChevronLeft, ChevronRight, Clock, FileText, Folder, Github, History, Link as LinkIcon, ListChecks, MessageSquare, Play, Power, RefreshCw, RotateCcw, Search, ShieldCheck, Unplug, Users, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import type { AgentRun, AgentRunStatus, Division, ExecutiveProposal, ForgeRepositorySnapshot, ForgeSnapshot, Operation, RunTraceSummary, RuntimeCommand, RuntimeEvent, RuntimeStatus, RuntimeVerificationCheckSummary, RuntimeVerificationSummary, VirtualFile, Worker } from "@/lib/runtime/types";
import { deriveForgeMetrics } from "@/lib/runtime/metrics";
import { getActiveRunForOperation, getLatestRunForOperation, getRunDurationLabel, getRunEvents, getRunsForOperation, getRunTraceSummaryRows, isActiveRun } from "@/lib/runtime/runs";
import { useForgeStore } from "@/lib/store/forge-store";
import { severityClass } from "./status";
import { EmptyState, ForgeShell, Panel, Progress, StatusBadge } from "./forge-ui";

type OperationStatusFilter = "all" | RuntimeStatus | "blockers";
type TeamTone = "strategy" | "operations" | "engineering" | "presentation" | "qa" | "release" | "general";
type AssetGroupMode = "feature" | "type" | "division" | "status";
type ForgeArtifact = ForgeSnapshot["artifacts"][number];

export interface ActiveAgentCard {
  id: string;
  operationId: string;
  workerName: string;
  operationTitle: string;
  activity: string;
  status: AgentRunStatus;
  provider: string;
  model?: string;
  modelTier?: string;
  durationLabel: string;
  teamTone: TeamTone;
}

export function OverviewPage({ initialSnapshot }: { initialSnapshot: ForgeSnapshot }) {
  const { snapshot, hydrate, connectEventStream, runCommand, commandPending, commandError } = useForgeStore();
  useEffect(() => hydrate(initialSnapshot), [hydrate, initialSnapshot]);
  useEffect(() => connectEventStream(initialSnapshot.forge.slug, initialSnapshot.lastEventSequence), [connectEventStream, initialSnapshot.forge.slug, initialSnapshot.lastEventSequence]);
  const current: ForgeSnapshot = snapshot ?? initialSnapshot;
  const metrics = deriveForgeMetrics(current);
  const blockers = current.operations.filter((operation) => ["blocked", "failed"].includes(operation.status));
  const readyOperations = current.operations.filter((operation) => operation.status === "ready");
  const activeRuns = current.runs.filter(isActiveRun);
  const activeOperation = activeRuns[0] ? current.operations.find((operation) => operation.id === activeRuns[0].operationId) : undefined;
  const nextOperation = readyOperations[0] ?? current.operations.find((operation) => operation.status === "running") ?? current.operations.find((operation) => operation.status === "blocked") ?? current.operations[0];
  const healthOperation = activeOperation ?? nextOperation;

  return (
    <ForgeShell snapshot={current}>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-4">
          <ExecutiveConsole
            snapshot={current}
            pending={commandPending}
            commandError={commandError}
            nextOperation={healthOperation}
            blockers={blockers}
            onCommand={runCommand}
          />
          <ActiveAgentsPanel snapshot={current} />
        </div>
        <ProjectHealthRail
          snapshot={current}
          metrics={metrics}
          nextOperation={nextOperation}
          blockers={blockers}
          activeRunCount={activeRuns.length}
          readyCount={readyOperations.length}
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <NeedsAttentionList snapshot={current} blockers={blockers} nextOperation={nextOperation} />
        <TeamHealthPanel snapshot={current} metrics={metrics} />
      </div>
    </ForgeShell>
  );
}

function ProjectHealthRail({
  snapshot,
  metrics,
  nextOperation,
  blockers,
  activeRunCount,
  readyCount
}: {
  snapshot: ForgeSnapshot;
  metrics: ReturnType<typeof deriveForgeMetrics>;
  nextOperation?: Operation;
  blockers: Operation[];
  activeRunCount: number;
  readyCount: number;
}) {
  const latestSummary = snapshot.messages.filter((item) => item.kind === "executive_summary").at(-1);

  return (
    <Panel title="Project Health" action={metrics.estimatedCompletion}>
      <div className="space-y-4 p-4">
        <div>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-forge-muted">Progress</span>
            <span className="font-semibold text-white">{metrics.progress}%</span>
          </div>
          <Progress value={metrics.progress} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <HealthMetric label="Phase" value={snapshot.forge.activePhase} />
          <HealthMetric label="Active Runs" value={activeRunCount} />
          <HealthMetric label="Blockers" value={blockers.length} tone={blockers.length > 0 ? "warning" : "success"} />
          <HealthMetric label="Next Ready" value={readyCount} />
        </div>
        <div className="rounded border border-forge-line bg-black/20 p-3">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase text-forge-muted">Next Work</div>
              <div className="mt-1 font-semibold text-white">{nextOperation?.title ?? "No operation selected"}</div>
            </div>
            {nextOperation ? <StatusBadge status={nextOperation.status} /> : null}
          </div>
          <p className="text-sm leading-6 text-slate-300">{nextOperation?.blockedReason ?? nextOperation?.description ?? "The Forge has no operations loaded."}</p>
        </div>
        <div className="rounded border border-forge-line bg-black/20 p-3">
          <div className="text-xs uppercase text-forge-muted">Latest Executive Summary</div>
          <p className="mt-2 text-sm leading-6 text-slate-300">{latestSummary?.content ?? "No executive summary has been generated yet."}</p>
        </div>
      </div>
    </Panel>
  );
}

function ActiveAgentsPanel({ snapshot }: { snapshot: ForgeSnapshot }) {
  const cards = deriveActiveAgentCards(snapshot);

  return (
    <Panel title="Active Agents" action={`${cards.length} running`}>
      <div className="scrollbar max-h-[260px] overflow-auto p-3">
        {cards.length > 0 ? (
          <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
            {cards.map((card) => (
              <NextLink
                key={card.id}
                href={getOperationsHref(snapshot.forge.slug, { operationId: card.operationId })}
                data-team-tone={card.teamTone}
                className="block rounded border border-forge-cyan/40 bg-forge-cyan/10 p-3 shadow-[0_0_0_1px_rgba(34,211,238,0.08),0_10px_28px_rgba(34,211,238,0.08)] hover:border-forge-cyan"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-white">{card.workerName}</div>
                    <div className="mt-1 truncate text-xs uppercase text-forge-muted">{card.operationTitle}</div>
                  </div>
                  <span className={`shrink-0 rounded px-2 py-1 text-xs uppercase ${runStatusClass(card.status)}`}>{card.status}</span>
                </div>
                <div className="mt-3 truncate text-sm text-slate-300">{card.activity}</div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-forge-muted">
                  <span>{card.provider}</span>
                  {card.modelTier ? <span>{card.modelTier}</span> : null}
                  {card.model ? <span>{card.model}</span> : null}
                  <span>{card.durationLabel}</span>
                </div>
              </NextLink>
            ))}
          </div>
        ) : (
          <EmptyState text="No active agents are running right now." />
        )}
      </div>
    </Panel>
  );
}

function HealthMetric({ label, value, tone = "default" }: { label: string; value: string | number; tone?: "default" | "success" | "warning" }) {
  const toneClass = tone === "success" ? "text-emerald-100" : tone === "warning" ? "text-amber-100" : "text-white";

  return (
    <div className="rounded border border-forge-line bg-black/20 p-3">
      <div className="text-xs uppercase text-forge-muted">{label}</div>
      <div className={`mt-1 truncate text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function NeedsAttentionList({ snapshot, blockers, nextOperation }: { snapshot: ForgeSnapshot; blockers: Operation[]; nextOperation?: Operation }) {
  const items = blockers.length > 0 ? blockers.slice(0, 4) : nextOperation ? [nextOperation] : [];

  return (
    <Panel title="Needs Attention" action={`${items.length} item${items.length === 1 ? "" : "s"}`}>
      <div className="space-y-3 p-4">
        {items.length > 0 ? items.map((operation) => (
          <AttentionOperation key={operation.id} snapshot={snapshot} operation={operation} />
        )) : <EmptyState text="No operations need attention right now." />}
      </div>
    </Panel>
  );
}

function AttentionOperation({ snapshot, operation }: { snapshot: ForgeSnapshot; operation: Operation }) {
  const division = snapshot.divisions.find((item) => item.id === operation.divisionId);
  const worker = snapshot.workers.find((item) => item.id === operation.workerId);
  const teamTone = getTeamTone(snapshot, operation.divisionId);

  return (
    <NextLink href={`/forge/${snapshot.forge.slug}/operations?operation=${operation.id}`} data-team-tone={teamTone} className="block rounded border border-forge-line bg-black/20 p-3 hover:border-forge-cyan">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-white">{operation.title}</div>
          <div className="mt-1 text-xs text-forge-muted">{division?.name ?? "Unknown division"} / {worker?.name ?? "Unassigned worker"}</div>
        </div>
        <StatusBadge status={operation.status} />
      </div>
      <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-300">{operation.blockedReason ?? operation.description}</p>
    </NextLink>
  );
}

function TeamHealthPanel({ snapshot, metrics }: { snapshot: ForgeSnapshot; metrics: ReturnType<typeof deriveForgeMetrics> }) {
  const divisions = snapshot.divisions
    .map((division) => {
      const operations = snapshot.operations.filter((operation) => operation.divisionId === division.id);
      const progress = operations.length === 0 ? division.progress : Math.round(operations.reduce((sum, operation) => sum + operation.progress, 0) / operations.length);
      const blocked = operations.filter((operation) => ["blocked", "failed"].includes(operation.status)).length;
      const activeWorkers = snapshot.workers.filter((worker) => worker.divisionId === division.id && worker.status === "running").length;

      return { ...division, progress, blocked, activeWorkers };
    })
    .sort((first, second) => second.blocked - first.blocked || first.progress - second.progress)
    .slice(0, 4);

  return (
    <Panel title="Team Health" action={`${metrics.runtimeStability}% stability`}>
      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <HealthMetric label="Active Workers" value={metrics.activeWorkers} />
          <HealthMetric label="Readiness" value={`${metrics.deploymentReadiness}%`} />
          <HealthMetric label="Confidence" value={`${metrics.confidence}%`} />
        </div>
        <div className="space-y-3">
          {divisions.map((division) => (
            <div key={division.id} data-team-tone={getTeamTone(snapshot, division.id)} className="rounded border border-forge-line bg-black/20 p-3">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-white">{division.name}</div>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-forge-muted">
                    <span className="flex items-center gap-1"><Users className="h-3 w-3" />{division.activeWorkers} active</span>
                    <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3" />{division.blocked} blocked</span>
                  </div>
                </div>
                <span className="shrink-0 text-sm font-semibold text-white">{division.progress}%</span>
              </div>
              <Progress value={division.progress} compact />
            </div>
          ))}
          {divisions.length === 0 ? <EmptyState text="No divisions have been configured yet." /> : null}
        </div>
      </div>
    </Panel>
  );
}

export function OrganizationPage({ initialSnapshot }: { initialSnapshot: ForgeSnapshot }) {
  const { snapshot, hydrate, connectEventStream } = useForgeStore();
  useEffect(() => hydrate(initialSnapshot), [hydrate, initialSnapshot]);
  useEffect(() => connectEventStream(initialSnapshot.forge.slug, initialSnapshot.lastEventSequence), [connectEventStream, initialSnapshot.forge.slug, initialSnapshot.lastEventSequence]);
  const current: ForgeSnapshot = snapshot ?? initialSnapshot;
  const [selected, setSelected] = useState<{ type: "division" | "worker"; id: string } | null>(null);
  const detail = getOrgDetail(current, selected);
  const detailTeamTone = getOrgSelectionTeamTone(current, selected);

  return (
    <ForgeShell snapshot={current}>
      <div className="grid min-h-[720px] gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <Panel title="Agent Organization Map" action="Full page topology">
          <div className="scrollbar grid max-h-[760px] gap-4 overflow-auto p-4 lg:grid-cols-2 2xl:grid-cols-3">
            {current.divisions.map((division) => {
              const workers = current.workers.filter((worker) => worker.divisionId === division.id);
              const divisionSelected = selected?.type === "division" && selected.id === division.id;
              return (
                <div
                  key={division.id}
                  data-team-tone={getTeamTone(current, division.id)}
                  className={`rounded-lg border p-4 transition duration-150 hover:-translate-y-0.5 hover:border-forge-cyan hover:bg-forge-cyan/10 hover:shadow-[0_0_0_1px_rgba(34,211,238,0.18),0_14px_32px_rgba(34,211,238,0.08)] ${
                    divisionSelected ? "border-forge-cyan bg-forge-cyan/10 shadow-[0_0_0_1px_rgba(34,211,238,0.22)]" : "border-forge-line bg-black/20"
                  }`}
                >
                  <button
                    type="button"
                    className="group relative flex w-full items-start justify-between gap-3 rounded p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forge-cyan/70"
                    onClick={() => setSelected({ type: "division", id: division.id })}
                    aria-label={`Inspect ${division.name}`}
                  >
                    <span className="pointer-events-none absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded border border-forge-cyan/0 bg-forge-cyan/0 text-forge-cyan opacity-0 transition group-hover:border-forge-cyan/30 group-hover:bg-forge-cyan/10 group-hover:opacity-100 group-focus-visible:border-forge-cyan/30 group-focus-visible:bg-forge-cyan/10 group-focus-visible:opacity-100">
                      <Search className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 pr-9">
                      <div className="font-semibold text-white transition group-hover:text-forge-cyan">{division.name}</div>
                      <p className="mt-2 text-sm leading-6 text-slate-300">{division.objective}</p>
                    </div>
                    <div className="mr-8 shrink-0">
                      <StatusBadge status={division.status} />
                    </div>
                  </button>
                  <Progress value={division.progress} compact />
                  <div className="mt-4 space-y-2">
                    {workers.map((worker) => (
                      <button
                        key={worker.id}
                        data-team-tone={getTeamTone(current, worker.divisionId)}
                        className={`group relative flex w-full items-center gap-2 rounded border px-3 py-2 pr-10 text-left text-sm transition duration-150 hover:-translate-y-0.5 hover:border-forge-cyan hover:bg-forge-cyan/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forge-cyan/70 ${
                          selected?.type === "worker" && selected.id === worker.id ? "border-forge-cyan bg-forge-cyan/10" : "border-forge-line bg-forge-panel"
                        }`}
                        onClick={() => setSelected({ type: "worker", id: worker.id })}
                        aria-label={`Inspect ${worker.name}`}
                      >
                        <Search className="pointer-events-none absolute right-2 top-2 h-3.5 w-3.5 text-forge-cyan opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100" />
                        <Bot className="h-4 w-4 text-forge-blue transition group-hover:text-forge-cyan" />
                        <span className="min-w-0 flex-1 truncate text-slate-200 transition group-hover:text-white">{worker.name}</span>
                        <StatusBadge status={worker.status} />
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
        <StickyDetail title={detail.title} subtitle={detail.subtitle} teamTone={detailTeamTone}>
          {!selected ? <EmptyOrgInspectorHint /> : null}
          <DetailRows rows={detail.rows} />
          <DetailSections sections={detail.sections} />
        </StickyDetail>
      </div>
    </ForgeShell>
  );
}

export function OperationsPage({ initialSnapshot }: { initialSnapshot: ForgeSnapshot }) {
  return (
    <Suspense fallback={<OperationsPageFallback initialSnapshot={initialSnapshot} />}>
      <OperationsPageContent initialSnapshot={initialSnapshot} />
    </Suspense>
  );
}

function OperationsPageFallback({ initialSnapshot }: { initialSnapshot: ForgeSnapshot }) {
  return (
    <ForgeShell snapshot={initialSnapshot}>
      <div className="grid min-h-[720px] gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <Panel title="Operations Board" action="Loading">
          <div className="p-4">
            <EmptyState text="Loading operations board." />
          </div>
        </Panel>
        <StickyDetail title="Operation" subtitle="Loading selected operation.">
          <EmptyState text="Operation details will appear here." />
        </StickyDetail>
      </div>
    </ForgeShell>
  );
}

function OperationsPageContent({ initialSnapshot }: { initialSnapshot: ForgeSnapshot }) {
  const { snapshot, hydrate, connectEventStream, runCommand, commandPending, commandError } = useForgeStore();
  useEffect(() => hydrate(initialSnapshot), [hydrate, initialSnapshot]);
  useEffect(() => connectEventStream(initialSnapshot.forge.slug, initialSnapshot.lastEventSequence), [connectEventStream, initialSnapshot.forge.slug, initialSnapshot.lastEventSequence]);
  const current: ForgeSnapshot = snapshot ?? initialSnapshot;
  const searchParams = useSearchParams();
  const operationParam = searchParams.get("operation");
  const statusParam = parseOperationStatusFilter(searchParams.get("status"));
  const initialSelectedId = operationParam && current.operations.some((operation) => operation.id === operationParam) ? operationParam : null;
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [query, setQuery] = useState("");
  const [groupBy, setGroupBy] = useState<"status" | "division" | "worker" | "priority">("status");
  const [statusFilter, setStatusFilter] = useState<OperationStatusFilter>(statusParam);
  const filteredOperations = useMemo(
    () => filterOperations(current, query, statusFilter),
    [current, query, statusFilter]
  );
  const operationGroups = useMemo(
    () => groupOperations(current, filteredOperations, groupBy),
    [current, filteredOperations, groupBy]
  );
  const selected = selectedId ? current.operations.find((operation) => operation.id === selectedId) : undefined;
  const deps = selected ? current.dependencies.filter((dependency) => dependency.operationId === selected.id) : [];
  const selectedRuns = selected ? getRunsForOperation(current.runs, selected.id) : [];
  const activeRun = selected ? getActiveRunForOperation(current.runs, selected.id) : undefined;
  const latestRun = selected ? getLatestRunForOperation(current.runs, selected.id) : undefined;
  const timelineRun = activeRun ?? latestRun;
  const timelineEvents = timelineRun ? getRunEvents(current.events, timelineRun.id) : [];
  const canRunSelectedOperation = selected?.status === "ready" && current.forge.status === "active" && !activeRun;

  useEffect(() => {
    if (operationParam && filteredOperations.some((operation) => operation.id === operationParam)) {
      setSelectedId(operationParam);
      return;
    }

    if (operationParam) {
      setSelectedId(null);
      return;
    }

    if (selectedId && !filteredOperations.some((operation) => operation.id === selectedId)) {
      setSelectedId(null);
    }
  }, [current.operations, filteredOperations, operationParam, selectedId]);

  useEffect(() => {
    setStatusFilter(statusParam);
  }, [statusParam]);

  function updateStatusFilter(nextStatusFilter: OperationStatusFilter) {
    setStatusFilter(nextStatusFilter);
    setSelectedId(null);
    window.history.replaceState(null, "", getOperationsHref(current.forge.slug, { statusFilter: nextStatusFilter }));
  }

  return (
    <ForgeShell snapshot={current}>
      <div className="grid min-h-[720px] gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <Panel title="Operations Board" action={`${filteredOperations.length} shown`}>
          <div className="border-b border-forge-line p-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_180px]">
              <label className="block">
                <span className="mb-2 block text-xs uppercase text-forge-muted">Search Operations</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search title, worker, division, status, blocker"
                  className="w-full rounded border border-forge-line bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-forge-cyan"
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-xs uppercase text-forge-muted">Group By</span>
                <select
                  value={groupBy}
                  onChange={(event) => setGroupBy(event.target.value as typeof groupBy)}
                  className="w-full rounded border border-forge-line bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-forge-cyan"
                >
                  <option value="status">Status</option>
                  <option value="division">Division</option>
                  <option value="worker">Worker</option>
                  <option value="priority">Priority</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-xs uppercase text-forge-muted">Status Filter</span>
                  <select
                  value={statusFilter}
                  onChange={(event) => updateStatusFilter(event.target.value as OperationStatusFilter)}
                  className="w-full rounded border border-forge-line bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-forge-cyan"
                >
                  <option value="all">All statuses</option>
                  <option value="blockers">Blockers</option>
                  <option value="planning">Planning</option>
                  <option value="ready">Ready</option>
                  <option value="running">Running</option>
                  <option value="blocked">Blocked</option>
                  <option value="reviewing">Reviewing</option>
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
                  <option value="archived">Archived</option>
                </select>
              </label>
            </div>
          </div>
          <div className="scrollbar max-h-[680px] overflow-auto p-4">
            {operationGroups.length > 0 ? (
              <div className="space-y-5">
                {operationGroups.map((group) => (
                  <section key={group.label}>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <h3 className="font-semibold text-white">{group.label}</h3>
                        <div className="mt-1 text-xs uppercase text-forge-muted">{group.operations.length} operations</div>
                      </div>
                      <div className="min-w-[96px] text-right text-sm text-forge-muted">{group.averageProgress}% avg</div>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-2">
                      {group.operations.map((operation) => (
                        <OperationBoardCard
                          key={operation.id}
                          operation={operation}
                          teamTone={getTeamTone(current, operation.divisionId)}
                          creationEvent={getOperationCreationEvent(current.events, operation.id)}
                          activeRun={getActiveRunForOperation(current.runs, operation.id)}
                          latestRun={getLatestRunForOperation(current.runs, operation.id)}
                          selected={selected?.id === operation.id}
                          onSelect={() => {
                            setSelectedId(operation.id);
                            window.history.replaceState(null, "", getOperationsHref(current.forge.slug, { operationId: operation.id, statusFilter }));
                          }}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <EmptyState text="No operations match the current search and filters." />
            )}
          </div>
        </Panel>
        <StickyDetail title={selected?.title ?? "Operations Board"} subtitle={selected?.description ?? "Track runtime work, dependencies, run history, and blockers across the Forge."} teamTone={selected ? getTeamTone(current, selected.divisionId) : undefined}>
          {selected ? (
            <>
              <DetailRows rows={[
                ["Status", selected.status],
                ["Priority", selected.priority],
                ["Progress", `${selected.progress}%`],
                ["Retries", String(selected.retryCount)]
              ]} />
              <OperationProvenancePanel event={getOperationCreationEvent(current.events, selected.id)} />
              <OperationRunSummary activeRun={activeRun} latestRun={latestRun} latestProgressEvent={getLatestRunProgressEvent(timelineEvents, timelineRun?.id)} />
              <OperationTraceSummary run={activeRun ?? latestRun} />
              <OperationRecoveryPanel snapshot={current} operation={selected} run={activeRun ?? latestRun} />
              <RuntimeVerificationSummaryPanel run={activeRun ?? latestRun} />
              <DetailSections sections={[
                { title: "Blocker", items: [selected.blockedReason ?? "No active blocker recorded."] },
                { title: "Dependencies", items: deps.length ? deps.map((dep) => `${dep.type}: ${dep.dependsOnOperationId}`) : ["No blocking dependency recorded."] }
              ]} />
              <button
                className="mt-4 flex w-full items-center justify-center gap-2 rounded bg-forge-cyan px-3 py-2 text-sm font-semibold text-black disabled:opacity-60"
                disabled={commandPending || !canRunSelectedOperation}
                onClick={() => void runCommand({ type: "run_operation", operationId: selected.id })}
              >
                <Play className="h-4 w-4" />
                {activeRun ? "Operation Run Active" : canRunSelectedOperation ? "Run Selected Operation" : "Select a Ready Operation"}
              </button>
              {activeRun ? (
                <div className="mt-3 rounded border border-forge-line bg-black/20 p-3 text-sm text-forge-muted">
                  A run is already active for this operation. Manual duplicates are disabled until it finishes.
                </div>
              ) : selected.status !== "ready" || current.forge.status !== "active" ? (
                <div className="mt-3 rounded border border-forge-line bg-black/20 p-3 text-sm text-forge-muted">
                  Operations can run only when the Forge is active and the selected operation is ready.
                </div>
              ) : null}
              {commandError ? <div className="mt-3 rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{commandError}</div> : null}
              <RunHistory runs={selectedRuns} />
              <RunTimeline run={timelineRun} events={timelineEvents} />
            </>
          ) : <EmptyOperationInspectorHint />}
        </StickyDetail>
      </div>
    </ForgeShell>
  );
}

function parseOperationStatusFilter(value: string | null): OperationStatusFilter {
  if (value === "blockers") {
    return "blockers";
  }

  if (isRuntimeStatus(value)) {
    return value;
  }

  return "all";
}

function isRuntimeStatus(value: string | null): value is RuntimeStatus {
  return Boolean(value && ["idle", "planning", "ready", "running", "blocked", "reviewing", "paused", "completed", "failed", "canceled", "archived"].includes(value));
}

function getOperationsHref(forgeSlug: string, input: { operationId?: string; statusFilter?: OperationStatusFilter }) {
  const params = new URLSearchParams();
  if (input.operationId) {
    params.set("operation", input.operationId);
  }
  if (input.statusFilter && input.statusFilter !== "all") {
    params.set("status", input.statusFilter);
  }
  const query = params.toString();
  return `/forge/${forgeSlug}/operations${query ? `?${query}` : ""}`;
}

function OperationBoardCard({
  operation,
  teamTone,
  creationEvent,
  activeRun,
  latestRun,
  selected,
  onSelect
}: {
  operation: Operation;
  teamTone: TeamTone;
  creationEvent?: RuntimeEvent;
  activeRun?: AgentRun;
  latestRun?: AgentRun;
  selected: boolean;
  onSelect: () => void;
}) {
  const showLatestRun = !activeRun && operation.status === "completed";
  const indicatorRun = activeRun ?? (showLatestRun ? latestRun : undefined);
  const indicatorLabel = activeRun ? "Active run" : showLatestRun && latestRun ? "Last run" : getOperationStateLabel(operation.status);

  return (
    <button
      data-team-tone={teamTone}
      className={`rounded border p-4 text-left hover:border-forge-cyan ${
        selected ? "border-forge-cyan bg-forge-cyan/10" : "border-forge-line bg-black/20"
      }`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="font-semibold text-white">{operation.title}</div>
        <StatusBadge status={operation.status} />
      </div>
      <OperationOriginBadge event={creationEvent} compact />
      <OperationRecoveryBadges operation={operation} latestRun={latestRun} />
      <p className="mt-3 text-sm leading-6 text-slate-300">{operation.blockedReason ?? operation.description}</p>
      <Progress value={operation.progress} compact />
      <div className="mt-3 flex items-center justify-between gap-3 rounded border border-forge-line bg-black/20 px-3 py-2 text-xs">
        <span className="flex min-w-0 items-center gap-2 text-forge-muted">
          {activeRun ? <Activity className="h-3.5 w-3.5 text-forge-cyan" /> : <Clock className="h-3.5 w-3.5 text-slate-400" />}
          <span>{indicatorLabel}</span>
        </span>
        {indicatorRun ? (
          <span className={`shrink-0 rounded px-2 py-0.5 uppercase ${runStatusClass(indicatorRun.status)}`}>{indicatorRun.status}</span>
        ) : (
          <span className={`shrink-0 rounded px-2 py-0.5 uppercase ${operationStateClass(operation.status)}`}>{operation.status}</span>
        )}
      </div>
    </button>
  );
}

function getOperationStateLabel(status: RuntimeStatus) {
  switch (status) {
    case "ready":
      return "Ready to run";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "reviewing":
      return "In review";
    case "planning":
      return "Planning";
    case "paused":
      return "Paused";
    case "canceled":
      return "Canceled";
    case "completed":
      return "Completed";
    case "archived":
      return "Archived";
    case "idle":
      return "Idle";
  }
}

function operationStateClass(status: RuntimeStatus) {
  switch (status) {
    case "blocked":
    case "failed":
    case "canceled":
      return "border border-red-400/30 bg-red-500/10 text-red-100";
    case "ready":
    case "planning":
    case "reviewing":
      return "border border-amber-400/30 bg-amber-400/10 text-amber-100";
    case "running":
      return "border border-forge-cyan/30 bg-forge-cyan/10 text-forge-cyan";
    case "completed":
      return "border border-emerald-400/30 bg-emerald-400/10 text-emerald-100";
    case "paused":
    case "archived":
    case "idle":
      return "border border-slate-500/30 bg-slate-500/10 text-slate-300";
  }
}

function OperationOriginBadge({ event, compact = false }: { event?: RuntimeEvent; compact?: boolean }) {
  const origin = getOperationOrigin(event);
  if (!origin) {
    return null;
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? "mt-2" : ""}`}>
      <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs uppercase ${origin.className}`}>
        <Bot className="h-3 w-3" />
        {origin.label}
      </span>
      {!compact && event ? <span className="text-xs text-forge-muted">Created {formatRepositoryTimestamp(event.createdAt)}</span> : null}
    </div>
  );
}

function OperationProvenancePanel({ event }: { event?: RuntimeEvent }) {
  const origin = getOperationOrigin(event);
  if (!origin || !event) {
    return null;
  }

  const proposalId = getPayloadString(event.payload, "proposalId");
  const reason = getPayloadString(event.payload, "reason");

  return (
    <div className="mt-5 rounded border border-forge-line bg-black/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-white">Operation Origin</div>
        <OperationOriginBadge event={event} />
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-300">{origin.description}</p>
      <div className="mt-3 grid gap-2 text-sm">
        <div className="rounded border border-forge-line bg-forge-panel px-3 py-2">
          <div className="text-xs uppercase text-forge-muted">Event</div>
          <div className="mt-1 truncate text-slate-200">#{event.sequence} / {event.message}</div>
        </div>
        {proposalId ? (
          <div className="rounded border border-forge-line bg-forge-panel px-3 py-2">
            <div className="text-xs uppercase text-forge-muted">Proposal</div>
            <div className="mt-1 truncate text-slate-200">{proposalId}</div>
          </div>
        ) : null}
        {reason ? (
          <div className="rounded border border-forge-line bg-forge-panel px-3 py-2">
            <div className="text-xs uppercase text-forge-muted">Reason</div>
            <div className="mt-1 text-slate-200">{reason}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function getOperationOrigin(event?: RuntimeEvent) {
  if (!event || event.type !== "operation.created") {
    return undefined;
  }

  if (event.actorType === "executive") {
    return {
      label: "Executive-created",
      description: "The Executive AI created this operation through an approved proposal or runtime replanning path.",
      className: "border-forge-cyan/30 bg-forge-cyan/10 text-forge-cyan"
    };
  }

  if (event.actorType === "division") {
    return {
      label: "Lead-created",
      description: "A division lead created this operation while handling recovery or triage work.",
      className: "border-amber-400/30 bg-amber-400/10 text-amber-100"
    };
  }

  if (event.actorType === "runtime") {
    return {
      label: "Runtime-created",
      description: "The runtime created this operation automatically as part of scheduling or recovery.",
      className: "border-slate-400/30 bg-slate-500/10 text-slate-200"
    };
  }

  return undefined;
}

function getOperationCreationEvent(events: RuntimeEvent[], operationId: string) {
  return events.find((event) => event.type === "operation.created" && (event.targetId === operationId || getPayloadString(event.payload, "operationId") === operationId));
}

function OperationRecoveryBadges({ operation, latestRun }: { operation: Operation; latestRun?: AgentRun }) {
  const badges = [
    ...(operation.retryCount > 0 && operation.status === "running" ? ["Retrying"] : []),
    ...(operation.escalatedFromOperationId || operation.routingStage === "lead_triaged" ? ["Lead triage"] : []),
    ...(getFinalFailureCategory(latestRun) || operation.escalationFailureCategory ? ["Escalated"] : [])
  ];
  if (badges.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {badges.map((badge) => (
        <span key={badge} className="rounded border border-amber-300/30 bg-amber-400/10 px-2 py-0.5 text-xs uppercase text-amber-100">
          {badge}
        </span>
      ))}
    </div>
  );
}

function OperationRunSummary({ activeRun, latestRun, latestProgressEvent }: { activeRun?: AgentRun; latestRun?: AgentRun; latestProgressEvent?: RuntimeEvent }) {
  const summaryRun = activeRun ?? latestRun;

  if (!summaryRun) {
    return (
      <div className="mt-5">
        <EmptyState text="No agent run has been recorded for this operation." />
      </div>
    );
  }
  const latestProgressMessage = latestProgressEvent ? getPayloadString(latestProgressEvent.payload, "latestProgressMessage") ?? latestProgressEvent.message : undefined;
  const activeDurationMs = latestProgressEvent ? getPayloadNumber(latestProgressEvent.payload, "activeDurationMs") : undefined;
  const model = latestProgressEvent ? getPayloadString(latestProgressEvent.payload, "model") : undefined;
  const modelTier = latestProgressEvent ? getPayloadString(latestProgressEvent.payload, "modelTier") : undefined;
  const failureCategory = getFinalFailureCategory(summaryRun) ?? (latestProgressEvent ? getPayloadString(latestProgressEvent.payload, "failureCategory") : undefined);
  const retryReason = latestProgressEvent ? getPayloadString(latestProgressEvent.payload, "retryReason") : undefined;

  return (
    <div className="mt-5 rounded border border-forge-line bg-black/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            {activeRun ? <Activity className="h-4 w-4 text-forge-cyan" /> : <Clock className="h-4 w-4 text-slate-400" />}
            {activeRun ? "Active Run" : "Latest Run"}
          </div>
          <div className="mt-1 text-xs text-forge-muted">{summaryRun.id}</div>
        </div>
        <span className={`rounded px-2 py-1 text-xs uppercase ${runStatusClass(summaryRun.status)}`}>{summaryRun.status}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <RunSummaryMetric label="Provider" value={summaryRun.provider} />
        <RunSummaryMetric label="Duration" value={getRunDurationLabel(summaryRun)} />
        <RunSummaryMetric label="Queued" value={formatRepositoryTimestamp(summaryRun.queuedAt)} />
        <RunSummaryMetric label="Started" value={formatRepositoryTimestamp(summaryRun.startedAt)} />
        {modelTier ? <RunSummaryMetric label="Model Tier" value={modelTier} /> : null}
        {model ? <RunSummaryMetric label="Model" value={model} /> : null}
        {activeDurationMs !== undefined ? <RunSummaryMetric label="Active" value={formatDurationMs(activeDurationMs)} /> : null}
        {failureCategory ? <RunSummaryMetric label="Failure" value={failureCategory} /> : null}
      </div>
      {latestProgressMessage ? <div className="mt-3 rounded border border-forge-line bg-forge-panel p-3 text-sm text-slate-300">{latestProgressMessage}</div> : null}
      {retryReason ? <div className="mt-3 rounded border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">Retrying after {retryReason}.</div> : null}
      {summaryRun.error ? <div className="mt-3 rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{summaryRun.error}</div> : null}
    </div>
  );
}

function RunSummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-forge-line bg-forge-panel p-2">
      <div className="text-xs uppercase text-forge-muted">{label}</div>
      <div className="mt-1 truncate text-slate-200">{value}</div>
    </div>
  );
}

function OperationTraceSummary({ run }: { run?: AgentRun }) {
  const rows = getRunTraceSummaryRows(run);

  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 rounded border border-forge-line bg-black/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-white">Trace Summary</div>
        <div className="text-xs uppercase text-forge-muted">{rows.length} signals</div>
      </div>
      <div className="mt-3 grid gap-2 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 rounded border border-forge-line bg-forge-panel px-3 py-2">
            <div className="truncate text-xs uppercase text-forge-muted">{row.label}</div>
            <div className="truncate text-slate-200">{row.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RunHistory({ runs }: { runs: AgentRun[] }) {
  return (
    <div className="mt-5 rounded border border-forge-line bg-black/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <History className="h-4 w-4 text-forge-blue" />
          Run History
        </div>
        <div className="text-xs uppercase text-forge-muted">{runs.length} total</div>
      </div>
      <div className="mt-3 space-y-2">
        {runs.length > 0 ? runs.map((run) => (
          <div key={run.id} className="rounded border border-forge-line bg-forge-panel p-3">
            {(() => {
              const verificationSummary = getRuntimeVerificationSummary(run);
              return verificationSummary ? (
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className={`rounded px-2 py-0.5 uppercase ${verificationStatusClass(verificationSummary.status)}`}>verification {verificationSummary.status}</span>
                  <span className="text-forge-muted">{verificationSummary.projectedArtifactIds.length + verificationSummary.projectedFileIds.length + verificationSummary.projectedHandoffIds.length} projected outputs</span>
                </div>
              ) : null;
            })()}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-200">{run.id}</div>
                <div className="mt-1 text-xs text-forge-muted">{formatRepositoryTimestamp(run.queuedAt)} / {getRunDurationLabel(run)}</div>
              </div>
              <span className={`shrink-0 rounded px-2 py-1 text-xs uppercase ${runStatusClass(run.status)}`}>{run.status}</span>
            </div>
          </div>
        )) : <EmptyState text="No prior runs are available for this operation." />}
      </div>
    </div>
  );
}

function RunTimeline({ run, events }: { run?: AgentRun; events: RuntimeEvent[] }) {
  return (
    <div className="mt-5 rounded border border-forge-line bg-black/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-white">Lifecycle Timeline</div>
        <div className="max-w-[180px] truncate text-xs uppercase text-forge-muted">{run?.id ?? "No run selected"}</div>
      </div>
      <div className="mt-3 space-y-3">
        {run && events.length > 0 ? events.map((event) => (
          <div key={event.id} className="border-l border-forge-line pl-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-200">{event.type}</div>
                <div className="mt-1 text-sm leading-6 text-slate-300">{event.message}</div>
              </div>
              <span className={`shrink-0 rounded px-2 py-1 text-xs uppercase ${severityClass(event.severity)}`}>{event.severity}</span>
            </div>
            <div className="mt-1 text-xs text-forge-muted">#{event.sequence} / {formatRepositoryTimestamp(event.createdAt)}</div>
          </div>
        )) : <EmptyState text={run ? "No lifecycle events are linked to this run." : "Select an operation with a run to inspect its lifecycle."} />}
      </div>
    </div>
  );
}

function OperationRecoveryPanel({ snapshot, operation, run }: { snapshot: ForgeSnapshot; operation: Operation; run?: AgentRun }) {
  const repairBrief = getRepairBriefSummary(run);
  const finalFailureCategory = getFinalFailureCategory(run) ?? operation.escalationFailureCategory;
  const leadTriage = snapshot.operations.find((candidate) => candidate.escalatedFromOperationId === operation.id);
  const hasRecoveryState = operation.retryCount > 0 || finalFailureCategory || repairBrief || leadTriage || operation.escalatedFromOperationId;
  if (!hasRecoveryState) {
    return null;
  }

  const rows = [
    ["Retry Count", String(operation.retryCount)],
    ["Failure", finalFailureCategory ?? "None"],
    ["Repair Brief", repairBrief?.failureCategory ?? "None"],
    ["Next Action", leadTriage ? "Lead triage" : operation.escalatedFromOperationId ? "Resolve escalation" : "Worker retry"]
  ];

  return (
    <div className="mt-3 rounded border border-forge-line bg-black/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-white">Recovery State</div>
        {leadTriage ? <span className="rounded px-2 py-1 text-xs uppercase text-amber-100">Lead triage</span> : null}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded border border-forge-line bg-forge-panel p-2">
            <div className="text-xs uppercase text-forge-muted">{label}</div>
            <div className="mt-1 truncate text-slate-200">{value}</div>
          </div>
        ))}
      </div>
      {repairBrief?.whatFailed ? <p className="mt-3 text-sm leading-6 text-slate-300">{repairBrief.whatFailed}</p> : null}
      {leadTriage ? (
        <NextLink className="mt-3 inline-flex text-sm font-semibold text-forge-cyan hover:text-white" href={getOperationsHref(snapshot.forge.slug, { operationId: leadTriage.id })}>
          Open lead triage operation
        </NextLink>
      ) : null}
    </div>
  );
}

function RuntimeVerificationSummaryPanel({ run }: { run?: AgentRun }) {
  const summary = getRuntimeVerificationSummary(run);

  if (!summary) {
    return null;
  }

  const projectedCount = summary.projectedArtifactIds.length + summary.projectedFileIds.length + summary.projectedHandoffIds.length;
  const rows = [
    ["Status", summary.status],
    ["Tier", summary.tier ?? "development"],
    ["Checked", formatRepositoryTimestamp(summary.checkedAt)],
    ["Projected", String(projectedCount)],
    ["Blockers", String(summary.blockerCount)]
  ];

  return (
    <div className="mt-3 rounded border border-forge-line bg-black/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-white">Runtime Verification</div>
        <span className={`rounded px-2 py-1 text-xs uppercase ${verificationStatusClass(summary.status)}`}>{summary.status}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded border border-forge-line bg-forge-panel p-2">
            <div className="text-xs uppercase text-forge-muted">{label}</div>
            <div className="mt-1 truncate text-slate-200">{value}</div>
          </div>
        ))}
      </div>
      {summary.checks?.length ? (
        <div className="mt-3 space-y-2">
          {summary.checks.map((check) => (
            <div key={check.name} className="rounded border border-forge-line bg-forge-panel px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate font-semibold text-slate-200">{check.name}</span>
                <span className={`shrink-0 rounded px-2 py-0.5 text-xs uppercase ${verificationStatusClass(check.status)}`}>{check.status}</span>
              </div>
              {check.message ? <div className="mt-1 text-slate-300">{check.message}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
      {summary.omittedReasons?.length ? (
        <div className="mt-3 text-sm leading-6 text-forge-muted">{summary.omittedReasons.join(" ")}</div>
      ) : null}
    </div>
  );
}

function getRuntimeVerificationSummary(run?: AgentRun): RuntimeVerificationSummary | null {
  const value = run?.providerMetadata.verificationSummary;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const summary = value as Partial<RuntimeVerificationSummary>;
  if (
    summary.source !== "runtime" ||
    !isRuntimeVerificationStatus(summary.status) ||
    typeof summary.checkedAt !== "string" ||
    summary.providerShellAccess !== false ||
    !Array.isArray(summary.projectedArtifactIds) ||
    !Array.isArray(summary.projectedFileIds) ||
    !Array.isArray(summary.projectedHandoffIds) ||
    typeof summary.blockerCount !== "number"
  ) {
    return null;
  }

  return {
    source: "runtime",
    status: summary.status,
    tier: isRuntimeVerificationTier(summary.tier) ? summary.tier : undefined,
    checkedAt: summary.checkedAt,
    providerShellAccess: false,
    projectedArtifactIds: summary.projectedArtifactIds.filter((id): id is string => typeof id === "string"),
    projectedFileIds: summary.projectedFileIds.filter((id): id is string => typeof id === "string"),
    projectedHandoffIds: summary.projectedHandoffIds.filter((id): id is string => typeof id === "string"),
    blockerCount: summary.blockerCount,
    checks: Array.isArray(summary.checks)
      ? summary.checks.filter((check): check is RuntimeVerificationCheckSummary =>
          Boolean(check && typeof check === "object" && "name" in check && typeof check.name === "string" && "status" in check && isRuntimeVerificationStatus(check.status))
        )
      : undefined,
    omittedReasons: Array.isArray(summary.omittedReasons) ? summary.omittedReasons.filter((reason): reason is string => typeof reason === "string") : undefined
  };
}

function getRepairBriefSummary(run?: AgentRun): { failureCategory?: string; whatFailed?: string } | null {
  const value = run?.providerMetadata.repairBriefSummary;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const summary = value as { failureCategory?: unknown; whatFailed?: unknown };
  return {
    failureCategory: typeof summary.failureCategory === "string" ? summary.failureCategory : undefined,
    whatFailed: typeof summary.whatFailed === "string" ? summary.whatFailed : undefined
  };
}

function getFinalFailureCategory(run?: AgentRun) {
  const direct = run?.providerMetadata.finalFailureCategory;
  if (typeof direct === "string") {
    return direct;
  }
  const traceSummary = run?.providerMetadata.traceSummary;
  if (!traceSummary || typeof traceSummary !== "object" || Array.isArray(traceSummary)) {
    return undefined;
  }
  const lifecycle = (traceSummary as { lifecycle?: unknown }).lifecycle;
  if (!lifecycle || typeof lifecycle !== "object" || Array.isArray(lifecycle)) {
    return undefined;
  }
  const category = (lifecycle as { finalFailureCategory?: unknown }).finalFailureCategory;
  return typeof category === "string" ? category : undefined;
}

function isRuntimeVerificationStatus(value: unknown): value is RuntimeVerificationSummary["status"] {
  return value === "passed" || value === "failed" || value === "skipped" || value === "error";
}

function isRuntimeVerificationTier(value: unknown): value is RuntimeVerificationSummary["tier"] {
  return value === "development" || value === "acceptance";
}

function verificationStatusClass(status: RuntimeVerificationSummary["status"]) {
  switch (status) {
    case "passed":
      return "border border-emerald-400/30 bg-emerald-400/10 text-emerald-100";
    case "failed":
    case "error":
      return "border border-red-400/30 bg-red-500/10 text-red-100";
    case "skipped":
      return "border border-amber-400/30 bg-amber-400/10 text-amber-100";
  }
}

function runStatusClass(status: AgentRunStatus) {
  switch (status) {
    case "completed":
      return "border border-emerald-400/30 bg-emerald-400/10 text-emerald-100";
    case "failed":
    case "canceled":
      return "border border-red-400/30 bg-red-500/10 text-red-100";
    case "queued":
    case "starting":
      return "border border-amber-400/30 bg-amber-400/10 text-amber-100";
    case "running":
    case "streaming":
    case "resumed":
      return "border border-forge-cyan/30 bg-forge-cyan/10 text-forge-cyan";
  }
}

function filterOperations(snapshot: ForgeSnapshot, query: string, statusFilter: OperationStatusFilter) {
  const normalizedQuery = query.trim().toLowerCase();

  return snapshot.operations.filter((operation) => {
    if (statusFilter === "all" && operation.status === "archived") {
      return false;
    }

    if (statusFilter === "blockers" && !["blocked", "failed"].includes(operation.status)) {
      return false;
    }

    if (statusFilter !== "all" && statusFilter !== "blockers" && operation.status !== statusFilter) {
      return false;
    }

    if (!normalizedQuery) {
      return true;
    }

    const division = snapshot.divisions.find((item) => item.id === operation.divisionId);
    const worker = snapshot.workers.find((item) => item.id === operation.workerId);
    const searchable = [
      operation.title,
      operation.description,
      operation.status,
      operation.priority,
      operation.blockedReason ?? "",
      division?.name ?? "",
      worker?.name ?? ""
    ].join(" ").toLowerCase();

    return searchable.includes(normalizedQuery);
  });
}

function groupOperations(snapshot: ForgeSnapshot, operations: Operation[], groupBy: "status" | "division" | "worker" | "priority") {
  const groups = new Map<string, Operation[]>();

  for (const operation of operations) {
    const label = getOperationGroupLabel(snapshot, operation, groupBy);
    groups.set(label, [...(groups.get(label) ?? []), operation]);
  }

  return Array.from(groups.entries())
    .map(([label, groupOperations]) => ({
      label,
      operations: groupOperations,
      averageProgress: Math.round(groupOperations.reduce((sum, operation) => sum + operation.progress, 0) / groupOperations.length)
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function getOperationGroupLabel(snapshot: ForgeSnapshot, operation: Operation, groupBy: "status" | "division" | "worker" | "priority") {
  if (groupBy === "division") {
    return snapshot.divisions.find((division) => division.id === operation.divisionId)?.name ?? "Unknown Division";
  }

  if (groupBy === "worker") {
    return snapshot.workers.find((worker) => worker.id === operation.workerId)?.name ?? "Unassigned Worker";
  }

  if (groupBy === "priority") {
    return `${operation.priority[0].toUpperCase()}${operation.priority.slice(1)} Priority`;
  }

  return `${operation.status[0].toUpperCase()}${operation.status.slice(1)}`;
}

export function filterAssetsForSearch(artifacts: ForgeArtifact[], snapshot: ForgeSnapshot, query: string) {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return artifacts;
  }

  return artifacts.filter((artifact) => {
    const operation = snapshot.operations.find((item) => item.id === artifact.operationId);
    const division = snapshot.divisions.find((item) => item.id === artifact.divisionId);
    const worker = snapshot.workers.find((item) => item.id === artifact.workerId);
    const searchable = [
      artifact.title,
      artifact.type,
      artifact.status,
      artifact.content,
      ...artifact.tags,
      operation?.title ?? "",
      operation?.description ?? "",
      division?.name ?? "",
      worker?.name ?? ""
    ].join(" ").toLowerCase();

    return searchable.includes(normalizedQuery);
  });
}

export function buildAssetGroups(artifacts: ForgeArtifact[], snapshot: ForgeSnapshot, groupBy: AssetGroupMode) {
  const groups = new Map<string, { id: string; label: string; artifacts: ForgeArtifact[] }>();

  for (const artifact of artifacts) {
    const group = getAssetGroup(snapshot, artifact, groupBy);
    const existing = groups.get(group.id);
    groups.set(group.id, {
      ...group,
      artifacts: [...(existing?.artifacts ?? []), artifact]
    });
  }

  return Array.from(groups.values()).sort((left, right) => left.label.localeCompare(right.label));
}

function getAssetGroup(snapshot: ForgeSnapshot, artifact: ForgeArtifact, groupBy: AssetGroupMode) {
  if (groupBy === "division") {
    const division = snapshot.divisions.find((item) => item.id === artifact.divisionId);
    return { id: `division:${artifact.divisionId}`, label: division?.name ?? "Unknown Division" };
  }

  if (groupBy === "status") {
    return { id: `status:${artifact.status}`, label: formatAssetLabel(artifact.status) };
  }

  if (groupBy === "type") {
    return { id: `type:${artifact.type}`, label: formatAssetLabel(artifact.type) };
  }

  const operation = snapshot.operations.find((item) => item.id === artifact.operationId);
  if (operation) {
    return { id: `feature:${operation.id}`, label: operation.title };
  }

  const fallbackTag = artifact.tags[0];
  return fallbackTag
    ? { id: `feature-tag:${fallbackTag}`, label: `#${fallbackTag}` }
    : { id: "feature:unassigned", label: "Unassigned Feature" };
}

function formatAssetLabel(value: string) {
  return value
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function RepositoryConnectionPanel({
  forgeSlug,
  repository,
  githubAccount,
  githubOAuth,
  githubRepositories,
  githubAccountLoading,
  githubConfigLoading,
  githubStateError,
  githubRepositoryError,
  githubRepositoriesLoaded,
  repositoryUrl,
  owner,
  repo,
  defaultBranch,
  workingBranch,
  pending,
  githubPending,
  commandError,
  onRepositoryUrlChange,
  onOwnerChange,
  onRepoChange,
  onDefaultBranchChange,
  onWorkingBranchChange,
  onConnect,
  onLoadGitHubRepositories,
  onSelectGitHubRepository,
  onSyncGitHubRepository,
  onRefresh,
  onDisconnect
}: {
  forgeSlug: string;
  repository: ForgeRepositorySnapshot | null;
  githubAccount: { accountLogin: string; scopes: string[] } | null;
  githubOAuth: { configured: boolean; callbackUrl: string; missing: string[]; applicationSettingsUrl?: string } | null;
  githubRepositories: Array<{ owner: string; name: string; fullName: string; defaultBranch: string; private: boolean }>;
  githubAccountLoading: boolean;
  githubConfigLoading: boolean;
  githubStateError: string | null;
  githubRepositoryError: string | null;
  githubRepositoriesLoaded: boolean;
  repositoryUrl: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  workingBranch: string;
  pending: boolean;
  githubPending: boolean;
  commandError: string | null;
  onRepositoryUrlChange: (value: string) => void;
  onOwnerChange: (value: string) => void;
  onRepoChange: (value: string) => void;
  onDefaultBranchChange: (value: string) => void;
  onWorkingBranchChange: (value: string) => void;
  onConnect: () => void;
  onLoadGitHubRepositories: () => void;
  onSelectGitHubRepository: (repository: { owner: string; name: string; defaultBranch: string }) => void;
  onSyncGitHubRepository: (repository: { owner: string; name: string; defaultBranch: string }) => void;
  onRefresh: () => void;
  onDisconnect: () => void;
}) {
  const canConnect = repositoryUrl.trim().length > 0 || (owner.trim().length > 0 && repo.trim().length > 0);
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const visibleRepositories = useMemo(() => {
    const query = repositoryQuery.trim().toLowerCase();
    if (!query) {
      return githubRepositories;
    }

    return githubRepositories.filter((item) =>
      [item.owner, item.name, item.fullName, item.defaultBranch, item.private ? "private" : "public"]
        .some((value) => value.toLowerCase().includes(query))
    );
  }, [githubRepositories, repositoryQuery]);
  const hasPrivateRepositories = githubRepositories.some((item) => item.private);
  const hasRepoScope = githubAccount?.scopes.includes("repo") ?? false;
  const selectedRepositoryFullName = `${owner.trim()}/${repo.trim()}`.toLowerCase();
  const githubLoading = githubAccountLoading || githubConfigLoading;
  const accountDescription = githubAccount
    ? `Connected as ${githubAccount.accountLogin}${githubAccount.scopes.length > 0 ? ` / scopes: ${githubAccount.scopes.join(", ")}` : ""}`
    : githubLoading
      ? "Checking GitHub account and OAuth configuration."
      : githubOAuth?.configured
      ? "OAuth ready. Connect GitHub to sync private repositories."
      : githubStateError
        ? "GitHub account status is currently unavailable."
      : "GitHub OAuth app credentials are not configured.";

  return (
    <Panel title="GitHub Repository" action={repository ? "Metadata connected" : "Metadata only"}>
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          {repository ? (
            <div className="rounded border border-emerald-400/30 bg-emerald-400/10 p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm uppercase text-emerald-200">
                    <Github className="h-4 w-4" />
                    {repository.provider}
                  </div>
                  <div className="mt-2 truncate text-2xl font-semibold text-white">
                    {repository.owner}/{repository.repo}
                  </div>
                  <div className="mt-2 grid gap-2 text-sm text-emerald-100 sm:grid-cols-2">
                    <span>Default: {repository.defaultBranch}</span>
                    <span>Working: {repository.workingBranch}</span>
                  </div>
                </div>
                <div className="grid gap-2 text-sm text-emerald-100 sm:grid-cols-2 lg:min-w-[280px]">
                  <div className="rounded border border-emerald-400/20 bg-black/20 p-3">
                    <div className="text-xs uppercase text-emerald-200">Connected</div>
                    <div className="mt-1">{formatRepositoryTimestamp(repository.connectedAt)}</div>
                  </div>
                  <div className="rounded border border-emerald-400/20 bg-black/20 p-3">
                    <div className="text-xs uppercase text-emerald-200">Refreshed</div>
                    <div className="mt-1">{formatRepositoryTimestamp(repository.lastRefreshedAt)}</div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <EmptyState text="No GitHub repository metadata is connected." />
          )}

          <div className="rounded border border-forge-line bg-black/20 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="text-sm font-semibold text-white">GitHub Account</div>
                <div className="mt-1 text-sm text-forge-muted">
                  {accountDescription}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {githubOAuth?.configured ? (
                  <a href={`/api/github/oauth/start?forgeSlug=${encodeURIComponent(forgeSlug)}`} className="flex items-center justify-center gap-2 rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan">
                    <Github className="h-4 w-4" />
                    {githubAccount ? "Reconnect GitHub" : "Connect GitHub"}
                  </a>
                ) : (
                  <button type="button" disabled className="flex items-center justify-center gap-2 rounded border border-forge-line px-3 py-2 text-sm text-slate-400 opacity-60">
                    <Github className="h-4 w-4" />
                    Connect GitHub
                  </button>
                )}
                <button
                  className="flex items-center justify-center gap-2 rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan disabled:opacity-60"
                  disabled={!githubAccount || githubPending || githubAccountLoading}
                  onClick={onLoadGitHubRepositories}
                >
                  <RefreshCw className="h-4 w-4" />
                  Load Repositories
                </button>
              </div>
            </div>
            {githubStateError ? (
              <div className="mt-4 rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{githubStateError}</div>
            ) : null}
            {githubOAuth && !githubOAuth.configured ? (
              <div className="mt-4 rounded border border-amber-400/30 bg-amber-400/10 p-3 text-sm leading-6 text-amber-100">
                Create a GitHub OAuth app with callback <span className="font-mono text-xs">{githubOAuth.callbackUrl}</span>, then set {githubOAuth.missing.join(" and ")} in <span className="font-mono text-xs">.env.local</span>.
              </div>
            ) : null}
            {githubRepositoryError ? (
              <div className="mt-4 rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{githubRepositoryError}</div>
            ) : null}
            {githubRepositories.length > 0 || githubRepositoriesLoaded ? (
              <div className="mt-4 space-y-3">
                {githubRepositories.length > 0 && !hasPrivateRepositories ? (
                  <div className="rounded border border-amber-400/30 bg-amber-400/10 p-3 text-sm leading-6 text-amber-100">
                    {hasRepoScope
                      ? "GitHub granted the repo scope, but returned only public repositories. If the private repository belongs to an organization, approve SSO or OAuth app access in GitHub."
                      : "GitHub did not grant the repo scope, so private repositories are hidden. Reconnect GitHub and approve private repository access."}
                    {githubOAuth?.applicationSettingsUrl ? (
                      <>
                        {" "}
                        <a className="underline hover:text-white" href={githubOAuth.applicationSettingsUrl} target="_blank" rel="noreferrer">
                          Review GitHub authorization
                        </a>
                        .
                      </>
                    ) : null}
                  </div>
                ) : null}
                {githubRepositories.length > 0 ? (
                  <>
                    <label className="block">
                      <span className="mb-2 block text-xs uppercase text-forge-muted">Search Loaded Repositories</span>
                      <div className="flex items-center gap-2 rounded border border-forge-line bg-black/30 px-3 py-2 focus-within:border-forge-cyan">
                        <Search className="h-4 w-4 shrink-0 text-forge-muted" />
                        <input
                          value={repositoryQuery}
                          placeholder="Search owner, repo, branch, visibility"
                          onChange={(event) => setRepositoryQuery(event.target.value)}
                          className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-forge-muted"
                        />
                        <span className="text-xs text-forge-muted">{visibleRepositories.length}/{githubRepositories.length}</span>
                      </div>
                    </label>
                    <div className="scrollbar grid max-h-[252px] gap-2 overflow-y-auto pr-1 md:grid-cols-2">
                      {visibleRepositories.length > 0 ? visibleRepositories.map((item) => (
                        <button
                          key={item.fullName}
                          className={`rounded border bg-black/20 p-3 text-left hover:border-forge-cyan disabled:opacity-60 ${
                            item.fullName.toLowerCase() === selectedRepositoryFullName ? "border-forge-cyan" : "border-forge-line"
                          }`}
                          disabled={githubPending}
                          onClick={() => onSelectGitHubRepository({ owner: item.owner, name: item.name, defaultBranch: item.defaultBranch })}
                        >
                          <div className="truncate text-sm font-semibold text-white">{item.fullName}</div>
                          <div className="mt-1 text-xs uppercase text-forge-muted">
                            {item.private ? "private" : "public"} / {item.defaultBranch}
                            {item.fullName.toLowerCase() === selectedRepositoryFullName ? " / selected" : ""}
                          </div>
                        </button>
                      )) : (
                        <div className="rounded border border-dashed border-forge-line p-4 text-sm text-forge-muted md:col-span-2">No loaded repositories match this search.</div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="rounded border border-dashed border-forge-line p-4 text-sm text-forge-muted">
                    No repositories were returned for this GitHub account. Check private repository access, organization SSO, or OAuth app authorization.
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div className="md:col-span-2 xl:col-span-1">
              <RepositoryInput label="GitHub URL" value={repositoryUrl} placeholder="https://github.com/owner/repo" onChange={onRepositoryUrlChange} />
            </div>
            <RepositoryInput label="Owner" value={owner} placeholder="octo-org" onChange={onOwnerChange} />
            <RepositoryInput label="Repository" value={repo} placeholder="forgeos" onChange={onRepoChange} />
            <RepositoryInput label="Default Branch" value={defaultBranch} placeholder="main" onChange={onDefaultBranchChange} />
            <RepositoryInput label="Working Branch" value={workingBranch} placeholder={defaultBranch || "main"} onChange={onWorkingBranchChange} />
          </div>
        </div>

        <div className="flex flex-col justify-between gap-3 rounded border border-forge-line bg-black/20 p-4">
          <div>
            <div className="text-sm font-semibold text-white">Repository Context</div>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              Stores provider, owner, repository, branch, and refresh timestamps on the Forge snapshot.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
            <button
              className="flex items-center justify-center gap-2 rounded bg-forge-cyan px-3 py-2 text-sm font-semibold text-black disabled:opacity-60"
              disabled={pending || !canConnect}
              onClick={onConnect}
            >
              <LinkIcon className="h-4 w-4" />
              {repository ? "Update Connection" : "Connect"}
            </button>
            <button
              className="flex items-center justify-center gap-2 rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan disabled:opacity-60"
              disabled={pending || !repository}
              onClick={onRefresh}
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
            <button
              className="flex items-center justify-center gap-2 rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan disabled:opacity-60"
              disabled={githubPending || !githubAccount || !repository}
              onClick={() => onSyncGitHubRepository({ owner, name: repo, defaultBranch: workingBranch || defaultBranch })}
            >
              <RotateCcw className="h-4 w-4" />
              Sync Repository
            </button>
            <button
              className="flex items-center justify-center gap-2 rounded border border-red-400/40 px-3 py-2 text-sm text-red-100 hover:border-red-200 disabled:opacity-60"
              disabled={pending || !repository}
              onClick={onDisconnect}
            >
              <Unplug className="h-4 w-4" />
              Disconnect
            </button>
          </div>
          {commandError ? <div className="rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{commandError}</div> : null}
        </div>
      </div>
    </Panel>
  );
}

function RepositoryInput({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs uppercase text-forge-muted">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded border border-forge-line bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-forge-cyan"
      />
    </label>
  );
}

function formatRepositoryTimestamp(value: string | undefined) {
  if (!value) {
    return "Not recorded";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return value.slice(0, 19).replace("T", " ");
}

export function WorkspacePage({ initialSnapshot }: { initialSnapshot: ForgeSnapshot }) {
  const { snapshot, hydrate, connectEventStream, runCommand, commandPending, commandError } = useForgeStore();
  useEffect(() => hydrate(initialSnapshot), [hydrate, initialSnapshot]);
  useEffect(() => connectEventStream(initialSnapshot.forge.slug, initialSnapshot.lastEventSequence), [connectEventStream, initialSnapshot.forge.slug, initialSnapshot.lastEventSequence]);
  const current = snapshot ?? initialSnapshot;
  const searchParams = useSearchParams();
  const githubStatus = searchParams.get("github");
  const repository = current.repository ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [owner, setOwner] = useState(repository?.owner ?? "");
  const [repo, setRepo] = useState(repository?.repo ?? "");
  const [defaultBranch, setDefaultBranch] = useState(repository?.defaultBranch ?? "main");
  const [workingBranch, setWorkingBranch] = useState(repository?.workingBranch ?? repository?.defaultBranch ?? "main");
  const [githubAccount, setGithubAccount] = useState<{ accountLogin: string; scopes: string[] } | null>(null);
  const [githubOAuth, setGithubOAuth] = useState<{ configured: boolean; callbackUrl: string; missing: string[]; applicationSettingsUrl?: string } | null>(null);
  const [githubRepositories, setGithubRepositories] = useState<Array<{ owner: string; name: string; fullName: string; defaultBranch: string; private: boolean }>>([]);
  const [githubPending, setGithubPending] = useState(false);
  const [githubAccountLoading, setGithubAccountLoading] = useState(true);
  const [githubConfigLoading, setGithubConfigLoading] = useState(true);
  const [githubStateError, setGithubStateError] = useState<string | null>(null);
  const [githubRepositoryError, setGithubRepositoryError] = useState<string | null>(null);
  const [githubRepositoriesLoaded, setGithubRepositoriesLoaded] = useState(false);
  const [fileSearch, setFileSearch] = useState("");
  const [fileGroupBy, setFileGroupBy] = useState<WorkspaceFileGroupMode>("directory");
  const [collapsedFileGroups, setCollapsedFileGroups] = useState<Set<string>>(() => new Set());
  const selected = selectedId ? current.files.find((file) => file.id === selectedId) : undefined;
  const visibleFiles = useMemo(() => filterWorkspaceFiles(current.files, fileSearch), [current.files, fileSearch]);
  const fileGroups = useMemo(() => buildWorkspaceFileGroups(visibleFiles, current, fileGroupBy), [visibleFiles, current, fileGroupBy]);

  function toggleFileGroup(groupId: string) {
    setCollapsedFileGroups((currentGroups) => {
      const nextGroups = new Set(currentGroups);
      if (nextGroups.has(groupId)) {
        nextGroups.delete(groupId);
      } else {
        nextGroups.add(groupId);
      }
      return nextGroups;
    });
  }

  useEffect(() => {
    if (!repository) {
      return;
    }

    setOwner(repository.owner);
    setRepo(repository.repo);
    setDefaultBranch(repository.defaultBranch);
    setWorkingBranch(repository.workingBranch);
  }, [repository]);

  useEffect(() => {
    let active = true;
    async function loadGitHubState() {
      setGithubAccountLoading(true);
      setGithubConfigLoading(true);
      setGithubStateError(null);
      const [accountResult, oauthResult] = await Promise.allSettled([
        fetch(`/api/forges/${current.forge.slug}/github/account`, { cache: "no-store" }),
        fetch("/api/github/oauth/config", { cache: "no-store" })
      ]);
      if (!active) {
        return;
      }

      if (accountResult.status === "fulfilled") {
        const accountPayload = (await accountResult.value.json().catch(() => ({}))) as { success?: boolean; data?: { account: { accountLogin: string; scopes: string[] } | null }; error?: string };
        if (accountResult.value.ok && accountPayload.success) {
          setGithubAccount(accountPayload.data?.account ?? null);
        } else {
          setGithubStateError(accountPayload.error ?? "GitHub account status failed to load.");
        }
      } else {
        setGithubStateError("GitHub account status failed to load.");
      }
      setGithubAccountLoading(false);

      if (oauthResult.status === "fulfilled") {
        const oauthPayload = (await oauthResult.value.json().catch(() => ({}))) as { success?: boolean; data?: { configured: boolean; callbackUrl: string; missing: string[]; applicationSettingsUrl?: string }; error?: string };
        if (oauthResult.value.ok && oauthPayload.success && oauthPayload.data) {
          setGithubOAuth(oauthPayload.data);
        } else {
          setGithubStateError(oauthPayload.error ?? "GitHub OAuth configuration failed to load.");
        }
      } else {
        setGithubStateError("GitHub OAuth configuration failed to load.");
      }
      setGithubConfigLoading(false);
    }
    void loadGitHubState();
    return () => {
      active = false;
    };
  }, [current.forge.slug]);

  async function connectRepository() {
    const trimmedRepositoryUrl = repositoryUrl.trim();
    const trimmedOwner = owner.trim();
    const trimmedRepo = repo.trim();
    const trimmedDefaultBranch = defaultBranch.trim() || "main";
    const trimmedWorkingBranch = workingBranch.trim() || trimmedDefaultBranch;

    if (!trimmedRepositoryUrl && (!trimmedOwner || !trimmedRepo)) {
      return;
    }

    await runCommand({
      type: "connect_repository",
      repositoryUrl: trimmedRepositoryUrl || undefined,
      owner: trimmedRepositoryUrl ? undefined : trimmedOwner,
      repo: trimmedRepositoryUrl ? undefined : trimmedRepo,
      defaultBranch: trimmedDefaultBranch,
      workingBranch: trimmedWorkingBranch
    });
  }

  async function loadGitHubRepositories() {
    setGithubPending(true);
    setGithubRepositoryError(null);
    try {
      const response = await fetch(`/api/forges/${current.forge.slug}/github/repositories`, { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as { success?: boolean; data?: { repositories: Array<{ owner: string; name: string; fullName: string; defaultBranch: string; private: boolean }> }; error?: string };
      if (response.ok && payload.success && payload.data) {
        setGithubRepositories(payload.data.repositories);
        setGithubRepositoriesLoaded(true);
      } else {
        setGithubRepositories([]);
        setGithubRepositoriesLoaded(true);
        setGithubRepositoryError(payload.error ?? "GitHub repositories failed to load.");
      }
    } catch {
      setGithubRepositories([]);
      setGithubRepositoriesLoaded(true);
      setGithubRepositoryError("GitHub repositories failed to load.");
    } finally {
      setGithubPending(false);
    }
  }

  async function syncGitHubRepository(item: { owner: string; name: string; defaultBranch: string }) {
    setGithubPending(true);
    setGithubRepositoryError(null);
    try {
      const response = await fetch(`/api/forges/${current.forge.slug}/github/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: item.owner, repo: item.name, ref: item.defaultBranch, idempotencyKey: `sync-${item.owner}-${item.name}-${Date.now()}` })
      });
      const payload = (await response.json().catch(() => ({}))) as { success?: boolean; data?: ForgeSnapshot; error?: string };
      if (response.ok && payload.success && payload.data) {
        hydrate(payload.data);
      } else {
        setGithubRepositoryError(payload.error ?? "GitHub repository sync failed.");
      }
    } catch {
      setGithubRepositoryError("GitHub repository sync failed.");
    } finally {
      setGithubPending(false);
    }
  }

  function selectGitHubRepository(item: { owner: string; name: string; defaultBranch: string }) {
    setRepositoryUrl("");
    setOwner(item.owner);
    setRepo(item.name);
    setDefaultBranch(item.defaultBranch);
    setWorkingBranch(item.defaultBranch);
  }

  return (
    <ForgeShell snapshot={current}>
      <div className="space-y-4">
        {githubStatus === "connected" ? (
          <div className="rounded border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">GitHub account connected. Load repositories to test access.</div>
        ) : null}
        {githubStatus === "oauth_failed" ? (
          <div className="rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">GitHub OAuth failed. Check the OAuth app callback URL and environment credentials.</div>
        ) : null}
        <RepositoryConnectionPanel
          forgeSlug={current.forge.slug}
          repository={repository}
          githubAccount={githubAccount}
          githubOAuth={githubOAuth}
          githubRepositories={githubRepositories}
          githubAccountLoading={githubAccountLoading}
          githubConfigLoading={githubConfigLoading}
          githubStateError={githubStateError}
          githubRepositoryError={githubRepositoryError}
          githubRepositoriesLoaded={githubRepositoriesLoaded}
          repositoryUrl={repositoryUrl}
          owner={owner}
          repo={repo}
          defaultBranch={defaultBranch}
          workingBranch={workingBranch}
          pending={commandPending}
          githubPending={githubPending}
          commandError={commandError}
          onRepositoryUrlChange={setRepositoryUrl}
          onOwnerChange={setOwner}
          onRepoChange={setRepo}
          onDefaultBranchChange={setDefaultBranch}
          onWorkingBranchChange={setWorkingBranch}
          onConnect={() => void connectRepository()}
          onLoadGitHubRepositories={() => void loadGitHubRepositories()}
          onSelectGitHubRepository={selectGitHubRepository}
          onSyncGitHubRepository={(item) => void syncGitHubRepository(item)}
          onRefresh={() => void runCommand({ type: "refresh_repository_context" })}
          onDisconnect={() => void runCommand({ type: "disconnect_repository" })}
        />
        <LaunchProjectPanel snapshot={current} pending={commandPending} commandError={commandError} onCommand={runCommand} />
        <div className="grid min-h-[720px] gap-4 xl:grid-cols-[340px_minmax(0,1fr)_360px]">
          <Panel title="Virtual File Tree" action={`${visibleFiles.length}/${current.files.length} files`}>
            <div className="border-b border-forge-line p-4">
              <label className="flex items-center gap-2 rounded border border-forge-line bg-black/20 px-3 py-2 text-sm text-slate-200 focus-within:border-forge-cyan">
                <Search className="h-4 w-4 text-forge-muted" />
                <input
                  value={fileSearch}
                  onChange={(event) => setFileSearch(event.target.value)}
                  placeholder="Search files"
                  className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-forge-muted"
                />
              </label>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {workspaceFileGroupModes.map((mode) => (
                  <button
                    key={mode.id}
                    className={`rounded border px-2 py-2 text-xs font-semibold ${fileGroupBy === mode.id ? "border-forge-cyan bg-forge-cyan/10 text-white" : "border-forge-line bg-black/20 text-forge-muted"}`}
                    onClick={() => setFileGroupBy(mode.id)}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="scrollbar max-h-[640px] space-y-1 overflow-auto p-3">
              {fileGroups.length > 0 ? (
                fileGroups.map((group) => (
                  <WorkspaceFileGroup
                    key={group.id}
                    group={group}
                    selectedId={selected?.id}
                    collapsedGroups={collapsedFileGroups}
                    onToggleGroup={toggleFileGroup}
                    onSelectFile={setSelectedId}
                    snapshot={current}
                  />
                ))
              ) : (
                <EmptyState text="No virtual files match the current search." />
              )}
            </div>
          </Panel>
          <Panel title={selected?.path ?? "File Renderer"} action="Read-only virtual workspace">
            {selected ? (
              <pre data-team-tone={getTeamTone(current, selected.divisionId)} className="scrollbar max-h-[760px] overflow-auto whitespace-pre-wrap p-5 font-mono text-sm leading-6 text-slate-200">{selected.content}</pre>
            ) : (
              <EmptyWorkspaceRenderer />
            )}
          </Panel>
          <StickyDetail title={selected?.path ?? "Workspace Files"} subtitle={selected ? "Read-only virtual workspace metadata." : "Browse synced and generated virtual files without touching the connected repository."} teamTone={selected ? getTeamTone(current, selected.divisionId) : undefined}>
            {selected ? <FileMetadata file={selected} snapshot={current} /> : <EmptyWorkspaceInspectorHint />}
          </StickyDetail>
        </div>
      </div>
    </ForgeShell>
  );
}

function LaunchProjectPanel({
  snapshot,
  pending,
  commandError,
  onCommand
}: {
  snapshot: ForgeSnapshot;
  pending: boolean;
  commandError: string | null;
  onCommand: (command: RuntimeCommand) => Promise<void>;
}) {
  const state = useMemo(() => deriveLauncherPanelState(snapshot), [snapshot]);
  const noPackage = !state.hasPackageJson;
  const noDevCheck = state.developmentScripts.length === 0;
  const noAcceptanceCheck = state.acceptanceScripts.length === 0;
  const noPreview = state.previewScripts.length === 0;
  const busy = pending || state.pending;

  function nextLauncherId() {
    return `launcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  return (
    <Panel title="Launch Project" action={state.statusLabel}>
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-4">
            <LauncherMetric label="Package" value={state.hasPackageJson ? "Detected" : "Missing"} tone={state.hasPackageJson ? "success" : "warning"} />
            <LauncherMetric label="Scripts" value={state.packageScripts.length} />
            <LauncherMetric label="Latest Check" value={state.latestCheckLabel} tone={state.latestCheckTone} />
            <LauncherMetric label="Preview" value={state.previewUrl ? "Ready" : state.activePreviewLauncherId ? "Starting" : "Stopped"} tone={state.previewUrl ? "success" : "default"} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="inline-flex items-center gap-2 rounded border border-forge-line bg-black/20 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
              disabled={busy || noPackage || noDevCheck}
              onClick={() => void onCommand({ type: "run_project_check", launcherTier: "development", launcherScript: "auto", launcherId: nextLauncherId() })}
              title={noPackage ? "package.json is required" : noDevCheck ? "No development check scripts found" : "Run the fastest available project check"}
            >
              <ListChecks className="h-4 w-4 text-forge-cyan" />
              Dev Check
            </button>
            <button
              className="inline-flex items-center gap-2 rounded border border-forge-line bg-black/20 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
              disabled={busy || noPackage || noAcceptanceCheck}
              onClick={() => void onCommand({ type: "run_project_check", launcherTier: "acceptance", launcherScript: "auto", launcherId: nextLauncherId() })}
              title={noPackage ? "package.json is required" : noAcceptanceCheck ? "No acceptance check scripts found" : "Run all available acceptance checks"}
            >
              <ShieldCheck className="h-4 w-4 text-emerald-300" />
              Acceptance Check
            </button>
            <button
              className="inline-flex items-center gap-2 rounded border border-forge-line bg-black/20 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
              disabled={busy || noPackage || noPreview}
              onClick={() => void onCommand({ type: "start_project_preview", previewScript: "auto", launcherId: nextLauncherId() })}
              title={noPackage ? "package.json is required" : noPreview ? "No preview scripts found" : "Start a local preview"}
            >
              <Play className="h-4 w-4 text-forge-cyan" />
              Start Preview
            </button>
            <button
              className="inline-flex items-center gap-2 rounded border border-forge-line bg-black/20 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
              disabled={busy || !state.activePreviewLauncherId}
              onClick={() => void onCommand({ type: "stop_project_preview", launcherId: state.activePreviewLauncherId ?? undefined })}
              title={state.activePreviewLauncherId ? "Stop the active local preview" : "No active preview is recorded"}
            >
              <Power className="h-4 w-4 text-red-300" />
              Stop Preview
            </button>
          </div>
          {state.previewUrl ? (
            <a className="inline-flex max-w-full items-center gap-2 truncate text-sm font-semibold text-forge-cyan hover:text-white" href={state.previewUrl} target="_blank" rel="noreferrer">
              <LinkIcon className="h-4 w-4 shrink-0" />
              <span className="truncate">{state.previewUrl}</span>
            </a>
          ) : null}
          {commandError ? <div className="rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{commandError}</div> : null}
        </div>
        <div className="rounded border border-forge-line bg-black/20 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-xs uppercase text-forge-muted">Detected Scripts</div>
            <div className="truncate text-xs text-slate-300">{state.packageScripts.length > 0 ? state.packageScripts.join(", ") : "None"}</div>
          </div>
          <pre className="scrollbar max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-slate-300">{state.logTail || "Launcher output will appear after a check or preview run."}</pre>
        </div>
      </div>
    </Panel>
  );
}

function LauncherMetric({ label, value, tone = "default" }: { label: string; value: string | number; tone?: "default" | "success" | "warning" | "error" }) {
  const toneClass = tone === "success" ? "text-emerald-100" : tone === "warning" ? "text-amber-100" : tone === "error" ? "text-red-100" : "text-white";
  return (
    <div className="rounded border border-forge-line bg-black/20 p-3">
      <div className="text-xs uppercase text-forge-muted">{label}</div>
      <div className={`mt-1 truncate text-sm font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

export function AssetsPage({ initialSnapshot }: { initialSnapshot: ForgeSnapshot }) {
  const { snapshot, hydrate, connectEventStream } = useForgeStore();
  useEffect(() => hydrate(initialSnapshot), [hydrate, initialSnapshot]);
  useEffect(() => connectEventStream(initialSnapshot.forge.slug, initialSnapshot.lastEventSequence), [connectEventStream, initialSnapshot.forge.slug, initialSnapshot.lastEventSequence]);
  const current: ForgeSnapshot = snapshot ?? initialSnapshot;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [groupBy, setGroupBy] = useState<AssetGroupMode>("feature");
  const filteredArtifacts = useMemo(() => filterAssetsForSearch(current.artifacts, current, query), [current, query]);
  const assetGroups = useMemo(() => buildAssetGroups(filteredArtifacts, current, groupBy), [current, filteredArtifacts, groupBy]);
  const selected = selectedId ? current.artifacts.find((artifact) => artifact.id === selectedId) : undefined;

  useEffect(() => {
    if (selectedId && !filteredArtifacts.some((artifact) => artifact.id === selectedId)) {
      setSelectedId(null);
    }
  }, [filteredArtifacts, selectedId]);

  return (
    <ForgeShell snapshot={current}>
      <div className="grid min-h-[720px] gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <Panel title="Forge Assets" action={`${filteredArtifacts.length}/${current.artifacts.length} artifacts`}>
          <div className="border-b border-forge-line p-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
              <label className="block">
                <span className="mb-2 block text-xs uppercase text-forge-muted">Quick Search</span>
                <span className="flex items-center gap-2 rounded border border-forge-line bg-black/30 px-3 py-2 focus-within:border-forge-cyan">
                  <Search className="h-4 w-4 text-forge-muted" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search title, content, tags, feature"
                    className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-forge-muted"
                  />
                </span>
              </label>
              <label className="block">
                <span className="mb-2 block text-xs uppercase text-forge-muted">Group By</span>
                <select
                  value={groupBy}
                  onChange={(event) => setGroupBy(event.target.value as AssetGroupMode)}
                  className="w-full rounded border border-forge-line bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-forge-cyan"
                >
                  <option value="feature">Feature</option>
                  <option value="type">Type</option>
                  <option value="division">Division</option>
                  <option value="status">Status</option>
                </select>
              </label>
            </div>
          </div>
          <div className="space-y-5 p-4">
            {assetGroups.length > 0 ? assetGroups.map((group) => (
              <section key={group.id}>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-white">{group.label}</div>
                    <div className="text-xs uppercase text-forge-muted">{group.artifacts.length} artifacts</div>
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {group.artifacts.map((artifact) => (
                    <button key={artifact.id} data-team-tone={getTeamTone(current, artifact.divisionId)} className={`rounded border p-4 text-left hover:border-forge-cyan ${selected?.id === artifact.id ? "border-forge-cyan bg-forge-cyan/10" : "border-forge-line bg-black/20"}`} onClick={() => setSelectedId(artifact.id)}>
                      <div className="text-sm font-semibold text-white">{artifact.title}</div>
                      <div className="mt-2 text-xs uppercase text-forge-muted">{artifact.type}</div>
                      <p className="mt-3 line-clamp-4 text-sm leading-6 text-slate-300">{artifact.content}</p>
                    </button>
                  ))}
                </div>
              </section>
            )) : (
              <EmptyAssetsListHint text={current.artifacts.length > 0 ? "No assets match this search." : undefined} />
            )}
          </div>
        </Panel>
        <StickyDetail
          title={selected?.title ?? "Artifact Details"}
          subtitle={selected ? selected.type : "Inspect generated assets, provenance, tags, and version state."}
          teamTone={selected ? getTeamTone(current, selected.divisionId) : undefined}
        >
          {selected ? (
            <>
              <DetailRows rows={[["Status", selected.status], ["Version", `v${selected.version}`], ["Division", selected.divisionId]]} />
              <DetailSections sections={[{ title: "Content", items: [selected.content] }, { title: "Tags", items: selected.tags }]} />
            </>
          ) : (
            <EmptyArtifactInspectorHint />
          )}
        </StickyDetail>
      </div>
    </ForgeShell>
  );
}

export function LogsPage({ initialSnapshot }: { initialSnapshot: ForgeSnapshot }) {
  const { snapshot, hydrate, connectEventStream } = useForgeStore();
  useEffect(() => hydrate(initialSnapshot), [hydrate, initialSnapshot]);
  useEffect(() => connectEventStream(initialSnapshot.forge.slug, initialSnapshot.lastEventSequence), [connectEventStream, initialSnapshot.forge.slug, initialSnapshot.lastEventSequence]);
  const current: ForgeSnapshot = snapshot ?? initialSnapshot;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? current.events.find((event) => event.id === selectedId) : undefined;

  return (
    <ForgeShell snapshot={current}>
      <div className="grid min-h-[720px] gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <Panel title="Runtime Event Stream" action={`last #${current.lastEventSequence}`}>
          <div className="scrollbar max-h-[760px] space-y-2 overflow-auto p-4">
            {current.events.slice().reverse().map((event) => (
              <button key={event.id} data-team-tone={getEventTeamTone(current, event)} className={`flex w-full items-start gap-3 rounded border p-3 text-left hover:border-forge-cyan ${selected?.id === event.id ? "border-forge-cyan bg-forge-cyan/10" : "border-forge-line bg-black/20"}`} onClick={() => setSelectedId(event.id)}>
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${event.severity === "success" ? "bg-forge-green" : event.severity === "warning" ? "bg-forge-amber" : event.severity === "error" ? "bg-forge-red" : "bg-forge-blue"}`} />
                <span className="min-w-0">
                  <span className={`block text-sm font-semibold ${severityClass(event.severity)}`}>{event.type}</span>
                  <span className="block text-sm leading-6 text-slate-300">{event.message}</span>
                </span>
                <span className="ml-auto text-xs text-forge-muted">#{event.sequence}</span>
              </button>
            ))}
          </div>
        </Panel>
        <StickyDetail title={selected?.type ?? "Activity Stream"} subtitle={selected?.message ?? "Review append-only runtime events, lifecycle updates, handoffs, and operator-visible state changes."} teamTone={selected ? getEventTeamTone(current, selected) : undefined}>
          {selected ? <EventMetadata event={selected} snapshot={current} /> : <EmptyActivityInspectorHint />}
        </StickyDetail>
      </div>
    </ForgeShell>
  );
}

function ExecutiveConsole({
  snapshot,
  pending,
  commandError,
  nextOperation,
  blockers,
  onCommand
}: {
  snapshot: ForgeSnapshot;
  pending: boolean;
  commandError: string | null;
  nextOperation?: Operation;
  blockers: Operation[];
  onCommand: (command: {
    type:
      | "run_full_flow"
      | "run_bounded_cycle"
      | "scheduler_tick"
      | "pause_forge"
      | "resume_forge"
      | "reset_demo_state"
      | "operator_message"
      | "propose_operation_changes"
      | "apply_operation_proposal"
      | "reject_operation_proposal"
      | "approve_executive_review"
      | "reject_executive_review"
      | "answer_worker_question"
      | "escalate_worker_question"
      | "approve_dependency_request"
      | "reject_dependency_request"
      | "escalate_dependency_request"
      | "start_executive_loop"
      | "continue_executive_loop"
      | "pause_executive_loop"
      | "resume_executive_loop"
      | "answer_executive_question";
    message?: string;
    maxRuns?: number;
    proposalId?: string;
    reviewId?: string;
    dependencyRequestId?: string;
    workerQuestionId?: string;
    promptFilePath?: string;
    promptFileId?: string;
    questionId?: string;
    selectedOptionIds?: string[];
    notes?: string;
  }) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [tipDismissed, setTipDismissed] = useState(false);
  const [processingPrompt, setProcessingPrompt] = useState<string | null>(null);
  const [processingStageIndex, setProcessingStageIndex] = useState(0);
  const [operatorQuestionIndex, setOperatorQuestionIndex] = useState(0);
  const summaries = sortMessagesByCreatedAt(snapshot.messages.filter((item) => item.kind === "executive_summary")).slice(-2).reverse();
  const recent = sortMessagesByCreatedAt(snapshot.messages.filter((item) => item.kind !== "executive_summary")).slice(-8);
  const latestConversationMessageId = recent.at(-1)?.id ?? "";
  const conversationRef = useRef<HTMLDivElement>(null);
  const pendingProposals = snapshot.proposals.filter((proposal) => proposal.status === "pending").slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const operatorQuestions = deriveOperatorQuestionState(snapshot);
  const activeOperatorQuestionIndex = operatorQuestions.pending.length === 0 ? 0 : Math.min(operatorQuestionIndex, operatorQuestions.pending.length - 1);
  const activeOperatorQuestion = operatorQuestions.pending[activeOperatorQuestionIndex];
  const workerQuestions = getPendingWorkerQuestionEvents(snapshot);
  const dependencyRequests = getPendingDependencyRequestEvents(snapshot);
  const pendingDangerousReviews = getPendingDangerousReviewEvents(snapshot);
  const activeRunCount = snapshot.operations.filter((operation) => getActiveRunForOperation(snapshot.runs, operation.id)).length;
  const hasActiveRuns = activeRunCount > 0;
  const canRunScheduler = snapshot.forge.status === "active" && !hasActiveRuns;
  const nextWorkHref = nextOperation ? `/forge/${snapshot.forge.slug}/operations?operation=${nextOperation.id}` : `/forge/${snapshot.forge.slug}/operations`;
  const blockerHref = getOperationsHref(snapshot.forge.slug, { operationId: blockers[0]?.id, statusFilter: "blockers" });
  const processingStatus = useMemo(() => (processingPrompt ? getExecutiveProcessingStatus(processingPrompt, snapshot) : null), [processingPrompt, snapshot]);
  const processingStage = processingStatus?.stages[Math.min(processingStageIndex, Math.max(0, processingStatus.stages.length - 1))];

  useEffect(() => {
    setTipDismissed(window.localStorage.getItem(getExecutiveTipDismissalKey(snapshot.forge.slug)) === "true");
  }, [snapshot.forge.slug]);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation) {
      return;
    }

    conversation.scrollTop = conversation.scrollHeight;
  }, [latestConversationMessageId, recent.length, processingPrompt]);

  useEffect(() => {
    setProcessingStageIndex(0);
    if (!processingPrompt || !processingStatus || processingStatus.stages.length <= 1) {
      return;
    }

    const timer = window.setInterval(() => {
      setProcessingStageIndex((current) => Math.min(current + 1, processingStatus.stages.length - 1));
    }, 1600);
    return () => window.clearInterval(timer);
  }, [processingPrompt, processingStatus]);

  useEffect(() => {
    setOperatorQuestionIndex((current) => Math.min(current, Math.max(0, operatorQuestions.pending.length - 1)));
  }, [operatorQuestions.pending.length]);

  async function submit() {
    const trimmed = message.trim();
    if (!trimmed || processingPrompt) return;
    setMessage("");
    setSubmitError(null);
    setProcessingPrompt(trimmed);
    try {
      if (trimmed.length > 1800) {
        const promptFile = await saveLargeExecutivePrompt(snapshot.forge.slug, trimmed);
        await onCommand({
          type: "propose_operation_changes",
          message: `Use ${promptFile.path} as the project instructions and prepare a proposal for approval.`,
          promptFilePath: promptFile.path
        });
      } else {
        await onCommand({ type: "propose_operation_changes", message: trimmed });
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Executive prompt submit failed.");
      setMessage(trimmed);
    } finally {
      setProcessingPrompt(null);
    }
  }

  function dismissTip() {
    setTipDismissed(true);
    window.localStorage.setItem(getExecutiveTipDismissalKey(snapshot.forge.slug), "true");
  }

  return (
    <Panel title="Executive AI" action="Primary control surface" className="min-h-[560px]">
      <div className="space-y-4 p-4">
        {!tipDismissed ? (
          <div className="rounded border border-forge-cyan/30 bg-forge-cyan/10 p-4">
            <div className="flex items-start gap-3">
              <MessageSquare className="mt-1 h-5 w-5 shrink-0 text-forge-cyan" />
              <div className="min-w-0 flex-1">
                <div className="text-lg font-semibold text-white">Command the Forge from here</div>
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  Executive AI coordinates the team cycle, tracks blockers, and keeps the operator conversation attached to the project.
                </p>
              </div>
              <button
                type="button"
                className="shrink-0 rounded border border-forge-line p-1.5 text-forge-muted hover:border-forge-cyan hover:text-white"
                aria-label="Dismiss Executive AI tip"
                onClick={dismissTip}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : null}
        {operatorQuestions.pending.length > 0 && activeOperatorQuestion ? (
          <div className="rounded border border-amber-400/30 bg-amber-400/10">
            <div className="flex items-center justify-between gap-3 border-b border-amber-400/20 px-3 py-2">
              <div className="text-sm font-semibold text-amber-100">Operator questions</div>
              <div className="flex items-center gap-2 text-xs text-amber-100">
                <button
                  type="button"
                  className="rounded border border-amber-300/40 p-1 hover:border-amber-200 disabled:opacity-40"
                  disabled={operatorQuestions.pending.length <= 1}
                  aria-label="Previous question"
                  onClick={() => setOperatorQuestionIndex((current) => (current - 1 + operatorQuestions.pending.length) % operatorQuestions.pending.length)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span>{activeOperatorQuestionIndex + 1} / {operatorQuestions.pending.length}</span>
                <button
                  type="button"
                  className="rounded border border-amber-300/40 p-1 hover:border-amber-200 disabled:opacity-40"
                  disabled={operatorQuestions.pending.length <= 1}
                  aria-label="Next question"
                  onClick={() => setOperatorQuestionIndex((current) => (current + 1) % operatorQuestions.pending.length)}
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="space-y-3 p-3">
              <OperatorQuestionCard key={activeOperatorQuestion.id} question={activeOperatorQuestion} pending={pending} onCommand={onCommand} />
            </div>
          </div>
        ) : operatorQuestions.answered.length > 0 ? (
          <div className="rounded border border-forge-line bg-black/20 p-3 text-sm text-forge-muted">
            <div className="mb-2 font-semibold text-slate-200">Recent operator answers</div>
            <div className="space-y-2">
              {operatorQuestions.answered.map((question) => (
                <div key={question.id}>
                  <span className="text-slate-300">{question.question}</span>
                  {question.selectedLabels?.length ? <span> Answered: {question.selectedLabels.join(", ")}.</span> : null}
                  {question.notes ? <span> Notes: {question.notes}</span> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {summaries.length > 0 ? (
          <div className="rounded border border-emerald-400/30 bg-emerald-500/10">
            <div className="border-b border-emerald-400/20 px-3 py-2 text-sm font-semibold text-emerald-100">Executive summaries</div>
            <div className="space-y-2 p-3">
              {summaries.map((item) => (
                <div key={item.id} className="rounded border border-emerald-400/20 bg-black/20 p-3 text-sm">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs uppercase text-emerald-200">
                    <span>summary {item.status ? `· ${item.status}` : ""}</span>
                    <span className="text-forge-muted">{formatChatTimestamp(item.createdAt)}</span>
                  </div>
                  <div className="leading-6 text-slate-100">{item.content}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="rounded border border-forge-line bg-black/20">
          <div className="flex items-center justify-between border-b border-forge-line px-3 py-2">
            <div className="text-sm font-semibold text-white">Conversation</div>
            <div className="text-xs text-forge-muted">Oldest to newest</div>
          </div>
          <div ref={conversationRef} className="scrollbar max-h-[340px] space-y-3 overflow-auto p-3">
            {recent.length > 0 ? recent.map((item) => <ExecutiveChatMessage key={item.id} message={item} />) : <EmptyState text="No operator conversation yet. Send the first Executive AI message below." />}
            {processingPrompt ? (
              <>
                <ExecutivePendingOperatorMessage content={processingPrompt} />
                <ExecutiveProcessingMessage status={processingStatus} stage={processingStage} />
              </>
            ) : null}
          </div>
        </div>
        {pendingProposals.length > 0 ? (
          <div className="rounded border border-forge-cyan/30 bg-forge-cyan/10">
            <div className="border-b border-forge-cyan/20 px-3 py-2 text-sm font-semibold text-white">Pending proposals</div>
            <div className="space-y-3 p-3">
              {pendingProposals.map((proposal) => (
                <ExecutiveProposalCard key={proposal.id} proposal={proposal} pending={pending} onCommand={onCommand} />
              ))}
            </div>
          </div>
        ) : null}
        {pendingDangerousReviews.length > 0 ? (
          <div className="rounded border border-amber-400/30 bg-amber-400/10">
            <div className="border-b border-amber-400/20 px-3 py-2 text-sm font-semibold text-amber-100">Executive review requests</div>
            <div className="space-y-3 p-3">
              {pendingDangerousReviews.map((event) => (
                <DangerousReviewEventCard key={event.id} event={event} snapshot={snapshot} pending={pending} onCommand={onCommand} />
              ))}
            </div>
          </div>
        ) : null}
        {dependencyRequests.length > 0 ? (
          <div className="rounded border border-emerald-400/30 bg-emerald-400/10">
            <div className="border-b border-emerald-400/20 px-3 py-2 text-sm font-semibold text-emerald-100">Dependency requests</div>
            <div className="space-y-3 p-3">
              {dependencyRequests.map((event) => (
                <DependencyRequestCard key={event.id} event={event} snapshot={snapshot} pending={pending} onCommand={onCommand} />
              ))}
            </div>
          </div>
        ) : null}
        {workerQuestions.length > 0 ? (
          <div className="rounded border border-sky-400/30 bg-sky-400/10">
            <div className="border-b border-sky-400/20 px-3 py-2 text-sm font-semibold text-sky-100">Division lead questions</div>
            <div className="space-y-3 p-3">
              {workerQuestions.map((event) => (
                <WorkerQuestionCard key={event.id} event={event} snapshot={snapshot} pending={pending} onCommand={onCommand} />
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex gap-2">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
            }}
            disabled={Boolean(processingPrompt)}
            placeholder={processingPrompt ? "Executive AI is processing" : "Ask Executive AI"}
            className="min-h-11 min-w-0 flex-1 resize-y rounded border border-forge-line bg-black/30 px-3 py-2 text-sm outline-none focus:border-forge-cyan disabled:opacity-60"
          />
          <button className="rounded bg-forge-cyan px-3 py-2 text-sm font-semibold text-black disabled:opacity-60" disabled={pending || Boolean(processingPrompt)} onClick={() => void submit()}>{processingPrompt ? "Processing" : "Send"}</button>
        </div>
        {submitError ? <div className="rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{submitError}</div> : null}
        {processingStatus ? <div className="rounded border border-forge-cyan/30 bg-forge-cyan/10 p-3 text-sm text-forge-cyan">{processingStage ?? processingStatus.summary}</div> : null}
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <button className="flex min-h-11 items-center justify-center gap-2 rounded border border-forge-cyan/40 bg-forge-cyan/10 px-3 py-2 text-sm font-semibold text-white hover:border-forge-cyan disabled:opacity-60" disabled={pending || !canRunScheduler} onClick={() => void onCommand({ type: "scheduler_tick" })}><Play className="h-4 w-4" />Run Ready Team</button>
          <NextLink className="flex min-h-11 items-center justify-center gap-2 rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan" href={nextWorkHref}><ArrowRight className="h-4 w-4" />Show Next Work</NextLink>
          <NextLink className="flex min-h-11 items-center justify-center gap-2 rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan" href={blockerHref}><ListChecks className="h-4 w-4" />Review Blockers</NextLink>
          {snapshot.forge.status === "paused" ? (
            <button className="flex min-h-11 items-center justify-center gap-2 rounded border border-emerald-400/40 px-3 py-2 text-sm text-emerald-100 hover:border-emerald-200 disabled:opacity-60" disabled={pending} onClick={() => void onCommand({ type: "resume_forge" })}><Power className="h-4 w-4" />Resume</button>
          ) : (
            <button className="flex min-h-11 items-center justify-center gap-2 rounded border border-amber-400/40 px-3 py-2 text-sm text-amber-100 hover:border-amber-200 disabled:opacity-60" disabled={pending || snapshot.forge.status === "archived"} onClick={() => void onCommand({ type: "pause_forge" })}><Power className="h-4 w-4" />Pause</button>
          )}
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <button className="flex items-center justify-center gap-2 rounded border border-forge-line px-3 py-2 text-sm hover:border-forge-cyan disabled:opacity-60" disabled={pending || hasActiveRuns || snapshot.forge.slug !== "demo"} onClick={() => void onCommand({ type: "run_full_flow" })}><Play className="h-4 w-4" />Demo Flow</button>
          <button className="flex items-center justify-center gap-2 rounded border border-forge-line px-3 py-2 text-sm hover:border-forge-cyan disabled:opacity-60" disabled={pending || !canRunScheduler} onClick={() => void onCommand({ type: "scheduler_tick" })}><RefreshCw className="h-4 w-4" />Scheduler Tick</button>
          <button className="flex items-center justify-center gap-2 rounded border border-forge-line px-3 py-2 text-sm hover:border-forge-cyan disabled:opacity-60" disabled={pending} onClick={() => void onCommand({ type: "reset_demo_state" })}><RotateCcw className="h-4 w-4" />Reset</button>
        </div>
        {hasActiveRuns ? <div className="rounded border border-forge-line bg-black/20 p-3 text-sm text-forge-muted">{activeRunCount} operation run{activeRunCount === 1 ? " is" : "s are"} active. Manual flow and scheduler triggers are disabled until active runs finish.</div> : null}
        {commandError ? <div className="rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{commandError}</div> : null}
      </div>
    </Panel>
  );
}

function OperatorQuestionCard({
  question,
  pending,
  onCommand
}: {
  question: OperatorQuestionCardState;
  pending: boolean;
  onCommand: (command: { type: "answer_executive_question"; questionId?: string; selectedOptionIds?: string[]; notes?: string }) => Promise<void>;
}) {
  const [selectedOptionId, setSelectedOptionId] = useState(question.options[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const canSubmit = Boolean(selectedOptionId || notes.trim());

  async function submitAnswer() {
    if (!canSubmit || pending) {
      return;
    }
    setError(null);
    try {
      await onCommand({
        type: "answer_executive_question",
        questionId: question.id,
        selectedOptionIds: selectedOptionId ? [selectedOptionId] : [],
        notes: notes.trim() || undefined
      });
      setNotes("");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Executive question answer failed.");
    }
  }

  async function rejectQuestion() {
    if (pending) {
      return;
    }
    setError(null);
    try {
      await onCommand({
        type: "answer_executive_question",
        questionId: question.id,
        selectedOptionIds: [],
        notes: notes.trim() || "Rejected by operator. Do not proceed with this request; choose a different approach or continue without this permission."
      });
      setNotes("");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Executive question rejection failed.");
    }
  }

  return (
    <div className="rounded border border-amber-400/20 bg-black/25 p-3">
      <div className="text-xs uppercase text-amber-200">Executive AI is waiting for input</div>
      <div className="mt-2 text-base font-semibold text-white">{question.question}</div>
      <p className="mt-2 text-sm leading-6 text-slate-300">{question.reason}</p>
      {question.options.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {question.options.map((option) => (
            <label
              key={option.id}
              className={`cursor-pointer rounded border p-3 text-sm transition ${
                selectedOptionId === option.id ? "border-amber-300 bg-amber-300/10 text-white" : "border-forge-line bg-black/20 text-slate-300 hover:border-amber-300/70"
              }`}
            >
              <input className="sr-only" type="radio" name={`executive-question-${question.id}`} value={option.id} checked={selectedOptionId === option.id} onChange={() => setSelectedOptionId(option.id)} />
              <span className="block font-semibold">{option.label}</span>
              {option.description ? <span className="mt-1 block leading-5 text-forge-muted">{option.description}</span> : null}
            </label>
          ))}
        </div>
      ) : null}
      {question.allowNotes ? (
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Add notes for Executive AI"
          className="mt-3 min-h-20 w-full resize-y rounded border border-forge-line bg-black/30 px-3 py-2 text-sm outline-none focus:border-amber-300"
        />
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="text-xs text-forge-muted">The Executive loop will continue after this answer.</div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded border border-amber-300/50 px-3 py-2 text-sm font-semibold text-amber-100 hover:border-amber-200 disabled:opacity-60" disabled={pending} onClick={() => void rejectQuestion()}>
            Reject
          </button>
          <button className="rounded bg-amber-300 px-3 py-2 text-sm font-semibold text-black disabled:opacity-60" disabled={pending || !canSubmit} onClick={() => void submitAnswer()}>
            Submit answer
          </button>
        </div>
      </div>
      {error ? <div className="mt-3 rounded border border-red-400/30 bg-red-500/10 p-2 text-sm text-red-100">{error}</div> : null}
    </div>
  );
}

function WorkerQuestionCard({
  event,
  snapshot,
  pending,
  onCommand
}: {
  event: RuntimeEvent;
  snapshot: ForgeSnapshot;
  pending: boolean;
  onCommand: (command: { type: "answer_worker_question" | "escalate_worker_question"; workerQuestionId: string; selectedOptionIds?: string[]; notes?: string }) => Promise<void>;
}) {
  const workerQuestionId = getPayloadString(event.payload, "workerQuestionId");
  const operationId = getPayloadString(event.payload, "operationId");
  const workerId = getPayloadString(event.payload, "workerId");
  const leadWorkerId = getPayloadString(event.payload, "leadWorkerId");
  const operation = operationId ? snapshot.operations.find((candidate) => candidate.id === operationId) : undefined;
  const worker = workerId ? snapshot.workers.find((candidate) => candidate.id === workerId) : undefined;
  const lead = leadWorkerId ? snapshot.workers.find((candidate) => candidate.id === leadWorkerId) : undefined;
  const options = getPayloadQuestionOptions(event.payload);
  const [selectedOptionId, setSelectedOptionId] = useState(options[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const canAnswer = Boolean(workerQuestionId && (selectedOptionId || notes.trim()));

  async function send(type: "answer_worker_question" | "escalate_worker_question") {
    if (!workerQuestionId || pending) {
      return;
    }
    setError(null);
    try {
      await onCommand({
        type,
        workerQuestionId,
        selectedOptionIds: type === "answer_worker_question" && selectedOptionId ? [selectedOptionId] : [],
        notes: notes.trim() || undefined
      });
      setNotes("");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Worker question command failed.");
    }
  }

  async function rejectQuestion() {
    if (!workerQuestionId || pending) {
      return;
    }
    setError(null);
    try {
      await onCommand({
        type: "answer_worker_question",
        workerQuestionId,
        selectedOptionIds: [],
        notes: notes.trim() || "Rejected by division lead. Do not proceed with this request; use a different approach or continue without this permission."
      });
      setNotes("");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Worker question rejection failed.");
    }
  }

  return (
    <div className="rounded border border-sky-400/25 bg-black/25 p-3">
      <div className="text-xs uppercase text-sky-200">{lead?.name ?? "Division lead"} input requested</div>
      <div className="mt-2 text-base font-semibold text-white">{getPayloadString(event.payload, "question") ?? event.message}</div>
      <p className="mt-2 text-sm leading-6 text-slate-300">{getPayloadString(event.payload, "reason") ?? "Worker needs division lead input before continuing."}</p>
      <div className="mt-2 text-xs text-forge-muted">
        {operation?.title ?? operationId ?? "No operation linked"}
        {worker ? ` · ${worker.name}` : ""}
      </div>
      {options.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {options.map((option) => (
            <label
              key={option.id}
              className={`cursor-pointer rounded border p-3 text-sm transition ${
                selectedOptionId === option.id ? "border-sky-300 bg-sky-300/10 text-white" : "border-forge-line bg-black/20 text-slate-300 hover:border-sky-300/70"
              }`}
            >
              <input className="sr-only" type="radio" name={`worker-question-${workerQuestionId}`} value={option.id} checked={selectedOptionId === option.id} onChange={() => setSelectedOptionId(option.id)} />
              <span className="block font-semibold">{option.label}</span>
              {option.description ? <span className="mt-1 block leading-5 text-forge-muted">{option.description}</span> : null}
            </label>
          ))}
        </div>
      ) : null}
      <textarea
        value={notes}
        onChange={(input) => setNotes(input.target.value)}
        placeholder="Answer or escalation notes"
        className="mt-3 min-h-20 w-full resize-y rounded border border-forge-line bg-black/30 px-3 py-2 text-sm outline-none focus:border-sky-300"
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-forge-muted">Leads can answer directly or pass the question to Executive.</div>
        <div className="flex gap-2">
          <button className="rounded border border-sky-300/50 px-3 py-2 text-sm font-semibold text-sky-100 hover:border-sky-200 disabled:opacity-60" disabled={pending || !workerQuestionId} onClick={() => void rejectQuestion()}>
            Reject
          </button>
          <button className="rounded bg-sky-300 px-3 py-2 text-sm font-semibold text-black disabled:opacity-60" disabled={pending || !canAnswer} onClick={() => void send("answer_worker_question")}>
            Answer
          </button>
          <button className="rounded border border-sky-300/50 px-3 py-2 text-sm font-semibold text-sky-100 hover:border-sky-200 disabled:opacity-60" disabled={pending || !workerQuestionId} onClick={() => void send("escalate_worker_question")}>
            Ask Executive
          </button>
        </div>
      </div>
      {error ? <div className="mt-3 rounded border border-red-400/30 bg-red-500/10 p-2 text-sm text-red-100">{error}</div> : null}
    </div>
  );
}

function DangerousReviewEventCard({
  event,
  snapshot,
  pending,
  onCommand
}: {
  event: RuntimeEvent;
  snapshot: ForgeSnapshot;
  pending: boolean;
  onCommand: (command: { type: "approve_executive_review" | "reject_executive_review"; reviewId: string }) => Promise<void>;
}) {
  const firstAction = getPayloadAction(event.payload);
  const reviewId = getPayloadString(event.payload, "reviewId");
  const category = getPayloadString(event.payload, "category");
  const action = firstAction?.action ?? category ?? getPayloadString(event.payload, "action") ?? getPayloadString(event.payload, "type") ?? "Executive review requested";
  const reason = firstAction?.reason ?? getPayloadString(event.payload, "reason") ?? getPayloadString(event.payload, "rationale") ?? getPayloadString(event.payload, "blockerReason") ?? event.message;
  const command = firstAction?.command ?? getPayloadString(event.payload, "command");
  const operationId = getPayloadString(event.payload, "operationId");
  const runId = getPayloadString(event.payload, "runId");
  const operation = operationId ? snapshot.operations.find((candidate) => candidate.id === operationId) : undefined;
  const isDangerousAction = category === "dangerous_action" || Boolean(firstAction);
  const approvalLabel = isDangerousAction ? "Record approval" : "Approve repair routing";
  const approvalExplanation = isDangerousAction
    ? "Approval records your decision only. ForgeOS will not run provider shell commands or grant shell access from this warning."
    : "Approval lets ForgeOS create or link safe prerequisite repair work. It does not approve shell commands.";

  return (
    <div className="rounded border border-amber-400/30 bg-black/30 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-amber-100">{action}</div>
          <div className="mt-1 text-xs uppercase text-amber-200">
            {operation?.title ?? operationId ?? "No operation linked"} · {formatChatTimestamp(event.createdAt)}
          </div>
        </div>
        <span className={`shrink-0 rounded px-2 py-1 text-xs uppercase ${severityClass(event.severity)}`}>{event.severity}</span>
      </div>
      <div className="mt-2 text-sm leading-6 text-slate-300">{reason}</div>
      <div className="mt-2 rounded border border-amber-400/20 bg-amber-400/10 p-2 text-xs leading-5 text-amber-100">{approvalExplanation}</div>
      {command ? <pre className="mt-2 overflow-auto rounded border border-forge-line bg-forge-panel p-2 font-mono text-xs text-slate-200">{command}</pre> : null}
      {runId ? <div className="mt-2 truncate text-xs text-forge-muted">Run: {runId}</div> : null}
      {reviewId ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="rounded border border-emerald-400/40 px-3 py-1.5 text-xs font-semibold text-emerald-100 hover:border-emerald-200 disabled:opacity-60" disabled={pending} onClick={() => void onCommand({ type: "approve_executive_review", reviewId })}>
            {approvalLabel}
          </button>
          <button className="rounded border border-forge-line px-3 py-1.5 text-xs text-slate-200 hover:border-forge-cyan disabled:opacity-60" disabled={pending} onClick={() => void onCommand({ type: "reject_executive_review", reviewId })}>
            Reject
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DependencyRequestCard({
  event,
  snapshot,
  pending,
  onCommand
}: {
  event: RuntimeEvent;
  snapshot: ForgeSnapshot;
  pending: boolean;
  onCommand: (command: { type: "approve_dependency_request" | "reject_dependency_request" | "escalate_dependency_request"; dependencyRequestId: string }) => Promise<void>;
}) {
  const dependencyRequestId = getPayloadString(event.payload, "dependencyRequestId");
  const packageName = getPayloadString(event.payload, "packageName") ?? "Dependency";
  const dependencyType = getPayloadString(event.payload, "dependencyType") ?? "dependency";
  const versionRange = getPayloadString(event.payload, "versionRange");
  const reason = getPayloadString(event.payload, "reason") ?? event.message;
  const operationId = getPayloadString(event.payload, "operationId");
  const operation = operationId ? snapshot.operations.find((candidate) => candidate.id === operationId) : undefined;

  return (
    <div className="rounded border border-emerald-400/30 bg-black/30 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-emerald-100">
            {packageName}
            {versionRange ? <span className="text-forge-muted"> {versionRange}</span> : null}
          </div>
          <div className="mt-1 text-xs uppercase text-emerald-200">
            {dependencyType} · {operation?.title ?? operationId ?? "No operation linked"}
          </div>
        </div>
        <span className={`shrink-0 rounded px-2 py-1 text-xs uppercase ${severityClass(event.severity)}`}>{event.severity}</span>
      </div>
      <div className="mt-2 text-sm leading-6 text-slate-300">{reason}</div>
      {dependencyRequestId ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="rounded border border-emerald-400/40 px-3 py-1.5 text-xs font-semibold text-emerald-100 hover:border-emerald-200 disabled:opacity-60" disabled={pending} onClick={() => void onCommand({ type: "approve_dependency_request", dependencyRequestId })}>
            Approve
          </button>
          <button className="rounded border border-forge-line px-3 py-1.5 text-xs text-slate-200 hover:border-forge-cyan disabled:opacity-60" disabled={pending} onClick={() => void onCommand({ type: "reject_dependency_request", dependencyRequestId })}>
            Reject
          </button>
          <button className="rounded border border-amber-400/40 px-3 py-1.5 text-xs text-amber-100 hover:border-amber-200 disabled:opacity-60" disabled={pending} onClick={() => void onCommand({ type: "escalate_dependency_request", dependencyRequestId })}>
            Escalate
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function getPendingDangerousReviewEvents(snapshot: ForgeSnapshot) {
  const resolvedReviewIds = new Set(
    snapshot.events
      .filter((event) => event.type === "executive.review_approved" || event.type === "executive.review_rejected")
      .map((event) => getPayloadString(event.payload, "reviewId"))
      .filter((reviewId): reviewId is string => Boolean(reviewId))
  );
  return snapshot.events
    .filter((event) => event.type === "executive.review_requested")
    .filter((event) => {
      const reviewId = getPayloadString(event.payload, "reviewId");
      return reviewId ? !resolvedReviewIds.has(reviewId) : false;
    })
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 4);
}

export function getPendingDependencyRequestEvents(snapshot: ForgeSnapshot) {
  const resolvedRequestIds = new Set(
    snapshot.events
      .filter((event) => event.type === "dependency.approved" || event.type === "dependency.rejected" || event.type === "dependency.escalated")
      .map((event) => getPayloadString(event.payload, "dependencyRequestId"))
      .filter((dependencyRequestId): dependencyRequestId is string => Boolean(dependencyRequestId))
  );
  return snapshot.events
    .filter((event) => event.type === "dependency.requested")
    .filter((event) => {
      const dependencyRequestId = getPayloadString(event.payload, "dependencyRequestId");
      return dependencyRequestId ? !resolvedRequestIds.has(dependencyRequestId) : false;
    })
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 4);
}

function getPendingWorkerQuestionEvents(snapshot: ForgeSnapshot) {
  const answeredQuestionIds = new Set(
    snapshot.events
      .filter((event) => event.type === "worker.question_answered")
      .map((event) => getPayloadString(event.payload, "workerQuestionId"))
      .filter((id): id is string => Boolean(id))
  );
  return snapshot.events
    .filter((event) => event.type === "worker.question_requested")
    .filter((event) => {
      const workerQuestionId = getPayloadString(event.payload, "workerQuestionId");
      return workerQuestionId ? !answeredQuestionIds.has(workerQuestionId) : false;
    })
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 4);
}

async function saveLargeExecutivePrompt(forgeSlug: string, content: string) {
  const path = `operator-prompts/instructions-${Date.now()}.md`;
  const response = await fetch(`/api/forges/${forgeSlug}/workspace/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content })
  });
  const payload = (await response.json().catch(() => ({}))) as { success?: boolean; data?: { id: string; path: string }; error?: string };
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(payload.error ?? "Executive prompt file save failed.");
  }
  return payload.data;
}

function getPayloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getPayloadStringArray(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function getPayloadQuestionOptions(payload: Record<string, unknown>) {
  const value = payload.options;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const option = item as Record<string, unknown>;
    const id = getPayloadString(option, "id");
    const label = getPayloadString(option, "label");
    const description = getPayloadString(option, "description");
    return id && label ? [{ id, label, ...(description ? { description } : {}) }] : [];
  });
}

function getPayloadAction(payload: Record<string, unknown>) {
  const actions = payload.actions;
  if (!Array.isArray(actions)) {
    return undefined;
  }
  const action = actions[0];
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return undefined;
  }
  const candidate = action as Record<string, unknown>;
  return {
    action: typeof candidate.action === "string" ? candidate.action : undefined,
    reason: typeof candidate.reason === "string" ? candidate.reason : undefined,
    command: typeof candidate.command === "string" ? candidate.command : undefined
  };
}

function getPayloadNumber(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getLatestRunProgressEvent(events: RuntimeEvent[], runId: string | undefined) {
  if (!runId) {
    return undefined;
  }

  return events
    .filter((event) => event.type === "run.progress" && event.payload.runId === runId)
    .sort((left, right) => right.sequence - left.sequence)[0];
}

function formatDurationMs(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function ExecutiveChatMessage({ message }: { message: ForgeSnapshot["messages"][number] }) {
  const isOperator = message.role === "operator";

  return (
    <div className={`flex ${isOperator ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[86%] rounded border p-3 text-sm ${isOperator ? "border-forge-blue/40 bg-forge-blue/10" : "border-forge-cyan/40 bg-forge-cyan/10"}`}>
        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs uppercase text-forge-muted">
          <span className={isOperator ? "text-forge-blue" : "text-forge-cyan"}>{isOperator ? "Operator" : "Executive AI"}</span>
          <time dateTime={message.createdAt}>{formatChatTimestamp(message.createdAt)}</time>
        </div>
        <div className="leading-6 text-slate-100">{message.content}</div>
      </div>
    </div>
  );
}

function ExecutivePendingOperatorMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[86%] rounded border border-forge-blue/40 bg-forge-blue/10 p-3 text-sm opacity-80">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs uppercase text-forge-muted">
          <span className="text-forge-blue">Operator</span>
          <span>sending</span>
        </div>
        <div className="leading-6 text-slate-100">{content}</div>
      </div>
    </div>
  );
}

type ExecutiveProcessingStatus = {
  label: string;
  summary: string;
  stages: string[];
};

function ExecutiveProcessingMessage({
  status,
  stage
}: {
  status: ExecutiveProcessingStatus | null;
  stage?: string;
}) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[86%] rounded border border-forge-cyan/40 bg-forge-cyan/10 p-3 text-sm">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs uppercase text-forge-muted">
          <span className="text-forge-cyan">Executive AI</span>
          <span>{status?.label ?? "processing"}</span>
        </div>
        <div className="flex items-start gap-2 text-slate-100">
          <span className="h-2 w-2 animate-pulse rounded-full bg-forge-cyan" />
          <span>{stage ?? status?.summary ?? "Processing the request."}</span>
        </div>
      </div>
    </div>
  );
}

function getExecutiveProcessingStatus(prompt: string, snapshot: ForgeSnapshot): ExecutiveProcessingStatus {
  const normalized = prompt.toLowerCase();
  const target = inferExecutivePromptTarget(prompt, snapshot);
  const hasPendingPlan = snapshot.proposals.some((proposal) => proposal.status === "pending");
  const mentionsLink = /https?:\/\/\S+|\blink\b|\burl\b|\bsource\b/i.test(prompt);
  const asksForRun = /\b(run|start|kick off|launch|execute)\b/.test(normalized);
  const asksForStaffing = /\b(spawn|worker|agent|team|staff|specialist|division head)\b/.test(normalized);
  const asksForRevision = hasPendingPlan || /\b(change|revise|adjust|update|modify|use|instead|add|include)\b/.test(normalized);
  const asksForBuild = /\b(build|create|implement|make|site|app|website|feature|project)\b/.test(normalized);
  const asksForOrganizing = /\b(organize|coordinate|keep|manage|plan|break down|assign)\b/.test(normalized);

  if (asksForRun && !asksForBuild && !asksForRevision) {
    return {
      label: "coordinating",
      summary: `Checking ready operations and run slots for ${target}.`,
      stages: [
        "Checking active runs and available worker slots.",
        "Reviewing ready operations and blocked dependencies.",
        `Preparing the next ${target} execution step.`
      ]
    };
  }

  if (asksForRevision || mentionsLink) {
    return {
      label: "revising plan",
      summary: `Updating the plan with ${mentionsLink ? "the supplied source link" : "your new constraints"}.`,
      stages: [
        "Reading the existing proposal and recent conversation.",
        mentionsLink ? "Attaching the supplied source link to the affected operations." : "Mapping your change onto the current operation plan.",
        `Rewriting ${target} operation briefs and handoffs.`,
        "Preparing a revised proposal for approval."
      ]
    };
  }

  if (asksForStaffing) {
    return {
      label: "staffing",
      summary: `Choosing workers and teams for ${target}.`,
      stages: [
        "Reviewing current divisions and worker capacity.",
        `Selecting specialist workers for ${target}.`,
        "Writing focused expertise prompts for any new workers.",
        "Drafting operations with clear owners and handoffs."
      ]
    };
  }

  if (asksForBuild || asksForOrganizing) {
    return {
      label: "planning",
      summary: `Creating teams and operations for ${target}.`,
      stages: [
        `Breaking ${target} into buildable workstreams.`,
        "Assigning Strategy, Engineering, QA, and Release responsibilities.",
        "Creating worker-specific operations and dependency order.",
        "Preparing the proposal for review."
      ]
    };
  }

  return {
    label: "responding",
    summary: "Reviewing the conversation and current Forge state.",
    stages: [
      "Reading the recent Executive conversation.",
      "Checking current operations, workers, blockers, and proposals.",
      "Preparing a focused response or plan adjustment."
    ]
  };
}

function inferExecutivePromptTarget(prompt: string, snapshot: ForgeSnapshot) {
  const quoted = prompt.match(/["“]([^"”]{4,80})["”]/)?.[1];
  if (quoted) {
    return quoted;
  }

  const lower = prompt.toLowerCase();
  if (lower.includes("website") || lower.includes("site")) {
    return "the website";
  }
  if (lower.includes("agent") || lower.includes("worker") || lower.includes("team")) {
    return "the team";
  }

  return snapshot.forge.name;
}

function ExecutiveProposalCard({
  proposal,
  pending,
  onCommand
}: {
  proposal: ExecutiveProposal;
  pending: boolean;
  onCommand: (command: { type: "apply_operation_proposal" | "reject_operation_proposal"; proposalId: string }) => Promise<void>;
}) {
  const actionLabels = proposal.actions.map((action) => {
    if (action.type === "create_worker") {
      return `Create worker: ${action.name}`;
    }
    if (action.type === "create_operation") {
      return `Create operation: ${action.title}`;
    }
    if (action.type === "update_operation") {
      return `Update operation: ${action.operationId}`;
    }
    if (action.type === "delete_operation") {
      return `Delete operation: ${action.operationId}`;
    }
    if (action.type === "create_handoff") {
      return `Create handoff: ${action.fromDivisionId} to ${action.toDivisionId}`;
    }
    return `Block operation: ${action.operationId}`;
  });

  return (
    <div className="rounded border border-forge-cyan/30 bg-black/30 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">{proposal.summary}</div>
          <div className="mt-1 text-xs uppercase text-forge-muted">
            {proposal.provider}
            {proposal.model ? ` · ${proposal.model}` : ""} · {formatChatTimestamp(proposal.createdAt)}
            {proposal.supersedesProposalIds?.length ? ` · revises ${proposal.supersedesProposalIds.length} plan${proposal.supersedesProposalIds.length === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            className="rounded bg-forge-cyan px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-60"
            disabled={pending}
            onClick={() => void onCommand({ type: "apply_operation_proposal", proposalId: proposal.id })}
          >
            Approve
          </button>
          <button
            type="button"
            className="rounded border border-forge-line px-3 py-1.5 text-xs text-slate-200 hover:border-forge-cyan disabled:opacity-60"
            disabled={pending}
            onClick={() => void onCommand({ type: "reject_operation_proposal", proposalId: proposal.id })}
          >
            Reject
          </button>
        </div>
      </div>
      <div className="mt-3 space-y-1 text-sm leading-6 text-slate-300">
        {actionLabels.map((label, index) => (
          <div key={`${index}-${label}`}>{label}</div>
        ))}
      </div>
    </div>
  );
}

function sortMessagesByCreatedAt<T extends { createdAt: string }>(messages: T[]) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.message.createdAt);
      const rightTime = Date.parse(right.message.createdAt);
      const normalizedLeft = Number.isNaN(leftTime) ? 0 : leftTime;
      const normalizedRight = Number.isNaN(rightTime) ? 0 : rightTime;
      return normalizedLeft - normalizedRight || left.index - right.index;
    })
    .map((item) => item.message);
}

function formatChatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function getExecutiveTipDismissalKey(forgeSlug: string) {
  return `forgeos:executive-tip-dismissed:${forgeSlug}`;
}

function StickyDetail({ title, subtitle, teamTone, children }: { title: string; subtitle: string; teamTone?: TeamTone; children: React.ReactNode }) {
  return (
    <aside className="xl:sticky xl:top-4 xl:self-start" data-team-tone={teamTone}>
      <Panel title="Details" action="Local selection">
        <div className="scrollbar max-h-[760px] overflow-auto p-4">
          <div className="text-xl font-semibold text-white">{title}</div>
          <p className="mt-2 text-sm leading-6 text-slate-300">{subtitle}</p>
          {children}
        </div>
      </Panel>
    </aside>
  );
}

function DetailRows({ rows }: { rows: Array<Array<string | number>> }) {
  return (
    <div className="mt-5 grid grid-cols-2 gap-3">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded border border-forge-line bg-black/20 p-3">
          <div className="text-xs uppercase text-forge-muted">{label}</div>
          <div className="mt-1 text-sm font-semibold text-white">{value}</div>
        </div>
      ))}
    </div>
  );
}

function DetailSections({ sections }: { sections: Array<{ title: string; items: string[] }> }) {
  return (
    <div className="mt-5 space-y-3">
      {sections.map((section) => (
        <div key={section.title} className="rounded border border-forge-line bg-black/20 p-3">
          <div className="text-sm font-semibold text-white">{section.title}</div>
          <div className="mt-2 space-y-2 text-sm leading-6 text-slate-300">
            {section.items.map((item) => <div key={item}>{item}</div>)}
          </div>
        </div>
      ))}
    </div>
  );
}

function getOrgSelectionTeamTone(snapshot: ForgeSnapshot, selected: { type: "division" | "worker"; id: string } | null): TeamTone | undefined {
  if (!selected) {
    return undefined;
  }

  if (selected.type === "division") {
    return getTeamTone(snapshot, selected.id);
  }

  const worker = snapshot.workers.find((candidate) => candidate.id === selected.id);
  return getTeamTone(snapshot, worker?.divisionId);
}

function getEventTeamTone(snapshot: ForgeSnapshot, event: RuntimeEvent): TeamTone {
  const payloadDivisionId = typeof event.payload.divisionId === "string" ? event.payload.divisionId : undefined;
  const payloadOperationId = typeof event.payload.operationId === "string" ? event.payload.operationId : undefined;
  const payloadOperationDivisionId = payloadOperationId ? snapshot.operations.find((operation) => operation.id === payloadOperationId)?.divisionId : undefined;
  const actorDivisionId = resolveDivisionIdForRuntimeRef(snapshot, event.actorType, event.actorId);
  const targetDivisionId = resolveDivisionIdForRuntimeRef(snapshot, event.targetType, event.targetId);

  return getTeamTone(snapshot, payloadDivisionId ?? payloadOperationDivisionId ?? targetDivisionId ?? actorDivisionId);
}

function resolveDivisionIdForRuntimeRef(snapshot: ForgeSnapshot, type?: string, id?: string) {
  if (!id) {
    return undefined;
  }

  if (type === "division") {
    return id;
  }

  if (type === "worker") {
    return snapshot.workers.find((worker) => worker.id === id)?.divisionId;
  }

  if (type === "operation") {
    return snapshot.operations.find((operation) => operation.id === id)?.divisionId;
  }

  if (type === "artifact") {
    return snapshot.artifacts.find((artifact) => artifact.id === id)?.divisionId;
  }

  if (type === "file") {
    return snapshot.files.find((file) => file.id === id)?.divisionId;
  }

  return undefined;
}

function getTeamTone(snapshot: ForgeSnapshot, divisionId?: string | null): TeamTone {
  if (!divisionId) {
    return "general";
  }

  const division = snapshot.divisions.find((candidate) => candidate.id === divisionId);
  const source = `${divisionId} ${division?.name ?? ""}`.toLowerCase();

  if (source.includes("strategy")) {
    return "strategy";
  }

  if (source.includes("operation")) {
    return "operations";
  }

  if (source.includes("engineer")) {
    return "engineering";
  }

  if (source.includes("presentation") || source.includes("pitch") || source.includes("story")) {
    return "presentation";
  }

  if (source.includes("qa") || source.includes("quality")) {
    return "qa";
  }

  if (source.includes("release") || source.includes("launch")) {
    return "release";
  }

  return "general";
}

function getOrgDetail(snapshot: ForgeSnapshot, selected: { type: "division" | "worker"; id: string } | null) {
  if (!selected) {
    return {
      title: "Organization Map",
      subtitle: "Inspect how the Forge is staffed and where work is flowing.",
      rows: [],
      sections: [
        {
          title: "How to use this section",
          items: [
            "Division cards summarize each team, its objective, status, and progress.",
            "Worker cards show the active agent roles inside each division.",
            "Click any division or worker card to inspect current work, context, and responsibilities."
          ]
        }
      ]
    };
  }

  if (selected.type === "worker") {
    const worker = snapshot.workers.find((item) => item.id === selected.id) as Worker | undefined;
    return {
      title: worker?.name ?? "Worker",
      subtitle: worker?.role ?? "",
      rows: [["Status", worker?.status ?? "unknown"], ["Division", snapshot.divisions.find((division) => division.id === worker?.divisionId)?.name ?? "Unknown"], ["Current", worker?.currentTask ?? "Idle"]],
      sections: [
        { title: "Context Manifest", items: worker ? [worker.contextManifest.objective, ...worker.contextManifest.instructionSources, ...worker.contextManifest.redactions] : [] },
        { title: "Recent Memory", items: worker?.contextManifest.memorySnippets ?? [] }
      ]
    };
  }

  const division = snapshot.divisions.find((item) => item.id === selected.id) as Division | undefined;
  const workers = snapshot.workers.filter((worker) => worker.divisionId === selected.id);
  const operations = snapshot.operations.filter((operation) => operation.divisionId === selected.id);
  return {
    title: division?.name ?? "Division",
    subtitle: division?.objective ?? "",
    rows: [["Status", division?.status ?? "unknown"], ["Progress", `${division?.progress ?? 0}%`], ["Workers", workers.length], ["Operations", operations.length]],
    sections: [
      { title: "Workers", items: workers.map((worker) => `${worker.name}: ${worker.currentTask}`) },
      { title: "Operations", items: operations.map((operation) => `${operation.title}: ${operation.status}`) }
    ]
  };
}

function EmptyOrgInspectorHint() {
  return (
    <InspectorHint
      title="No card selected"
      description="Start with a division for team-level context, or choose a worker for role-specific context."
      jokes={cardJokes}
      ariaLabel="Organization easter egg"
    />
  );
}

function EmptyOperationInspectorHint() {
  return (
    <InspectorHint
      title="No operation selected"
      description="Use the board to compare work by status, division, worker, or priority. Select an operation to inspect dependencies, run history, trace summaries, blockers, and the run control."
      jokes={operationJokes}
      ariaLabel="Operations easter egg"
    />
  );
}

function EmptyWorkspaceRenderer() {
  return (
    <div className="p-5">
      <InspectorHint
        title="No file selected"
        description="The virtual workspace shows bounded read-only repository sync content and runtime-generated files. Pick a file from the tree to render its contents here."
        jokes={workspaceJokes}
        ariaLabel="Workspace easter egg"
      />
    </div>
  );
}

function EmptyWorkspaceInspectorHint() {
  return (
    <InspectorHint
      title="No file metadata selected"
      description="File metadata explains provenance, linked artifacts, owning operation, and whether the content came from sync or runtime output."
      jokes={workspaceJokes}
      ariaLabel="Workspace metadata easter egg"
    />
  );
}

function EmptyAssetsListHint({ text }: { text?: string }) {
  return (
    <InspectorHint
      title={text ? "No matching assets" : "No assets generated yet"}
      description={text ?? "Assets are structured runtime outputs such as briefs, specs, implementation notes, QA evidence, release material, and other deliverables produced by Forge operations."}
      jokes={assetJokes}
      ariaLabel="Assets easter egg"
    />
  );
}

function EmptyArtifactInspectorHint() {
  return (
    <InspectorHint
      title="No artifact selected"
      description="Select an asset to inspect its status, version, owning division, tags, and full content. Blank-template projects will stay empty here until operations produce deliverables."
      jokes={assetJokes}
      ariaLabel="Artifact detail easter egg"
    />
  );
}

function EmptyActivityInspectorHint() {
  return (
    <InspectorHint
      title="No event selected"
      description="The activity stream is append-only runtime history. Select an event to inspect actor, target, severity, sequence, and sanitized payload details."
      jokes={activityJokes}
      ariaLabel="Activity easter egg"
    />
  );
}

function InspectorHint({ title, description, jokes, ariaLabel }: { title: string; description: string; jokes: string[]; ariaLabel: string }) {
  const [jokeIndex, setJokeIndex] = useState(0);
  const tooltipId = useId();
  const hasRevealedJoke = useRef(false);
  const pointerInside = useRef(false);

  function revealJoke(source: "focus" | "pointer") {
    if (source === "pointer") {
      pointerInside.current = true;
    }

    if (source === "focus" && pointerInside.current) {
      return;
    }

    setJokeIndex((current) => {
      if (!hasRevealedJoke.current) {
        hasRevealedJoke.current = true;
        return current;
      }

      return (current + 1) % jokes.length;
    });
  }

  return (
    <div className="mt-5 rounded border border-forge-line bg-black/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">{title}</div>
          <p className="mt-1 text-sm leading-6 text-slate-300">{description}</p>
        </div>
        <div className="group relative shrink-0" onMouseEnter={() => revealJoke("pointer")} onMouseLeave={() => { pointerInside.current = false; }}>
          <button
            type="button"
            className="flex h-5 w-5 items-center justify-center rounded-full border border-forge-line/40 text-[10px] text-forge-muted/60 opacity-35 transition hover:border-forge-cyan/50 hover:text-forge-cyan hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-forge-cyan/60"
            aria-label={ariaLabel}
            aria-describedby={tooltipId}
            onFocus={() => revealJoke("focus")}
          >
            ?
          </button>
          <div
            id={tooltipId}
            role="tooltip"
            aria-live="polite"
            className="pointer-events-none absolute right-0 top-full z-10 mt-2 w-64 rounded border border-forge-line bg-forge-panel p-3 text-sm leading-5 text-slate-200 opacity-0 shadow-command transition group-hover:opacity-100 group-focus-within:opacity-100"
          >
            {jokes[jokeIndex]}
          </div>
        </div>
      </div>
    </div>
  );
}

const cardJokes = [
  "Click a card, any card. Demo day respects confidence.",
  "This inspector has been awake since kickoff and is handling it professionally.",
  "No shuffle required. The backlog already did that.",
  "The cards are face up, unlike the API limits discovered at 2 a.m.",
  "A division card and a worker card walk into a sprint. Scope walks out.",
  "Pick a card before the pitch deck picks one for you.",
  "This deck contains no jokers, only stretch goals.",
  "Hover responsibly. These cards are running on snacks and optimism.",
  "The strategy card promised it is not selected anymore. It has pivoted.",
  "Every card has a story. Some have blockers. Some have pizza stains.",
  "Choose wisely. Or hackathon-fast. Both are supported.",
  "No card selected, no drama detected. Suspiciously rare for a hackathon.",
  "The inspector is practicing patience, unlike the countdown timer.",
  "Card investigation starts with one bold click and one questionable commit message.",
  "This is not poker, but there are still stakes and too little sleep.",
  "A full house would be every division green before judging.",
  "The deck is deterministic. The judging rubric may vary.",
  "Clicking a card improves local observability and team morale by 3%.",
  "The cards declined to auto-select themselves. They learned from merge conflicts.",
  "Pick a worker to see what they are bravely calling v1.",
  "A card in motion stays in motion until someone says MVP.",
  "The map is ready when you are. The pitch script is still negotiating.",
  "No tarot here, just runtime state and caffeine traces.",
  "The best card is the one with passing tests and a working demo.",
  "Card says: ask again after scheduler tick and one more coffee.",
  "Please do not feed the cards raw provider prompts or cold fries.",
  "One click unlocks approximately one inspector panel and three new ideas.",
  "Card jokes are append-only, like the team chat during final hour.",
  "Select a card to reveal its lore, responsibilities, and probable TODOs.",
  "The organization map has entered idle mode, unlike the hackathon room.",
  "This card tip compiled successfully on the first try, which feels illegal.",
  "If the demo breaks, calmly select a card and call it observability.",
  "The roadmap is scoped. The team is scoped. The snacks are out of scope.",
  "A blocker is just a plot twist with a Jira-friendly name.",
  "This card has not slept, but its TypeScript types are strong.",
  "Judges love clarity. Cards love clicks. Everybody has needs.",
  "Clicking randomly is not a strategy, unless it works during the demo.",
  "The pitch deck said five minutes. The feature list said no.",
  "This tooltip is the only feature that requested a joke budget.",
  "Hackathon law: every simple card hides one integration surprise."
];

const operationJokes = [
  "No operation selected. The backlog is enjoying a rare quiet moment.",
  "Pick an operation before it grows a new dependency.",
  "This board is where scope comes to negotiate.",
  "A ready operation is just a demo scene waiting for its cue.",
  "Blocked is a status, not a personality. Usually.",
  "Every hackathon plan is deterministic until the API key expires.",
  "Select an operation to see what the team meant by almost done.",
  "The critical priority badge has entered dramatic lighting.",
  "This operation board has seen things during final hour.",
  "Run history: because memory after midnight is not admissible evidence.",
  "A dependency graph is just a group project with arrows.",
  "Pick a card to reveal whether the MVP is still M, V, or P.",
  "Scheduler tick says it can stop whenever it wants.",
  "This board sorts by priority, not by panic level.",
  "No selection means no blockers. Temporarily. Enjoy it.",
  "The safest operation is the one with tests and a snack sponsor.",
  "If everything is critical, the board quietly judges you.",
  "Click an operation to inspect the plot twist.",
  "The run button is waiting for a ready operation and emotional maturity.",
  "Progress percentages are tiny motivational posters.",
  "The operation timeline remembers what standup forgot.",
  "Hackathon estimates are measured in demos, not hours.",
  "This board supports optimism, but persists status.",
  "A failed operation is just a future lightning talk.",
  "Select work before work selects you.",
  "Dependencies are where simple ideas go to become architecture.",
  "The board has no opinion on caffeine strategy.",
  "Operation cards are legally distinct from fortune cards.",
  "The best blocker is the one discovered before judging.",
  "If the demo works twice, record the run history immediately."
];

const workspaceJokes = [
  "No file selected. The virtual workspace is resisting eye contact.",
  "Pick a file before someone says just check the repo.",
  "Read-only means the demo cannot accidentally commit vibes.",
  "This workspace syncs files, not last-minute confidence.",
  "A virtual file tree is a bonsai repo for hackathons.",
  "Select a file to see whether the notes survived final hour.",
  "No filesystem writes here. The repository may exhale.",
  "The file renderer is waiting for content with good indentation.",
  "Workspace law: every README contains one future feature.",
  "This panel supports copy, paste, and quiet reflection.",
  "No file selected, no merge conflict detected.",
  "The virtual workspace has bounded context and unbounded ambition.",
  "Pick a file to inspect its lore and line breaks.",
  "Generated files are artifacts with better posture.",
  "Sync first, panic later.",
  "This tree has branches, but please do not push them yet.",
  "The repo is read-only. The ideas are not.",
  "A selected file is worth a thousand Slack messages.",
  "This workspace is where hackathon plans become markdown.",
  "No file selected. The preview pane is practicing minimalism.",
  "Virtual paths: fewer surprises than absolute ones.",
  "The best file is the one the demo can explain.",
  "If the file is empty, call it a placeholder and keep moving.",
  "Workspace metadata knows who touched what, emotionally speaking.",
  "Pick a file before the pitch deck invents one.",
  "The file tree is not lost, just recursively organized.",
  "Read-only sync: because production repos deserve boundaries.",
  "This renderer has never met a tab it could not display.",
  "Hackathon docs age in accelerated time.",
  "Select a file to convert mystery into context."
];

const assetJokes = [
  "No artifact selected. The deliverables table is keeping its powder dry.",
  "Assets are quiet for now. The next completed operation may change that.",
  "No generated asset yet. The archive is accepting future receipts.",
  "Artifact detail is idle. Version zero remains undefeated.",
  "No asset selected. The tags are taking a brief intermission.",
  "Generated assets prefer a completed operation before making an entrance.",
  "The asset shelf is empty, but the provenance labels are ready.",
  "No selection yet. The detail rail is practicing restraint.",
  "Artifacts arrive after the runtime has something worth preserving.",
  "This page is ready for evidence, specs, and the occasional useful note."
];

const activityJokes = [
  "No event selected. The activity stream is still quietly judging.",
  "Pick an event to see what really happened.",
  "Logs are the hackathon memory nobody has to trust.",
  "Runtime events: tiny receipts for big claims.",
  "Select an event before the demo narrator improves the story.",
  "The stream is append-only, unlike the pitch script.",
  "No event selected, no blame assigned.",
  "Activity logs are where optimism meets timestamps.",
  "Every sequence number has a journey.",
  "Pick a log entry to inspect the plot in JSON.",
  "The payload is sanitized. The suspense remains.",
  "Runtime history never sleeps, which is very hackathon of it.",
  "A warning event is just the system clearing its throat.",
  "Success events deserve tiny applause.",
  "Error events prefer actionable follow-up, not vibes.",
  "The event stream remembers your scheduler tick.",
  "Select an event to learn which actor moved the story forward.",
  "Logs: because it worked on stage needs evidence.",
  "This stream has more chronology than the team chat.",
  "No selection means the details panel is off duty.",
  "Runtime events are breadcrumbs with sequence numbers.",
  "The best debug tool is a timestamp with receipts.",
  "Activity pages turn chaos into rows.",
  "Click an event before it becomes folklore.",
  "The payload will not include raw prompts, even if you ask nicely.",
  "Hackathon logs are the diary of the demo.",
  "This event stream is a calm river of consequences.",
  "Pick a row to inspect the runtime alibi.",
  "If it emitted an event, it probably happened.",
  "The logs have entered observer mode."
];

type WorkspaceFileGroupMode = "directory" | "division" | "status";

type WorkspaceFileGroupNode = {
  id: string;
  label: string;
  files: VirtualFile[];
  children: WorkspaceFileGroupNode[];
};

const workspaceFileGroupModes: Array<{ id: WorkspaceFileGroupMode; label: string }> = [
  { id: "directory", label: "Dirs" },
  { id: "division", label: "Teams" },
  { id: "status", label: "Status" }
];

export function deriveActiveAgentCards(snapshot: ForgeSnapshot): ActiveAgentCard[] {
  return snapshot.runs
    .filter(isActiveRun)
    .slice()
    .sort((left, right) => runStartTime(left) - runStartTime(right))
    .map((run) => {
      const operation = snapshot.operations.find((candidate) => candidate.id === run.operationId);
      const worker = run.workerId ? snapshot.workers.find((candidate) => candidate.id === run.workerId) : undefined;
      const latestProgress = getLatestRunProgressEvent(snapshot.events, run.id);
      const checkpoint = getLatestRunCheckpoint(run);
      const activity =
        checkpoint?.latestActivity ??
        (latestProgress ? getPayloadString(latestProgress.payload, "latestProgressMessage") ?? latestProgress.message : undefined) ??
        worker?.currentTask ??
        operation?.description ??
        "Operation is active.";
      const activeDurationMs = latestProgress ? getPayloadNumber(latestProgress.payload, "activeDurationMs") : undefined;
      const model = latestProgress ? getPayloadString(latestProgress.payload, "model") : undefined;
      const modelTier = latestProgress ? getPayloadString(latestProgress.payload, "modelTier") : undefined;

      return {
        id: run.id,
        operationId: run.operationId,
        workerName: worker?.name ?? "Unassigned agent",
        operationTitle: operation?.title ?? run.operationId,
        activity,
        status: run.status,
        provider: run.provider,
        model,
        modelTier,
        durationLabel: getActiveAgentDurationLabel(run, activeDurationMs),
        teamTone: getTeamTone(snapshot, operation?.divisionId ?? worker?.divisionId)
      };
    });
}

function getLatestRunCheckpoint(run: AgentRun) {
  const traceSummary = run.providerMetadata.traceSummary;
  return traceSummary && typeof traceSummary === "object" && !Array.isArray(traceSummary) ? (traceSummary as RunTraceSummary).checkpoint : undefined;
}

function getActiveAgentDurationLabel(run: AgentRun, activeDurationMs: number | undefined) {
  if (activeDurationMs !== undefined) {
    return formatDurationMs(activeDurationMs);
  }
  if (run.status === "queued") {
    return "Queued";
  }
  return run.startedAt ? "In progress" : "Starting";
}

function runStartTime(run: AgentRun) {
  const value = Date.parse(run.startedAt ?? run.queuedAt);
  return Number.isNaN(value) ? 0 : value;
}

export function deriveLauncherPanelState(snapshot: ForgeSnapshot) {
  const packageFile = snapshot.files.find((file) => file.path.replace(/^\.\//, "") === "package.json");
  const packageScripts = packageFile ? readWorkspacePackageScripts(packageFile.content) : [];
  const scriptSet = new Set(packageScripts);
  const developmentScripts = ["test", "typecheck", "smoke", "build", "lint"].filter((script) => scriptSet.has(script));
  const acceptanceScripts = ["test", "typecheck", "lint", "build", "smoke", "e2e"].filter((script) => scriptSet.has(script));
  const previewScripts = ["dev", "start", "preview"].filter((script) => scriptSet.has(script));
  const launcherEvents = snapshot.events.filter((event) => event.type.startsWith("launcher."));
  const pending = launcherEvents.some((event) => ["launcher.check_started", "launcher.preview_started"].includes(event.type) && !hasLaterLauncherTerminalEvent(launcherEvents, event));
  const latestCheck = [...launcherEvents].reverse().find((event) => event.type === "launcher.check_completed");
  const latestLog = [...launcherEvents].reverse().find((event) => event.type === "launcher.log");
  const latestReady = [...launcherEvents].reverse().find((event) => event.type === "launcher.preview_ready");
  const latestReadyLauncherId = getPayloadString(latestReady?.payload ?? {}, "launcherId");
  const latestPreviewTerminal = latestReadyLauncherId
    ? [...launcherEvents].reverse().find((event) => {
        const eventLauncherId = getPayloadString(event.payload, "launcherId");
        return eventLauncherId === latestReadyLauncherId && ["launcher.preview_stopped", "launcher.preview_failed"].includes(event.type);
      })
    : undefined;
  const previewUrl = latestReady && (!latestPreviewTerminal || latestPreviewTerminal.sequence < latestReady.sequence) ? getPayloadString(latestReady.payload, "url") : undefined;
  const activePreviewLauncherId = previewUrl ? latestReadyLauncherId : undefined;
  const latestCheckStatus = getPayloadString(latestCheck?.payload ?? {}, "status");
  const latestCheckLabel = latestCheckStatus ? latestCheckStatus : "Not run";
  const latestCheckTone = latestCheckStatus === "passed" ? "success" : latestCheckStatus === "failed" ? "error" : latestCheckStatus === "skipped" ? "warning" : "default";
  const logTail = getPayloadString(latestLog?.payload ?? {}, "output") ?? "";
  const statusLabel = pending ? "Launcher running" : previewUrl ? "Preview ready" : latestCheckStatus ? `Check ${latestCheckStatus}` : "Local runtime";

  return {
    hasPackageJson: Boolean(packageFile),
    packageScripts,
    developmentScripts,
    acceptanceScripts,
    previewScripts,
    latestCheckLabel,
    latestCheckTone: latestCheckTone as "default" | "success" | "warning" | "error",
    previewUrl,
    activePreviewLauncherId,
    logTail,
    statusLabel,
    pending
  };
}

export interface OperatorQuestionCardState {
  id: string;
  loopId?: string;
  question: string;
  reason: string;
  options: Array<{ id: string; label: string; description?: string }>;
  allowNotes: boolean;
  selectedOptionIds?: string[];
  selectedLabels?: string[];
  notes?: string;
  createdAt: string;
  answeredAt?: string;
}

export function deriveOperatorQuestionState(snapshot: ForgeSnapshot) {
  const answerEventsByQuestionId = new Map(
    snapshot.events
      .filter((event) => event.type === "executive.user_input_answered")
      .flatMap((event) => {
        const questionId = getPayloadString(event.payload, "questionId");
        return questionId ? [[questionId, event] as const] : [];
      })
  );
  const questions = snapshot.events
    .filter((event) => event.type === "executive.user_input_requested")
    .flatMap((event): OperatorQuestionCardState[] => {
      const id = getPayloadString(event.payload, "questionId");
      if (!id) {
        return [];
      }
      const answer = answerEventsByQuestionId.get(id);
      return [
        {
          id,
          loopId: getPayloadString(event.payload, "loopId"),
          question: getPayloadString(event.payload, "question") ?? event.message,
          reason: getPayloadString(event.payload, "reason") ?? "Executive AI needs operator input before continuing.",
          options: getPayloadQuestionOptions(event.payload),
          allowNotes: event.payload.allowNotes !== false,
          selectedOptionIds: answer ? getPayloadStringArray(answer.payload, "selectedOptionIds") : undefined,
          selectedLabels: answer ? getPayloadStringArray(answer.payload, "selectedLabels") : undefined,
          notes: answer ? getPayloadString(answer.payload, "notes") : undefined,
          createdAt: event.createdAt,
          answeredAt: answer?.createdAt
        }
      ];
    });
  const dedupedPending = new Map<string, OperatorQuestionCardState>();
  for (const question of questions.filter((item) => !item.answeredAt)) {
    const key = operatorQuestionFingerprint(question);
    const existing = dedupedPending.get(key);
    if (!existing || question.createdAt.localeCompare(existing.createdAt) > 0) {
      dedupedPending.set(key, question);
    }
  }

  return {
    pending: Array.from(dedupedPending.values()).sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    answered: questions.filter((question) => question.answeredAt).sort((left, right) => (right.answeredAt ?? "").localeCompare(left.answeredAt ?? "")).slice(0, 3)
  };
}

function operatorQuestionFingerprint(question: OperatorQuestionCardState) {
  return JSON.stringify({
    question: question.question.trim().toLowerCase().replace(/\s+/g, " "),
    reason: question.reason.trim().toLowerCase().replace(/\s+/g, " "),
    options: question.options.map((option) => `${option.id.trim().toLowerCase()}:${option.label.trim().toLowerCase()}`).sort()
  });
}

function readWorkspacePackageScripts(content: string) {
  try {
    const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
    if (!parsed.scripts || typeof parsed.scripts !== "object") {
      return [];
    }
    return Object.entries(parsed.scripts)
      .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
      .map(([key]) => key)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function hasLaterLauncherTerminalEvent(events: RuntimeEvent[], event: RuntimeEvent) {
  const launcherId = getPayloadString(event.payload, "launcherId");
  if (!launcherId) {
    return false;
  }
  const terminalTypes =
    event.type === "launcher.check_started"
      ? ["launcher.check_completed"]
      : ["launcher.preview_ready", "launcher.preview_failed", "launcher.preview_stopped"];
  return events.some((candidate) => candidate.sequence > event.sequence && terminalTypes.includes(candidate.type) && getPayloadString(candidate.payload, "launcherId") === launcherId);
}

function filterWorkspaceFiles(files: VirtualFile[], search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) {
    return files.slice().sort(compareWorkspaceFiles);
  }

  return files
    .filter((file) => `${file.path} ${file.status} ${file.divisionId ?? ""} ${file.workerId ?? ""}`.toLowerCase().includes(needle))
    .sort(compareWorkspaceFiles);
}

function buildWorkspaceFileGroups(files: VirtualFile[], snapshot: ForgeSnapshot, mode: WorkspaceFileGroupMode) {
  if (mode === "directory") {
    return buildDirectoryFileGroups(files);
  }

  const groups = new Map<string, WorkspaceFileGroupNode>();
  files.forEach((file) => {
    const id = mode === "division" ? file.divisionId ?? "unknown" : file.status;
    const label = mode === "division" ? snapshot.divisions.find((division) => division.id === id)?.name ?? id : id;
    const existing = groups.get(id) ?? { id: `${mode}:${id}`, label, files: [], children: [] };
    groups.set(id, { ...existing, files: [...existing.files, file].sort(compareWorkspaceFiles) });
  });
  return Array.from(groups.values()).sort((left, right) => left.label.localeCompare(right.label));
}

function buildDirectoryFileGroups(files: VirtualFile[]) {
  const root: WorkspaceFileGroupNode = { id: "dir:/", label: "workspace", files: [], children: [] };
  files.forEach((file) => {
    const parts = file.path.split("/").filter(Boolean);
    if (parts.length <= 1) {
      root.files.push(file);
      return;
    }

    let current = root;
    parts.slice(0, -1).forEach((part, index) => {
      const id = `dir:${parts.slice(0, index + 1).join("/")}`;
      const existing = current.children.find((child) => child.id === id);
      if (existing) {
        current = existing;
        return;
      }

      const next = { id, label: part, files: [], children: [] };
      current.children = [...current.children, next].sort((left, right) => left.label.localeCompare(right.label));
      current = next;
    });
    current.files = [...current.files, file].sort(compareWorkspaceFiles);
  });
  return [...root.children, ...(root.files.length > 0 ? [{ ...root, children: [] }] : [])];
}

function compareWorkspaceFiles(left: VirtualFile, right: VirtualFile) {
  return left.path.localeCompare(right.path);
}

function WorkspaceFileGroup({
  group,
  selectedId,
  collapsedGroups,
  onToggleGroup,
  onSelectFile,
  snapshot,
  depth = 0
}: {
  group: WorkspaceFileGroupNode;
  selectedId?: string;
  collapsedGroups: Set<string>;
  onToggleGroup: (groupId: string) => void;
  onSelectFile: (fileId: string) => void;
  snapshot: ForgeSnapshot;
  depth?: number;
}) {
  const collapsed = collapsedGroups.has(group.id);
  const count = countWorkspaceGroupFiles(group);

  return (
    <div className="space-y-1">
      <button
        className="flex w-full items-center gap-2 rounded border border-forge-line bg-black/20 px-2 py-2 text-left text-sm text-slate-200 hover:border-forge-cyan"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => onToggleGroup(group.id)}
      >
        {collapsed ? <ChevronRight className="h-4 w-4 text-forge-muted" /> : <ChevronDown className="h-4 w-4 text-forge-muted" />}
        <Folder className="h-4 w-4 text-forge-cyan" />
        <span className="min-w-0 flex-1 truncate">{group.label}</span>
        <span className="text-xs text-forge-muted">{count}</span>
      </button>
      {!collapsed ? (
        <div className="space-y-1">
          {group.children.map((child) => (
            <WorkspaceFileGroup
              key={child.id}
              group={child}
              selectedId={selectedId}
              collapsedGroups={collapsedGroups}
              onToggleGroup={onToggleGroup}
              onSelectFile={onSelectFile}
              snapshot={snapshot}
              depth={depth + 1}
            />
          ))}
          {group.files.map((file) => (
            <button
              key={file.id}
              data-team-tone={getTeamTone(snapshot, file.divisionId)}
              className={`flex w-full items-center gap-2 rounded border px-2 py-2 text-left font-mono text-sm hover:border-forge-cyan ${
                selectedId === file.id ? "border-forge-cyan bg-forge-cyan/10 text-white" : "border-forge-line bg-black/20 text-slate-300"
              }`}
              style={{ paddingLeft: `${28 + depth * 14}px` }}
              onClick={() => onSelectFile(file.id)}
            >
              <FileText className="h-4 w-4 shrink-0 text-forge-muted" />
              <span className="min-w-0 flex-1 truncate">{file.path}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function countWorkspaceGroupFiles(group: WorkspaceFileGroupNode): number {
  return group.files.length + group.children.reduce((total, child) => total + countWorkspaceGroupFiles(child), 0);
}

function FileMetadata({ file, snapshot }: { file: VirtualFile; snapshot: ForgeSnapshot }) {
  return (
    <>
      <DetailRows rows={[["Status", file.status], ["Version", `v${file.version}`], ["Division", file.divisionId ?? "unknown"], ["Worker", file.workerId ?? "unknown"]]} />
      <DetailSections sections={[
        { title: "Provenance", items: [`Operation: ${file.operationId ?? "unknown"}`, "Source: virtual workspace store", "No real filesystem reads or writes in v1."] },
        { title: "Linked Artifacts", items: file.artifactIds.map((id) => snapshot.artifacts.find((artifact) => artifact.id === id)?.title ?? id) }
      ]} />
    </>
  );
}

function EventMetadata({ event, snapshot }: { event: RuntimeEvent; snapshot: ForgeSnapshot }) {
  const runId = getPayloadString(event.payload, "runId") ?? (event.targetType === "run" ? event.targetId : undefined);
  const run = runId ? snapshot.runs.find((candidate) => candidate.id === runId) : undefined;

  return (
    <>
      <DetailRows rows={[["Sequence", `#${event.sequence}`], ["Severity", event.severity], ["Actor", event.actorType], ["Target", event.targetType ?? "none"]]} />
      <RuntimeVerificationSummaryPanel run={run} />
      <DetailSections sections={[{ title: "Payload", items: [JSON.stringify(event.payload, null, 2)] }]} />
    </>
  );
}
