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
  connectEventStream: () => () => void;
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
      if (state.snapshot && state.snapshot.lastEventSequence > snapshot.lastEventSequence) {
        return { selected: state.selected ?? { type: "forge", id: state.snapshot.forge.id } };
      }

      return { snapshot, selected: state.selected ?? { type: "forge", id: snapshot.forge.id } };
    }),
  connectEventStream: () => connectRuntimeEventStream(set, () => get().snapshot?.lastEventSequence ?? 0),
  selectNode: (selected) => set({ selected }),
  setPanel: (activePanel) => set({ activePanel }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  runCommand: async (command) => {
    set({ commandPending: true, commandError: null });
    try {
      const response = await fetch("/api/runtime/commands", {
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
let subscribers = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function connectRuntimeEventStream(
  set: (partial: Partial<ForgeStore> | ((state: ForgeStore) => Partial<ForgeStore>)) => void,
  getLastSequence: () => number
) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  subscribers += 1;

  if (!eventSource) {
    eventSource = new EventSource(`/api/forge/current/events/stream?afterSequence=${getLastSequence()}`);
    eventSource.addEventListener("runtime.event", (message) => {
      const event = JSON.parse(message.data) as RuntimeEvent;
      scheduleSnapshotRefresh(set, event.sequence);
    });
  }

  return () => {
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0 && eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (subscribers === 0 && refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  };
}

function scheduleSnapshotRefresh(
  set: (partial: Partial<ForgeStore> | ((state: ForgeStore) => Partial<ForgeStore>)) => void,
  eventSequence: number
) {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    const response = await fetch("/api/forge/current/snapshot", { cache: "no-store" });
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
