import { z } from "zod";
import { createForgeSnapshot } from "@/lib/mock/seed";
import { MockRuntime } from "./mock-runtime";
import { calculateOperationReadiness } from "./metrics";
import { FileRuntimePersistence, InMemoryRuntimePersistence, type RuntimePersistence } from "./persistence";
import { PrismaRuntimePersistence } from "./prisma";
import { projectOrganizationalState, unlockReadyOperations } from "./projector";
import { getBlockingDependencyIds } from "./scheduler";
import type { AgentRuntime, ForgeSnapshot, RuntimeCommand, RuntimeEvent, RuntimeEventDraft, RuntimeStatus } from "./types";

const commandSchema = z.object({
  type: z.enum([
    "initialize_forge",
    "start_phase",
    "run_operation",
    "run_full_flow",
    "connect_repository",
    "disconnect_repository",
    "refresh_repository_context",
    "pause_forge",
    "resume_forge",
    "shutdown_forge",
    "reset_demo_state",
    "operator_message"
  ]),
  forgeId: z.string().optional(),
  operationId: z.string().optional(),
  phase: z.string().max(80).optional(),
  message: z.string().max(2000).optional(),
  repositoryUrl: z.string().max(300).optional(),
  provider: z.literal("github").optional(),
  owner: z.string().max(80).optional(),
  repo: z.string().max(120).optional(),
  defaultBranch: z.string().max(255).optional(),
  workingBranch: z.string().max(255).optional(),
  installationId: z.string().max(120).optional(),
  accountRef: z.string().max(160).optional(),
  idempotencyKey: z.string().max(120).optional()
});

const createForgeSchema = z.object({
  name: z.string().trim().min(1).max(80)
});

export class RuntimeCommandError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RuntimeCommandError";
  }
}

export class RuntimeStore {
  constructor(
    private readonly persistence: RuntimePersistence = createDefaultPersistence(),
    private readonly agentRuntime: AgentRuntime = new MockRuntime()
  ) {}

  async listForges() {
    return this.persistence.listForges();
  }

  async createForge(input: unknown) {
    const { name } = createForgeSchema.parse(input);
    const slug = slugifyForgeName(name);

    if (!slug) {
      throw new RuntimeCommandError("Forge name must include letters or numbers.", 400);
    }

    const existing = await this.persistence.loadSnapshot(slug);
    if (existing) {
      throw new RuntimeCommandError("A Forge with this slug already exists.", 409);
    }

    const snapshot = createForgeSnapshot({
      id: `forge-${slug}`,
      slug,
      name,
      prefixEntityIds: true
    });

    await this.persistence.saveSnapshot(snapshot);
    return {
      id: snapshot.forge.id,
      slug: snapshot.forge.slug,
      name: snapshot.forge.name
    };
  }

  async getSnapshot(forgeSlug: string) {
    return structuredClone(await this.loadSnapshot(forgeSlug));
  }

  async getEvents(forgeSlug: string, afterSequence = 0) {
    const snapshot = await this.loadSnapshot(forgeSlug);
    const events = await this.persistence.getEvents(snapshot.forge.id, afterSequence);
    return structuredClone(events);
  }

  async dispatch(forgeSlug: string, input: unknown) {
    const command = commandSchema.parse(input) as RuntimeCommand;
    const snapshot = await this.loadSnapshot(forgeSlug);

    if (command.idempotencyKey && (await this.persistence.hasIdempotencyKey(snapshot.forge.id, command.idempotencyKey))) {
      return this.getSnapshot(forgeSlug);
    }

    const nextSnapshot = await this.handleCommand(snapshot, command);

    if (command.idempotencyKey) {
      await this.persistence.recordIdempotencyKey(snapshot.forge.id, command.idempotencyKey);
    }

    await this.persistence.saveSnapshot(nextSnapshot);
    return structuredClone(nextSnapshot);
  }

  private async loadSnapshot(forgeSlug: string) {
    const snapshot = await this.persistence.loadSnapshot(forgeSlug);
    if (!snapshot) {
      throw new RuntimeCommandError("Forge not found.", 404);
    }

    return snapshot;
  }

