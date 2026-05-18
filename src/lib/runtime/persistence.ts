import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ForgeSnapshot, RuntimeEvent } from "./types";

export interface ForgeSummary {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  status: ForgeSnapshot["forge"]["status"];
  activePhase: string;
}

export interface RuntimePersistence {
  listForges(): Promise<ForgeSummary[]>;
  loadSnapshot(forgeSlug: string): Promise<ForgeSnapshot | null>;
  saveSnapshot(snapshot: ForgeSnapshot): Promise<void>;
  resetSnapshot(snapshot: ForgeSnapshot): Promise<void>;
  getEvents(forgeId: string, afterSequence: number): Promise<RuntimeEvent[]>;
  hasIdempotencyKey(forgeId: string, key: string): Promise<boolean>;
  recordIdempotencyKey(forgeId: string, key: string): Promise<void>;
}

export class InMemoryRuntimePersistence implements RuntimePersistence {
  private readonly snapshots = new Map<string, ForgeSnapshot>();
  private readonly appliedKeys = new Set<string>();

  constructor(initialSnapshot?: ForgeSnapshot) {
    if (initialSnapshot) {
      this.snapshots.set(initialSnapshot.forge.slug, structuredClone(initialSnapshot));
    }
  }

  async listForges() {
    return Array.from(this.snapshots.values())
      .filter((snapshot) => snapshot.forge.status !== "archived")
      .map((snapshot) => ({
        id: snapshot.forge.id,
        slug: snapshot.forge.slug,
        name: snapshot.forge.name,
        tagline: snapshot.forge.tagline,
        status: snapshot.forge.status,
        activePhase: snapshot.forge.activePhase
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async loadSnapshot(forgeSlug: string) {
    const snapshot = this.snapshots.get(forgeSlug);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async saveSnapshot(snapshot: ForgeSnapshot) {
    this.snapshots.set(snapshot.forge.slug, structuredClone(snapshot));
  }

  async resetSnapshot(snapshot: ForgeSnapshot) {
    this.snapshots.set(snapshot.forge.slug, structuredClone(snapshot));
    for (const key of this.appliedKeys) {
      if (key.startsWith(`${snapshot.forge.id}:`)) {
        this.appliedKeys.delete(key);
      }
    }
  }

  async getEvents(forgeId: string, afterSequence: number) {
    const snapshot = Array.from(this.snapshots.values()).find((candidate) => candidate.forge.id === forgeId);
    return (snapshot?.events ?? []).filter((event) => event.sequence > afterSequence);
  }

  async hasIdempotencyKey(forgeId: string, key: string) {
    return this.appliedKeys.has(scopedKey(forgeId, key));
  }

  async recordIdempotencyKey(forgeId: string, key: string) {
    this.appliedKeys.add(scopedKey(forgeId, key));
  }
}

interface FileRuntimePersistencePayload {
  snapshots: ForgeSnapshot[];
  appliedKeys: string[];
}

export class FileRuntimePersistence implements RuntimePersistence {
  private loaded = false;
  private readonly snapshots = new Map<string, ForgeSnapshot>();
  private readonly appliedKeys = new Set<string>();
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath = path.join(process.cwd(), ".forgeos", "runtime-store.json")) {}

  async listForges() {
    await this.ensureLoaded();
    return Array.from(this.snapshots.values())
      .filter((snapshot) => snapshot.forge.status !== "archived")
      .map((snapshot) => ({
        id: snapshot.forge.id,
        slug: snapshot.forge.slug,
        name: snapshot.forge.name,
        tagline: snapshot.forge.tagline,
        status: snapshot.forge.status,
        activePhase: snapshot.forge.activePhase
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async loadSnapshot(forgeSlug: string) {
    await this.ensureLoaded();
    const snapshot = this.snapshots.get(forgeSlug);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async saveSnapshot(snapshot: ForgeSnapshot) {
    await this.ensureLoaded();
    this.snapshots.set(snapshot.forge.slug, structuredClone(snapshot));
    await this.persist();
  }

  async resetSnapshot(snapshot: ForgeSnapshot) {
    await this.ensureLoaded();
    this.snapshots.set(snapshot.forge.slug, structuredClone(snapshot));
    for (const key of this.appliedKeys) {
      if (key.startsWith(`${snapshot.forge.id}:`)) {
        this.appliedKeys.delete(key);
      }
    }
    await this.persist();
  }

  async getEvents(forgeId: string, afterSequence: number) {
    await this.ensureLoaded();
    const snapshot = Array.from(this.snapshots.values()).find((candidate) => candidate.forge.id === forgeId);
    return (snapshot?.events ?? []).filter((event) => event.sequence > afterSequence);
  }

  async hasIdempotencyKey(forgeId: string, key: string) {
    await this.ensureLoaded();
    return this.appliedKeys.has(scopedKey(forgeId, key));
  }

  async recordIdempotencyKey(forgeId: string, key: string) {
    await this.ensureLoaded();
    this.appliedKeys.add(scopedKey(forgeId, key));
    await this.persist();
  }

  private async ensureLoaded() {
    if (this.loaded) {
      return;
    }

    try {
      const payload = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<FileRuntimePersistencePayload>;
      for (const snapshot of payload.snapshots ?? []) {
        if (isForgeSnapshot(snapshot)) {
          this.snapshots.set(snapshot.forge.slug, structuredClone(snapshot));
        }
      }
      for (const key of payload.appliedKeys ?? []) {
        if (typeof key === "string") {
          this.appliedKeys.add(key);
        }
      }
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
    }

    this.loaded = true;
  }

  private async persist() {
    const payload: FileRuntimePersistencePayload = {
      snapshots: Array.from(this.snapshots.values()),
      appliedKeys: Array.from(this.appliedKeys)
    };

    const write = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
      await writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
      await rename(tempPath, this.filePath);
    };

    this.writeQueue = this.writeQueue.then(write, write);

    await this.writeQueue;
  }
}

function scopedKey(forgeId: string, key: string) {
  return `${forgeId}:${key}`;
}

function isForgeSnapshot(value: unknown): value is ForgeSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { forge?: { id?: unknown; slug?: unknown; name?: unknown }; events?: unknown };
  return (
    typeof candidate.forge?.id === "string" &&
    typeof candidate.forge.slug === "string" &&
    typeof candidate.forge.name === "string" &&
    Array.isArray(candidate.events)
  );
}

function isFileNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
