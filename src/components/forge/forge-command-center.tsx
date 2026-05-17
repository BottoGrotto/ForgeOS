"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Boxes,
  ChevronRight,
  CircleAlert,
  FileText,
  Gauge,
  GitBranch,
  MessageSquare,
  Network,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  TerminalSquare,
  Users
} from "lucide-react";
import type { ForgeSnapshot, RuntimeStatus } from "@/lib/runtime/types";
import { deriveForgeMetrics } from "@/lib/runtime/metrics";
import { Selection, useForgeStore } from "@/lib/store/forge-store";
import { severityClass, statusClass } from "./status";

export function ForgeCommandCenter({ initialSnapshot }: { initialSnapshot: ForgeSnapshot }) {
  const { snapshot, hydrate, connectEventStream, selected, selectNode, runCommand, commandPending, activePanel, setPanel } = useForgeStore();

  useEffect(() => {
    hydrate(initialSnapshot);
  }, [hydrate, initialSnapshot]);
  useEffect(() => connectEventStream(), [connectEventStream]);

  const current: ForgeSnapshot = snapshot ?? initialSnapshot;
  const metrics = useMemo(() => deriveForgeMetrics(current), [current]);

  return (
    <main className="min-h-screen bg-forge-bg text-forge-text">
      <div className="mx-auto flex min-h-screen w-full max-w-[1800px] flex-col gap-4 px-4 py-4 lg:px-6">
        <ForgeHeader snapshot={current} metrics={metrics} />
        <section className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)_420px]">
          <aside className="min-h-0 rounded-lg border border-forge-line bg-forge-panel shadow-command">
            <OrgMap snapshot={current} selected={selected} onSelect={selectNode} />
          </aside>
          <section className="min-h-0 rounded-lg border border-forge-line bg-forge-panel shadow-command">
            <OperationsBoard snapshot={current} selected={selected} onSelect={selectNode} />
          </section>
          <aside className="grid min-h-0 gap-4 xl:grid-rows-[minmax(0,1fr)_360px]">
            <InspectorPanel snapshot={current} selected={selected} onSelect={selectNode} />
            <ExecutiveConsole snapshot={current} pending={commandPending} onCommand={runCommand} />
          </aside>
        </section>
        <WorkspacePanel activePanel={activePanel} setPanel={setPanel} snapshot={current} onSelect={selectNode} />
      </div>
    </main>
  );
}

function ForgeHeader({ snapshot, metrics }: { snapshot: ForgeSnapshot; metrics: ReturnType<typeof deriveForgeMetrics> }) {
  const metricItems = [
    { label: "Active Workers", value: metrics.activeWorkers, icon: Users },
    { label: "Operations", value: metrics.activeOperations, icon: Activity },
    { label: "Blocked", value: metrics.blockedOperations, icon: CircleAlert },
    { label: "Assets", value: metrics.generatedAssets, icon: Boxes },
    { label: "Readiness", value: `${metrics.deploymentReadiness}%`, icon: ShieldCheck },
    { label: "Confidence", value: `${metrics.confidence}%`, icon: Gauge }
  ];

  return (
    <header className="rounded-lg border border-forge-line bg-forge-panel p-4 shadow-command">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3 text-sm text-forge-muted">
            <span className="rounded border border-forge-line px-2 py-1">Forge Command Center</span>
            <span>{snapshot.forge.activePhase}</span>
            <span>{metrics.estimatedCompletion}</span>
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-normal text-white">{snapshot.forge.name}</h1>
          <p className="mt-1 text-sm text-forge-muted">{snapshot.forge.tagline}</p>
        </div>
        <div className="w-full max-w-2xl">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-forge-muted">Forge Progress</span>
            <span className="font-semibold text-white">{metrics.progress}%</span>
          </div>
          <div className="h-3 overflow-hidden rounded bg-black/40">
            <div className="h-full rounded bg-gradient-to-r from-forge-cyan via-forge-blue to-forge-green" style={{ width: `${metrics.progress}%` }} />
          </div>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {metricItems.map((item) => (
          <div key={item.label} className="rounded-md border border-forge-line bg-black/20 p-3">
            <div className="flex items-center justify-between text-forge-muted">
              <span className="text-xs uppercase">{item.label}</span>
              <item.icon className="h-4 w-4" />
            </div>
            <div className="mt-2 text-2xl font-semibold text-white">{item.value}</div>
          </div>
        ))}
      </div>
    </header>
  );
}

