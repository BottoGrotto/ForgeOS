"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Boxes, FileText, Gauge, GitBranch, LayoutDashboard, Network, ShieldCheck, Users } from "lucide-react";
import type { ForgeSnapshot, RuntimeStatus } from "@/lib/runtime/types";
import { deriveForgeMetrics } from "@/lib/runtime/metrics";
import { statusClass } from "./status";

const navItems = [
  { href: "/forge/demo", label: "Overview", icon: LayoutDashboard },
  { href: "/forge/demo/org", label: "Organization", icon: Network },
  { href: "/forge/demo/operations", label: "Operations", icon: GitBranch },
  { href: "/forge/demo/workspace", label: "Workspace", icon: FileText },
  { href: "/forge/demo/assets", label: "Assets", icon: Boxes },
  { href: "/forge/demo/logs", label: "Logs", icon: Activity }
];

export function ForgeShell({ snapshot, children }: { snapshot: ForgeSnapshot; children: React.ReactNode }) {
  const pathname = usePathname();
  const metrics = deriveForgeMetrics(snapshot);

  return (
    <main className="min-h-screen bg-forge-bg text-forge-text">
      <div className="mx-auto flex min-h-screen w-full max-w-[1680px] flex-col gap-4 px-4 py-4 lg:px-6">
        <header className="rounded-lg border border-forge-line bg-forge-panel shadow-command">
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
            </div>
          </div>
          <nav className="scrollbar flex gap-2 overflow-x-auto px-3 py-3">
            {navItems.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex shrink-0 items-center gap-2 rounded border px-3 py-2 text-sm ${
                    active ? "border-forge-cyan bg-forge-cyan/10 text-white" : "border-forge-line text-forge-muted hover:border-forge-cyan"
                  }`}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </header>
        {children}
      </div>
    </main>
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
    <section className={`rounded-lg border border-forge-line bg-forge-panel shadow-command ${className}`}>
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
