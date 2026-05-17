"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { Bot, Play, RotateCcw } from "lucide-react";
import { useSearchParams } from "next/navigation";
import type { Division, ForgeSnapshot, Operation, RuntimeEvent, RuntimeStatus, VirtualFile, Worker } from "@/lib/runtime/types";
import { deriveForgeMetrics } from "@/lib/runtime/metrics";
import { useForgeStore } from "@/lib/store/forge-store";
import { severityClass } from "./status";
import { EmptyState, ForgeShell, MetricsGrid, Panel, Progress, StatusBadge } from "./forge-ui";

export function OverviewPage({ initialSnapshot }: { initialSnapshot: ForgeSnapshot }) {
  const { snapshot, hydrate, runCommand, commandPending, commandError } = useForgeStore();
  useEffect(() => hydrate(initialSnapshot), [hydrate, initialSnapshot]);
  const current = snapshot ?? initialSnapshot;
  const metrics = deriveForgeMetrics(current);
  const active = current.operations.filter((operation) => ["running", "ready", "blocked", "reviewing"].includes(operation.status));
  const blockers = current.operations.filter((operation) => ["blocked", "failed"].includes(operation.status));

  return (
    <ForgeShell snapshot={current}>
      <MetricsGrid snapshot={current} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Panel title="Organizational Brief" action={metrics.estimatedCompletion}>
          <div className="grid gap-4 p-4 lg:grid-cols-2">
            <div className="rounded border border-forge-line bg-black/20 p-4">
              <div className="text-sm text-forge-muted">Current Phase</div>
              <div className="mt-2 text-2xl font-semibold text-white">{current.forge.activePhase}</div>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                Strategy is complete, engineering and presentation are active, QA is preparing review, and Release is waiting for validation.
              </p>
            </div>
            <div className="rounded border border-forge-line bg-black/20 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm text-forge-muted">Priority Blockers</div>
                  <p className="mt-2 text-sm leading-6 text-slate-300">
                    These are operations that currently prevent downstream work from moving cleanly through the Forge pipeline.
                  </p>
                </div>
                <div className="rounded border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-center">
                  <div className="text-xl font-semibold text-amber-100">{blockers.length}</div>
                  <div className="text-xs uppercase text-amber-200">open</div>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {blockers.length > 0 ? blockers.map((operation) => (
                  <BlockerBrief key={operation.id} operation={operation} snapshot={current} />
                )) : (
                  <div className="rounded border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">
                    No priority blockers are open. The Forge can continue moving through the active operation queue.
                  </div>
                )}
              </div>
            </div>
          </div>
        </Panel>
        <ExecutiveConsole snapshot={current} pending={commandPending} commandError={commandError} onCommand={runCommand} />
      </div>
      <CompletenessBoard snapshot={current} />
    </ForgeShell>
  );
}

function BlockerBrief({ operation, snapshot }: { operation: Operation; snapshot: ForgeSnapshot }) {
  const division = snapshot.divisions.find((item) => item.id === operation.divisionId);
  const worker = snapshot.workers.find((item) => item.id === operation.workerId);
  const downstream = snapshot.dependencies
    .filter((dependency) => dependency.dependsOnOperationId === operation.id && dependency.type === "blocks")
    .map((dependency) => snapshot.operations.find((candidate) => candidate.id === dependency.operationId)?.title)
    .filter((title): title is string => Boolean(title));

  return (
    <a href={`/forge/demo/operations?operation=${operation.id}`} className="block rounded border border-amber-400/30 bg-amber-400/10 p-3 hover:border-forge-cyan">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-amber-100">{operation.title}</div>
          <div className="mt-1 text-xs text-amber-200">{division?.name ?? "Unknown division"} / {worker?.name ?? "Unassigned worker"}</div>
        </div>
        <StatusBadge status={operation.status} />
      </div>
      <div className="mt-3 grid gap-3 text-sm leading-6 text-slate-300 lg:grid-cols-3">
        <div>
          <div className="text-xs uppercase text-forge-muted">Why blocked</div>
          <div>{operation.blockedReason ?? "The runtime marked this operation as blocked."}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-forge-muted">Impact</div>
          <div>{downstream.length > 0 ? `Holding ${downstream.join(", ")}` : "No downstream blocker edge recorded."}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-forge-muted">Next action</div>
          <div>Open Operations and run or resolve this operation before Release advances.</div>
        </div>
      </div>
    </a>
  );
}

