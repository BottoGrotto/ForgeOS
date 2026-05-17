import type { ForgeSnapshot, RuntimeEvent } from "./types";

export interface RuntimePersistence {
  loadSnapshot(): Promise<ForgeSnapshot | null>;
  saveSnapshot(snapshot: ForgeSnapshot): Promise<void>;
  resetSnapshot(snapshot: ForgeSnapshot): Promise<void>;
  getEvents(forgeId: string, afterSequence: number): Promise<RuntimeEvent[]>;
  hasIdempotencyKey(key: string): Promise<boolean>;
  recordIdempotencyKey(key: string): Promise<void>;
}

export class InMemoryRuntimePersistence implements RuntimePersistence {
  private snapshot: ForgeSnapshot | null;
  private readonly appliedKeys = new Set<string>();

  constructor(initialSnapshot?: ForgeSnapshot) {
    this.snapshot = initialSnapshot ? structuredClone(initialSnapshot) : null;
  }

  async loadSnapshot() {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  async saveSnapshot(snapshot: ForgeSnapshot) {
    this.snapshot = structuredClone(snapshot);
  }

  async resetSnapshot(snapshot: ForgeSnapshot) {
    this.snapshot = structuredClone(snapshot);
    this.appliedKeys.clear();
  }

  async getEvents(_forgeId: string, afterSequence: number) {
    return (this.snapshot?.events ?? []).filter((event) => event.sequence > afterSequence);
  }

  async hasIdempotencyKey(key: string) {
    return this.appliedKeys.has(key);
  }

  async recordIdempotencyKey(key: string) {
    this.appliedKeys.add(key);
  }
}
