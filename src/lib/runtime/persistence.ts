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

export interface GitHubOAuthConnection {
  forgeId: string;
  accountLogin: string;
  accountId: string;
  scopes: string[];
  tokenType: string;
  encryptedAccessToken: string;
  connectedAt: string;
  updatedAt: string;
}

export interface RuntimePersistence {
  readonly mode: "memory" | "file" | "database";
  listForges(): Promise<ForgeSummary[]>;
  loadSnapshot(forgeSlug: string): Promise<ForgeSnapshot | null>;
  saveSnapshot(snapshot: ForgeSnapshot): Promise<void>;
  resetSnapshot(snapshot: ForgeSnapshot): Promise<void>;
  getEvents(forgeId: string, afterSequence: number): Promise<RuntimeEvent[]>;
  hasIdempotencyKey(forgeId: string, key: string): Promise<boolean>;
  recordIdempotencyKey(forgeId: string, key: string): Promise<void>;
  loadGitHubConnection(forgeId: string): Promise<GitHubOAuthConnection | null>;
  saveGitHubConnection(connection: GitHubOAuthConnection): Promise<void>;
  deleteGitHubConnection(forgeId: string): Promise<void>;
  clear?(): Promise<void>;
}

export class InMemoryRuntimePersistence implements RuntimePersistence {
  readonly mode = "memory" as const;
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

  private readonly githubConnections = new Map<string, GitHubOAuthConnection>();

  async loadGitHubConnection(forgeId: string) {
    const connection = this.githubConnections.get(forgeId);
    return connection ? structuredClone(connection) : null;
  }

  async saveGitHubConnection(connection: GitHubOAuthConnection) {
    this.githubConnections.set(connection.forgeId, structuredClone(connection));
  }

  async deleteGitHubConnection(forgeId: string) {
    this.githubConnections.delete(forgeId);
  }

  async clear() {
    this.snapshots.clear();
    this.appliedKeys.clear();
    this.githubConnections.clear();
  }
}

interface FileRuntimePersistencePayload {
  snapshots: ForgeSnapshot[];
  appliedKeys: string[];
  githubConnections?: GitHubOAuthConnection[];
}

export class FileRuntimePersistence implements RuntimePersistence {
  readonly mode = "file" as const;
  private loaded = false;
  private readonly snapshots = new Map<string, ForgeSnapshot>();
  private readonly appliedKeys = new Set<string>();
  private readonly githubConnections = new Map<string, GitHubOAuthConnection>();
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

  async loadGitHubConnection(forgeId: string) {
    await this.ensureLoaded();
    const connection = this.githubConnections.get(forgeId);
    return connection ? structuredClone(connection) : null;
  }

  async saveGitHubConnection(connection: GitHubOAuthConnection) {
    await this.ensureLoaded();
    this.githubConnections.set(connection.forgeId, structuredClone(connection));
    await this.persist();
  }

  async deleteGitHubConnection(forgeId: string) {
    await this.ensureLoaded();
    this.githubConnections.delete(forgeId);
    await this.persist();
  }

  async clear() {
    await this.ensureLoaded();
    this.snapshots.clear();
    this.appliedKeys.clear();
    this.githubConnections.clear();
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
      for (const connection of payload.githubConnections ?? []) {
        if (isGitHubOAuthConnection(connection)) {
          this.githubConnections.set(connection.forgeId, structuredClone(connection));
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
      appliedKeys: Array.from(this.appliedKeys),
      githubConnections: Array.from(this.githubConnections.values())
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

function isGitHubOAuthConnection(value: unknown): value is GitHubOAuthConnection {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<GitHubOAuthConnection>;
  return (
    typeof candidate.forgeId === "string" &&
    typeof candidate.accountLogin === "string" &&
    typeof candidate.accountId === "string" &&
    Array.isArray(candidate.scopes) &&
    typeof candidate.tokenType === "string" &&
    typeof candidate.encryptedAccessToken === "string"
  );
}
