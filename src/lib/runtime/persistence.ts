import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEmptyForgeSnapshot, defaultWorkerContextManifest, isDefaultForgeWorker } from "@/lib/mock/seed";
import { isActiveRun } from "./runs";
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
  deleteForge(forgeSlug: string): Promise<boolean>;
  getEvents(forgeId: string, afterSequence: number): Promise<RuntimeEvent[]>;
  hasIdempotencyKey(forgeId: string, key: string): Promise<boolean>;
  recordIdempotencyKey(forgeId: string, key: string): Promise<void>;
  loadGitHubConnection(forgeId: string): Promise<GitHubOAuthConnection | null>;
  saveGitHubConnection(connection: GitHubOAuthConnection): Promise<void>;
  deleteGitHubConnection(forgeId: string): Promise<void>;
  claimRun?(claim: RuntimeRunClaim): Promise<boolean>;
  heartbeatRunClaim?(runId: string, leaseExpiresAt: string): Promise<void>;
  releaseRunClaim?(runId: string): Promise<void>;
  clear?(): Promise<void>;
}

export interface RuntimeRunClaim {
  runId: string;
  forgeId: string;
  operationId: string;
  workerId?: string;
  provider: string;
  claimedBy: string;
  leaseExpiresAt: string;
}

export class InMemoryRuntimePersistence implements RuntimePersistence {
  readonly mode = "memory" as const;
  private readonly snapshots = new Map<string, ForgeSnapshot>();
  private readonly appliedKeys = new Set<string>();
  private readonly runClaims = new Map<string, RuntimeRunClaim>();

