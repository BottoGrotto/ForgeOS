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
        set({ commandError: "Runtime command failed.", commandPending: false });
        return;
      }

      const response = await fetch(`/api/forges/${forgeSlug}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...command, idempotencyKey: `${command.type}-${Date.now()}` })
      });
      const payload = (await response.json()) as { success: boolean; data?: ForgeSnapshot; error?: string };
      if (payload.success && payload.data) {
        set({ snapshot: payload.data });
      } else {
        set({ commandError: payload.error ?? "Runtime command failed." });
      }
    } catch {
      set({ commandError: "Runtime command failed." });
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
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (subscribers === 0 && refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
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
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    const response = await fetch(`/api/forges/${forgeSlug}/snapshot`, { cache: "no-store" });
    const payload = (await response.json()) as { success: boolean; data?: ForgeSnapshot };
    if (!payload.success || !payload.data) {
      return;
    }

    set((state) => {
      if (state.snapshot && state.snapshot.lastEventSequence > payload.data!.lastEventSequence) {
        return {};
      }
      if (state.snapshot && state.snapshot.lastEventSequence >= eventSequence && state.snapshot.lastEventSequence >= payload.data!.lastEventSequence) {
        return {};
      }
      return { snapshot: payload.data };
    });
  }, 150);
}