function CompletenessBoard({ snapshot }: { snapshot: ForgeSnapshot }) {
  const lanes = [
    {
      title: "Complete",
      action: "Done",
      statuses: ["completed"] as RuntimeStatus[],
      accent: "border-emerald-400/30 bg-emerald-400/5"
    },
    {
      title: "In Progress",
      action: "Active",
      statuses: ["running", "ready", "reviewing"] as RuntimeStatus[],
      accent: "border-sky-400/30 bg-sky-400/5"
    },
    {
      title: "Blocked",
      action: "Needs action",
      statuses: ["blocked", "failed"] as RuntimeStatus[],
      accent: "border-amber-400/30 bg-amber-400/5"
    },
    {
      title: "Not Started",
      action: "Queued",
      statuses: ["idle", "planning"] as RuntimeStatus[],
      accent: "border-slate-500/30 bg-slate-500/5"
    }
  ];

  return (
    <Panel title="Project Completeness Board" action={`${snapshot.operations.length} operations`}>
      <div className="grid gap-4 p-4 lg:grid-cols-2 2xl:grid-cols-4">
        {lanes.map((lane) => {
          const operations = snapshot.operations.filter((operation) => lane.statuses.includes(operation.status));
          const average =
            operations.length === 0
              ? 0
              : Math.round(operations.reduce((sum, operation) => sum + operation.progress, 0) / operations.length);

          return (
            <div key={lane.title} className={`rounded-lg border p-3 ${lane.accent}`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-white">{lane.title}</div>
                  <div className="mt-1 text-xs uppercase text-forge-muted">{lane.action}</div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-semibold text-white">{operations.length}</div>
                  <div className="text-xs text-forge-muted">{average}% avg</div>
                </div>
              </div>
              <div className="mt-3 space-y-2">
                {operations.length > 0 ? (
                  operations.map((operation) => <CompletenessCard key={operation.id} operation={operation} snapshot={snapshot} />)
                ) : (
                  <div className="rounded border border-dashed border-forge-line p-4 text-sm text-forge-muted">No operations in this lane.</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function CompletenessCard({ operation, snapshot }: { operation: Operation; snapshot: ForgeSnapshot }) {
  const division = snapshot.divisions.find((item) => item.id === operation.divisionId);
  const worker = snapshot.workers.find((item) => item.id === operation.workerId);

  return (
    <a href={`/forge/demo/operations?operation=${operation.id}`} className="block rounded border border-forge-line bg-black/25 p-3 hover:border-forge-cyan">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-white">{operation.title}</div>
          <div className="mt-1 truncate text-xs text-forge-muted">{division?.name ?? "Unknown division"} / {worker?.name ?? "Unassigned"}</div>
        </div>
        <StatusBadge status={operation.status} />
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-300">{operation.blockedReason ?? operation.description}</p>
      <Progress value={operation.progress} compact />
    </a>
  );
}

export function OrganizationPage({ initialSnapshot }: { initialSnapshot: ForgeSnapshot }) {
  const { snapshot, hydrate } = useForgeStore();
  useEffect(() => hydrate(initialSnapshot), [hydrate, initialSnapshot]);
  const current = snapshot ?? initialSnapshot;
  const [selected, setSelected] = useState<{ type: "division" | "worker"; id: string }>({ type: "division", id: current.divisions[0]?.id ?? "" });
  const detail = getOrgDetail(current, selected);

  return (
    <ForgeShell snapshot={current}>
      <div className="grid min-h-[720px] gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <Panel title="Agent Organization Map" action="Full page topology">
          <div className="scrollbar grid max-h-[760px] gap-4 overflow-auto p-4 lg:grid-cols-2 2xl:grid-cols-3">
            {current.divisions.map((division) => {
              const workers = current.workers.filter((worker) => worker.divisionId === division.id);
              return (
                <div key={division.id} className="rounded-lg border border-forge-line bg-black/20 p-4">
                  <button className="flex w-full items-start justify-between gap-3 text-left" onClick={() => setSelected({ type: "division", id: division.id })}>
                    <div>
                      <div className="font-semibold text-white">{division.name}</div>
                      <p className="mt-2 text-sm leading-6 text-slate-300">{division.objective}</p>
                    </div>
                    <StatusBadge status={division.status} />
                  </button>
                  <Progress value={division.progress} compact />
                  <div className="mt-4 space-y-2">
                    {workers.map((worker) => (
                      <button
                        key={worker.id}
                        className={`flex w-full items-center gap-2 rounded border px-3 py-2 text-left text-sm hover:border-forge-cyan ${
                          selected.type === "worker" && selected.id === worker.id ? "border-forge-cyan bg-forge-cyan/10" : "border-forge-line bg-forge-panel"
                        }`}
                        onClick={() => setSelected({ type: "worker", id: worker.id })}
                      >
                        <Bot className="h-4 w-4 text-forge-blue" />
                        <span className="min-w-0 flex-1 truncate text-slate-200">{worker.name}</span>
                        <StatusBadge status={worker.status} />
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
        <StickyDetail title={detail.title} subtitle={detail.subtitle}>
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
  const { snapshot, hydrate, runCommand, commandPending, commandError } = useForgeStore();
  useEffect(() => hydrate(initialSnapshot), [hydrate, initialSnapshot]);
  const current = snapshot ?? initialSnapshot;
  const searchParams = useSearchParams();
  const operationParam = searchParams.get("operation");
  const initialSelectedId = current.operations.some((operation) => operation.id === operationParam)
    ? operationParam ?? current.operations[0]?.id ?? ""
    : current.operations[0]?.id ?? "";
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [query, setQuery] = useState("");
  const [groupBy, setGroupBy] = useState<"status" | "division" | "worker" | "priority">("status");
  const [statusFilter, setStatusFilter] = useState<"all" | RuntimeStatus>("all");
  const selected = current.operations.find((operation) => operation.id === selectedId) ?? current.operations[0];
  const deps = selected ? current.dependencies.filter((dependency) => dependency.operationId === selected.id) : [];
  const filteredOperations = useMemo(
    () => filterOperations(current, query, statusFilter),
    [current, query, statusFilter]
  );
  const operationGroups = useMemo(
    () => groupOperations(current, filteredOperations, groupBy),
    [current, filteredOperations, groupBy]
  );

  useEffect(() => {
    if (operationParam && current.operations.some((operation) => operation.id === operationParam)) {
      setSelectedId(operationParam);
    }
  }, [current.operations, operationParam]);

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
                  onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
                  className="w-full rounded border border-forge-line bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-forge-cyan"
                >
                  <option value="all">All statuses</option>
                  <option value="planning">Planning</option>
                  <option value="ready">Ready</option>
                  <option value="running">Running</option>
                  <option value="blocked">Blocked</option>
                  <option value="reviewing">Reviewing</option>
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
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
                          selected={selected?.id === operation.id}
                          onSelect={() => {
                            setSelectedId(operation.id);
                            window.history.replaceState(null, "", `/forge/demo/operations?operation=${operation.id}`);
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
        <StickyDetail title={selected?.title ?? "Operation"} subtitle={selected?.description ?? ""}>
          {selected ? (
            <>
              <DetailRows rows={[
                ["Status", selected.status],
                ["Priority", selected.priority],
                ["Progress", `${selected.progress}%`],
                ["Retries", String(selected.retryCount)]
              ]} />
              <DetailSections sections={[
                { title: "Blocker", items: [selected.blockedReason ?? "No active blocker recorded."] },
                { title: "Dependencies", items: deps.length ? deps.map((dep) => `${dep.type}: ${dep.dependsOnOperationId}`) : ["No blocking dependency recorded."] }
              ]} />
              <button
                className="mt-4 flex w-full items-center justify-center gap-2 rounded bg-forge-cyan px-3 py-2 text-sm font-semibold text-black disabled:opacity-60"
                disabled={commandPending}
                onClick={() => void runCommand({ type: "run_operation", operationId: selected.id })}
              >
                <Play className="h-4 w-4" />
                Run Selected Operation
              </button>
              {commandError ? <div className="mt-3 rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{commandError}</div> : null}
            </>
          ) : null}
        </StickyDetail>
      </div>
    </ForgeShell>
  );
}

function OperationBoardCard({ operation, selected, onSelect }: { operation: Operation; selected: boolean; onSelect: () => void }) {
  return (
    <button
      className={`rounded border p-4 text-left hover:border-forge-cyan ${
        selected ? "border-forge-cyan bg-forge-cyan/10" : "border-forge-line bg-black/20"
      }`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="font-semibold text-white">{operation.title}</div>
        <StatusBadge status={operation.status} />
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-300">{operation.blockedReason ?? operation.description}</p>
      <Progress value={operation.progress} compact />
    </button>
  );
}

function filterOperations(snapshot: ForgeSnapshot, query: string, statusFilter: "all" | RuntimeStatus) {
  const normalizedQuery = query.trim().toLowerCase();

  return snapshot.operations.filter((operation) => {
    if (statusFilter !== "all" && operation.status !== statusFilter) {
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

export function WorkspacePage({ initialSnapshot }: { initialSnapshot: ForgeSnapshot }) {
  const { snapshot, hydrate } = useForgeStore();
  useEffect(() => hydrate(initialSnapshot), [hydrate, initialSnapshot]);
  const current = snapshot ?? initialSnapshot;
  const [selectedId, setSelectedId] = useState(current.files[0]?.id ?? "");
  const selected = current.files.find((file) => file.id === selectedId) ?? current.files[0];

  return (
    <ForgeShell snapshot={current}>
      <div className="grid min-h-[720px] gap-4 xl:grid-cols-[340px_minmax(0,1fr)_360px]">
        <Panel title="Virtual File Tree" action={`${current.files.length} files`}>
          <div className="scrollbar max-h-[760px] space-y-2 overflow-auto p-4">
            {current.files.map((file) => (
              <button
                key={file.id}
                className={`w-full rounded border px-3 py-3 text-left font-mono text-sm hover:border-forge-cyan ${
                  selected?.id === file.id ? "border-forge-cyan bg-forge-cyan/10 text-white" : "border-forge-line bg-black/20 text-slate-300"
                }`}
                onClick={() => setSelectedId(file.id)}
              >
                {file.path}
              </button>
            ))}
          </div>
        </Panel>
        <Panel title={selected?.path ?? "File Renderer"} action="Read-only virtual workspace">
          <pre className="scrollbar max-h-[760px] overflow-auto whitespace-pre-wrap p-5 font-mono text-sm leading-6 text-slate-200">{selected?.content}</pre>
        </Panel>
        <StickyDetail title="File Metadata" subtitle={selected?.path ?? ""}>
          {selected ? <FileMetadata file={selected} snapshot={current} /> : <EmptyState text="Select a virtual file." />}
        </StickyDetail>
      </div>
    </ForgeShell>
  );
}

export function AssetsPage({ initialSnapshot }: { initialSnapshot: ForgeSnapshot }) {
  const { snapshot, hydrate } = useForgeStore();
  useEffect(() => hydrate(initialSnapshot), [hydrate, initialSnapshot]);
  const current = snapshot ?? initialSnapshot;
  const [selectedId, setSelectedId] = useState(current.artifacts[0]?.id ?? "");
  const selected = current.artifacts.find((artifact) => artifact.id === selectedId) ?? current.artifacts[0];

  return (
    <ForgeShell snapshot={current}>
      <div className="grid min-h-[720px] gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <Panel title="Forge Assets" action={`${current.artifacts.length} artifacts`}>
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {current.artifacts.map((artifact) => (
              <button key={artifact.id} className={`rounded border p-4 text-left hover:border-forge-cyan ${selected?.id === artifact.id ? "border-forge-cyan bg-forge-cyan/10" : "border-forge-line bg-black/20"}`} onClick={() => setSelectedId(artifact.id)}>
                <div className="text-sm font-semibold text-white">{artifact.title}</div>
                <div className="mt-2 text-xs uppercase text-forge-muted">{artifact.type}</div>
                <p className="mt-3 line-clamp-4 text-sm leading-6 text-slate-300">{artifact.content}</p>
              </button>
            ))}
          </div>
        </Panel>
        <StickyDetail title={selected?.title ?? "Artifact"} subtitle={selected?.type ?? ""}>
          {selected ? (
            <>
              <DetailRows rows={[["Status", selected.status], ["Version", `v${selected.version}`], ["Division", selected.divisionId]]} />
              <DetailSections sections={[{ title: "Content", items: [selected.content] }, { title: "Tags", items: selected.tags }]} />
            </>
          ) : null}
        </StickyDetail>
      </div>
    </ForgeShell>
  );
}

export function LogsPage({ initialSnapshot }: { initialSnapshot: ForgeSnapshot }) {
  const { snapshot, hydrate } = useForgeStore();
  useEffect(() => hydrate(initialSnapshot), [hydrate, initialSnapshot]);
  const current = snapshot ?? initialSnapshot;
  const [selectedId, setSelectedId] = useState(current.events.at(-1)?.id ?? "");
  const selected = current.events.find((event) => event.id === selectedId) ?? current.events.at(-1);

  return (
    <ForgeShell snapshot={current}>
      <div className="grid min-h-[720px] gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <Panel title="Runtime Event Stream" action={`last #${current.lastEventSequence}`}>
          <div className="scrollbar max-h-[760px] space-y-2 overflow-auto p-4">
            {current.events.slice().reverse().map((event) => (
              <button key={event.id} className={`flex w-full items-start gap-3 rounded border p-3 text-left hover:border-forge-cyan ${selected?.id === event.id ? "border-forge-cyan bg-forge-cyan/10" : "border-forge-line bg-black/20"}`} onClick={() => setSelectedId(event.id)}>
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
        <StickyDetail title={selected?.type ?? "Event"} subtitle={selected?.message ?? ""}>
          {selected ? <EventMetadata event={selected} /> : null}
        </StickyDetail>
      </div>
    </ForgeShell>
  );
}

function ExecutiveConsole({ snapshot, pending, commandError, onCommand }: { snapshot: ForgeSnapshot; pending: boolean; commandError: string | null; onCommand: (command: { type: "run_full_flow" | "reset_demo_state" | "operator_message"; message?: string }) => Promise<void> }) {
  const [message, setMessage] = useState("");
  const recent = snapshot.messages.slice(-4);

  async function submit() {
    const trimmed = message.trim();
    if (!trimmed) return;
    setMessage("");
    await onCommand({ type: "operator_message", message: trimmed });
  }

  return (
    <Panel title="Executive Console" action="Local mock">
      <div className="space-y-3 p-4">
        {recent.map((item) => (
          <div key={item.id} className={`rounded border border-forge-line p-3 text-sm ${item.role === "executive" ? "bg-forge-cyan/10" : "bg-black/20"}`}>
            <div className="mb-1 text-xs uppercase text-forge-muted">{item.role}</div>
            <div className="leading-6 text-slate-200">{item.content}</div>
          </div>
        ))}
        <div className="flex gap-2">
          <input value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} placeholder="Ask Executive AI" className="min-w-0 flex-1 rounded border border-forge-line bg-black/30 px-3 py-2 text-sm outline-none focus:border-forge-cyan" />
          <button className="rounded bg-forge-cyan px-3 py-2 text-sm font-semibold text-black disabled:opacity-60" disabled={pending} onClick={() => void submit()}>Send</button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button className="flex items-center justify-center gap-2 rounded border border-forge-line px-3 py-2 text-sm hover:border-forge-cyan disabled:opacity-60" disabled={pending} onClick={() => void onCommand({ type: "run_full_flow" })}><Play className="h-4 w-4" />Run Flow</button>
          <button className="flex items-center justify-center gap-2 rounded border border-forge-line px-3 py-2 text-sm hover:border-forge-cyan disabled:opacity-60" disabled={pending} onClick={() => void onCommand({ type: "reset_demo_state" })}><RotateCcw className="h-4 w-4" />Reset</button>
        </div>
        {commandError ? <div className="rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{commandError}</div> : null}
      </div>
    </Panel>
  );
}

function StickyDetail({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <aside className="xl:sticky xl:top-4 xl:self-start">
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

function getOrgDetail(snapshot: ForgeSnapshot, selected: { type: "division" | "worker"; id: string }) {
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

function EventMetadata({ event }: { event: RuntimeEvent }) {
  return (
    <>
      <DetailRows rows={[["Sequence", `#${event.sequence}`], ["Severity", event.severity], ["Actor", event.actorType], ["Target", event.targetType ?? "none"]]} />
      <DetailSections sections={[{ title: "Payload", items: [JSON.stringify(event.payload, null, 2)] }]} />
    </>
  );
}
