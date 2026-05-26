"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, BarChart3, Boxes, Database, Plus, Settings2, Trash2 } from "lucide-react";
import type { ForgeSummary } from "@/lib/runtime/persistence";

interface RuntimeStorageInfo {
  mode: "memory" | "file" | "database";
  resettable: boolean;
  visible: boolean;
}

export function ForgesIndex({ forges, storageInfo }: { forges: ForgeSummary[]; storageInfo: RuntimeStorageInfo }) {
  const router = useRouter();
  const [currentForges, setCurrentForges] = useState(forges);
  const [pending, setPending] = useState(false);
  const [clearPending, setClearPending] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedSlugs, setSelectedSlugs] = useState<string[]>([]);
  const [manageMode, setManageMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const selectedCount = selectedSlugs.length;
  const allSelected = currentForges.length > 0 && selectedCount === currentForges.length;

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!clearDialogOpen && !deleteDialogOpen) {
      return;
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setClearDialogOpen(false);
        setDeleteDialogOpen(false);
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [clearDialogOpen, deleteDialogOpen]);

  async function createForge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedName = new FormData(event.currentTarget).get("forgeName");
    const trimmed = (typeof submittedName === "string" ? submittedName : "").trim();
    if (!trimmed) {
      setError("Forge name is required.");
      return;
    }

    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/forges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed })
      });
      const payload = (await response.json()) as { success: boolean; data?: { forge: { slug: string } }; error?: string };
      if (!payload.success || !payload.data) {
        setError(payload.error ?? "Forge creation failed.");
        return;
      }
      router.push(`/forge/${payload.data.forge.slug}`);
    } catch {
      setError("Forge creation failed.");
    } finally {
      setPending(false);
    }
  }

  async function clearLocalForges() {
    if (!storageInfo.resettable) {
      return;
    }

    setClearPending(true);
    setError(null);
    try {
      const response = await fetch("/api/dev/runtime-store", { method: "DELETE" });
      const payload = (await response.json()) as { success: boolean; data?: { forges: ForgeSummary[] }; error?: string };
      if (!payload.success || !payload.data) {
        setError(payload.error ?? "Development Forge storage reset failed.");
        return;
      }
      setCurrentForges(payload.data.forges);
      setSelectedSlugs([]);
      setClearDialogOpen(false);
      router.refresh();
    } catch {
      setError("Development Forge storage reset failed.");
    } finally {
      setClearPending(false);
    }
  }

  async function deleteSelectedForges() {
    if (selectedSlugs.length === 0) {
      return;
    }

    setDeletePending(true);
    setError(null);
    try {
      const response = await fetch("/api/forges", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slugs: selectedSlugs })
      });
      const payload = (await response.json()) as { success: boolean; data?: { deletedSlugs: string[]; forges: ForgeSummary[] }; error?: string };
      if (!payload.success || !payload.data) {
        setError(payload.error ?? "Selected Forge deletion failed.");
        return;
      }
      setCurrentForges(payload.data.forges);
      setSelectedSlugs([]);
      setDeleteDialogOpen(false);
      router.refresh();
    } catch {
      setError("Selected Forge deletion failed.");
    } finally {
      setDeletePending(false);
    }
  }

  function toggleForge(slug: string, checked: boolean) {
    setSelectedSlugs((current) => (checked ? Array.from(new Set([...current, slug])) : current.filter((item) => item !== slug)));
  }

  function toggleAll(checked: boolean) {
    setSelectedSlugs(checked ? currentForges.map((forge) => forge.slug) : []);
  }

  function toggleManageMode() {
    if (manageMode) {
      setSelectedSlugs([]);
      setClearDialogOpen(false);
      setDeleteDialogOpen(false);
    }
    setManageMode(!manageMode);
  }

  return (
    <main className="min-h-screen bg-forge-bg text-forge-text">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 px-4 py-6 lg:px-6">
        <header className="rounded-lg border border-forge-line bg-forge-panel p-5 shadow-command">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-sm text-forge-muted">ForgeOS</div>
              <h1 className="mt-2 text-3xl font-semibold text-white">Start a Project</h1>
              <p className="mt-1 text-sm text-forge-muted">Create a workspace, open the command deck, and send the team into the operation queue.</p>
            </div>
            <Link href="/usage" className="flex items-center justify-center gap-2 rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan">
              <BarChart3 className="h-4 w-4" />
              Usage
            </Link>
            <form onSubmit={createForge} className="grid w-full gap-2 sm:grid-cols-[minmax(0,1fr)_auto] lg:max-w-xl">
              <label className="sr-only" htmlFor="forgeName">Project name</label>
              <input
                id="forgeName"
                name="forgeName"
                placeholder="Project name"
                className="min-w-0 rounded border border-forge-line bg-black/30 px-3 py-2 text-sm text-white outline-none transition focus:border-forge-cyan focus:ring-2 focus:ring-forge-cyan/20"
              />
              <button
                type="submit"
                disabled={pending || !hydrated}
                className="flex items-center justify-center gap-2 rounded bg-forge-cyan px-4 py-2 text-sm font-semibold text-black transition hover:bg-cyan-300 disabled:opacity-60"
              >
                <Plus className="h-4 w-4" />
                Start Project
              </button>
              {error ? <div className="sm:col-span-2 rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{error}</div> : null}
            </form>
          </div>
        </header>
        {manageMode && storageInfo.visible ? (
          <section className="rounded-lg border border-forge-line bg-forge-panel p-4 shadow-command">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <Database className="h-5 w-5 shrink-0 text-forge-cyan" />
                <div className="min-w-0">
                  <h2 className="font-semibold text-white">Development Storage</h2>
                  <div className="mt-1 text-sm text-forge-muted">
                    {storageInfo.mode === "file" ? "File-backed local runtime" : storageInfo.mode === "database" ? "Database-backed runtime" : `${storageInfo.mode} runtime`}
                  </div>
                </div>
              </div>
              <button
                type="button"
                disabled={!storageInfo.resettable || clearPending || currentForges.length === 0}
                onClick={() => setClearDialogOpen(true)}
                className="flex items-center justify-center gap-2 rounded border border-red-400/40 px-3 py-2 text-sm text-red-100 hover:border-red-200 disabled:opacity-60"
              >
                <Trash2 className="h-4 w-4" />
                Clear Development State
              </button>
            </div>
          </section>
        ) : null}
        <section className="rounded-lg border border-forge-line bg-forge-panel shadow-command">
          <div className="flex min-h-[56px] flex-col gap-3 border-b border-forge-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <h2 className="font-semibold text-white">Projects</h2>
              <span className="rounded border border-forge-line px-2 py-1 text-xs text-forge-muted">{currentForges.length} active</span>
              {manageMode && currentForges.length > 0 ? (
                <label className="flex items-center gap-2 text-xs text-forge-muted">
                  <input type="checkbox" checked={allSelected} onChange={(event) => toggleAll(event.currentTarget.checked)} className="h-4 w-4 rounded border-forge-line bg-black/30" />
                  Select all
                </label>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {manageMode ? (
                <button
                  type="button"
                  disabled={selectedCount === 0 || deletePending}
                  onClick={() => setDeleteDialogOpen(true)}
                  className="flex items-center justify-center gap-2 rounded border border-red-400/40 px-3 py-2 text-sm text-red-100 hover:border-red-200 disabled:opacity-60"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete selected {selectedCount > 0 ? `(${selectedCount})` : ""}
                </button>
              ) : null}
              <button
                type="button"
                onClick={toggleManageMode}
                disabled={!hydrated}
                className={`flex items-center justify-center gap-2 rounded border px-3 py-2 text-sm ${
                  manageMode ? "border-forge-cyan bg-forge-cyan/10 text-white" : "border-forge-line text-slate-200 hover:border-forge-cyan"
                } disabled:opacity-60`}
                aria-pressed={manageMode}
              >
                <Settings2 className="h-4 w-4" />
                {manageMode ? "Done" : "Manage"}
              </button>
            </div>
          </div>
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {currentForges.length > 0 ? currentForges.map((forge) => (
              <div key={forge.id} className={`group rounded-lg border bg-black/20 p-4 transition hover:-translate-y-0.5 hover:border-forge-cyan hover:bg-forge-cyan/10 hover:shadow-[0_0_0_1px_rgba(34,211,238,0.18),0_14px_32px_rgba(34,211,238,0.08)] ${selectedSlugs.includes(forge.slug) ? "border-red-300/70" : "border-forge-line"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    {manageMode ? (
                      <input
                        type="checkbox"
                        aria-label={`Select ${forge.name}`}
                        checked={selectedSlugs.includes(forge.slug)}
                        onChange={(event) => toggleForge(forge.slug, event.currentTarget.checked)}
                        className="mt-1 h-4 w-4 shrink-0 rounded border-forge-line bg-black/30"
                      />
                    ) : null}
                    <Link href={`/forge/${forge.slug}`} className="min-w-0">
                      <div className="truncate font-semibold text-white transition group-hover:text-forge-cyan">{forge.name}</div>
                      <div className="mt-1 text-xs text-forge-muted">/{forge.slug}</div>
                    </Link>
                  </div>
                  <Boxes className="h-5 w-5 shrink-0 text-forge-cyan" />
                </div>
                <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-300">{forge.tagline}</p>
                <div className="mt-3 flex items-center justify-between text-xs uppercase text-forge-muted">
                  <span>{forge.activePhase}</span>
                  <Link href={`/forge/${forge.slug}`} className="flex items-center gap-1 text-forge-cyan">Open <ArrowRight className="h-3.5 w-3.5" /></Link>
                </div>
              </div>
            )) : (
              <div className="rounded border border-dashed border-forge-line bg-black/20 p-6 text-sm text-forge-muted md:col-span-2 xl:col-span-3">
                No projects yet. Enter a project name above to create the first command deck.
              </div>
            )}
          </div>
        </section>
      </div>
      {clearDialogOpen ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setClearDialogOpen(false);
            }
          }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="clear-local-state-title" className="w-full max-w-md rounded-lg border border-forge-line bg-forge-panel p-5 shadow-command">
            <h2 id="clear-local-state-title" className="text-lg font-semibold text-white">Clear Development Forge State</h2>
            <p className="mt-3 text-sm leading-6 text-slate-300">This removes every Forge instance from the active development storage backend.</p>
            {error ? <div className="mt-4 rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{error}</div> : null}
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={clearPending}
                onClick={() => setClearDialogOpen(false)}
                className="rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={clearPending}
                onClick={() => void clearLocalForges()}
                className="flex items-center justify-center gap-2 rounded border border-red-400/40 px-3 py-2 text-sm text-red-100 hover:border-red-200 disabled:opacity-60"
              >
                <Trash2 className="h-4 w-4" />
                Clear Development State
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {deleteDialogOpen ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setDeleteDialogOpen(false);
            }
          }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="delete-selected-forges-title" className="w-full max-w-md rounded-lg border border-forge-line bg-forge-panel p-5 shadow-command">
            <h2 id="delete-selected-forges-title" className="text-lg font-semibold text-white">Delete Selected Forges</h2>
            <p className="mt-3 text-sm leading-6 text-slate-300">This removes {selectedCount} selected Forge{selectedCount === 1 ? "" : "s"} from the active storage backend.</p>
            {error ? <div className="mt-4 rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{error}</div> : null}
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={deletePending}
                onClick={() => setDeleteDialogOpen(false)}
                className="rounded border border-forge-line px-3 py-2 text-sm text-slate-200 hover:border-forge-cyan disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletePending || selectedCount === 0}
                onClick={() => void deleteSelectedForges()}
                className="flex items-center justify-center gap-2 rounded border border-red-400/40 px-3 py-2 text-sm text-red-100 hover:border-red-200 disabled:opacity-60"
              >
                <Trash2 className="h-4 w-4" />
                Delete selected
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