  constructor(initialSnapshot?: ForgeSnapshot) {
    if (initialSnapshot) {
      this.snapshots.set(initialSnapshot.forge.slug, normalizeSnapshot(initialSnapshot));
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
    this.snapshots.set(snapshot.forge.slug, normalizeSnapshot(snapshot));
    pruneReplacedSnapshotRunClaims(this.runClaims, snapshot);
  }

  async resetSnapshot(snapshot: ForgeSnapshot) {
    this.snapshots.set(snapshot.forge.slug, normalizeSnapshot(snapshot));
    for (const key of this.appliedKeys) {
      if (key.startsWith(`${snapshot.forge.id}:`)) {
        this.appliedKeys.delete(key);
      }
    }
    pruneReplacedSnapshotRunClaims(this.runClaims, snapshot);
  }

  async deleteForge(forgeSlug: string) {
    const snapshot = this.snapshots.get(forgeSlug);
    if (!snapshot) {
      return false;
    }
    this.snapshots.delete(forgeSlug);
    for (const key of Array.from(this.appliedKeys)) {
      if (key.startsWith(`${snapshot.forge.id}:`)) {
        this.appliedKeys.delete(key);
      }
    }
    this.githubConnections.delete(snapshot.forge.id);
    for (const [runId, claim] of Array.from(this.runClaims.entries())) {
      if (claim.forgeId === snapshot.forge.id) {
        this.runClaims.delete(runId);
      }
    }
    return true;
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

  async claimRun(claim: RuntimeRunClaim) {
    this.pruneExpiredRunClaims();
    if (Array.from(this.runClaims.values()).some((candidate) => conflictsWithClaim(candidate, claim))) {
      return false;
    }
    this.runClaims.set(claim.runId, structuredClone(claim));
    return true;
  }

  async heartbeatRunClaim(runId: string, leaseExpiresAt: string) {
    const claim = this.runClaims.get(runId);
    if (claim) {
      this.runClaims.set(runId, { ...claim, leaseExpiresAt });
    }
  }

  async releaseRunClaim(runId: string) {
    this.runClaims.delete(runId);
  }

  async clear() {
    this.snapshots.clear();
    this.appliedKeys.clear();
    this.githubConnections.clear();
    this.runClaims.clear();
  }

  private pruneExpiredRunClaims() {
    const now = Date.now();
    for (const [runId, claim] of this.runClaims.entries()) {
      if (Date.parse(claim.leaseExpiresAt) <= now) {
        this.runClaims.delete(runId);
      }
    }
  }
}

interface FileRuntimePersistencePayload {
  snapshots: ForgeSnapshot[];
  appliedKeys: string[];
  githubConnections?: GitHubOAuthConnection[];
  runClaims?: RuntimeRunClaim[];
}

interface FilePersistOptions {
  clear?: boolean;
  deletedForgeIds?: string[];
  deletedForgeSlugs?: string[];
  deletedGitHubConnectionForgeIds?: string[];
  deletedRunIds?: string[];
  forceSnapshotSlugs?: string[];
  reconciledClaimForgeIds?: string[];
  activeClaimRunIds?: string[];
  resetClaimForgeIds?: string[];
  resetKeyForgeIds?: string[];
}

export class FileRuntimePersistence implements RuntimePersistence {
  readonly mode = "file" as const;
  private static readonly fileWriteQueues = new Map<string, Promise<void>>();
  private loaded = false;
  private readonly snapshots = new Map<string, ForgeSnapshot>();
  private readonly appliedKeys = new Set<string>();
  private readonly githubConnections = new Map<string, GitHubOAuthConnection>();
  private readonly runClaims = new Map<string, RuntimeRunClaim>();

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
    this.snapshots.set(snapshot.forge.slug, normalizeSnapshot(snapshot));
    pruneReplacedSnapshotRunClaims(this.runClaims, snapshot);
    await this.persist({ reconciledClaimForgeIds: [snapshot.forge.id], activeClaimRunIds: getActiveRunIds(snapshot) });
  }

  async resetSnapshot(snapshot: ForgeSnapshot) {
    await this.ensureLoaded();
    this.snapshots.set(snapshot.forge.slug, normalizeSnapshot(snapshot));
    for (const key of this.appliedKeys) {
      if (key.startsWith(`${snapshot.forge.id}:`)) {
        this.appliedKeys.delete(key);
      }
    }
    pruneReplacedSnapshotRunClaims(this.runClaims, snapshot);
    await this.persist({ forceSnapshotSlugs: [snapshot.forge.slug], resetClaimForgeIds: [snapshot.forge.id], resetKeyForgeIds: [snapshot.forge.id] });
  }

  async deleteForge(forgeSlug: string) {
    await this.ensureLoaded();
    const snapshot = this.snapshots.get(forgeSlug);
    if (!snapshot) {
      return false;
    }
    this.snapshots.delete(forgeSlug);
    for (const key of Array.from(this.appliedKeys)) {
      if (key.startsWith(`${snapshot.forge.id}:`)) {
        this.appliedKeys.delete(key);
      }
    }
    this.githubConnections.delete(snapshot.forge.id);
    for (const [runId, claim] of Array.from(this.runClaims.entries())) {
      if (claim.forgeId === snapshot.forge.id) {
        this.runClaims.delete(runId);
      }
    }
    await this.persist({ deletedForgeIds: [snapshot.forge.id], deletedForgeSlugs: [forgeSlug] });
    return true;
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
    await this.persist({ deletedGitHubConnectionForgeIds: [forgeId] });
  }

  async claimRun(claim: RuntimeRunClaim) {
    await this.ensureLoaded();
    this.pruneExpiredRunClaims();
    if (Array.from(this.runClaims.values()).some((candidate) => conflictsWithClaim(candidate, claim))) {
      return false;
    }
    this.runClaims.set(claim.runId, structuredClone(claim));
    await this.persist();
    return true;
  }

  async heartbeatRunClaim(runId: string, leaseExpiresAt: string) {
    await this.ensureLoaded();
    const claim = this.runClaims.get(runId);
    if (claim) {
      this.runClaims.set(runId, { ...claim, leaseExpiresAt });
      await this.persist();
    }
  }

  async releaseRunClaim(runId: string) {
    await this.ensureLoaded();
    this.runClaims.delete(runId);
    await this.persist({ deletedRunIds: [runId] });
  }

  async clear() {
    await this.ensureLoaded();
    this.snapshots.clear();
    this.appliedKeys.clear();
    this.githubConnections.clear();
    this.runClaims.clear();
    await this.persist({ clear: true });
  }

  private async ensureLoaded() {
    if (this.loaded) {
      return;
    }

    try {
      this.loadPayload(parseFileRuntimePersistencePayload(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
    }

    this.loaded = true;
  }

  private async persist(options: FilePersistOptions = {}) {
    const localPayload: FileRuntimePersistencePayload = {
      snapshots: Array.from(this.snapshots.values()),
      appliedKeys: Array.from(this.appliedKeys),
      githubConnections: Array.from(this.githubConnections.values()),
      runClaims: Array.from(this.runClaims.values())
    };

    const write = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const diskPayload = await this.readPayloadFromDisk();
      const payload = mergeFileRuntimePersistencePayload(diskPayload, localPayload, options);
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
      await writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
      await rename(tempPath, this.filePath);
      this.loadPayload(payload);
    };

    const previousWrite = FileRuntimePersistence.fileWriteQueues.get(this.filePath) ?? Promise.resolve();
    const nextWrite = previousWrite.then(write, write);
    FileRuntimePersistence.fileWriteQueues.set(this.filePath, nextWrite);

    try {
      await nextWrite;
    } finally {
      if (FileRuntimePersistence.fileWriteQueues.get(this.filePath) === nextWrite) {
        FileRuntimePersistence.fileWriteQueues.delete(this.filePath);
      }
    }
  }

  private async readPayloadFromDisk() {
    try {
      return parseFileRuntimePersistencePayload(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return emptyFileRuntimePersistencePayload();
      }
      throw error;
    }
  }

  private loadPayload(payload: FileRuntimePersistencePayload) {
    this.snapshots.clear();
    this.appliedKeys.clear();
    this.githubConnections.clear();
    this.runClaims.clear();

    for (const snapshot of payload.snapshots) {
      this.snapshots.set(snapshot.forge.slug, normalizeSnapshot(snapshot));
    }
    for (const key of payload.appliedKeys) {
      this.appliedKeys.add(key);
    }
    for (const connection of payload.githubConnections ?? []) {
      this.githubConnections.set(connection.forgeId, structuredClone(connection));
    }
    for (const claim of payload.runClaims ?? []) {
      this.runClaims.set(claim.runId, structuredClone(claim));
    }
  }

  private pruneExpiredRunClaims() {
    const now = Date.now();
    for (const [runId, claim] of this.runClaims.entries()) {
      if (Date.parse(claim.leaseExpiresAt) <= now) {
        this.runClaims.delete(runId);
      }
    }
  }
}

function emptyFileRuntimePersistencePayload(): FileRuntimePersistencePayload {
  return { snapshots: [], appliedKeys: [], githubConnections: [], runClaims: [] };
}

function parseFileRuntimePersistencePayload(contents: string): FileRuntimePersistencePayload {
  const payload = JSON.parse(contents) as Partial<FileRuntimePersistencePayload>;
  const snapshots = (payload.snapshots ?? []).filter(isForgeSnapshot).map((snapshot) => normalizeSnapshot(snapshot));
  const appliedKeys = (payload.appliedKeys ?? []).filter((key): key is string => typeof key === "string");
  const githubConnections = (payload.githubConnections ?? []).filter(isGitHubOAuthConnection).map((connection) => structuredClone(connection));
  const runClaims = (payload.runClaims ?? []).filter(isRuntimeRunClaim).map((claim) => structuredClone(claim));
  return { snapshots, appliedKeys, githubConnections, runClaims };
}

function mergeFileRuntimePersistencePayload(
  diskPayload: FileRuntimePersistencePayload,
  localPayload: FileRuntimePersistencePayload,
  options: FilePersistOptions
): FileRuntimePersistencePayload {
  if (options.clear) {
    return localPayload;
  }

  const deletedForgeIds = new Set(options.deletedForgeIds ?? []);
  const deletedForgeSlugs = new Set(options.deletedForgeSlugs ?? []);
  const deletedGitHubConnectionForgeIds = new Set(options.deletedGitHubConnectionForgeIds ?? []);
  const deletedRunIds = new Set(options.deletedRunIds ?? []);
  const forceSnapshotSlugs = new Set(options.forceSnapshotSlugs ?? []);
  const reconciledClaimForgeIds = new Set(options.reconciledClaimForgeIds ?? []);
  const activeClaimRunIds = new Set(options.activeClaimRunIds ?? []);
  const resetClaimForgeIds = new Set(options.resetClaimForgeIds ?? []);
  const resetKeyForgeIds = new Set(options.resetKeyForgeIds ?? []);

  const snapshots = new Map<string, ForgeSnapshot>();
  for (const snapshot of diskPayload.snapshots) {
    if (!deletedForgeIds.has(snapshot.forge.id) && !deletedForgeSlugs.has(snapshot.forge.slug)) {
      snapshots.set(snapshot.forge.slug, snapshot);
    }
  }
  for (const snapshot of localPayload.snapshots) {
    if (deletedForgeIds.has(snapshot.forge.id) || deletedForgeSlugs.has(snapshot.forge.slug)) {
      continue;
    }
    const diskSnapshot = snapshots.get(snapshot.forge.slug);
    if (!diskSnapshot || forceSnapshotSlugs.has(snapshot.forge.slug) || snapshot.lastEventSequence >= diskSnapshot.lastEventSequence) {
      snapshots.set(snapshot.forge.slug, snapshot);
    }
  }

  const appliedKeys = new Set([...diskPayload.appliedKeys, ...localPayload.appliedKeys]);
  for (const key of Array.from(appliedKeys)) {
    const forgeId = key.slice(0, key.indexOf(":"));
    if (deletedForgeIds.has(forgeId) || resetKeyForgeIds.has(forgeId)) {
      appliedKeys.delete(key);
    }
  }

  const githubConnections = new Map<string, GitHubOAuthConnection>();
  for (const connection of diskPayload.githubConnections ?? []) {
    if (!deletedForgeIds.has(connection.forgeId) && !deletedGitHubConnectionForgeIds.has(connection.forgeId)) {
      githubConnections.set(connection.forgeId, connection);
    }
  }
  for (const connection of localPayload.githubConnections ?? []) {
    if (!deletedForgeIds.has(connection.forgeId) && !deletedGitHubConnectionForgeIds.has(connection.forgeId)) {
      githubConnections.set(connection.forgeId, connection);
    }
  }

  const runClaims = new Map<string, RuntimeRunClaim>();
  for (const claim of diskPayload.runClaims ?? []) {
    if (shouldKeepMergedRunClaim(claim, { deletedForgeIds, deletedRunIds, resetClaimForgeIds, reconciledClaimForgeIds, activeClaimRunIds })) {
      runClaims.set(claim.runId, claim);
    }
  }
  for (const claim of localPayload.runClaims ?? []) {
    if (shouldKeepMergedRunClaim(claim, { deletedForgeIds, deletedRunIds, resetClaimForgeIds, reconciledClaimForgeIds, activeClaimRunIds })) {
      runClaims.set(claim.runId, claim);
    }
  }

  return {
    snapshots: Array.from(snapshots.values()),
    appliedKeys: Array.from(appliedKeys),
    githubConnections: Array.from(githubConnections.values()),
    runClaims: Array.from(runClaims.values())
  };
}

function scopedKey(forgeId: string, key: string) {
  return `${forgeId}:${key}`;
}

function pruneReplacedSnapshotRunClaims(runClaims: Map<string, RuntimeRunClaim>, snapshot: ForgeSnapshot) {
  const activeRunIds = new Set(getActiveRunIds(snapshot));
  for (const [runId, claim] of Array.from(runClaims.entries())) {
    if (claim.forgeId === snapshot.forge.id && !activeRunIds.has(runId)) {
      runClaims.delete(runId);
    }
  }
}

function getActiveRunIds(snapshot: ForgeSnapshot) {
  return snapshot.runs.filter(isActiveRun).map((run) => run.id);
}

function shouldKeepMergedRunClaim(
  claim: RuntimeRunClaim,
  options: {
    deletedForgeIds: Set<string>;
    deletedRunIds: Set<string>;
    resetClaimForgeIds: Set<string>;
    reconciledClaimForgeIds: Set<string>;
    activeClaimRunIds: Set<string>;
  }
) {
  if (options.deletedForgeIds.has(claim.forgeId) || options.deletedRunIds.has(claim.runId) || options.resetClaimForgeIds.has(claim.forgeId)) {
    return false;
  }
  return !options.reconciledClaimForgeIds.has(claim.forgeId) || options.activeClaimRunIds.has(claim.runId);
}

function stableIdForPath(filePath: string) {
  return filePath.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "root";
}

function inferArtifactTypeFromPath(filePath: string) {
  if (/\.(tsx|jsx|ts|js|css|html)$/i.test(filePath)) {
    return "implementation_file";
  }
  if (/\.md$/i.test(filePath)) {
    return "documentation_file";
  }
  if (/test|spec/i.test(filePath)) {
    return "test_file";
  }
  return "generated_file";
}

function mergeStringLists(left: string[], right: string[]) {
  return Array.from(new Set([...left, ...right]));
}

function normalizeWorkerSnapshot(worker: ForgeSnapshot["workers"][number], hasAssignedOperations: boolean, leadWorkerIds: Set<string>, executiveWorkerId?: string): ForgeSnapshot["workers"][number] {
  const baseWorker = hasAssignedOperations
    ? worker
    : {
        ...worker,
        status: "idle" as const,
        currentTask: undefined
      };
  const workerWithHierarchy = {
    ...baseWorker,
    kind: baseWorker.kind ?? inferWorkerKind(baseWorker, leadWorkerIds),
    managerWorkerId: baseWorker.managerWorkerId ?? inferManagerWorkerId(baseWorker, leadWorkerIds, executiveWorkerId)
  };
  if (!isDefaultForgeWorker(workerWithHierarchy.id, workerWithHierarchy.name, workerWithHierarchy.role)) {
    return workerWithHierarchy;
  }

  return {
    ...workerWithHierarchy,
    contextManifest: defaultWorkerContextManifest(workerWithHierarchy.id, workerWithHierarchy.name, workerWithHierarchy.role, workerWithHierarchy.currentTask ?? "Waiting for operation assignment", {
      virtualFileRefs: workerWithHierarchy.contextManifest?.virtualFileRefs ?? [],
      artifactRefs: workerWithHierarchy.contextManifest?.artifactRefs ?? [],
      redactions: workerWithHierarchy.contextManifest?.redactions
    })
  };
}

function inferLeadWorkerIdsByDivision(divisions: ForgeSnapshot["divisions"], workers: ForgeSnapshot["workers"]) {
  return new Map(
    divisions.flatMap((division) => {
      const explicit = division.leadWorkerId && workers.some((worker) => worker.id === division.leadWorkerId) ? division.leadWorkerId : undefined;
      const inferred =
        explicit ??
        workers.find((worker) => worker.divisionId === division.id && inferWorkerKind(worker, new Set()) === "lead")?.id ??
        workers.find((worker) => worker.divisionId === division.id)?.id;
      return inferred ? [[division.id, inferred] as const] : [];
    })
  );
}

function inferWorkerKind(worker: ForgeSnapshot["workers"][number], leadWorkerIds: Set<string>): ForgeSnapshot["workers"][number]["kind"] {
  if (worker.kind) {
    return worker.kind;
  }
  const key = `${worker.id} ${worker.name} ${worker.role}`.toLowerCase();
  if (/\bexecutive\b/.test(key)) {
    return "executive";
  }
  if (leadWorkerIds.has(worker.id) || /\bdirector\b|\bcoordinator\b|\blead\b|\bdivision head\b/.test(key)) {
    return "lead";
  }
  return "worker";
}

function inferManagerWorkerId(worker: ForgeSnapshot["workers"][number], leadWorkerIds: Set<string>, executiveWorkerId?: string) {
  const kind = inferWorkerKind(worker, leadWorkerIds);
  if (kind === "executive") {
    return undefined;
  }
  if (kind === "lead") {
    return executiveWorkerId;
  }
  return Array.from(leadWorkerIds).find((leadWorkerId) => leadWorkerId !== worker.id);
}

function inferRoutingStage(operation: ForgeSnapshot["operations"][number], workers: ForgeSnapshot["workers"]): ForgeSnapshot["operations"][number]["routingStage"] {
  if (operation.status === "completed") {
    return "done";
  }
  if (operation.status === "running") {
    return "running";
  }
  const worker = operation.workerId ? workers.find((candidate) => candidate.id === operation.workerId) : undefined;
  if (worker?.kind === "lead" || worker?.kind === "executive") {
    return "lead_triaged";
  }
  return operation.status === "ready" ? "worker_ready" : "executive_planned";
}

function normalizeRoutingStage(operation: ForgeSnapshot["operations"][number], workers: ForgeSnapshot["workers"]) {
  if (operation.status === "completed") {
    return "done" as const;
  }

  if (operation.status === "running") {
    return "running" as const;
  }

  if (operation.status === "ready" && (operation.routingStage === "done" || operation.routingStage === "running")) {
    return inferRoutingStage(operation, workers);
  }

  if (operation.status === "blocked" && operation.routingStage === "done") {
    return "worker_ready" as const;
  }

  return operation.routingStage ?? inferRoutingStage(operation, workers);
}

function isInformationalCoordinationBlocker(operation: ForgeSnapshot["operations"][number]) {
  const operationText = `${operation.title} ${operation.description}`.toLowerCase();
  const reasonText = (operation.blockedReason ?? "").toLowerCase();
  const isCoordinationOperation = /\b(coordinat|dependency routing|attention-needed|scheduler|handoff|operations?)\b/.test(operationText);
  const isDependencyStatus =
    /\b(no currently eligible operations|no eligible operations|scheduler reports no|work is dependency-gated|dependency-gated rather than blocked|not blocked by missing execution capacity)\b/.test(reasonText);
  return operation.status === "blocked" && isCoordinationOperation && isDependencyStatus;
}

function normalizeAllowedDomains(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const domains = Array.from(
    new Set(
      value
        .flatMap((item) => (typeof item === "string" ? [item] : []))
        .map((item) => item.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase())
        .filter((item) => /^[a-z0-9.-]+$/.test(item))
        .slice(0, 20)
    )
  );
  return domains.length > 0 ? domains : undefined;
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

export function normalizeSnapshot(snapshot: ForgeSnapshot): ForgeSnapshot {
  const cloned = structuredClone(snapshot);
  const shouldBackfillFreshOrganization =
    (!Array.isArray(cloned.divisions) || cloned.divisions.length === 0) &&
    (!Array.isArray(cloned.workers) || cloned.workers.length === 0) &&
    (!Array.isArray(cloned.operations) || cloned.operations.length === 0);
  const freshOrganization = shouldBackfillFreshOrganization
    ? createEmptyForgeSnapshot({
        id: cloned.forge.id,
        slug: cloned.forge.slug,
        name: cloned.forge.name,
        tagline: cloned.forge.tagline,
        prefixEntityIds: cloned.forge.slug !== "demo"
      })
    : undefined;
  const files = Array.isArray(cloned.files)
    ? cloned.files.map((file) => ({
        ...file,
        artifactIds: Array.isArray(file.artifactIds) ? file.artifactIds : []
      }))
    : [];
  const artifacts = Array.isArray(cloned.artifacts)
    ? cloned.artifacts.map((artifact) => ({
        ...artifact,
        fileIds: Array.isArray(artifact.fileIds) ? artifact.fileIds : []
      }))
    : [];
  const fileBackfilledArtifacts = files
    .filter((file) => file.operationId && file.status === "generated" && file.artifactIds.length === 0)
    .map((file) => ({
      id: `${cloned.forge.slug}-file-artifact-${stableIdForPath(file.id || file.path)}`,
      title: `Generated file: ${file.path}`,
      type: inferArtifactTypeFromPath(file.path),
      divisionId: file.divisionId ?? "",
      workerId: file.workerId,
      operationId: file.operationId,
      content: file.content,
      status: "generated" as const,
      version: 1,
      tags: ["generated-file"],
      fileIds: [file.id],
      createdAt: file.updatedAt,
      updatedAt: file.updatedAt
    }));
  const backfilledArtifactIdsByFileId = new Map(fileBackfilledArtifacts.flatMap((artifact) => artifact.fileIds.map((fileId) => [fileId, artifact.id] as const)));
  const normalizedFiles = files.map((file) => {
    const artifactId = backfilledArtifactIdsByFileId.get(file.id);
    return artifactId ? { ...file, artifactIds: [artifactId] } : file;
  });
  const normalizedArtifacts = [...artifacts, ...fileBackfilledArtifacts.filter((artifact) => !artifacts.some((existing) => existing.id === artifact.id))];
  const handoffs = Array.isArray(cloned.handoffs)
    ? cloned.handoffs.map((handoff) => ({
        ...handoff,
        deliverables: Array.isArray(handoff.deliverables) ? handoff.deliverables : [],
        blockers: Array.isArray(handoff.blockers) ? handoff.blockers : [],
        requiredContext: Array.isArray(handoff.requiredContext) ? handoff.requiredContext : [],
        artifactIds: Array.isArray(handoff.artifactIds) ? handoff.artifactIds : [],
        fileIds: Array.isArray(handoff.fileIds) ? handoff.fileIds : [],
        status: handoff.status ?? "open"
      }))
    : [];
  const messages = Array.isArray(cloned.messages)
    ? cloned.messages.map((message) => ({
        ...message,
        kind: message.kind ?? (message.role === "operator" ? "operator_prompt" : "executive_reply"),
        source: message.source ?? "manual"
      }))
    : [];
  const proposals = Array.isArray(cloned.proposals)
    ? cloned.proposals.filter((proposal) => proposal && typeof proposal === "object" && typeof proposal.id === "string")
    : [];
  const executiveLoops = Array.isArray(cloned.executiveLoops)
    ? cloned.executiveLoops.filter((loop) => loop && typeof loop === "object" && typeof loop.id === "string")
    : [];
  const executiveCycles = Array.isArray(cloned.executiveCycles)
    ? cloned.executiveCycles.filter((cycle) => cycle && typeof cycle === "object" && typeof cycle.id === "string")
    : [];
  const executivePlans = Array.isArray(cloned.executivePlans)
    ? cloned.executivePlans.filter((plan) => plan && typeof plan === "object" && typeof plan.id === "string")
    : [];
  const executiveReports = Array.isArray(cloned.executiveReports)
    ? cloned.executiveReports.filter((report) => report && typeof report === "object" && typeof report.id === "string")
    : [];
  const operationWorkerIds = new Set((Array.isArray(cloned.operations) ? cloned.operations : []).map((operation) => operation.workerId).filter(Boolean));
  const rawWorkers = Array.isArray(cloned.workers) && cloned.workers.length > 0 ? cloned.workers : freshOrganization?.workers ?? [];
  const rawDivisions = Array.isArray(cloned.divisions) && cloned.divisions.length > 0 ? cloned.divisions : freshOrganization?.divisions ?? [];
  const inferredLeadWorkerIdsByDivision = inferLeadWorkerIdsByDivision(rawDivisions, rawWorkers);
  const leadWorkerIds = new Set(Array.from(inferredLeadWorkerIdsByDivision.values()));
  const executiveWorkerId = rawWorkers.find((worker) => inferWorkerKind(worker, leadWorkerIds) === "executive")?.id;
  const normalizedWorkers = rawWorkers.map((worker) => normalizeWorkerSnapshot(worker, operationWorkerIds.has(worker.id), leadWorkerIds, executiveWorkerId));
  const normalizedDivisions = rawDivisions.map((division) => ({
    ...division,
    leadWorkerId: division.leadWorkerId ?? inferredLeadWorkerIdsByDivision.get(division.id)
  }));
  const completedRunOperationIds = new Set(
    (Array.isArray(cloned.runs) ? cloned.runs : [])
      .filter((run) => run.status === "completed")
      .map((run) => run.operationId)
  );

  return {
    ...cloned,
    schemaVersion: Math.max(cloned.schemaVersion ?? 1, 5),
    divisions: normalizedDivisions,
    workers: normalizedWorkers,
    operations: Array.isArray(cloned.operations)
      ? cloned.operations.map((operation) => {
          const repairedCoordinationStatus = completedRunOperationIds.has(operation.id) && isInformationalCoordinationBlocker(operation);
          const normalizedOperation = repairedCoordinationStatus
            ? {
                ...operation,
                status: "completed" as const,
                progress: 100,
                blockedReason: undefined
              }
            : operation;
          return {
            ...normalizedOperation,
            outputArtifactIds: mergeStringLists(
              Array.isArray(normalizedOperation.outputArtifactIds) ? normalizedOperation.outputArtifactIds : [],
              fileBackfilledArtifacts.filter((artifact) => artifact.operationId === normalizedOperation.id).map((artifact) => artifact.id)
            ),
            routingStage: normalizeRoutingStage(normalizedOperation, normalizedWorkers),
            webAccessPolicy: normalizedOperation.webAccessPolicy ?? "none",
            webAccessPurpose: normalizedOperation.webAccessPurpose,
            allowedDomains: normalizeAllowedDomains(normalizedOperation.allowedDomains)
          };
        })
      : [],
    artifacts: normalizedArtifacts,
    files: normalizedFiles,
    handoffs,
    messages,
    proposals,
    executiveLoops,
    executiveCycles,
    executivePlans,
    executiveReports,
    runs: Array.isArray(cloned.runs) ? cloned.runs : [],
    events: Array.isArray(cloned.events) ? cloned.events : []
  };
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

function isRuntimeRunClaim(value: unknown): value is RuntimeRunClaim {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RuntimeRunClaim>;
  return (
    typeof candidate.runId === "string" &&
    typeof candidate.forgeId === "string" &&
    typeof candidate.operationId === "string" &&
    typeof candidate.provider === "string" &&
    typeof candidate.claimedBy === "string" &&
    typeof candidate.leaseExpiresAt === "string"
  );
}

function conflictsWithClaim(existing: RuntimeRunClaim, claim: RuntimeRunClaim) {
  if (Date.parse(existing.leaseExpiresAt) <= Date.now()) {
    return false;
  }
  return existing.forgeId === claim.forgeId && (existing.operationId === claim.operationId || Boolean(existing.workerId && claim.workerId && existing.workerId === claim.workerId));
}
