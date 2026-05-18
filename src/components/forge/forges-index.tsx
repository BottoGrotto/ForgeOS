"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Boxes, Plus } from "lucide-react";
import type { ForgeSummary } from "@/lib/runtime/persistence";

export function ForgesIndex({ forges }: { forges: ForgeSummary[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createForge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
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

  return (
    <main className="min-h-screen bg-forge-bg text-forge-text">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 px-4 py-6 lg:px-6">
        <header className="rounded-lg border border-forge-line bg-forge-panel p-5 shadow-command">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-sm text-forge-muted">ForgeOS</div>
              <h1 className="mt-2 text-3xl font-semibold text-white">Forges</h1>
              <p className="mt-1 text-sm text-forge-muted">Create and open isolated autonomous organization runtimes.</p>
            </div>
            <form onSubmit={createForge} className="grid w-full gap-2 sm:grid-cols-[minmax(0,1fr)_auto] lg:max-w-xl">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="New Forge name"
                className="min-w-0 rounded border border-forge-line bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-forge-cyan"
              />
              <button
                type="submit"
                disabled={pending}
                className="flex items-center justify-center gap-2 rounded bg-forge-cyan px-4 py-2 text-sm font-semibold text-black disabled:opacity-60"
              >
                <Plus className="h-4 w-4" />
                Create Forge
              </button>
              {error ? <div className="sm:col-span-2 rounded border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{error}</div> : null}
            </form>
          </div>
        </header>
        <section className="rounded-lg border border-forge-line bg-forge-panel shadow-command">
          <div className="flex min-h-[56px] items-center justify-between border-b border-forge-line px-4">
            <h2 className="font-semibold text-white">Active Forge Instances</h2>
            <span className="rounded border border-forge-line px-2 py-1 text-xs text-forge-muted">{forges.length} active</span>
          </div>
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {forges.length > 0 ? forges.map((forge) => (
              <Link key={forge.id} href={`/forge/${forge.slug}`} className="rounded-lg border border-forge-line bg-black/20 p-4 hover:border-forge-cyan">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-white">{forge.name}</div>
                    <div className="mt-1 text-xs text-forge-muted">/{forge.slug}</div>
                  </div>
                  <Boxes className="h-5 w-5 shrink-0 text-forge-cyan" />
                </div>
                <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-300">{forge.tagline}</p>
                <div className="mt-3 flex items-center justify-between text-xs uppercase text-forge-muted">
                  <span>{forge.activePhase}</span>
                  <span>{forge.status}</span>
                </div>
              </Link>
            )) : (
              <div className="rounded border border-dashed border-forge-line p-6 text-sm text-forge-muted md:col-span-2 xl:col-span-3">
                No Forge instances exist yet.
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
