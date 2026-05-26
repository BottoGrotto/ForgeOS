"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type PointerEvent } from "react";
import { Activity, ArrowLeft, BarChart3, Boxes, FileText, Gauge, GitBranch, LayoutDashboard, Network, Paintbrush, Replace, ShieldCheck, Users, X } from "lucide-react";
import type { ForgeSummary } from "@/lib/runtime/persistence";
import type { ForgeSnapshot, RuntimeStatus } from "@/lib/runtime/types";
import { deriveForgeMetrics } from "@/lib/runtime/metrics";
import { statusClass } from "./status";

const navItems = [
  { path: "", label: "Overview", icon: LayoutDashboard },
  { path: "/org", label: "Organization", icon: Network },
  { path: "/operations", label: "Operations", icon: GitBranch },
  { path: "/workspace", label: "Workspace", icon: FileText },
  { path: "/assets", label: "Assets", icon: Boxes },
  { path: "/logs", label: "Logs", icon: Activity }
];

const visualModes = [
  { value: "default", label: "Default Theme" },
  { value: "colorful", label: "Color Theme" },
  { value: "hacker", label: "Hacker Theme" },
  { value: "top-secret", label: "Top Secret Mode" }
] as const;

type VisualMode = (typeof visualModes)[number]["value"];

export function ForgeShell({ snapshot, children }: { snapshot: ForgeSnapshot; children: React.ReactNode }) {
  const pathname = usePathname();
  const metrics = deriveForgeMetrics(snapshot);
  const basePath = `/forge/${snapshot.forge.slug}`;
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [visualMode, setVisualMode] = useState<VisualMode>("default");

  useEffect(() => {
    const savedMode = window.localStorage.getItem("forgeos:visual-mode");
    if (isVisualMode(savedMode)) {
      setVisualMode(savedMode);
    }
  }, []);

  function selectVisualMode(next: VisualMode) {
    setVisualMode(next);
    window.localStorage.setItem("forgeos:visual-mode", next);
  }

  function cycleVisualMode() {
    const currentIndex = visualModes.findIndex((mode) => mode.value === visualMode);
    const nextMode = visualModes[(currentIndex + 1) % visualModes.length];
    selectVisualMode(nextMode.value);
  }

  function updateTopSecretPointer(event: PointerEvent<HTMLElement>) {
    if (visualMode !== "top-secret") {
      return;
    }
    event.currentTarget.style.setProperty("--secret-x", `${event.clientX}px`);
    event.currentTarget.style.setProperty("--secret-y", `${event.clientY}px`);
  }

  const activeVisualMode = visualModes.find((mode) => mode.value === visualMode) ?? visualModes[0];

  return (
    <main
      className={`min-h-screen bg-forge-bg text-forge-text ${visualMode === "colorful" ? "forge-colorful" : ""} ${visualMode === "hacker" ? "forge-hacker" : ""} ${
        visualMode === "top-secret" ? "forge-top-secret" : ""
      }`}
      onPointerMove={updateTopSecretPointer}
    >
      <div className="mx-auto flex min-h-screen w-full max-w-[1680px] flex-col gap-4 px-4 py-4 lg:px-6">
        <header className="forge-shell-header rounded-lg border border-forge-line bg-forge-panel shadow-command">
          <div className="flex flex-col gap-4 border-b border-forge-line p-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="text-sm text-forge-muted">Forge Command Center / {snapshot.forge.activePhase}</div>
              <h1 className="mt-2 text-3xl font-semibold text-white">{snapshot.forge.name}</h1>
              <p className="mt-1 text-sm text-forge-muted">{snapshot.forge.tagline}</p>
            </div>
            <div className="w-full max-w-2xl">
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-forge-muted">Global Forge Progress</span>
                <span className="font-semibold text-white">{metrics.progress}%</span>
              </div>
              <Progress value={metrics.progress} />
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Link
                  href="/forges"
                  className="flex items-center gap-2 rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Forges
                </Link>
                <Link
                  href="/usage"
                  className="flex items-center gap-2 rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan"
                >
                  <BarChart3 className="h-4 w-4" />
                  Usage
                </Link>
                <button
                  type="button"
                  className="flex items-center gap-2 rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan"
                  onClick={() => setSwitcherOpen(true)}
                >
                  <Replace className="h-4 w-4" />
                  Switch Forge
                </button>
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2 px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
            <nav className="forge-section-nav scrollbar flex gap-2 overflow-x-auto rounded border p-1">
              {navItems.map((item) => {
                const href = `${basePath}${item.path}`;
                const active = pathname === href;
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`forge-section-nav-item flex shrink-0 items-center gap-2 rounded border px-3 py-2 text-sm transition-colors ${
                      active ? "forge-section-nav-item-active" : "forge-section-nav-item-idle"
                    }`}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="flex shrink-0 items-center justify-end gap-2 text-xs text-forge-muted">
              <span>Preferences</span>
              <button
                type="button"
                className="flex items-center gap-2 rounded border border-forge-line px-2.5 py-1.5 text-xs text-slate-300 hover:border-forge-cyan hover:text-white"
                onClick={cycleVisualMode}
                aria-label={`Theme selector: ${activeVisualMode.label}`}
                aria-pressed={visualMode !== "default"}
              >
                <Paintbrush className="h-3.5 w-3.5" />
                {activeVisualMode.label}
              </button>
            </div>
          </div>
        </header>
        {children}
      </div>
      {switcherOpen ? <ForgeSwitcherModal currentSlug={snapshot.forge.slug} onClose={() => setSwitcherOpen(false)} /> : null}
    </main>
  );
}

function isVisualMode(value: string | null): value is VisualMode {
  return visualModes.some((mode) => mode.value === value);
}

function ForgeSwitcherModal({ currentSlug, onClose }: { currentSlug: string; onClose: () => void }) {
  const [forges, setForges] = useState<ForgeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadForges() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/forges", { cache: "no-store" });
        const payload = (await response.json()) as { success: boolean; data?: { forges: ForgeSummary[] }; error?: string };
        if (!active) {
          return;
        }
        if (!payload.success || !payload.data) {
          setError(payload.error ?? "Forge list failed.");
          return;
        }
        setForges(payload.data.forges);
      } catch {
        if (active) {
          setError("Forge list failed.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadForges();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="forge-switcher-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-2xl rounded-lg border border-forge-line bg-forge-panel shadow-command">
        <div className="flex items-center justify-between border-b border-forge-line px-4 py-3">
          <div>
            <h2 id="forge-switcher-title" className="font-semibold text-white">Switch Forge</h2>
            <div className="mt-1 text-sm text-forge-muted">Open another active Forge instance.</div>
          </div>
          <button type="button" className="rounded border border-forge-line p-2 text-forge-muted hover:border-forge-cyan hover:text-white" onClick={onClose} aria-label="Close switcher">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="scrollbar max-h-[60vh] overflow-auto p-4">
          {loading ? <EmptyState text="Loading Forge instances." /> : null}
          {error ? <div className="rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{error}</div> : null}
          {!loading && !error ? (
            <div className="space-y-2">
              {forges.map((forge) => {
                const current = forge.slug === currentSlug;
                return (
                  <Link
                    key={forge.id}
                    href={`/forge/${forge.slug}`}
                    className={`block rounded border p-3 hover:border-forge-cyan ${current ? "border-forge-cyan bg-forge-cyan/10" : "border-forge-line bg-black/20"}`}
                    onClick={onClose}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-white">{forge.name}</div>
                        <div className="mt-1 text-xs text-forge-muted">/{forge.slug}</div>
                      </div>
                      <span className="shrink-0 rounded border border-forge-line px-2 py-1 text-xs text-forge-muted">{current ? "current" : forge.status}</span>
                    </div>
                    <div className="mt-3 text-sm text-slate-300">{forge.activePhase}</div>
                  </Link>
                );
              })}
              {forges.length === 0 ? <EmptyState text="No Forge instances exist yet." /> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function MetricsGrid({ snapshot }: { snapshot: ForgeSnapshot }) {
  const metrics = deriveForgeMetrics(snapshot);
  const items = [
    { label: "Active Workers", value: metrics.activeWorkers, icon: Users },
    { label: "Active Operations", value: metrics.activeOperations, icon: Activity },
    { label: "Blocked", value: metrics.blockedOperations, icon: ShieldCheck },
    { label: "Assets", value: metrics.generatedAssets, icon: Boxes },
    { label: "Readiness", value: `${metrics.deploymentReadiness}%`, icon: Gauge },
    { label: "Stability", value: `${metrics.runtimeStability}%`, icon: ShieldCheck }
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border border-forge-line bg-forge-panel p-4 shadow-command">
          <div className="flex items-center justify-between text-forge-muted">
            <span className="text-xs uppercase">{item.label}</span>
            <item.icon className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-semibold text-white">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

export function Panel({ title, action, children, className = "" }: { title: string; action?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`forge-panel-shell rounded-lg border border-forge-line bg-forge-panel shadow-command ${className}`}>
      <div className="flex min-h-[56px] items-center justify-between border-b border-forge-line px-4">
        <h2 className="font-semibold text-white">{title}</h2>
        {action ? <span className="rounded border border-forge-line px-2 py-1 text-xs text-forge-muted">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function Progress({ value, compact = false }: { value: number; compact?: boolean }) {
  return (
    <div className={compact ? "mt-2" : ""}>
      <div className={`overflow-hidden rounded bg-black/40 ${compact ? "h-1.5" : "h-3"}`}>
        <div className="h-full rounded bg-forge-cyan" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: RuntimeStatus }) {
  return <span className={`shrink-0 rounded border px-2 py-1 text-xs ${statusClass(status)}`}>{status}</span>;
}

export function EmptyState({ text }: { text: string }) {
  return <div className="rounded border border-dashed border-forge-line p-6 text-sm text-forge-muted">{text}</div>;
}