  private async handleCommand(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    switch (command.type) {
      case "initialize_forge":
      case "reset_demo_state":
        return this.reset(snapshot, command.type);
      case "start_phase":
        return this.startPhase(snapshot, command.phase ?? "Autonomous Development");
      case "run_operation":
        return this.runOperation(snapshot, command.operationId);
      case "run_full_flow":
        return this.runFullFlow(snapshot);
      case "connect_repository":
        return this.connectRepository(snapshot, command);
      case "disconnect_repository":
        return this.disconnectRepository(snapshot);
      case "refresh_repository_context":
        return this.refreshRepositoryContext(snapshot);
      case "pause_forge":
      case "shutdown_forge":
        return this.pauseForge(snapshot);
      case "resume_forge":
        return this.resumeForge(snapshot);
      case "operator_message":
        return this.addOperatorMessage(snapshot, command.message ?? "");
    }
  }

  private async reset(current: ForgeSnapshot, commandType: "initialize_forge" | "reset_demo_state") {
    const seeded = createForgeSnapshot({
      id: current.forge.id,
      slug: current.forge.slug,
      name: current.forge.name,
      tagline: current.forge.tagline,
      prefixEntityIds: current.forge.slug !== "demo"
    });
    const snapshot = appendEvents(seeded, [
      {
        forgeId: seeded.forge.id,
        type: commandType === "reset_demo_state" ? "runtime.reset" : "forge.initialized",
        actorType: "operator",
        targetType: "forge",
        targetId: seeded.forge.id,
        message: commandType === "reset_demo_state" ? "Forge state reset." : "Forge initialized.",
        severity: "success",
        payload: { command: commandType }
      }
    ]);

    await this.persistence.resetSnapshot(snapshot);
    return snapshot;
  }

