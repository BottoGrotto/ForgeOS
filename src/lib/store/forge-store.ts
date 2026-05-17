"use client";

import { create } from "zustand";
import type { ForgeSnapshot, RuntimeCommand } from "@/lib/runtime/types";
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
  selectNode: (selection: Selection) => void;
  setPanel: (panel: ForgeStore["activePanel"]) => void;
  setInspectorTab: (tab: ForgeStore["inspectorTab"]) => void;
  runCommand: (command: RuntimeCommand) => Promise<void>;
}

export const useForgeStore = create<ForgeStore>((set) => ({
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