function OrgMap({ snapshot, selected, onSelect }: { snapshot: ForgeSnapshot; selected: Selection | null; onSelect: (selection: Selection) => void }) {
  return (
    <div className="flex h-full min-h-[520px] flex-col">
      <PanelTitle icon={Network} title="Live Organization Map" action="Topology" />
      <div className="scrollbar flex-1 overflow-auto p-4">
        <button
          className={nodeClass(selected?.type === "forge")}
          onClick={() => onSelect({ type: "forge", id: snapshot.forge.id })}
        >
          <Bot className="h-4 w-4 text-forge-cyan" />
          <span className="font-medium">Executive AI</span>
          <span className="ml-auto text-xs text-forge-muted">{snapshot.forge.activePhase}</span>
        </button>
        <div className="mt-3 space-y-3 border-l border-forge-line pl-4">
          {snapshot.divisions.map((division) => {
            const workers = snapshot.workers.filter((worker) => worker.divisionId === division.id);
            return (
              <div key={division.id}>
                <button
                  className={nodeClass(selected?.type === "division" && selected.id === division.id)}
                  onClick={() => onSelect({ type: "division", id: division.id })}
                >
                  <ChevronRight className="h-4 w-4 text-forge-muted" />
                  <span className="min-w-0 truncate">{division.name}</span>
                  <StatusBadge status={division.status} />
                </button>
                <div className="mt-2 space-y-2 border-l border-forge-line/60 pl-4">
                  {workers.map((worker) => (
                    <button
                      key={worker.id}
                      className={nodeClass(selected?.type === "worker" && selected.id === worker.id)}
                      onClick={() => onSelect({ type: "worker", id: worker.id })}
                    >
                      <Bot className="h-4 w-4 text-forge-blue" />
                      <span className="min-w-0 truncate">{worker.name}</span>
                      <StatusBadge status={worker.status} />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function OperationsBoard({ snapshot, selected, onSelect }: { snapshot: ForgeSnapshot; selected: Selection | null; onSelect: (selection: Selection) => void }) {
  const active = snapshot.operations.filter((operation) => ["running", "ready", "blocked", "reviewing", "planning"].includes(operation.status));
  const handoff = snapshot.handoffs[0];

  return (
    <div className="flex h-full min-h-[520px] flex-col">
      <PanelTitle icon={GitBranch} title="Active Operations" action="Dependency-aware" />
      <div className="scrollbar grid flex-1 gap-4 overflow-auto p-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        <div className="space-y-3">
          {active.map((operation) => {
            const division = snapshot.divisions.find((candidate) => candidate.id === operation.divisionId);
            const worker = snapshot.workers.find((candidate) => candidate.id === operation.workerId);
            return (
              <button
                key={operation.id}
                className={`w-full rounded-md border p-4 text-left transition hover:border-forge-cyan ${
                  selected?.type === "operation" && selected.id === operation.id ? "border-forge-cyan bg-forge-cyan/10" : "border-forge-line bg-black/20"
                }`}
                onClick={() => onSelect({ type: "operation", id: operation.id })}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-white">{operation.title}</div>
                    <div className="mt-1 text-sm text-forge-muted">{division?.name} / {worker?.name ?? "Unassigned"}</div>
                  </div>
                  <StatusBadge status={operation.status} />
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-300">{operation.description}</p>
                {operation.blockedReason ? <p className="mt-2 text-sm text-amber-200">{operation.blockedReason}</p> : null}
                <Progress value={operation.progress} />
              </button>
            );
          })}
        </div>
        <div className="space-y-4">
          <div className="rounded-md border border-forge-line bg-black/20 p-4">
            <div className="text-sm font-semibold text-white">Division Status</div>
            <div className="mt-4 space-y-3">
              {snapshot.divisions.map((division) => (
                <button
                  key={division.id}
                  className="w-full text-left"
                  onClick={() => onSelect({ type: "division", id: division.id })}
                >
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-slate-200">{division.name}</span>
                    <span className="text-forge-muted">{division.progress}%</span>
                  </div>
                  <Progress value={division.progress} compact />
                </button>
              ))}
            </div>
          </div>
          {handoff ? (
            <button
              className="w-full rounded-md border border-forge-line bg-black/20 p-4 text-left hover:border-forge-cyan"
              onClick={() => onSelect({ type: "handoff", id: handoff.id })}
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <TerminalSquare className="h-4 w-4 text-forge-cyan" />
                Latest Handoff
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-300">{handoff.summary}</p>
              <div className="mt-3 text-xs text-forge-muted">Confidence {handoff.confidence}%</div>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function InspectorPanel({ snapshot, selected, onSelect }: { snapshot: ForgeSnapshot; selected: Selection | null; onSelect: (selection: Selection) => void }) {
  const entity = getSelectedEntity(snapshot, selected);

  return (
    <section className="min-h-[420px] rounded-lg border border-forge-line bg-forge-panel shadow-command">
      <PanelTitle icon={Search} title="Inspector" action={entity.label} />
      <div className="scrollbar h-[calc(100%-57px)] overflow-auto p-4">
        <div className="text-xl font-semibold text-white">{entity.title}</div>
        <p className="mt-2 text-sm leading-6 text-slate-300">{entity.description}</p>
        {entity.status ? <div className="mt-4"><StatusBadge status={entity.status} /></div> : null}
        {entity.progress !== undefined ? <Progress value={entity.progress} /> : null}
        <div className="mt-5 grid grid-cols-2 gap-3">
          {entity.stats.map((stat) => (
            <div key={stat.label} className="rounded border border-forge-line bg-black/20 p-3">
              <div className="text-xs uppercase text-forge-muted">{stat.label}</div>
              <div className="mt-1 text-lg font-semibold text-white">{stat.value}</div>
            </div>
          ))}
        </div>
        <div className="mt-5 space-y-3">
          {entity.sections.map((section) => (
            <div key={section.title} className="rounded border border-forge-line bg-black/20 p-3">
              <div className="text-sm font-semibold text-white">{section.title}</div>
              <div className="mt-2 space-y-2 text-sm leading-6 text-slate-300">
                {section.items.map((item) => (
                  <div key={item}>{item}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {entity.links.length > 0 ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {entity.links.map((link) => (
              <button key={`${link.type}-${link.id}`} className="rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan" onClick={() => onSelect(link)}>
                Inspect {link.type}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ExecutiveConsole({
  snapshot,
  pending,
  onCommand
}: {
  snapshot: ForgeSnapshot;
  pending: boolean;
  onCommand: (command: { type: "run_full_flow" | "pause_forge" | "resume_forge" | "reset_demo_state" | "run_operation" | "operator_message"; message?: string }) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const recent = snapshot.messages.slice(-5);

  async function submit() {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }
    setMessage("");
    await onCommand({ type: "operator_message", message: trimmed });
  }

  return (
    <section className="rounded-lg border border-forge-line bg-forge-panel shadow-command">
      <PanelTitle icon={MessageSquare} title="Executive Console" action="Mock LLM" />
      <div className="scrollbar h-[185px] overflow-auto px-4 py-3">
        <div className="space-y-3">
          {recent.map((item) => (
            <div key={item.id} className={`rounded border border-forge-line p-3 text-sm ${item.role === "executive" ? "bg-forge-cyan/10" : "bg-black/20"}`}>
              <div className="mb-1 text-xs uppercase text-forge-muted">{item.role}</div>
              <div className="leading-6 text-slate-200">{item.content}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-forge-line p-4">
        <div className="flex gap-2">
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            placeholder="Issue a strategic command"
            className="min-w-0 flex-1 rounded border border-forge-line bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-forge-cyan"
          />
          <button className="rounded bg-forge-cyan px-3 py-2 text-sm font-semibold text-black disabled:opacity-60" disabled={pending} onClick={() => void submit()}>
            Send
          </button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <IconButton label="Run Flow" icon={Play} disabled={pending} onClick={() => void onCommand({ type: "run_full_flow" })} />
          {snapshot.forge.status === "paused" ? (
            <IconButton label="Resume" icon={Activity} disabled={pending} onClick={() => void onCommand({ type: "resume_forge" })} />
          ) : (
            <IconButton label="Shutdown" icon={Activity} disabled={pending || snapshot.forge.status === "archived"} onClick={() => void onCommand({ type: "pause_forge" })} />
          )}
          <IconButton label="Reset" icon={RotateCcw} disabled={pending} onClick={() => void onCommand({ type: "reset_demo_state" })} />
        </div>
      </div>
    </section>
  );
}

function WorkspacePanel({
  activePanel,
  setPanel,
  snapshot,
  onSelect
}: {
  activePanel: "overview" | "files" | "artifacts" | "logs";
  setPanel: (panel: "overview" | "files" | "artifacts" | "logs") => void;
  snapshot: ForgeSnapshot;
  onSelect: (selection: Selection) => void;
}) {
  const tabs = [
    { id: "files", label: "Virtual Files", icon: FileText },
    { id: "artifacts", label: "Forge Assets", icon: Boxes },
    { id: "logs", label: "Activity Stream", icon: Activity }
  ] as const;

  return (
    <section className="rounded-lg border border-forge-line bg-forge-panel shadow-command">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-forge-line p-3">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`flex items-center gap-2 rounded border px-3 py-2 text-sm ${
                activePanel === tab.id ? "border-forge-cyan bg-forge-cyan/10 text-white" : "border-forge-line text-forge-muted"
              }`}
              onClick={() => setPanel(tab.id)}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          ))}
        </div>
        <div className="text-sm text-forge-muted">Virtual workspace only</div>
      </div>
      <div className="scrollbar max-h-[320px] overflow-auto p-4">
        {activePanel === "files" ? (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {snapshot.files.map((file) => (
              <button key={file.id} className="rounded border border-forge-line bg-black/20 p-3 text-left hover:border-forge-cyan" onClick={() => onSelect({ type: "file", id: file.id })}>
                <div className="font-mono text-sm text-white">{file.path}</div>
                <div className="mt-2 flex items-center justify-between text-xs text-forge-muted">
                  <span>v{file.version}</span>
                  <span>{file.status}</span>
                </div>
              </button>
            ))}
          </div>
        ) : null}
        {activePanel === "artifacts" ? (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
            {snapshot.artifacts.map((artifact) => (
              <button key={artifact.id} className="rounded border border-forge-line bg-black/20 p-3 text-left hover:border-forge-cyan" onClick={() => onSelect({ type: "artifact", id: artifact.id })}>
                <div className="text-sm font-semibold text-white">{artifact.title}</div>
                <div className="mt-2 text-xs uppercase text-forge-muted">{artifact.type}</div>
                <p className="mt-3 line-clamp-3 text-sm leading-6 text-slate-300">{artifact.content}</p>
              </button>
            ))}
          </div>
        ) : null}
        {activePanel === "logs" || activePanel === "overview" ? (
          <div className="space-y-2">
            {snapshot.events.slice().reverse().map((event) => (
              <button key={event.id} className="flex w-full items-start gap-3 rounded border border-forge-line bg-black/20 p-3 text-left hover:border-forge-cyan" onClick={() => event.targetType && event.targetId ? onSelect({ type: event.targetType === "operation" ? "operation" : event.targetType as Selection["type"], id: event.targetId } as Selection) : undefined}>
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${event.severity === "success" ? "bg-forge-green" : event.severity === "warning" ? "bg-forge-amber" : event.severity === "error" ? "bg-forge-red" : "bg-forge-blue"}`} />
                <span className="min-w-0">
                  <span className={`block text-sm font-semibold ${severityClass(event.severity)}`}>{event.type}</span>
                  <span className="block text-sm leading-6 text-slate-300">{event.message}</span>
                </span>
                <span className="ml-auto shrink-0 text-xs text-forge-muted">#{event.sequence}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function getSelectedEntity(snapshot: ForgeSnapshot, selected: Selection | null) {
  if (!selected || selected.type === "forge") {
    return {
      label: "Forge",
      title: snapshot.forge.name,
      description: snapshot.forge.tagline,
      progress: deriveForgeMetrics(snapshot).progress,
      status: undefined,
      stats: [
        { label: "Phase", value: snapshot.forge.activePhase },
        { label: "Events", value: snapshot.lastEventSequence }
      ],
      sections: [{ title: "Operating Model", items: ["Server-authoritative snapshot plus append-only runtime events.", "Mock workers emit the same event surface planned for Nemoclaw."] }],
      links: [] as Selection[]
    };
  }

  if (selected.type === "division") {
    const division = snapshot.divisions.find((item) => item.id === selected.id);
    const workers = snapshot.workers.filter((worker) => worker.divisionId === selected.id);
    return entity("Division", division?.name, division?.objective, division?.status, division?.progress, [
      { label: "Workers", value: workers.length },
      { label: "Operations", value: snapshot.operations.filter((operation) => operation.divisionId === selected.id).length }
    ], [{ title: "Assigned Workers", items: workers.map((worker) => `${worker.name}: ${worker.currentTask}`) }], workers.map((worker) => ({ type: "worker", id: worker.id } as Selection)));
  }

  if (selected.type === "worker") {
    const worker = snapshot.workers.find((item) => item.id === selected.id);
    return entity("Worker", worker?.name, worker?.role, worker?.status, undefined, [
      { label: "Division", value: snapshot.divisions.find((division) => division.id === worker?.divisionId)?.name ?? "Unknown" },
      { label: "Current", value: worker?.currentTask ?? "Idle" }
    ], [
      { title: "Context Manifest", items: worker ? [worker.contextManifest.objective, ...worker.contextManifest.instructionSources, ...worker.contextManifest.redactions] : [] },
      { title: "Memory", items: worker?.contextManifest.memorySnippets ?? [] }
    ], snapshot.operations.filter((operation) => operation.workerId === worker?.id).map((operation) => ({ type: "operation", id: operation.id } as Selection)));
  }

  if (selected.type === "operation") {
    const operation = snapshot.operations.find((item) => item.id === selected.id);
    const dependencies = snapshot.dependencies.filter((dependency) => dependency.operationId === selected.id);
    return entity("Operation", operation?.title, operation?.description, operation?.status, operation?.progress, [
      { label: "Priority", value: operation?.priority ?? "normal" },
      { label: "Retries", value: operation?.retryCount ?? 0 }
    ], [
      { title: "Blockers", items: operation?.blockedReason ? [operation.blockedReason] : ["No active blocker recorded."] },
      { title: "Dependencies", items: dependencies.map((dependency) => `${dependency.type}: ${dependency.dependsOnOperationId}`) }
    ], operation?.outputArtifactIds.map((id) => ({ type: "artifact", id } as Selection)) ?? []);
  }

  if (selected.type === "artifact") {
    const artifact = snapshot.artifacts.find((item) => item.id === selected.id);
    return entity("Artifact", artifact?.title, artifact?.content, undefined, undefined, [
      { label: "Type", value: artifact?.type ?? "Unknown" },
      { label: "Version", value: artifact?.version ?? 0 }
    ], [{ title: "Tags", items: artifact?.tags ?? [] }], artifact?.fileIds.map((id) => ({ type: "file", id } as Selection)) ?? []);
  }

  if (selected.type === "file") {
    const file = snapshot.files.find((item) => item.id === selected.id);
    return entity("Virtual File", file?.path, file?.content, undefined, undefined, [
      { label: "Status", value: file?.status ?? "Unknown" },
      { label: "Version", value: file?.version ?? 0 }
    ], [{ title: "Provenance", items: [`Division: ${file?.divisionId ?? "unknown"}`, `Worker: ${file?.workerId ?? "unknown"}`, "Source: virtual workspace store"] }], file?.artifactIds.map((id) => ({ type: "artifact", id } as Selection)) ?? []);
  }

  const handoff = snapshot.handoffs.find((item) => item.id === selected.id);
  return entity("Handoff", "Division Handoff", handoff?.summary, undefined, handoff?.confidence, [
    { label: "From", value: handoff?.fromDivisionId ?? "Unknown" },
    { label: "To", value: handoff?.toDivisionId ?? "Unknown" }
  ], [
    { title: "Deliverables", items: handoff?.deliverables ?? [] },
    { title: "Required Context", items: handoff?.requiredContext ?? [] }
  ], []);
}

function entity(
  label: string,
  title = "Unknown",
  description = "No details available.",
  status?: RuntimeStatus,
  progress?: number,
  stats: { label: string; value: string | number }[] = [],
  sections: { title: string; items: string[] }[] = [],
  links: Selection[] = []
) {
  return { label, title, description, status, progress, stats, sections, links };
}

function PanelTitle({ icon: Icon, title, action }: { icon: typeof Activity; title: string; action: string }) {
  return (
    <div className="flex h-[57px] items-center justify-between border-b border-forge-line px-4">
      <div className="flex items-center gap-2 font-semibold text-white">
        <Icon className="h-4 w-4 text-forge-cyan" />
        {title}
      </div>
      <span className="rounded border border-forge-line px-2 py-1 text-xs text-forge-muted">{action}</span>
    </div>
  );
}

function Progress({ value, compact = false }: { value: number; compact?: boolean }) {
  return (
    <div className={compact ? "mt-2" : "mt-4"}>
      <div className={`overflow-hidden rounded bg-black/40 ${compact ? "h-1.5" : "h-2"}`}>
        <div className="h-full rounded bg-forge-cyan" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: RuntimeStatus }) {
  return <span className={`shrink-0 rounded border px-2 py-1 text-xs ${statusClass(status)}`}>{status}</span>;
}

function IconButton({ label, icon: Icon, disabled, onClick }: { label: string; icon: typeof Play; disabled: boolean; onClick: () => void }) {
  return (
    <button className="flex items-center justify-center gap-2 rounded border border-forge-line px-2 py-2 text-sm text-slate-200 hover:border-forge-cyan disabled:opacity-60" disabled={disabled} onClick={onClick}>
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );
}

function nodeClass(active: boolean) {
  return `flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition ${
    active ? "border-forge-cyan bg-forge-cyan/10 text-white" : "border-forge-line bg-black/20 text-slate-200 hover:border-forge-cyan"
  }`;
}