  private async startPhase(snapshot: ForgeSnapshot, phase: string) {
    return appendEvents(
      {
        ...snapshot,
        forge: {
          ...snapshot.forge,
          activePhase: phase
        }
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "division.status_changed",
          actorType: "operator",
          targetType: "forge",
          targetId: snapshot.forge.id,
          message: `Active phase changed to ${phase}.`,
          severity: "info",
          payload: { phase }
        }
      ]
    );
  }

  private async runOperation(snapshot: ForgeSnapshot, operationId?: string) {
    const operation = snapshot.operations.find((candidate) => candidate.id === operationId);

    if (!operation) {
      throw new RuntimeCommandError("No operation selected.", 400);
    }

    this.assertOperationCanRun(snapshot, operation.id);

    let nextSnapshot = {
      ...snapshot,
      operations: snapshot.operations.map((candidate) =>
        candidate.id === operation.id
          ? {
              ...candidate,
              status: "running" as const,
              progress: Math.max(candidate.progress, 50),
              blockedReason: undefined
            }
          : candidate
      ),
      workers: snapshot.workers.map((worker) =>
        worker.id === operation.workerId
          ? {
              ...worker,
              status: "running" as const,
              currentTask: operation.title
            }
          : worker
      )
    };

    const runtimeEvents: RuntimeEventDraft[] = [];
    for await (const event of this.agentRuntime.runOperation({ forgeId: snapshot.forge.id, operationId: operation.id })) {
      runtimeEvents.push(event);
    }

    nextSnapshot = {
      ...nextSnapshot,
      operations: nextSnapshot.operations.map((candidate) =>
        candidate.id === operation.id
          ? {
              ...candidate,
              status: "completed" as const,
              progress: 100,
              blockedReason: undefined
            }
          : candidate
      )
    };

    nextSnapshot = projectOrganizationalState(nextSnapshot);
    const unlocked = unlockReadyOperations(nextSnapshot);
    nextSnapshot = projectOrganizationalState(unlocked.snapshot);

    return appendEvents(nextSnapshot, [...runtimeEvents, ...unlocked.events]);
  }

  private runFullFlow(snapshot: ForgeSnapshot) {
    const timestamp = new Date().toISOString();
      const launchArtifact = {
        id: `${snapshot.forge.slug}-artifact-launch-${Date.now()}`,
        title: "Launch Checklist",
        type: "launch_checklist",
        divisionId: snapshot.divisions.find((division) => division.name === "Release Division")?.id ?? "release",
        workerId: snapshot.workers.find((worker) => worker.name === "Release Director")?.id ?? "release-director",
        operationId: snapshot.operations.find((operation) => operation.title === "Prepare release pass")?.id ?? "op-release",
        content: "Demo path validated, release assets finalized, and Forge is deployment ready.",
        status: "finalized" as const,
        version: 1,
        tags: ["release", "demo"],
        fileIds: snapshot.files.filter((file) => file.path === "review/qa-report.md").map((file) => file.id),
        createdAt: timestamp,
        updatedAt: timestamp
      };

      const projected = projectOrganizationalState({
        ...snapshot,
        operations: snapshot.operations.map((operation) => ({
          ...operation,
          status: "completed" as const,
          progress: 100,
          blockedReason: undefined
        })),
        workers: snapshot.workers.map((worker) => ({ ...worker, status: "completed" as const })),
        divisions: snapshot.divisions.map((division) => ({ ...division, status: "completed" as const, progress: 100 })),
        artifacts: [...snapshot.artifacts, launchArtifact],
        forge: {
          ...snapshot.forge,
          activePhase: "Deployment Ready"
        }
      });

      return appendEvents(projected, [
        {
          forgeId: snapshot.forge.id,
          type: "operation.completed",
          actorType: "runtime",
          targetType: "forge",
          targetId: snapshot.forge.id,
          message: "Full autonomous flow completed through Release Pass.",
          severity: "success",
          payload: { phase: "Deployment Ready" }
        },
        {
          forgeId: snapshot.forge.id,
          type: "artifact.created",
          actorType: "worker",
          actorId: launchArtifact.workerId,
          targetType: "artifact",
          targetId: launchArtifact.id,
          message: "Release Division generated the launch checklist.",
          severity: "success",
          payload: { artifactId: launchArtifact.id }
        }
      ]);
  }

  private async pauseForge(snapshot: ForgeSnapshot) {
    const activeOperationStatuses = new Set(["planning", "ready", "running", "blocked", "reviewing"]);
    const pausedOperationIds = new Set(
      snapshot.operations
        .filter((operation) => activeOperationStatuses.has(operation.status))
        .map((operation) => operation.id)
    );
    const affectedDivisionIds = new Set(
      snapshot.operations
        .filter((operation) => pausedOperationIds.has(operation.id))
        .map((operation) => operation.divisionId)
    );
    const pausedOperations = snapshot.operations
      .filter((operation) => pausedOperationIds.has(operation.id))
      .map((operation) => ({
        id: operation.id,
        status: operation.status,
        blockedReason: operation.blockedReason
      }));
    const pausedWorkers = snapshot.workers
      .filter((worker) => worker.status !== "completed")
      .map((worker) => ({
        id: worker.id,
        status: worker.status,
        currentTask: worker.currentTask
      }));
    const pausedDivisions = snapshot.divisions
      .filter((division) => affectedDivisionIds.has(division.id) && division.status !== "completed")
      .map((division) => ({
        id: division.id,
        status: division.status
      }));

    return appendEvents(
      {
        ...snapshot,
        forge: {
          ...snapshot.forge,
          status: "paused",
          activePhase: "Safe Shutdown"
        },
        operations: snapshot.operations.map((operation) =>
          pausedOperationIds.has(operation.id)
            ? {
                ...operation,
                status: "paused" as const,
                blockedReason: undefined
              }
            : operation
        ),
        workers: snapshot.workers.map((worker) =>
          worker.status === "completed"
            ? worker
            : {
                ...worker,
                status: "paused" as const,
                currentTask: undefined
              }
        ),
        divisions: snapshot.divisions.map((division) =>
          affectedDivisionIds.has(division.id) && division.status !== "completed"
            ? {
                ...division,
                status: "paused" as const
              }
            : division
        )
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "runtime.paused",
          actorType: "operator",
          targetType: "forge",
          targetId: snapshot.forge.id,
          message: "Safe shutdown completed. New operation runs are paused and incomplete work can be resumed.",
          severity: "warning",
          payload: {
            pausedOperationIds: Array.from(pausedOperationIds),
            pausedOperations,
            pausedWorkers,
            pausedDivisions
          }
        }
      ]
    );
  }

  private async resumeForge(snapshot: ForgeSnapshot) {
    if (snapshot.forge.status === "active") {
      return snapshot;
    }

    if (snapshot.forge.status !== "paused") {
      throw new RuntimeCommandError("Only paused forges can be resumed.", 409);
    }

    const pauseState = getLatestPauseState(snapshot);
    const operations = snapshot.operations.map((operation) => {
      if (operation.status !== "paused") {
        return operation;
      }

      const previous = pauseState.operations.get(operation.id);
      if (previous) {
        return { ...operation, status: previous.status, blockedReason: previous.blockedReason };
      }

      const readiness = calculateOperationReadiness(operation, snapshot.operations, getBlockingDependencyIds(snapshot, operation.id));
      if (readiness.ready) {
        return { ...operation, status: "ready" as const, blockedReason: undefined };
      }

      return { ...operation, status: "blocked" as const, blockedReason: readiness.reason ?? "Waiting for dependencies" };
    });

    const resumed = projectOrganizationalState({
      ...snapshot,
      forge: {
        ...snapshot.forge,
        status: "active"
      },
      operations,
      workers: snapshot.workers.map((worker) =>
        worker.status === "paused" ? { ...worker, ...(pauseState.workers.get(worker.id) ?? { status: "idle" as const }) } : worker
      ),
      divisions: snapshot.divisions.map((division) =>
        division.status === "paused" ? { ...division, ...(pauseState.divisions.get(division.id) ?? { status: "idle" as const }) } : division
      )
    });

    return appendEvents(resumed, [
      {
        forgeId: snapshot.forge.id,
        type: "runtime.resumed",
        actorType: "operator",
        targetType: "forge",
        targetId: snapshot.forge.id,
        message: "Forge resumed. Eligible paused operations are ready for execution.",
        severity: "success",
        payload: { resumedOperationIds: operations.filter((operation) => operation.status === "ready").map((operation) => operation.id) }
      }
    ]);
  }

  private async addOperatorMessage(snapshot: ForgeSnapshot, content: string) {
    const timestamp = new Date().toISOString();
    const operatorMessage = { id: `msg-${Date.now()}-operator`, role: "operator" as const, content, createdAt: timestamp };
    const response = {
      id: `msg-${Date.now()}-executive`,
      role: "executive" as const,
      content: content.toLowerCase().includes("block")
        ? "Current blocker: testing remains dependent on runtime contract completion. Recommendation: run the runtime operation first."
        : "Executive AI received the command and updated the operational context. The Forge remains in autonomous development.",
      createdAt: timestamp
    };

    return appendEvents(
      {
        ...snapshot,
        messages: [...snapshot.messages, operatorMessage, response]
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "chat.message_added",
          actorType: "operator",
          targetType: "chat",
          message: "Operator message recorded in Executive Console.",
          severity: "info",
          payload: { messageId: operatorMessage.id }
        },
        {
          forgeId: snapshot.forge.id,
          type: "chat.message_added",
          actorType: "executive",
          targetType: "chat",
          message: "Executive AI response generated by mock provider.",
          severity: "success",
          payload: { messageId: response.id }
        }
      ]
    );
  }

  private async connectRepository(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    const normalizedRepository = normalizeRepositoryCommand(command, snapshot.repository?.connectedAt);
    const repository = {
      ...normalizedRepository,
      id: `${snapshot.forge.slug}-${normalizedRepository.id}`
    };

    return appendEvents(
      {
        ...snapshot,
        repository
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "repository.connected",
          actorType: "operator",
          targetType: "repository",
          targetId: repository.id,
          message: `GitHub repository connected: ${repository.owner}/${repository.repo}.`,
          severity: "success",
          payload: {
            provider: repository.provider,
            owner: repository.owner,
            repo: repository.repo,
            defaultBranch: repository.defaultBranch,
            workingBranch: repository.workingBranch
          }
        }
      ]
    );
  }

  private async disconnectRepository(snapshot: ForgeSnapshot) {
    const repository = snapshot.repository;
    if (!repository) {
      return snapshot;
    }

    return appendEvents(
      {
        ...snapshot,
        repository: undefined
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "repository.disconnected",
          actorType: "operator",
          targetType: "repository",
          targetId: repository.id,
          message: `GitHub repository disconnected: ${repository.owner}/${repository.repo}.`,
          severity: "warning",
          payload: {
            provider: repository.provider,
            owner: repository.owner,
            repo: repository.repo
          }
        }
      ]
    );
  }

  private async refreshRepositoryContext(snapshot: ForgeSnapshot) {
    if (!snapshot.repository) {
      throw new RuntimeCommandError("No repository is connected.", 409);
    }

    const repository = {
      ...snapshot.repository,
      lastRefreshedAt: new Date().toISOString()
    };

    return appendEvents(
      {
        ...snapshot,
        repository
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "repository.refreshed",
          actorType: "operator",
          targetType: "repository",
          targetId: repository.id,
          message: `Repository context refreshed for ${repository.owner}/${repository.repo}.`,
          severity: "info",
          payload: {
            provider: repository.provider,
            owner: repository.owner,
            repo: repository.repo,
            defaultBranch: repository.defaultBranch,
            workingBranch: repository.workingBranch,
            lastRefreshedAt: repository.lastRefreshedAt
          }
        }
      ]
    );
  }

  private assertOperationCanRun(snapshot: ForgeSnapshot, operationId: string) {
    if (snapshot.forge.status === "paused") {
      throw new RuntimeCommandError("Forge is paused and is not accepting operation runs.", 409);
    }

    if (snapshot.forge.status === "archived") {
      throw new RuntimeCommandError("Forge is archived and is not accepting operation runs.", 409);
    }

    const operation = snapshot.operations.find((candidate) => candidate.id === operationId);
    if (!operation) {
      throw new RuntimeCommandError("No operation selected.", 400);
    }

    const readiness = calculateOperationReadiness(operation, snapshot.operations, getBlockingDependencyIds(snapshot, operation.id));

    if (operation.status === "blocked") {
      throw new RuntimeCommandError("Operation is blocked until its dependencies complete.", 409);
    }

    if (operation.status !== "ready") {
      throw new RuntimeCommandError(`Operation cannot run from ${operation.status} status.`, 409);
    }

    if (!readiness.ready) {
      throw new RuntimeCommandError(readiness.reason ?? "Operation is not ready to run.", 409);
    }

    if (operation.workerId && snapshot.operations.some((candidate) => candidate.workerId === operation.workerId && candidate.id !== operation.id && candidate.status === "running")) {
      throw new RuntimeCommandError("Worker is already running another operation.", 409);
    }
  }
}

