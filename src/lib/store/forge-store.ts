"use client";

import { create } from "zustand";
import type { ForgeSnapshot, RuntimeCommand, RuntimeEvent } from "@/lib/runtime/types";
import { deriveForgeMetrics } from "@/lib/runtime/metrics";

export type Selection =
  | { type: "forge"; id: string }
  | { type: "division"; id: string }
  | { type: "worker"; id: string }
  | { type: "operation"; id: string }
  | { type: "artifact"; id: string }
  | { type: "file"; id: string }
  | { type: "handoff"; id: string };

interface ForgeStore {
  snapshot: ForgeSnapshot | null;
  selected: Selection | null;
  activePanel: "overview" | "files" | "artifacts" | "logs";
  inspectorTab: "summary" | "context" | "artifacts" | "logs" | "dependencies";
  commandPending: boolean;
  commandError: string | null;
  hydrate: (snapshot: ForgeSnapshot) => void;
  connectEventStream: (forgeSlug?: string, lastSequence?: number) => () => void;
  selectNode: (selection: Selection) => void;
  setPanel: (panel: ForgeStore["activePanel"]) => void;
  setInspectorTab: (tab: ForgeStore["inspectorTab"]) => void;
  runCommand: (command: RuntimeCommand) => Promise<void>;
}

export const useForgeStore = create<ForgeStore>((set, get) => ({
  snapshot: null,
  selected: null,
  activePanel: "overview",
  inspectorTab: "summary",
  commandPending: false,
  commandError: null,
  hydrate: (snapshot) =>
    set((state) => {
      if (state.snapshot?.forge.id && state.snapshot.forge.id !== snapshot.forge.id) {
        return { snapshot, selected: { type: "forge", id: snapshot.forge.id }, commandError: null };
      }

      if (state.snapshot?.forge.slug && state.snapshot.forge.slug !== snapshot.forge.slug) {
        return { snapshot, selected: { type: "forge", id: snapshot.forge.id }, commandError: null };
      }

      if (state.snapshot && state.snapshot.lastEventSequence > snapshot.lastEventSequence) {
        return { selected: state.selected ?? { type: "forge", id: state.snapshot.forge.id } };
      }

      return { snapshot, selected: state.selected ?? { type: "forge", id: snapshot.forge.id } };
    }),
  connectEventStream: (forgeSlug, lastSequence) => connectRuntimeEventStream(set, forgeSlug, lastSequence ?? get().snapshot?.lastEventSequence ?? 0),
  selectNode: (selected) => set({ selected }),
  setPanel: (activePanel) => set({ activePanel }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  runCommand: async (command) => {
    set({ commandPending: true, commandError: null });
    try {
      const forgeSlug = getCurrentPageForgeSlug() ?? get().snapshot?.forge.slug;
      if (!forgeSlug) {
        set({ commandError: "Runtime command failed: no Forge is selected.", commandPending: false });
        return;
      }

      const response = await fetch(`/api/forges/${forgeSlug}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...command, idempotencyKey: `${command.type}-${Date.now()}` })
      });
      const payload = (await response.json().catch(() => null)) as { success?: boolean; data?: ForgeSnapshot; error?: string } | null;
      if (payload?.success && payload.data) {
        set({ snapshot: payload.data });
        scheduleSnapshotRefresh(set, forgeSlug, payload.data.lastEventSequence);
      } else if (payload?.success) {
        scheduleSnapshotRefresh(set, forgeSlug, get().snapshot?.lastEventSequence ?? 0);
      } else {
        set({ commandError: payload?.error ?? `Runtime command failed with HTTP ${response.status}.` });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown client error";
      set({ commandError: `Runtime command failed: ${detail}` });
    } finally {
      set({ commandPending: false });
    }
  }
}));

export function selectMetrics(snapshot: ForgeSnapshot | null) {
  return snapshot ? deriveForgeMetrics(snapshot) : null;
}

let eventSource: EventSource | null = null;
let eventSourceSlug: string | null = null;
let subscribers = 0;
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function connectRuntimeEventStream(
  set: (partial: Partial<ForgeStore> | ((state: ForgeStore) => Partial<ForgeStore>)) => void,
  forgeSlug: string | undefined,
  lastSequence: number
) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  subscribers += 1;

  const resolvedForgeSlug = forgeSlug ?? useForgeStore.getState().snapshot?.forge.slug;
  if (!resolvedForgeSlug) {
    return () => {
      subscribers = Math.max(0, subscribers - 1);
    };
  }

  if (eventSource && eventSourceSlug !== resolvedForgeSlug) {
    eventSource.close();
    eventSource = null;
    eventSourceSlug = null;
  }

  if (!eventSource) {
    eventSourceSlug = resolvedForgeSlug;
    eventSource = new EventSource(`/api/forges/${resolvedForgeSlug}/events/stream?afterSequence=${lastSequence}`);
    eventSource.addEventListener("open", () => {
      scheduleSnapshotRefresh(set, resolvedForgeSlug, useForgeStore.getState().snapshot?.lastEventSequence ?? lastSequence);
    });
    eventSource.addEventListener("error", () => {
      scheduleSnapshotRefresh(set, resolvedForgeSlug, useForgeStore.getState().snapshot?.lastEventSequence ?? lastSequence);
    });
    eventSource.addEventListener("runtime.event", (message) => {
      const event = JSON.parse(message.data) as RuntimeEvent;
      scheduleSnapshotRefresh(set, resolvedForgeSlug, event.sequence);
    });
  }

  return () => {
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0 && eventSource) {
      eventSource.close();
      eventSource = null;
      eventSourceSlug = null;
    }
    if (subscribers === 0) {
      for (const timer of refreshTimers.values()) {
        clearTimeout(timer);
      }
      refreshTimers.clear();
    }
  };
}

function getCurrentPageForgeSlug() {
  if (typeof window === "undefined") {
    return undefined;
  }

  const match = window.location.pathname.match(/^\/forge\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function scheduleSnapshotRefresh(
  set: (partial: Partial<ForgeStore> | ((state: ForgeStore) => Partial<ForgeStore>)) => void,
  forgeSlug: string,
  eventSequence: number
) {
  const currentTimer = refreshTimers.get(forgeSlug);
  if (currentTimer) {
    clearTimeout(currentTimer);
  }

  refreshTimers.set(
    forgeSlug,
    setTimeout(async () => {
      refreshTimers.delete(forgeSlug);
      let payload: { success: boolean; data?: ForgeSnapshot; error?: string } | null = null;
      try {
        const response = await fetch(`/api/forges/${forgeSlug}/snapshot`, { cache: "no-store" });
        payload = (await response.json()) as { success: boolean; data?: ForgeSnapshot; error?: string };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown client error";
        set({ commandError: `Snapshot refresh failed: ${detail}` });
        return;
      }

      if (!payload.success || !payload.data) {
        set({ commandError: `Snapshot refresh failed: ${payload.error ?? "snapshot response was invalid."}` });
        return;
      }

      set((state) => {
        if (state.snapshot && state.snapshot.lastEventSequence > payload.data!.lastEventSequence) {
          return {};
        }
        if (state.snapshot && state.snapshot.lastEventSequence >= eventSequence && state.snapshot.lastEventSequence >= payload.data!.lastEventSequence) {
          return {};
        }
        return { snapshot: payload.data, commandError: null };
      });
    }, 150)
  );
}