function appendEvents(snapshot: ForgeSnapshot, drafts: RuntimeEventDraft[]): ForgeSnapshot {
  const createdAt = new Date().toISOString();
  const events: RuntimeEvent[] = drafts.map((draft, index) => ({
    ...draft,
    id: `event-${Date.now()}-${snapshot.lastEventSequence + index + 1}`,
    sequence: snapshot.lastEventSequence + index + 1,
    createdAt
  }));

  return {
    ...snapshot,
    events: [...snapshot.events, ...events],
    lastEventSequence: snapshot.lastEventSequence + events.length
  };
}

function getLatestPauseState(snapshot: ForgeSnapshot) {
  const pauseEvent = snapshot.events
    .slice()
    .reverse()
    .find((event) => event.type === "runtime.paused");
  const payload = pauseEvent?.payload ?? {};
  const pausedOperations = Array.isArray(payload.pausedOperations) ? payload.pausedOperations : [];
  const pausedWorkers = Array.isArray(payload.pausedWorkers) ? payload.pausedWorkers : [];
  const pausedDivisions = Array.isArray(payload.pausedDivisions) ? payload.pausedDivisions : [];
  const operations = new Map<string, { status: RuntimeStatus; blockedReason?: string }>();
  const workers = new Map<string, { status: RuntimeStatus; currentTask?: string }>();
  const divisions = new Map<string, { status: RuntimeStatus }>();

  for (const operation of pausedOperations) {
    if (isPreviousOperationState(operation)) {
      operations.set(operation.id, { status: operation.status, blockedReason: operation.blockedReason });
    }
  }

  for (const worker of pausedWorkers) {
    if (isPreviousWorkerState(worker)) {
      workers.set(worker.id, { status: worker.status, currentTask: worker.currentTask });
    }
  }

  for (const division of pausedDivisions) {
    if (isPreviousDivisionState(division)) {
      divisions.set(division.id, { status: division.status });
    }
  }

  return {
    operations,
    workers,
    divisions
  };
}

function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  return typeof value === "string" && ["idle", "planning", "ready", "running", "blocked", "reviewing", "paused", "completed", "failed", "canceled"].includes(value);
}

function isPreviousOperationState(value: unknown): value is { id: string; status: RuntimeStatus; blockedReason?: string } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { id?: unknown; status?: unknown; blockedReason?: unknown };
  return typeof candidate.id === "string" && isRuntimeStatus(candidate.status) && (candidate.blockedReason === undefined || typeof candidate.blockedReason === "string");
}

function isPreviousWorkerState(value: unknown): value is { id: string; status: RuntimeStatus; currentTask?: string } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { id?: unknown; status?: unknown; currentTask?: unknown };
  return typeof candidate.id === "string" && isRuntimeStatus(candidate.status) && (candidate.currentTask === undefined || typeof candidate.currentTask === "string");
}

function isPreviousDivisionState(value: unknown): value is { id: string; status: RuntimeStatus } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { id?: unknown; status?: unknown };
  return typeof candidate.id === "string" && isRuntimeStatus(candidate.status);
}

function normalizeRepositoryCommand(command: RuntimeCommand, existingConnectedAt?: string) {
  const parsed = parseRepositoryLocator(command);
  const defaultBranch = command.defaultBranch?.trim();
  if (!defaultBranch) {
    throw new RuntimeCommandError("Repository default branch is required.", 400);
  }
  const workingBranch = command.workingBranch?.trim() || defaultBranch;

  validateOwner(parsed.owner);
  validateRepo(parsed.repo);
  validateBranch(defaultBranch, "default branch");
  validateBranch(workingBranch, "working branch");

  return {
    id: `repo-${parsed.owner}-${parsed.repo}`.toLowerCase(),
    provider: "github" as const,
    owner: parsed.owner,
    repo: parsed.repo,
    defaultBranch,
    workingBranch,
    installationId: command.installationId?.trim() || undefined,
    accountRef: command.accountRef?.trim() || undefined,
    connectedAt: existingConnectedAt ?? new Date().toISOString()
  };
}

function parseRepositoryLocator(command: RuntimeCommand) {
  if (command.repositoryUrl) {
    const parsed = parseGitHubRepositoryUrl(command.repositoryUrl);
    if (command.owner || command.repo) {
      const explicitOwner = command.owner?.trim();
      const explicitRepo = command.repo ? stripGitSuffix(command.repo.trim()) : undefined;
      if (explicitOwner !== parsed.owner || explicitRepo !== parsed.repo) {
        throw new RuntimeCommandError("Repository URL and owner/repo fields do not match.", 400);
      }
    }
    return parsed;
  }

  if (!command.owner || !command.repo) {
    throw new RuntimeCommandError("Repository owner and name are required.", 400);
  }

  return {
    owner: command.owner.trim(),
    repo: stripGitSuffix(command.repo.trim())
  };
}

function parseGitHubRepositoryUrl(repositoryUrl: string) {
  const trimmed = repositoryUrl.trim();
  if (trimmed.startsWith("git@")) {
    throw new RuntimeCommandError("Repository URL must use https://github.com.", 400);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new RuntimeCommandError("Repository URL must be a valid GitHub URL.", 400);
  }

  if (url.hostname.toLowerCase() !== "github.com") {
    throw new RuntimeCommandError("Only GitHub repository URLs are supported.", 400);
  }

  if (url.protocol !== "https:") {
    throw new RuntimeCommandError("Repository URL must use https://github.com.", 400);
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new RuntimeCommandError("Repository URL must not include credentials, query strings, or fragments.", 400);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new RuntimeCommandError("GitHub repository URL must include owner and repository name.", 400);
  }

  return {
    owner: parts[0],
    repo: stripGitSuffix(parts[1])
  };
}

function stripGitSuffix(value: string) {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function validateOwner(owner: string) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new RuntimeCommandError("Invalid GitHub repository owner.", 400);
  }
}

function validateRepo(repo: string) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..") {
    throw new RuntimeCommandError("Invalid GitHub repository name.", 400);
  }
}

function validateBranch(branch: string, label: string) {
  if (
    branch.length === 0 ||
    branch.length > 255 ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    branch.includes("\\") ||
    branch.endsWith(".lock") ||
    /\s/.test(branch) ||
    /[\u0000-\u001f\u007f~^:?*[{]/.test(branch)
  ) {
    throw new RuntimeCommandError(`Invalid ${label}.`, 400);
  }
}

export function slugifyForgeName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createDefaultPersistence(): RuntimePersistence {
  if (process.env.DATABASE_URL) {
    return new PrismaRuntimePersistence();
  }

  if (process.env.NODE_ENV === "test") {
    return new InMemoryRuntimePersistence();
  }

  return new FileRuntimePersistence(process.env.FORGEOS_RUNTIME_STORE_PATH);
}

const globalForRuntime = globalThis as unknown as { forgeRuntimeStore?: RuntimeStore };

export const runtimeStore = globalForRuntime.forgeRuntimeStore ?? new RuntimeStore();

if (process.env.NODE_ENV !== "production") {
  globalForRuntime.forgeRuntimeStore = runtimeStore;
}
