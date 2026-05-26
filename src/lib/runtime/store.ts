import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { listGitHubRepositories, syncGitHubRepositoryFiles, type GitHubRepositorySummary } from "@/lib/github/client";
import { ExecutiveProviderRequestError, OpenAIExecutiveIntentProvider } from "@/lib/llm/provider";
import { createEmptyForgeSnapshot, createForgeSnapshot } from "@/lib/mock/seed";
import { decryptSecret } from "@/lib/security/tokens";
import { normalizeVirtualPath } from "@/lib/workspace/paths";
import { assembleRunContext, buildProviderPromptPackage } from "./context";
import { RuntimeCommandError } from "./errors";
import { verifyGeneratedFiles, type VerificationTier } from "./execution";
import * as launcherService from "./launcher";
import { buildExecutiveObservationSummary, chooseConservativeDispatchMax, createExecutiveReportSummary, deriveLoopStatusRecommendation } from "./executive-manager";
import { FileRuntimePersistence, InMemoryRuntimePersistence, normalizeSnapshot, type RuntimePersistence } from "./persistence";
import { createAgentRuntimeFromEnv, createProviderThrottleFromEnv, createRuntimeProviderMap, type RuntimeProviderMap } from "./provider-registry";
import { ProviderThrottle } from "./provider-throttle";
import { PrismaRuntimePersistence } from "./prisma";
import { projectOrganizationalState, unlockReadyOperations } from "./projector";
import { isActiveRun } from "./runs";
import { calculateSnapshotOperationReadiness, resolveReadyOperations } from "./scheduler";
import type {
  AgentProviderName,
  AgentFailureCategory,
  AgentRepairBrief,
  AgentRunAttempt,
  AgentRun,
  AgentRuntime,
  ExecutiveLoop,
  ExecutiveIntentProvider,
  ExecutiveManagerDecision,
  ExecutiveProjectPlan,
  ExecutiveProposal,
  ExecutiveProposalAction,
  ExecutiveProposalDraft,
  ExecutiveUserQuestion,
  ForgeSnapshot,
  Operation,
  ProviderArtifactDeclaration,
  ProviderArtifactRequestDeclaration,
  ProviderBlockerDeclaration,
  ProviderDangerousActionDeclaration,
  ProviderDependencyRequestDeclaration,
  ProviderDependencyRequestType,
  ProviderFileDeclaration,
  ProviderFilePatchDeclaration,
  ProviderFileReadRequestDeclaration,
  ProviderFileSearchRequestDeclaration,
  ProviderHandoffDeclaration,
  ProviderPromptPackage,
  ProviderRecoveryActionDeclaration,
  ProviderVerificationEvidenceDeclaration,
  ProviderWorkerQuestionRequestDeclaration,
  ProviderRunOutputDeclarations,
  RunContextAccounting,
  RunContextCheckpoint,
  RunTraceSummary,
  RuntimeVerificationHook,
  RuntimeVerificationSummary,
  RuntimeCommand,
  RuntimeEvent,
  RuntimeEventDraft,
  RuntimeStatus,
  OperationDependency,
  VirtualFile
} from "./types";

const commandSchema = z.object({
  type: z.enum([
    "initialize_forge",
    "start_phase",
    "run_operation",
    "scheduler_tick",
    "run_bounded_cycle",
    "run_full_flow",
    "connect_repository",
    "disconnect_repository",
    "refresh_repository_context",
    "sync_repository",
    "pause_forge",
    "resume_forge",
    "shutdown_forge",
    "set_openai_spend_limit",
    "reset_demo_state",
    "operator_message",
    "propose_operation_changes",
    "apply_operation_proposal",
    "reject_operation_proposal",
    "approve_executive_review",
    "reject_executive_review",
    "answer_worker_question",
    "escalate_worker_question",
    "approve_dependency_request",
    "reject_dependency_request",
    "escalate_dependency_request",
    "start_executive_loop",
    "continue_executive_loop",
    "pause_executive_loop",
    "resume_executive_loop",
    "answer_executive_question",
    "run_project_check",
    "start_project_preview",
    "stop_project_preview"
  ]),
  forgeId: z.string().optional(),
  operationId: z.string().optional(),
  phase: z.string().max(80).optional(),
  message: z.string().max(2000).optional(),
  promptFileId: z.string().max(160).optional(),
  promptFilePath: z.string().max(240).optional(),
  proposalId: z.string().max(160).optional(),
  maxRuns: z.number().int().min(1).max(25).optional(),
  dispatchPolicy: z.literal("single_ready").optional(),
  repositoryUrl: z.string().max(300).optional(),
  provider: z.literal("github").optional(),
  agentProvider: z.enum(["mock", "openclaw", "codex", "nemoclaw"]).optional(),
  owner: z.string().max(80).optional(),
  repo: z.string().max(120).optional(),
  defaultBranch: z.string().max(255).optional(),
  workingBranch: z.string().max(255).optional(),
  ref: z.string().max(255).optional(),
  installationId: z.string().max(120).optional(),
  accountRef: z.string().max(160).optional(),
  openaiSpendLimitUsd: z.number().min(0).max(1_000_000).nullable().optional(),
  reviewId: z.string().max(240).optional(),
  dependencyRequestId: z.string().max(240).optional(),
  workerQuestionId: z.string().max(240).optional(),
  questionId: z.string().trim().min(1).max(160).optional(),
  selectedOptionIds: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
  notes: z.string().trim().max(2000).optional(),
  idempotencyKey: z.string().max(120).optional(),
  launcherTier: z.enum(["development", "acceptance"]).optional(),
  launcherScript: z.enum(["auto", "test", "typecheck", "lint", "build", "smoke", "e2e"]).optional(),
  previewScript: z.enum(["auto", "dev", "start", "preview"]).optional(),
  launcherId: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_.-]+$/).optional()
});

const executiveProposalActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_worker"),
    name: z.string().trim().min(1).max(120),
    role: z.string().trim().min(1).max(160),
    divisionId: z.string().trim().min(1).max(120),
    currentTask: z.string().trim().min(1).max(240).optional(),
    status: z.enum(["idle", "planning", "ready"]).optional()
  }),
  z.object({
    type: z.literal("create_operation"),
    operationKey: z.string().trim().min(1).max(120).optional(),
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1000),
    divisionId: z.string().trim().min(1).max(120),
    workerId: z.string().trim().min(1).max(120).optional(),
    workerName: z.string().trim().min(1).max(120).optional(),
    priority: z.enum(["low", "normal", "high", "critical"]).optional(),
    status: z.enum(["planning", "ready", "blocked"]).optional(),
    routingStage: z.enum(["executive_planned", "lead_triaged", "worker_ready", "running", "done"]).optional(),
    webAccessPolicy: z.enum(["none", "allowed", "required"]).optional(),
    webAccessPurpose: z.string().trim().min(1).max(500).optional(),
    allowedDomains: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    dependsOnOperationIds: z.array(z.string().trim().min(1).max(240)).max(8).optional(),
    dependsOnOperationKeys: z.array(z.string().trim().min(1).max(120)).max(8).optional()
  }),
  z.object({
    type: z.literal("update_operation"),
    operationId: z.string().trim().min(1).max(240),
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().min(1).max(1000).optional(),
    divisionId: z.string().trim().min(1).max(120).optional(),
    workerId: z.string().trim().min(1).max(120).optional(),
    priority: z.enum(["low", "normal", "high", "critical"]).optional(),
    status: z.enum(["planning", "ready", "blocked"]).optional(),
    blockedReason: z.string().trim().min(1).max(500).optional(),
    routingStage: z.enum(["executive_planned", "lead_triaged", "worker_ready", "running", "done"]).optional(),
    webAccessPolicy: z.enum(["none", "allowed", "required"]).optional(),
    webAccessPurpose: z.string().trim().min(1).max(500).optional(),
    allowedDomains: z.array(z.string().trim().min(1).max(120)).max(20).optional()
  }),
  z.object({
    type: z.literal("delete_operation"),
    operationId: z.string().trim().min(1).max(240),
    reason: z.string().trim().min(1).max(500)
  }),
  z.object({
    type: z.literal("create_handoff"),
    fromDivisionId: z.string().trim().min(1).max(120),
    toDivisionId: z.string().trim().min(1).max(120),
    targetOperationId: z.string().trim().min(1).max(240).optional(),
    summary: z.string().trim().min(1).max(500),
    deliverables: z.array(z.string().trim().min(1).max(160)).max(8).optional(),
    blockers: z.array(z.string().trim().min(1).max(160)).max(8).optional(),
    requiredContext: z.array(z.string().trim().min(1).max(160)).max(8).optional(),
    confidence: z.number().int().min(0).max(100).optional()
  }),
  z.object({
    type: z.literal("create_blocker"),
    operationId: z.string().trim().min(1).max(240),
    reason: z.string().trim().min(1).max(500),
    severity: z.enum(["info", "success", "warning", "error"]).optional()
  })
]);

const executiveProposalDraftSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  actions: z.array(executiveProposalActionSchema).max(8),
  supersedesProposalIds: z.array(z.string().trim().min(1).max(160)).max(8).optional()
});

class ExecutiveProposalQualityError extends Error {
  constructor(readonly issues: string[]) {
    super(`Executive proposal needs revision before approval: ${issues.join(" ")}`);
    this.name = "ExecutiveProposalQualityError";
  }
}

const executiveManagerDecisionSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  projectStatus: z.enum(["planning", "running", "blocked", "ready_for_test", "completed"]),
  userReport: z.string().trim().min(1).max(2000),
  planPatch: z
    .object({
      successCriteria: z.array(z.string().trim().min(1).max(240)).max(12).optional(),
      assumptions: z.array(z.string().trim().min(1).max(240)).max(12).optional(),
      phases: z
        .array(
          z.object({
            title: z.string().trim().min(1).max(160),
            objective: z.string().trim().min(1).max(500),
            divisionIds: z.array(z.string().trim().min(1).max(120)).max(8).optional()
          })
        )
        .max(8)
        .optional(),
      risks: z.array(z.string().trim().min(1).max(240)).max(12).optional(),
      testStrategy: z.array(z.string().trim().min(1).max(240)).max(12).optional()
    })
    .optional(),
  operationActions: z.array(executiveProposalActionSchema).max(12),
  dispatchPolicy: z.object({
    maxRuns: z.number().int().min(0).max(25),
    targetDivisionIds: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
    priority: z.enum(["critical_first", "balanced", "qa_first"]).optional()
  }),
  userQuestion: z
    .object({
      reason: z.string().trim().min(1).max(500),
      question: z.string().trim().min(1).max(500),
      options: z
        .array(
          z.object({
            id: z.string().trim().min(1).max(120),
            label: z.string().trim().min(1).max(160),
            description: z.string().trim().min(1).max(300).optional()
          })
        )
        .max(6)
        .optional(),
      allowNotes: z.boolean().optional()
    })
    .optional()
});

const MAX_PROMPT_FILE_CHARS = 80_000;
const MAX_FILE_REQUEST_PASSES = 3;
const MAX_REQUESTED_FILES_PER_PASS = 8;
const MAX_REQUESTED_SEARCHES_PER_PASS = 5;
const MAX_REQUESTED_ARTIFACTS_PER_PASS = 6;
const MAX_REQUESTED_FILE_EXCERPT_CHARS = 20_000;
const MAX_REQUESTED_ARTIFACT_SUMMARY_CHARS = 1_200;
const MAX_SEARCH_RESULTS_PER_REQUEST = 12;
const MAX_SEARCH_SNIPPET_CHARS = 600;
const CHARS_PER_ESTIMATED_TOKEN = 4;
const MAX_SELF_REPAIR_RETRIES = 2;

const createForgeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  template: z.enum(["empty", "demo"]).optional()
});

const upsertVirtualFileSchema = z.object({
  path: z.string().trim().min(1).max(240),
  content: z.string().max(200_000),
  divisionId: z.string().trim().min(1).max(120).optional(),
  workerId: z.string().trim().min(1).max(120).optional(),
  operationId: z.string().trim().min(1).max(120).optional()
});

const deleteForgesSchema = z.object({
  slugs: z.array(z.string().trim().min(1).max(120)).min(1).max(100)
});

export { RuntimeCommandError } from "./errors";

export class RuntimeStore {
  private readonly forgeQueues = new Map<string, Promise<void>>();
  private readonly startedRunIds = new Set<string>();
  private readonly activeCycleForges = new Set<string>();
  private readonly agentRuntimes: RuntimeProviderMap;

  constructor(
    private readonly persistence: RuntimePersistence = createDefaultPersistence(),
    private readonly agentRuntime: AgentRuntime = createAgentRuntimeFromEnv(),
    private readonly executiveIntentProvider: ExecutiveIntentProvider = new OpenAIExecutiveIntentProvider(),
    private readonly providerThrottle: ProviderThrottle = createProviderThrottleFromEnv(),
    private readonly runtimeVerificationHook: RuntimeVerificationHook = createDefaultRuntimeVerificationHook()
  ) {
    this.agentRuntimes = createRuntimeProviderMap(agentRuntime);
  }

  getAgentRuntimeCapabilities() {
    return this.agentRuntime.capabilities();
  }

  getStorageInfo() {
    const resettable =
      process.env.NODE_ENV !== "production" &&
      Boolean(this.persistence.clear) &&
      (this.persistence.mode !== "database" || allowsDatabaseStorageReset());

    return {
      mode: this.persistence.mode,
      resettable,
      visible: process.env.NODE_ENV !== "production"
    };
  }

  async listForges() {
    return this.persistence.listForges();
  }

  async clearLocalForges() {
    const storage = this.getStorageInfo();
    if (!storage.resettable || !this.persistence.clear) {
      throw new RuntimeCommandError("Forge storage reset is available only in development storage modes that support clearing.", 403);
    }

    await this.persistence.clear();
  }

  async deleteForges(input: unknown) {
    const { slugs } = deleteForgesSchema.parse(input);
    const uniqueSlugs = Array.from(new Set(slugs));
    const snapshots = (
      await Promise.all(
        uniqueSlugs.map(async (slug) => {
          try {
            return await this.persistence.loadSnapshot(slug);
          } catch {
            return null;
          }
        })
      )
    ).filter((snapshot): snapshot is ForgeSnapshot => Boolean(snapshot));
    const deletedSlugs: string[] = [];
    for (const slug of uniqueSlugs) {
      if (await this.persistence.deleteForge(slug)) {
        deletedSlugs.push(slug);
      }
    }
    const deletedSlugSet = new Set(deletedSlugs);
    const cleanup = await cleanupDeletedForgeWorkspaces(snapshots.filter((snapshot) => deletedSlugSet.has(snapshot.forge.slug)));

    return {
      deletedSlugs,
      workspaceCleanup: cleanup,
      forges: await this.persistence.listForges()
    };
  }

  async connectGitHubAccount(forgeSlug: string, input: { accountLogin: string; accountId: string; scopes: string[]; tokenType: string; encryptedAccessToken: string }) {
    const snapshot = await this.loadSnapshot(forgeSlug);
    const timestamp = new Date().toISOString();
    await this.persistence.saveGitHubConnection({
      forgeId: snapshot.forge.id,
      accountLogin: input.accountLogin,
      accountId: input.accountId,
      scopes: input.scopes,
      tokenType: input.tokenType,
      encryptedAccessToken: input.encryptedAccessToken,
      connectedAt: timestamp,
      updatedAt: timestamp
    });
    const repository = snapshot.repository
      ? {
          ...snapshot.repository,
          authenticatedAccountLogin: input.accountLogin
        }
      : undefined;
    const nextSnapshot = appendEvents({ ...snapshot, repository }, [
      {
        forgeId: snapshot.forge.id,
        type: "github.connected",
        actorType: "operator",
        targetType: "repository",
        targetId: snapshot.repository?.id,
        message: `GitHub account ${input.accountLogin} connected.`,
        severity: "success",
        payload: { accountLogin: input.accountLogin, scopes: input.scopes }
      }
    ]);
    await this.persistence.saveSnapshot(nextSnapshot);
    return {
      accountLogin: input.accountLogin,
      scopes: input.scopes,
      connectedAt: timestamp
    };
  }

  async getGitHubAccount(forgeSlug: string) {
    const snapshot = await this.loadSnapshot(forgeSlug);
    const connection = await this.persistence.loadGitHubConnection(snapshot.forge.id);
    return connection
      ? {
          accountLogin: connection.accountLogin,
          accountId: connection.accountId,
          scopes: connection.scopes,
          connectedAt: connection.connectedAt,
          updatedAt: connection.updatedAt
        }
      : null;
  }

  async listGitHubRepositories(forgeSlug: string): Promise<GitHubRepositorySummary[]> {
    const accessToken = await this.getGitHubAccessToken(forgeSlug);
    return listGitHubRepositories(accessToken);
  }

  async syncGitHubRepository(forgeSlug: string, input: { owner: string; repo: string; ref?: string; idempotencyKey?: string }) {
    return this.dispatch(forgeSlug, {
      type: "sync_repository",
      owner: input.owner,
      repo: input.repo,
      ref: input.ref,
      workingBranch: input.ref,
      idempotencyKey: input.idempotencyKey
    });
  }

  async upsertVirtualFile(forgeSlug: string, input: unknown) {
    const parsed = upsertVirtualFileSchema.parse(input);
    return this.enqueueForgeCommand(forgeSlug, async () => {
      const snapshot = await this.loadSnapshot(forgeSlug);
      const path = normalizeVirtualPath(parsed.path);
      const existing = snapshot.files.find((file) => file.path === path);
      const timestamp = new Date().toISOString();
      const file = {
        id: existing?.id ?? `${snapshot.forge.slug}-operator-file-${stableIdForPath(path)}-${Date.now()}`,
        path,
        content: parsed.content,
        status: "generated" as const,
        version: existing ? existing.version + 1 : 1,
        divisionId: parsed.divisionId ?? existing?.divisionId,
        workerId: parsed.workerId ?? existing?.workerId,
        operationId: parsed.operationId ?? existing?.operationId,
        artifactIds: existing?.artifactIds ?? [],
        updatedAt: timestamp
      };
      const nextSnapshot = appendEvents(
        {
          ...snapshot,
          files: [...snapshot.files.filter((candidate) => candidate.id !== file.id), file]
        },
        [
          {
            forgeId: snapshot.forge.id,
            type: "file.updated",
            actorType: "operator",
            targetType: "file",
            targetId: file.id,
            message: `Operator saved workspace file: ${file.path}.`,
            severity: "success",
            payload: { fileId: file.id, path: file.path, version: file.version }
          }
        ]
      );
      await this.persistence.saveSnapshot(nextSnapshot);
      return structuredClone(file);
    });
  }

  async createForge(input: unknown) {
    const { name, template = "empty" } = createForgeSchema.parse(input);
    const slug = slugifyForgeName(name);

    if (!slug) {
      throw new RuntimeCommandError("Forge name must include letters or numbers.", 400);
    }

    const existing = await this.persistence.loadSnapshot(slug);
    if (existing) {
      throw new RuntimeCommandError("A Forge with this slug already exists.", 409);
    }

    const snapshotInput = {
      id: `forge-${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      slug,
      name,
      prefixEntityIds: true
    };
    const snapshot =
      template === "demo"
        ? createForgeSnapshot(snapshotInput)
        : createEmptyForgeSnapshot(snapshotInput);

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
    if (command.type === "run_bounded_cycle" && this.activeCycleForges.has(forgeSlug)) {
      throw new RuntimeCommandError("A bounded team loop is already active for this Forge.", 409);
    }
    let cycleId: string | undefined;
    return this.enqueueForgeCommand(forgeSlug, async () => {
      const snapshot = await this.loadSnapshot(forgeSlug);

      if (command.idempotencyKey && (await this.persistence.hasIdempotencyKey(snapshot.forge.id, command.idempotencyKey))) {
        return structuredClone(snapshot);
      }

      const existingRunIds = new Set(snapshot.runs.map((run) => run.id));
      const nextSnapshot = await this.handleCommand(snapshot, command);
      if (command.type === "run_bounded_cycle") {
        cycleId = getLatestCycleId(nextSnapshot);
      }

      if (command.idempotencyKey) {
        await this.persistence.recordIdempotencyKey(snapshot.forge.id, command.idempotencyKey);
      }

      await this.persistence.saveSnapshot(nextSnapshot);
      this.startQueuedRuns(forgeSlug, nextSnapshot, existingRunIds);
      if (command.type === "run_bounded_cycle" && cycleId) {
        this.startBoundedCycle(forgeSlug, cycleId, command.maxRuns ?? 5);
      }
      return structuredClone(nextSnapshot);
    });
  }

  private async enqueueForgeCommand<T>(forgeSlug: string, task: () => Promise<T>) {
    const previous = this.forgeQueues.get(forgeSlug) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.forgeQueues.set(forgeSlug, queued);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.forgeQueues.get(forgeSlug) === queued) {
        this.forgeQueues.delete(forgeSlug);
      }
    }
  }

  private async loadSnapshot(forgeSlug: string) {
    const snapshot = await this.persistence.loadSnapshot(forgeSlug);
    if (!snapshot) {
      throw new RuntimeCommandError("Forge not found.", 404);
    }

    return normalizeSnapshot(snapshot);
  }

  private async getGitHubAccessToken(forgeSlug: string) {
    const snapshot = await this.loadSnapshot(forgeSlug);
    const connection = await this.persistence.loadGitHubConnection(snapshot.forge.id);
    if (!connection) {
      throw new RuntimeCommandError("GitHub account is not connected.", 401);
    }

    try {
      return decryptSecret(connection.encryptedAccessToken);
    } catch {
      throw new RuntimeCommandError("GitHub token could not be decrypted.", 500);
    }
  }

  private async handleCommand(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    switch (command.type) {
      case "initialize_forge":
      case "reset_demo_state":
        return this.reset(snapshot, command.type);
      case "start_phase":
        return this.startPhase(snapshot, command.phase ?? "Autonomous Development");
      case "run_operation":
        return this.runOperation(snapshot, command.operationId, command.agentProvider);
      case "scheduler_tick":
        return this.schedulerTick(snapshot);
      case "run_bounded_cycle":
        return this.runBoundedCycle(snapshot, command);
      case "run_full_flow":
        return this.runFullFlow(snapshot);
      case "connect_repository":
        return this.connectRepository(snapshot, command);
      case "disconnect_repository":
        return this.disconnectRepository(snapshot);
      case "refresh_repository_context":
        return this.refreshRepositoryContext(snapshot);
      case "sync_repository":
        return this.syncRepository(snapshot, command);
      case "pause_forge":
      case "shutdown_forge":
        return this.pauseForge(snapshot);
      case "resume_forge":
        return this.resumeForge(snapshot);
      case "set_openai_spend_limit":
        if (command.openaiSpendLimitUsd === undefined) {
          throw new RuntimeCommandError("OpenAI spend limit must be a number or null.", 400);
        }
        return this.setOpenAISpendLimit(snapshot, command.openaiSpendLimitUsd);
      case "operator_message":
        return this.addOperatorMessage(snapshot, resolveCommandMessage(snapshot, command));
      case "propose_operation_changes":
        return this.proposeOperationChanges(snapshot, resolveCommandMessage(snapshot, command));
      case "apply_operation_proposal":
        return this.applyOperationProposal(snapshot, command.proposalId);
      case "reject_operation_proposal":
        return this.rejectOperationProposal(snapshot, command.proposalId);
      case "approve_executive_review":
        return this.resolveExecutiveReview(snapshot, command.reviewId, "approved");
      case "reject_executive_review":
        return this.resolveExecutiveReview(snapshot, command.reviewId, "rejected");
      case "answer_worker_question":
        return this.answerWorkerQuestion(snapshot, command);
      case "escalate_worker_question":
        return this.escalateWorkerQuestion(snapshot, command);
      case "approve_dependency_request":
        return this.approveDependencyRequest(snapshot, command);
      case "reject_dependency_request":
        return this.rejectDependencyRequest(snapshot, command);
      case "escalate_dependency_request":
        return this.escalateDependencyRequest(snapshot, command);
      case "start_executive_loop":
        return this.startExecutiveLoop(snapshot, command);
      case "continue_executive_loop":
        return this.continueExecutiveLoop(snapshot);
      case "pause_executive_loop":
        return this.pauseExecutiveLoop(snapshot);
      case "resume_executive_loop":
        return this.resumeExecutiveLoop(snapshot);
      case "answer_executive_question":
        return this.answerExecutiveQuestion(snapshot, command);
      case "run_project_check":
        return this.runProjectLauncherCheck(snapshot, command);
      case "start_project_preview":
        return this.startProjectLauncherPreview(snapshot, command);
      case "stop_project_preview":
        return this.stopProjectLauncherPreview(snapshot, command);
    }
  }

  private async runProjectLauncherCheck(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    const launcherId = command.launcherId ?? launcherService.createLauncherId();
    const result = await launcherService.runProjectCheck(snapshot, {
      workspaceRoot: launcherService.getDefaultLauncherWorkspaceRoot(),
      launcherId,
      tier: command.launcherTier ?? "development",
      script: command.launcherScript ?? "auto"
    });
    return appendEvents(snapshot, result.events);
  }

  private async startProjectLauncherPreview(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    const launcherId = command.launcherId ?? launcherService.createLauncherId();
    const result = await launcherService.startProjectPreview(snapshot, {
      workspaceRoot: launcherService.getDefaultLauncherWorkspaceRoot(),
      launcherId,
      script: command.previewScript ?? "auto"
    });
    return appendEvents(snapshot, result.events);
  }

  private async stopProjectLauncherPreview(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    const result = await launcherService.stopProjectPreview(snapshot, {
      launcherId: command.launcherId ?? launcherService.createLauncherId()
    });
    return appendEvents(snapshot, result.events);
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

  private async runOperation(snapshot: ForgeSnapshot, operationId?: string, agentProvider?: AgentProviderName) {
    const operation = snapshot.operations.find((candidate) => candidate.id === operationId);

    if (!operation) {
      throw new RuntimeCommandError("No operation selected.", 400);
    }

    const unlocked = unlockReadyOperations(snapshot);
    const runnableSnapshot = unlocked.events.length > 0 ? appendEvents(unlocked.snapshot, unlocked.events) : snapshot;
    this.assertOperationCanRun(runnableSnapshot, operation.id);
    return this.enqueueOperationRun(runnableSnapshot, operation.id, agentProvider);
  }

  private schedulerTick(snapshot: ForgeSnapshot) {
    if (snapshot.forge.status !== "active") {
      return appendEvents(snapshot, [
        {
          forgeId: snapshot.forge.id,
          type: "operation.blocked",
          actorType: "runtime",
          targetType: "forge",
          targetId: snapshot.forge.id,
          message: "Scheduler tick skipped because the Forge is not active.",
          severity: "warning",
          payload: { forgeStatus: snapshot.forge.status, dispatchedOperationIds: [] }
        }
      ]);
    }

    const cycleRepair = repairBlockingDependencyCycles(snapshot);
    const cycleRepairSnapshot = cycleRepair.events.length > 0 ? appendEvents(cycleRepair.snapshot, cycleRepair.events) : cycleRepair.snapshot;
    const repaired = ensureMissingPrerequisiteOperations(cycleRepairSnapshot);
    const repairedSnapshot = repaired.events.length > 0 ? appendEvents(repaired.snapshot, repaired.events) : repaired.snapshot;
    const postRepairCycleRepair = repairBlockingDependencyCycles(repairedSnapshot);
    const cycleSafeSnapshot = postRepairCycleRepair.events.length > 0 ? appendEvents(postRepairCycleRepair.snapshot, postRepairCycleRepair.events) : postRepairCycleRepair.snapshot;
    const unlocked = unlockReadyOperations(cycleSafeSnapshot);
    const unlockedSnapshot = unlocked.events.length > 0 ? appendEvents(unlocked.snapshot, unlocked.events) : cycleSafeSnapshot;
    const gated = blockUnreadyReadyOperations(unlockedSnapshot);
    const schedulingSnapshot = gated.events.length > 0 ? appendEvents(gated.snapshot, gated.events) : unlockedSnapshot;
    const activeRuns = schedulingSnapshot.runs.filter((run) => isActiveRun(run));
    const selected = this.selectSchedulableOperations(schedulingSnapshot);
    if (selected.length === 0) {
      return appendEvents(schedulingSnapshot, [
        {
          forgeId: schedulingSnapshot.forge.id,
          type: "operation.blocked",
          actorType: "runtime",
          targetType: "forge",
          targetId: schedulingSnapshot.forge.id,
          message: activeRuns.length >= readSchedulerSlotTarget() ? "Scheduler tick found no available run slots." : "Scheduler tick found no eligible operations.",
          severity: "info",
          payload: { dispatchedOperationIds: [], activeRunCount: activeRuns.length, maxConcurrentRuns: readSchedulerSlotTarget() }
        }
      ]);
    }

    return selected.reduce((current, operation) => this.enqueueOperationRun(current, operation.id, undefined, { autofillOnCompletion: true }), schedulingSnapshot);
  }

  private runBoundedCycle(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    const maxRuns = command.maxRuns ?? 5;
    const activeRuns = snapshot.runs.filter((run) => isActiveRun(run));
    const cycleId = `${snapshot.forge.slug}-cycle-${Date.now()}`;

    if (activeRuns.length > 0) {
      return appendEvents(snapshot, [
        {
          forgeId: snapshot.forge.id,
          type: "cycle.completed",
          actorType: "runtime",
          targetType: "forge",
          targetId: snapshot.forge.id,
          message: "Bounded team loop skipped because an operation run is already active.",
          severity: "warning",
          payload: { cycleId, maxRuns, completedRuns: 0, stopReason: "active_run_present" }
        }
      ]);
    }

    return appendEvents(snapshot, [
      {
        forgeId: snapshot.forge.id,
        type: "cycle.started",
        actorType: "runtime",
        targetType: "forge",
        targetId: snapshot.forge.id,
        message: `Bounded team loop started for up to ${maxRuns} run${maxRuns === 1 ? "" : "s"}.`,
        severity: "info",
        payload: { cycleId, maxRuns, dispatchPolicy: command.dispatchPolicy ?? "single_ready" }
      }
    ]);
  }

  private startBoundedCycle(forgeSlug: string, cycleId: string, maxRuns: number) {
    if (this.activeCycleForges.has(forgeSlug)) {
      return;
    }

    this.activeCycleForges.add(forgeSlug);
    void this.executeBoundedCycle(forgeSlug, cycleId, maxRuns)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : "Bounded team loop failed.";
        await this.enqueueForgeCommand(forgeSlug, async () => {
          const snapshot = await this.loadSnapshot(forgeSlug);
          await this.persistence.saveSnapshot(this.finishCycle(snapshot, cycleId, maxRuns, 0, "failed", message));
        });
      })
      .finally(() => {
        this.activeCycleForges.delete(forgeSlug);
      });
  }

  private async executeBoundedCycle(forgeSlug: string, cycleId: string, maxRuns: number) {
    let completedRuns = 0;

    for (let index = 0; index < maxRuns; index += 1) {
      const queuedRun = await this.enqueueForgeCommand(forgeSlug, async () => {
        const snapshot = await this.loadSnapshot(forgeSlug);
        const activeRuns = snapshot.runs.filter((run) => isActiveRun(run));

        if (snapshot.forge.status === "paused") {
          await this.persistence.saveSnapshot(this.finishCycle(snapshot, cycleId, maxRuns, completedRuns, "paused", "Bounded team loop stopped because the Forge is paused."));
          return null;
        }

        if (snapshot.forge.status !== "active") {
          await this.persistence.saveSnapshot(this.finishCycle(snapshot, cycleId, maxRuns, completedRuns, "blocked", "Bounded team loop stopped because the Forge is not active."));
          return null;
        }

        if (activeRuns.length > 0) {
          await this.persistence.saveSnapshot(
            this.finishCycle(snapshot, cycleId, maxRuns, completedRuns, "active_run_present", "Bounded team loop stopped because an operation run is already active.")
          );
          return null;
        }

        const cycleRepair = repairBlockingDependencyCycles(snapshot);
        const cycleRepairSnapshot = cycleRepair.events.length > 0 ? appendEvents(cycleRepair.snapshot, cycleRepair.events) : cycleRepair.snapshot;
        const repaired = ensureMissingPrerequisiteOperations(cycleRepairSnapshot);
        const repairedSnapshot = repaired.events.length > 0 ? appendEvents(repaired.snapshot, repaired.events) : repaired.snapshot;
        const postRepairCycleRepair = repairBlockingDependencyCycles(repairedSnapshot);
        const cycleSafeSnapshot = postRepairCycleRepair.events.length > 0 ? appendEvents(postRepairCycleRepair.snapshot, postRepairCycleRepair.events) : postRepairCycleRepair.snapshot;
        const unlocked = unlockReadyOperations(cycleSafeSnapshot);
        const unlockedSnapshot = unlocked.events.length > 0 ? appendEvents(unlocked.snapshot, unlocked.events) : cycleSafeSnapshot;
        const gated = blockUnreadyReadyOperations(unlockedSnapshot);
        const schedulingSnapshot = gated.events.length > 0 ? appendEvents(gated.snapshot, gated.events) : unlockedSnapshot;
        const operation = resolveReadyOperations(schedulingSnapshot)[0];
        if (!operation) {
          await this.persistence.saveSnapshot(
            this.finishCycle(schedulingSnapshot, cycleId, maxRuns, completedRuns, "no_ready_operations", "Bounded team loop stopped because no ready operations remain.")
          );
          return null;
        }

        const existingRunIds = new Set(schedulingSnapshot.runs.map((run) => run.id));
        const nextSnapshot = this.enqueueOperationRun(schedulingSnapshot, operation.id);
        const run = nextSnapshot.runs.find((candidate) => !existingRunIds.has(candidate.id)) ?? null;
        await this.persistence.saveSnapshot(nextSnapshot);
        this.startQueuedRuns(forgeSlug, nextSnapshot, existingRunIds);
        return run;
      });

      if (!queuedRun) {
        return;
      }

      const terminalRun = await this.waitForTerminalRun(forgeSlug, queuedRun.id);
      completedRuns += 1;

      await this.enqueueForgeCommand(forgeSlug, async () => {
        const snapshot = await this.loadSnapshot(forgeSlug);
        const progressSnapshot = appendEvents(snapshot, [
          {
            forgeId: snapshot.forge.id,
            type: "cycle.progress",
            actorType: "runtime",
            targetType: "run",
            targetId: terminalRun.id,
            message: `Bounded team loop completed ${completedRuns} run${completedRuns === 1 ? "" : "s"}.`,
            severity: terminalRun.status === "completed" ? "success" : "warning",
            payload: { cycleId, maxRuns, completedRuns, runId: terminalRun.id, operationId: terminalRun.operationId, status: terminalRun.status }
          }
        ]);
        await this.persistence.saveSnapshot(progressSnapshot);
      });

      if (terminalRun.status === "failed" || terminalRun.status === "canceled") {
        await this.enqueueForgeCommand(forgeSlug, async () => {
          const snapshot = await this.loadSnapshot(forgeSlug);
          await this.persistence.saveSnapshot(
            this.finishCycle(
              snapshot,
              cycleId,
              maxRuns,
              completedRuns,
              terminalRun.status,
              `Bounded team loop stopped because run ${terminalRun.id} ${terminalRun.status}.`
            )
          );
        });
        return;
      }
    }

    await this.enqueueForgeCommand(forgeSlug, async () => {
      const snapshot = await this.loadSnapshot(forgeSlug);
      await this.persistence.saveSnapshot(
        this.finishCycle(snapshot, cycleId, maxRuns, completedRuns, "max_runs_reached", `Bounded team loop stopped after ${completedRuns} run${completedRuns === 1 ? "" : "s"}.`)
      );
    });
  }

  private async waitForTerminalRun(forgeSlug: string, runId: string) {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const snapshot = await this.loadSnapshot(forgeSlug);
      const run = snapshot.runs.find((candidate) => candidate.id === runId);
      if (run && !isActiveRun(run)) {
        return run;
      }
      await delay(50);
    }

    throw new RuntimeCommandError("Bounded team loop timed out waiting for a run to finish.", 504);
  }

  private finishCycle(snapshot: ForgeSnapshot, cycleId: string, maxRuns: number, completedRuns: number, stopReason: string, message: string) {
    const eventStartSequence = findCycleStartSequence(snapshot, cycleId);
    const eventEndSequence = snapshot.lastEventSequence + 2;
    return appendEvents(addExecutiveSummary(snapshot, {
      source: "cycle_terminal",
      scope: "cycle",
      status: stopReason,
      cycleId,
      eventStartSequence,
      eventEndSequence,
      content: `${message} ${completedRuns}/${maxRuns} runs completed.`,
      metricDeltas: { completedRuns, maxRuns }
    }), [
      {
        forgeId: snapshot.forge.id,
        type: "cycle.completed",
        actorType: "runtime",
        targetType: "forge",
        targetId: snapshot.forge.id,
        message,
        severity: stopReason === "max_runs_reached" || stopReason === "no_ready_operations" ? "success" : "warning",
        payload: { cycleId, maxRuns, completedRuns, stopReason }
      },
      {
        forgeId: snapshot.forge.id,
        type: "executive.summary_created",
        actorType: "executive",
        targetType: "forge",
        targetId: snapshot.forge.id,
        message: "Executive summary created for bounded team loop.",
        severity: "info",
        payload: { cycleId, source: "cycle_terminal", status: stopReason, eventStartSequence, eventEndSequence }
      }
    ]);
  }

  private enqueueOperationRun(snapshot: ForgeSnapshot, operationId: string, agentProvider?: AgentProviderName, options: { autofillOnCompletion?: boolean } = {}) {
    const operation = snapshot.operations.find((candidate) => candidate.id === operationId);

    if (!operation) {
      throw new RuntimeCommandError("No operation selected.", 400);
    }

    const runtime = this.getAgentRuntime(agentProvider);
    assertOpenAISpendAvailable(snapshot, runtime.provider());
    if (operation.webAccessPolicy === "required" && !runtime.capabilities().supportsWebSearch) {
      throw new RuntimeCommandError(`${runtime.provider()} does not support required web search for this operation. Route it to a web-capable provider or relax the web policy.`, 409);
    }
    const timestamp = new Date().toISOString();
    const run: AgentRun = {
      id: `${snapshot.forge.slug}-run-${operation.id}-${Date.now()}`,
      forgeId: snapshot.forge.id,
      operationId: operation.id,
      workerId: operation.workerId,
      provider: runtime.provider(),
      status: "queued",
      capabilities: runtime.capabilities(),
      queuedAt: timestamp,
      providerMetadata: options.autofillOnCompletion ? { schedulerAutofill: true } : {}
    };

    const baseSnapshot = {
      ...snapshot,
      runs: [...snapshot.runs, run],
      operations: snapshot.operations.map((candidate) =>
        candidate.id === operation.id
          ? {
              ...candidate,
              status: "running" as const,
              routingStage: "running" as const,
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
    const accepted = acceptMatchingHandoffs(baseSnapshot, operation, run, timestamp);
    const nextSnapshot = projectOrganizationalState(accepted.snapshot);

    const runtimeEvents: RuntimeEventDraft[] = [
      ...accepted.events,
      {
        forgeId: snapshot.forge.id,
        type: "run.queued",
        actorType: "runtime",
        targetType: "run",
        targetId: run.id,
        message: `${operation.title} queued for ${run.provider} execution.`,
        severity: "info",
        payload: { runId: run.id, operationId: operation.id, workerId: operation.workerId, provider: run.provider }
      }
    ];
    return appendEvents(nextSnapshot, runtimeEvents);
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

      const projected = {
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
      };

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
    const activeRuns = snapshot.runs.filter(isActiveRun);
    const canceledAt = new Date().toISOString();
    await Promise.allSettled(activeRuns.map((run) => this.getAgentRuntime(run.provider).cancelOperation(run.operationId)));
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
        status: operation.status === "running" ? ("ready" as const) : operation.status,
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
        ),
        runs: snapshot.runs.map((run) =>
          activeRuns.some((activeRun) => activeRun.id === run.id)
            ? {
                ...run,
                status: "canceled" as const,
                canceledAt,
                error: "Run canceled because the Forge was paused.",
                providerMetadata: mergeTraceSummary(run.providerMetadata, {
                  lifecycle: {
                    provider: run.provider,
                    status: "canceled",
                    canceledAt
                  }
                })
              }
            : run
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
            canceledRunIds: activeRuns.map((run) => run.id),
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

      const readiness = calculateSnapshotOperationReadiness(snapshot, operation);
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

  private setOpenAISpendLimit(snapshot: ForgeSnapshot, openaiSpendLimitUsd: number | null | undefined) {
    const openaiSpendLimitMicros = openaiSpendLimitUsd === null || openaiSpendLimitUsd === undefined ? undefined : Math.round(openaiSpendLimitUsd * 1_000_000);
    const nextForge = {
      ...snapshot.forge,
      ...(openaiSpendLimitMicros === undefined ? {} : { openaiSpendLimitMicros })
    };
    if (openaiSpendLimitMicros === undefined) {
      delete nextForge.openaiSpendLimitMicros;
    }

    const usage = getOpenAISpendUsage(snapshot);
    return appendEvents(
      {
        ...snapshot,
        forge: nextForge
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "runtime.spend_limit_updated",
          actorType: "operator",
          targetType: "forge",
          targetId: snapshot.forge.id,
          message: openaiSpendLimitMicros === undefined ? "OpenAI API spend limit cleared." : `OpenAI API spend limit set to $${(openaiSpendLimitMicros / 1_000_000).toFixed(4)}.`,
          severity: "info",
          payload: {
            openaiSpendMicros: usage.spendMicros,
            ...(openaiSpendLimitMicros === undefined ? { openaiSpendLimitCleared: true } : { openaiSpendLimitMicros })
          }
        }
      ]
    );
  }

  private async addOperatorMessage(snapshot: ForgeSnapshot, content: string) {
    const timestamp = new Date().toISOString();
    const operatorMessage = { id: `msg-${Date.now()}-operator`, role: "operator" as const, kind: "operator_prompt" as const, source: "manual" as const, content, createdAt: timestamp };
    const response = {
      id: `msg-${Date.now()}-executive`,
      role: "executive" as const,
      kind: "executive_reply" as const,
      source: "manual" as const,
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

  private async proposeOperationChanges(snapshot: ForgeSnapshot, content: string) {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new RuntimeCommandError("Executive proposal message is required.", 400);
    }

    const timestamp = new Date().toISOString();
    const operatorMessage = {
      id: `msg-${Date.now()}-operator`,
      role: "operator" as const,
      kind: "operator_prompt" as const,
      source: "manual" as const,
      content: trimmed,
      createdAt: timestamp
    };

    try {
      const draft = executiveProposalDraftSchema.parse(
        await this.executiveIntentProvider.proposeOperationChanges({
          forgeId: snapshot.forge.id,
          message: trimmed,
          snapshot
        })
      );
      const qualityIssues = validateExecutiveProposalQuality(draft, snapshot, trimmed);
      if (qualityIssues.length > 0) {
        throw new ExecutiveProposalQualityError(qualityIssues);
      }
      const provider = this.executiveIntentProvider.getProviderInfo();
      const supersedesProposalIds = getValidSupersededProposalIds(snapshot, draft.supersedesProposalIds);
      const proposal: ExecutiveProposal = {
        id: `${snapshot.forge.slug}-proposal-${Date.now()}`,
        status: "pending",
        sourceMessageId: operatorMessage.id,
        provider: provider.provider,
        model: provider.model,
        summary: draft.summary,
        actions: draft.actions,
        supersedesProposalIds,
        createdAt: timestamp
      };
      const approvalIssues = validateExecutiveProposalApprovalPath(snapshot, proposal, trimmed, timestamp);
      if (approvalIssues.length > 0) {
        throw new ExecutiveProposalQualityError(approvalIssues);
      }
      const response = {
        id: `msg-${Date.now()}-executive`,
        role: "executive" as const,
        kind: "executive_reply" as const,
        source: "manual" as const,
        content: `Prepared proposal: ${proposal.summary}`,
        status: "proposal_pending",
        createdAt: timestamp
      };

      return appendEvents(
        {
          ...snapshot,
          messages: [...snapshot.messages, operatorMessage, response],
          proposals: [
            ...snapshot.proposals.map((candidate) =>
              supersedesProposalIds.includes(candidate.id)
                ? {
                    ...candidate,
                    status: "superseded" as const,
                    updatedAt: timestamp
                  }
                : candidate
            ),
            proposal
          ]
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
            type: "executive.proposal_created",
            actorType: "executive",
            targetType: "chat",
            targetId: proposal.id,
            message: "Executive AI prepared an operation proposal.",
            severity: "success",
            payload: {
              proposalId: proposal.id,
              actionCount: proposal.actions.length,
              provider: proposal.provider,
              ...(proposal.model ? { model: proposal.model } : {})
            }
          },
          ...supersedesProposalIds.map((proposalId) => ({
            forgeId: snapshot.forge.id,
            type: "executive.proposal_superseded" as const,
            actorType: "executive" as const,
            targetType: "chat" as const,
            targetId: proposalId,
            message: "Executive AI replaced a pending operation proposal with a revised plan.",
            severity: "info" as const,
            payload: { proposalId, replacementProposalId: proposal.id }
          }))
        ]
      );
    } catch (error) {
      const provider = this.executiveIntentProvider.getProviderInfo();
      const diagnostics = createExecutiveProposalFailureDiagnostics(error, provider);
      const detail = diagnostics.message;
      const response = {
        id: `msg-${Date.now()}-executive`,
        role: "executive" as const,
        kind: "executive_reply" as const,
        source: "manual" as const,
        content: detail
          ? `Executive AI could not prepare a valid operation proposal. No operations were changed. ${detail}`
          : "Executive AI could not prepare a valid operation proposal. No operations were changed.",
        status: "failed",
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
            type: "executive.proposal_failed",
            actorType: "executive",
            targetType: "chat",
            message: detail ? `Executive AI could not prepare a valid operation proposal. ${detail}` : "Executive AI could not prepare a valid operation proposal.",
            severity: "error",
            payload: diagnostics.payload
          }
        ]
      );
    }
  }

  private async applyOperationProposal(snapshot: ForgeSnapshot, proposalId?: string) {
    const proposal = requirePendingProposal(snapshot, proposalId);
    const timestamp = new Date().toISOString();
    const sourceMessage = snapshot.messages.find((message) => message.id === proposal.sourceMessageId);
    const sourceContent = sourceMessage?.content ?? "";
    const applied = applyProposalActions(snapshot, proposal, timestamp, {
      makeCreatedOperationsRunnable: snapshot.operations.length === 0 && isProjectBuildRequest(sourceContent),
      prioritizeResearchBeforeDevelopment: isResearchBeforeDevelopmentRequest(sourceContent)
    });
    const cycleRepair = repairBlockingDependencyCycles(applied.snapshot);
    const appliedSnapshot = cycleRepair.events.length > 0 ? cycleRepair.snapshot : applied.snapshot;
    const proposals = applied.snapshot.proposals.map((candidate) =>
      candidate.id === proposal.id
        ? {
            ...candidate,
            status: "applied" as const,
            updatedAt: timestamp
          }
        : candidate
    );

    return appendEvents(
      {
        ...appliedSnapshot,
        proposals
      },
      [
        ...applied.events,
        ...cycleRepair.events,
        {
          forgeId: snapshot.forge.id,
          type: "executive.proposal_applied",
          actorType: "operator",
          targetType: "chat",
          targetId: proposal.id,
          message: "Executive operation proposal approved and applied.",
          severity: "success",
          payload: { proposalId: proposal.id, actionCount: proposal.actions.length, dependencyCount: applied.dependencyCount }
        }
      ]
    );
  }

  private async rejectOperationProposal(snapshot: ForgeSnapshot, proposalId?: string) {
    const proposal = requirePendingProposal(snapshot, proposalId);
    const timestamp = new Date().toISOString();

    return appendEvents(
      {
        ...snapshot,
        proposals: snapshot.proposals.map((candidate) =>
          candidate.id === proposal.id
            ? {
                ...candidate,
                status: "rejected" as const,
                updatedAt: timestamp
              }
            : candidate
        )
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "executive.proposal_rejected",
          actorType: "operator",
          targetType: "chat",
          targetId: proposal.id,
          message: "Executive operation proposal rejected.",
          severity: "info",
          payload: { proposalId: proposal.id }
        }
      ]
    );
  }

  private async resolveExecutiveReview(snapshot: ForgeSnapshot, reviewId: string | undefined, resolution: "approved" | "rejected") {
    if (!reviewId) {
      throw new RuntimeCommandError("Executive review id is required.", 400);
    }

    const review = findPendingExecutiveReview(snapshot, reviewId);
    if (!review) {
      throw new RuntimeCommandError("Executive review request not found or already resolved.", 404);
    }

    const timestamp = new Date().toISOString();
    const approved = resolution === "approved";
    const content = `Executive review ${resolution}: ${review.message}`;
    const message = {
      id: `${reviewId}-${resolution}-message`,
      role: "executive" as const,
      kind: "executive_summary" as const,
      source: "manual" as const,
      content,
      runId: getPayloadStringValue(review.payload, "runId"),
      operationId: getPayloadStringValue(review.payload, "operationId"),
      status: resolution,
      createdAt: timestamp
    };

    const category = getPayloadStringValue(review.payload, "category");
    const reviewEvent = {
      forgeId: snapshot.forge.id,
      type: approved ? ("executive.review_approved" as const) : ("executive.review_rejected" as const),
      actorType: "operator" as const,
      targetType: review.targetType,
      targetId: review.targetId,
      message: approved
        ? category === "dangerous_action"
          ? "Executive review request approved. ForgeOS recorded approval; provider shell access remains blocked unless a future explicit executor supports this action."
          : "Executive review request approved. ForgeOS recorded approval and applied safe prerequisite repair routing when available."
        : "Executive review request rejected.",
      severity: approved ? ("success" as const) : ("info" as const),
      payload: {
        reviewId,
        sourceEventId: review.id,
        runId: getPayloadStringValue(review.payload, "runId"),
        operationId: getPayloadStringValue(review.payload, "operationId"),
        resolution,
        providerShellAccess: false
      }
    };

    if (!approved) {
      return appendEvents(
        {
          ...snapshot,
          messages: [...snapshot.messages, message]
        },
        [reviewEvent]
      );
    }

    const withMessage = {
      ...snapshot,
      messages: [...snapshot.messages, message]
    };
    const reviewBlockerReason = getPayloadStringValue(review.payload, "blockerReason") ?? review.message;
    if (isRuntimeOwnedVerificationBlocker(reviewBlockerReason)) {
      const operationId = getPayloadStringValue(review.payload, "operationId");
      const readySnapshot = {
        ...withMessage,
        operations: withMessage.operations.map((operation) =>
          operation.id === operationId
            ? {
                ...operation,
                status: "ready" as const,
                blockedReason: undefined
              }
            : operation
        )
      };
      const readyEvent = operationId
        ? {
            forgeId: snapshot.forge.id,
            type: "operation.ready" as const,
            actorType: "runtime" as const,
            targetType: "operation" as const,
            targetId: operationId,
            message: "Runtime-owned verification blocker approved for retry; operation is ready to rerun with sandbox verification handled by ForgeOS.",
            severity: "info" as const,
            payload: {
              reviewId,
              operationId,
              reason: "runtime_owned_verification_retry"
            }
          }
        : undefined;

      return appendEvents(readySnapshot, readyEvent ? [reviewEvent, readyEvent] : [reviewEvent]);
    }
    const cycleRepair = repairBlockingDependencyCycles(withMessage);
    const cycleRepairSnapshot = cycleRepair.events.length > 0 ? cycleRepair.snapshot : withMessage;
    const repaired = ensureMissingPrerequisiteOperations(cycleRepairSnapshot);
    const repairedSnapshot = repaired.events.length > 0 ? repaired.snapshot : cycleRepairSnapshot;
    const postRepairCycleRepair = repairBlockingDependencyCycles(repairedSnapshot);
    const finalSnapshot = postRepairCycleRepair.events.length > 0 ? postRepairCycleRepair.snapshot : repairedSnapshot;

    return appendEvents(finalSnapshot, [reviewEvent, ...cycleRepair.events, ...repaired.events, ...postRepairCycleRepair.events]);
  }

  private async answerWorkerQuestion(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    const pendingQuestion = requirePendingWorkerQuestion(snapshot, command.workerQuestionId);
    const selectedOptionIds = Array.from(new Set(command.selectedOptionIds ?? []));
    const notes = command.notes?.trim() ?? "";
    if (selectedOptionIds.length === 0 && !notes) {
      throw new RuntimeCommandError("Answer notes or a selected option are required.", 400);
    }

    const optionMap = new Map(pendingQuestion.options.map((option) => [option.id, option]));
    const invalidOptionId = selectedOptionIds.find((optionId) => !optionMap.has(optionId));
    if (invalidOptionId) {
      throw new RuntimeCommandError(`Worker question option is not valid: ${invalidOptionId}`, 400);
    }

    const selectedLabels = selectedOptionIds.map((optionId) => optionMap.get(optionId)?.label ?? optionId);
    return appendEvents(snapshot, [
      createWorkerQuestionAnsweredEvent(snapshot, pendingQuestion, {
        actorType: "division",
        message: "Division lead answered worker question.",
        selectedOptionIds,
        selectedLabels,
        notes,
        source: "division_lead"
      })
    ]);
  }

  private async escalateWorkerQuestion(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    const pendingQuestion = requirePendingWorkerQuestion(snapshot, command.workerQuestionId);
    const notes = command.notes?.trim();
    const timestamp = new Date().toISOString();
    const escalatedEvent: RuntimeEventDraft = {
      forgeId: snapshot.forge.id,
      type: "worker.question_escalated",
      actorType: "division",
      actorId: pendingQuestion.leadWorkerId,
      targetType: "operation",
      targetId: pendingQuestion.operationId,
      message: "Division lead escalated worker question to Executive.",
      severity: "warning",
      payload: {
        workerQuestionId: pendingQuestion.id,
        runId: pendingQuestion.runId,
        operationId: pendingQuestion.operationId,
        workerId: pendingQuestion.workerId,
        leadWorkerId: pendingQuestion.leadWorkerId,
        question: pendingQuestion.question,
        reason: pendingQuestion.reason,
        scope: pendingQuestion.scope,
        options: pendingQuestion.options,
        ...(notes ? { notes } : {})
      }
    };

    if (isExecutiveAutopilotEnabled()) {
      return appendEvents(snapshot, [
        escalatedEvent,
        createWorkerQuestionAnsweredEvent(snapshot, pendingQuestion, {
          actorType: "executive",
          message: "Executive answered escalated worker question automatically.",
          selectedOptionIds: [],
          selectedLabels: [],
          notes: notes ?? pendingQuestion.recommendedDefault ?? "Executive approved the division lead to proceed with the conservative scoped answer.",
          source: "executive_auto"
        })
      ]);
    }

    const executiveQuestionId = `${pendingQuestion.id}-executive`;
    const message = {
      id: `${executiveQuestionId}-message`,
      role: "executive" as const,
      kind: "executive_summary" as const,
      source: "run_terminal" as const,
      content: `Executive input requested for worker question: ${pendingQuestion.question}`,
      runId: pendingQuestion.runId,
      operationId: pendingQuestion.operationId,
      status: "waiting_for_user",
      createdAt: timestamp
    };

    return appendEvents(
      {
        ...snapshot,
        messages: [...snapshot.messages, message]
      },
      [
        escalatedEvent,
        {
          forgeId: snapshot.forge.id,
          type: "executive.user_input_requested",
          actorType: "executive",
          targetType: "operation",
          targetId: pendingQuestion.operationId,
          message: pendingQuestion.question,
          severity: "warning",
          payload: {
            questionId: executiveQuestionId,
            loopId: "worker-question",
            workerQuestionId: pendingQuestion.id,
            runId: pendingQuestion.runId,
            operationId: pendingQuestion.operationId,
            workerId: pendingQuestion.workerId,
            leadWorkerId: pendingQuestion.leadWorkerId,
            question: pendingQuestion.question,
            reason: pendingQuestion.reason,
            scope: pendingQuestion.scope,
            options: pendingQuestion.options,
            allowNotes: true,
            ...(notes ? { escalationNotes: notes } : {})
          }
        }
      ]
    );
  }

  private async approveDependencyRequest(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    const request = requirePendingDependencyRequest(snapshot, command.dependencyRequestId);
    const packageFile = snapshot.files.find((file) => file.path.replace(/^\.\//, "") === "package.json");
    const timestamp = new Date().toISOString();

    if (!packageFile) {
      return appendEvents(snapshot, [
        {
          forgeId: snapshot.forge.id,
          type: "dependency.rejected",
          actorType: "division",
          actorId: request.leadWorkerId,
          targetType: "operation",
          targetId: request.operationId,
          message: "Dependency request rejected because package.json is missing.",
          severity: "warning",
          payload: {
            dependencyRequestId: request.id,
            runId: request.runId,
            operationId: request.operationId,
            packageName: request.packageName,
            reason: "package.json is required before approving dependencies. Scaffold a package manifest first.",
            approvedBy: request.leadWorkerId,
            requestedRunId: request.runId
          }
        }
      ]);
    }

    const policy = validateDependencyRequestPolicy(request);
    if (!policy.ok) {
      return appendEvents(snapshot, [
        {
          forgeId: snapshot.forge.id,
          type: "dependency.rejected",
          actorType: "division",
          actorId: request.leadWorkerId,
          targetType: "operation",
          targetId: request.operationId,
          message: `Dependency request rejected: ${policy.reason}`,
          severity: "warning",
          payload: {
            dependencyRequestId: request.id,
            runId: request.runId,
            operationId: request.operationId,
            packageName: request.packageName,
            reason: policy.reason,
            approvedBy: request.leadWorkerId,
            requestedRunId: request.runId
          }
        }
      ]);
    }

    const patchedContent = patchPackageJsonDependency(packageFile.content, request);
    if (!patchedContent.ok) {
      return appendEvents(snapshot, [
        {
          forgeId: snapshot.forge.id,
          type: "dependency.rejected",
          actorType: "division",
          actorId: request.leadWorkerId,
          targetType: "operation",
          targetId: request.operationId,
          message: patchedContent.reason,
          severity: "warning",
          payload: {
            dependencyRequestId: request.id,
            runId: request.runId,
            operationId: request.operationId,
            packageName: request.packageName,
            reason: patchedContent.reason,
            approvedBy: request.leadWorkerId,
            requestedRunId: request.runId
          }
        }
      ]);
    }

    const patchedFile = {
      ...packageFile,
      content: patchedContent.content,
      status: "generated" as const,
      version: packageFile.version + 1,
      divisionId: request.divisionId,
      workerId: request.leadWorkerId ?? request.workerId,
      operationId: request.operationId,
      updatedAt: timestamp
    };

    return appendEvents(
      {
        ...snapshot,
        files: snapshot.files.map((file) => (file.id === packageFile.id ? patchedFile : file))
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "dependency.approved",
          actorType: "division",
          actorId: request.leadWorkerId,
          targetType: "operation",
          targetId: request.operationId,
          message: `Dependency request approved: ${request.packageName}.`,
          severity: "success",
          payload: {
            dependencyRequestId: request.id,
            runId: request.runId,
            operationId: request.operationId,
            packageName: request.packageName,
            versionRange: request.versionRange,
            dependencyType: request.dependencyType,
            approvedBy: request.leadWorkerId,
            approvalReason: command.notes?.trim() || request.reason,
            requestedRunId: request.runId,
            providerShellAccess: false
          }
        },
        {
          forgeId: snapshot.forge.id,
          type: "file.updated",
          actorType: "runtime",
          targetType: "file",
          targetId: patchedFile.id,
          message: `Runtime updated package.json with approved dependency: ${request.packageName}.`,
          severity: "success",
          payload: {
            dependencyRequestId: request.id,
            runId: request.runId,
            operationId: request.operationId,
            fileId: patchedFile.id,
            path: patchedFile.path,
            version: patchedFile.version,
            patched: true,
            installCommandRun: false
          }
        }
      ]
    );
  }

  private async rejectDependencyRequest(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    const request = requirePendingDependencyRequest(snapshot, command.dependencyRequestId);
    const reason = command.notes?.trim() || "Division lead rejected the dependency request.";
    return appendEvents(snapshot, [
      {
        forgeId: snapshot.forge.id,
        type: "dependency.rejected",
        actorType: "division",
        actorId: request.leadWorkerId,
        targetType: "operation",
          targetId: request.operationId,
        message: `Dependency request rejected: ${request.packageName}.`,
        severity: "info",
        payload: {
          dependencyRequestId: request.id,
          runId: request.runId,
          operationId: request.operationId,
          packageName: request.packageName,
          reason,
          rejectedBy: request.leadWorkerId,
          requestedRunId: request.runId
        }
      }
    ]);
  }

  private async escalateDependencyRequest(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    const request = requirePendingDependencyRequest(snapshot, command.dependencyRequestId);
    const reason = command.notes?.trim() || "Division lead escalated the dependency request to Executive.";
    return appendEvents(snapshot, [
      {
        forgeId: snapshot.forge.id,
        type: "dependency.escalated",
        actorType: "division",
        actorId: request.leadWorkerId,
        targetType: "operation",
          targetId: request.operationId,
        message: `Dependency request escalated: ${request.packageName}.`,
        severity: "warning",
        payload: {
          dependencyRequestId: request.id,
          runId: request.runId,
          operationId: request.operationId,
          workerId: request.workerId,
          leadWorkerId: request.leadWorkerId,
          packageName: request.packageName,
          versionRange: request.versionRange,
          dependencyType: request.dependencyType,
          reason,
          requestedRunId: request.runId
        }
      }
    ]);
  }

  private async startExecutiveLoop(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    const userGoal = resolveCommandMessage(snapshot, command).trim();
    if (!userGoal) {
      throw new RuntimeCommandError("Executive loop prompt is required.", 400);
    }
    if (snapshot.executiveLoops.some((loop) => !isTerminalExecutiveLoopStatus(loop.status))) {
      throw new RuntimeCommandError("An Executive Manager loop is already active for this Forge.", 409);
    }

    const timestamp = new Date().toISOString();
    const promptFile = findPromptFile(snapshot, command);
    const loop: ExecutiveLoop = {
      id: `${snapshot.forge.slug}-exec-loop-${Date.now()}`,
      forgeId: snapshot.forge.id,
      status: "planning",
      userGoal,
      sourcePromptFileId: promptFile?.id,
      sourcePromptFilePath: promptFile?.path,
      cycleCount: 0,
      maxCycles: command.maxRuns ?? 8,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const operatorMessage = {
      id: `msg-${Date.now()}-operator-loop`,
      role: "operator" as const,
      kind: "operator_prompt" as const,
      source: "executive_loop" as const,
      content: userGoal,
      createdAt: timestamp
    };
    const started = appendEvents(
      {
        ...snapshot,
        messages: [...snapshot.messages, operatorMessage],
        executiveLoops: [...snapshot.executiveLoops, loop]
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "executive.loop_started",
          actorType: "executive",
          targetType: "forge",
          targetId: snapshot.forge.id,
          message: "Executive Manager loop started.",
          severity: "info",
          payload: { loopId: loop.id, maxCycles: loop.maxCycles, sourcePromptFilePath: loop.sourcePromptFilePath }
        }
      ]
    );

    return this.runExecutiveManagerCycle(started, loop.id);
  }

  private async continueExecutiveLoop(snapshot: ForgeSnapshot) {
    const loop = getActiveExecutiveLoop(snapshot);
    if (!loop) {
      throw new RuntimeCommandError("No active Executive Manager loop found.", 409);
    }
    if (loop.status === "paused") {
      throw new RuntimeCommandError("Executive Manager loop is paused.", 409);
    }
    if (loop.status === "waiting_for_user" && getPendingExecutiveQuestion(snapshot, loop.id)) {
      throw new RuntimeCommandError("Executive Manager is waiting for an operator answer.", 409);
    }
    return this.runExecutiveManagerCycle(snapshot, loop.id);
  }

  private async answerExecutiveQuestion(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    if (!command.questionId) {
      throw new RuntimeCommandError("Executive question id is required.", 400);
    }
    const pendingQuestion = getPendingExecutiveQuestion(snapshot, undefined, command.questionId);
    if (!pendingQuestion) {
      throw new RuntimeCommandError("Executive question is not pending.", 404);
    }
    const selectedOptionIds = Array.from(new Set(command.selectedOptionIds ?? []));
    const notes = command.notes?.trim() ?? "";
    if (selectedOptionIds.length === 0 && !notes) {
      throw new RuntimeCommandError("Select an answer or add notes before submitting.", 400);
    }

    const optionMap = new Map(pendingQuestion.options.map((option) => [option.id, option]));
    const invalidOptionId = selectedOptionIds.find((optionId) => !optionMap.has(optionId));
    if (invalidOptionId) {
      throw new RuntimeCommandError(`Executive question option is not valid: ${invalidOptionId}`, 400);
    }

    const timestamp = new Date().toISOString();
    const selectedLabels = selectedOptionIds.map((optionId) => optionMap.get(optionId)?.label ?? optionId);
    const answerParts = [
      `Answered Executive question: ${pendingQuestion.question}`,
      selectedLabels.length > 0 ? `Selected: ${selectedLabels.join(", ")}` : undefined,
      notes ? `Notes: ${notes}` : undefined
    ].filter(Boolean);
    const operatorMessage = {
      id: `msg-${Date.now()}-operator-answer`,
      role: "operator" as const,
      kind: "operator_prompt" as const,
      source: "executive_loop" as const,
      content: answerParts.join("\n"),
      createdAt: timestamp
    };

    const answered = appendEvents(
      {
        ...snapshot,
        messages: [...snapshot.messages, operatorMessage],
        executiveLoops: snapshot.executiveLoops.map((loop) =>
          loop.id === pendingQuestion.loopId && loop.status === "waiting_for_user" ? { ...loop, status: "observing" as const, updatedAt: timestamp } : loop
        )
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "chat.message_added",
          actorType: "operator",
          targetType: "chat",
          message: "Operator answered an Executive question.",
          severity: "info",
          payload: { messageId: operatorMessage.id, questionId: pendingQuestion.id }
        },
        {
          forgeId: snapshot.forge.id,
          type: "executive.user_input_answered",
          actorType: "operator",
          targetType: "forge",
          targetId: snapshot.forge.id,
          message: "Operator answered an Executive question.",
          severity: "info",
          payload: {
            questionId: pendingQuestion.id,
            loopId: pendingQuestion.loopId,
            selectedOptionIds,
            selectedLabels,
            ...(notes ? { notes } : {}),
            messageId: operatorMessage.id
          }
        }
      ]
    );

    if (pendingQuestion.workerQuestionId) {
      const pendingWorkerQuestion = getPendingWorkerQuestion(answered, pendingQuestion.workerQuestionId);
      return pendingWorkerQuestion
        ? appendEvents(answered, [
            createWorkerQuestionAnsweredEvent(answered, pendingWorkerQuestion, {
              actorType: "operator",
              message: "Operator answered escalated worker question.",
              selectedOptionIds,
              selectedLabels,
              notes,
              source: "operator"
            })
          ])
        : answered;
    }

    return this.runExecutiveManagerCycle(answered, pendingQuestion.loopId);
  }

  private async pauseExecutiveLoop(snapshot: ForgeSnapshot) {
    const loop = getActiveExecutiveLoop(snapshot);
    if (!loop) {
      throw new RuntimeCommandError("No active Executive Manager loop found.", 409);
    }
    const timestamp = new Date().toISOString();
    return appendEvents(
      {
        ...snapshot,
        executiveLoops: snapshot.executiveLoops.map((candidate) => (candidate.id === loop.id ? { ...candidate, status: "paused" as const, updatedAt: timestamp } : candidate))
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "executive.progress_reported",
          actorType: "executive",
          targetType: "forge",
          targetId: snapshot.forge.id,
          message: "Executive Manager loop paused.",
          severity: "info",
          payload: { loopId: loop.id }
        }
      ]
    );
  }

  private async resumeExecutiveLoop(snapshot: ForgeSnapshot) {
    const loop = snapshot.executiveLoops.find((candidate) => candidate.status === "paused");
    if (!loop) {
      throw new RuntimeCommandError("No paused Executive Manager loop found.", 409);
    }
    const timestamp = new Date().toISOString();
    const resumed = appendEvents(
      {
        ...snapshot,
        executiveLoops: snapshot.executiveLoops.map((candidate) => (candidate.id === loop.id ? { ...candidate, status: "observing" as const, updatedAt: timestamp } : candidate))
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "executive.progress_reported",
          actorType: "executive",
          targetType: "forge",
          targetId: snapshot.forge.id,
          message: "Executive Manager loop resumed.",
          severity: "info",
          payload: { loopId: loop.id }
        }
      ]
    );
    return this.runExecutiveManagerCycle(resumed, loop.id);
  }

  private async runExecutiveManagerCycle(snapshot: ForgeSnapshot, loopId: string) {
    const loop = snapshot.executiveLoops.find((candidate) => candidate.id === loopId);
    if (!loop) {
      throw new RuntimeCommandError("Executive Manager loop not found.", 404);
    }
    if (loop.cycleCount >= loop.maxCycles) {
      return blockExecutiveLoop(snapshot, loop, "Executive Manager loop reached its max cycle limit.");
    }

    const timestamp = new Date().toISOString();
    const cycle = {
      id: `${snapshot.forge.slug}-exec-cycle-${Date.now()}`,
      loopId,
      forgeId: snapshot.forge.id,
      sequence: loop.cycleCount + 1,
      status: "started" as const,
      startedAt: timestamp,
      dispatchedRunIds: [],
      observedRunIds: snapshot.runs.filter((run) => !isActiveRun(run)).map((run) => run.id).slice(-12),
      createdOperationIds: []
    };
    const cycleStarted = appendEvents(
      {
        ...snapshot,
        executiveCycles: [...snapshot.executiveCycles, cycle],
        executiveLoops: snapshot.executiveLoops.map((candidate) => (candidate.id === loop.id ? { ...candidate, cycleCount: candidate.cycleCount + 1, status: "observing" as const, updatedAt: timestamp } : candidate))
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "executive.cycle_started",
          actorType: "executive",
          targetType: "forge",
          targetId: snapshot.forge.id,
          message: `Executive Manager cycle ${cycle.sequence} started.`,
          severity: "info",
          payload: { loopId, cycleId: cycle.id, sequence: cycle.sequence }
        }
      ]
    );

    const recommendation = deriveLoopStatusRecommendation({
      forge: cycleStarted.forge,
      operations: cycleStarted.operations,
      runs: cycleStarted.runs,
      files: cycleStarted.files,
      artifacts: cycleStarted.artifacts
    });

    if (recommendation === "completed" || recommendation === "ready_for_test") {
      return completeExecutiveLoop(cycleStarted, loopId, cycle.id, recommendation);
    }
    if (recommendation === "blocked") {
      const observation = buildExecutiveObservationSummary({
        forge: cycleStarted.forge,
        operations: cycleStarted.operations,
        runs: cycleStarted.runs,
        files: cycleStarted.files,
        artifacts: cycleStarted.artifacts
      });
      return blockExecutiveLoop(cycleStarted, loop, observation.blockers[0]?.reason ?? "Executive Manager found blocking work.");
    }
    if (recommendation === "observing") {
      return reportExecutiveProgress(cycleStarted, loopId, cycle.id, "progress");
    }

    let decision: ExecutiveManagerDecision;
    try {
      decision = await this.getExecutiveManagerDecision(cycleStarted, loop);
    } catch (error) {
      const provider = this.executiveIntentProvider.getProviderInfo();
      const diagnostics = createExecutiveProposalFailureDiagnostics(error, provider);
      return blockExecutiveLoop(cycleStarted, loop, `Executive Manager could not produce a valid decision. ${diagnostics.message}`);
    }
    const appliedDecision = applyExecutiveManagerDecision(cycleStarted, loop, cycle.id, decision);
    if (decision.userQuestion) {
      return appliedDecision;
    }
    const dispatchLimit = chooseConservativeDispatchMax({ runs: appliedDecision.runs, maxRuns: decision.dispatchPolicy.maxRuns });
    const dispatched = this.dispatchExecutiveWork(appliedDecision, dispatchLimit, decision.dispatchPolicy.targetDivisionIds);
    return reportExecutiveProgress(dispatched, loopId, cycle.id, decision.projectStatus === "ready_for_test" ? "ready_for_test" : "progress");
  }

  private dispatchExecutiveWork(snapshot: ForgeSnapshot, maxRuns: number, targetDivisionIds?: string[]) {
    const eligible = this.selectSchedulableOperations(snapshot).filter((operation) => !targetDivisionIds?.length || targetDivisionIds.includes(operation.divisionId));
    return eligible.slice(0, maxRuns).reduce((current, operation) => this.enqueueOperationRun(current, operation.id, undefined, { autofillOnCompletion: true }), snapshot);
  }

  private async getExecutiveManagerDecision(snapshot: ForgeSnapshot, loop: ExecutiveLoop): Promise<ExecutiveManagerDecision> {
    const activePlan = loop.activePlanId ? snapshot.executivePlans.find((plan) => plan.id === loop.activePlanId) : undefined;
    if (this.executiveIntentProvider.decideNextExecutiveAction) {
      return executiveManagerDecisionSchema.parse(
        await this.executiveIntentProvider.decideNextExecutiveAction({
          forgeId: snapshot.forge.id,
          message: loop.userGoal,
          snapshot,
          loop,
          plan: activePlan
        })
      );
    }

    const draft = executiveProposalDraftSchema.parse(
      await this.executiveIntentProvider.proposeOperationChanges({
        forgeId: snapshot.forge.id,
        message: loop.userGoal,
        snapshot
      })
    );
    return {
      summary: draft.summary,
      projectStatus: snapshot.operations.length === 0 ? "planning" : "running",
      userReport: `Executive prepared work plan: ${draft.summary}`,
      planPatch: {
        successCriteria: ["Produce a testable project implementation.", "Report blockers and remaining risks."],
        phases: [{ title: "Build and verify", objective: loop.userGoal }],
        testStrategy: ["Run available project verification after generated files are ready."]
      },
      operationActions: draft.actions,
      dispatchPolicy: { maxRuns: readSchedulerSlotTarget(), priority: "critical_first" }
    };
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
    await this.persistence.deleteGitHubConnection(snapshot.forge.id);

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

  private async syncRepository(snapshot: ForgeSnapshot, command: RuntimeCommand) {
    const owner = command.owner?.trim() || snapshot.repository?.owner;
    const repo = command.repo?.trim() || snapshot.repository?.repo;
    const ref = command.ref?.trim() || command.workingBranch?.trim() || snapshot.repository?.workingBranch || snapshot.repository?.defaultBranch || "main";
    if (!owner || !repo) {
      throw new RuntimeCommandError("Repository owner and name are required.", 400);
    }

    const accessToken = await this.getGitHubAccessToken(snapshot.forge.slug);
    const startedAt = new Date().toISOString();
    const syncedFiles = await syncGitHubRepositoryFiles(accessToken, { owner, repo, ref });
    const completedAt = new Date().toISOString();
    const repository = {
      id: snapshot.repository?.id ?? `${snapshot.forge.slug}-repo-github-${owner}-${repo}`.toLowerCase(),
      provider: "github" as const,
      owner,
      repo,
      defaultBranch: snapshot.repository?.defaultBranch ?? ref,
      workingBranch: ref,
      connectedAt: snapshot.repository?.connectedAt ?? startedAt,
      lastRefreshedAt: completedAt,
      syncStatus: "completed" as const,
      lastSyncStartedAt: startedAt,
      lastSyncCompletedAt: completedAt,
      syncedFileCount: syncedFiles.length,
      authenticatedAccountLogin: (await this.getGitHubAccount(snapshot.forge.slug))?.accountLogin
    };
    const existingSyncedFileIds = new Set(snapshot.files.filter((file) => file.id.startsWith(`${snapshot.forge.slug}-github-file-`)).map((file) => file.id));
    const retainedFiles = snapshot.files.filter((file) => !existingSyncedFileIds.has(file.id));
    const repoFiles = syncedFiles.map((file) => ({
      id: `${snapshot.forge.slug}-github-file-${stableIdForPath(file.path)}`,
      path: `repo/${file.path}`,
      content: file.content,
      status: "generated" as const,
      version: 1,
      artifactIds: [],
      updatedAt: completedAt
    }));

    return appendEvents(
      {
        ...snapshot,
        repository,
        files: [...retainedFiles, ...repoFiles]
      },
      [
        {
          forgeId: snapshot.forge.id,
          type: "repository.synced",
          actorType: "operator",
          targetType: "repository",
          targetId: repository.id,
          message: `Synced ${syncedFiles.length} files from ${owner}/${repo}.`,
          severity: "success",
          payload: { owner, repo, ref, fileCount: syncedFiles.length }
        }
      ]
    );
  }

  private startQueuedRuns(forgeSlug: string, snapshot: ForgeSnapshot, existingRunIds: Set<string>) {
    const runsToStart = snapshot.runs.filter((run) => isActiveRun(run) && !existingRunIds.has(run.id) && !this.startedRunIds.has(run.id));
    for (const run of runsToStart) {
      this.startedRunIds.add(run.id);
      setTimeout(() => {
        void this.executeRun(forgeSlug, run.id);
      }, 0);
    }
  }

  private selectSchedulableOperations(snapshot: ForgeSnapshot) {
    if (snapshot.forge.status !== "active") {
      return [];
    }

    if (isOpenAISpendLimitReached(snapshot, this.agentRuntime.provider())) {
      return [];
    }

    const availableSlots = Math.max(0, readSchedulerSlotTarget() - snapshot.runs.filter((run) => isActiveRun(run)).length);
    if (availableSlots === 0) {
      return [];
    }

    return selectOneOperationPerWorker(resolveReadyOperations(snapshot)).slice(0, availableSlots);
  }

  private async autofillReadyRuns(forgeSlug: string) {
    await this.enqueueForgeCommand(forgeSlug, async () => {
      const snapshot = await this.loadSnapshot(forgeSlug);
      const selected = this.selectSchedulableOperations(snapshot);
      if (selected.length === 0) {
        return;
      }

      const existingRunIds = new Set(snapshot.runs.map((run) => run.id));
      const nextSnapshot = selected.reduce((current, operation) => this.enqueueOperationRun(current, operation.id, undefined, { autofillOnCompletion: true }), snapshot);
      await this.persistence.saveSnapshot(
        appendEvents(nextSnapshot, [
          {
            forgeId: snapshot.forge.id,
            type: "cycle.progress",
            actorType: "executive",
            targetType: "forge",
            targetId: snapshot.forge.id,
            message: `Executive autopilot filled ${selected.length} available run slot${selected.length === 1 ? "" : "s"}.`,
            severity: "info",
            payload: {
              dispatchedOperationIds: selected.map((operation) => operation.id),
              maxConcurrentRuns: readSchedulerSlotTarget()
            }
          }
        ])
      );
      this.startQueuedRuns(forgeSlug, nextSnapshot, existingRunIds);
    });
  }

  private async executeRun(forgeSlug: string, runId: string) {
    let terminalSeen = false;
    let throttleClaim: Awaited<ReturnType<ProviderThrottle["claim"]>> | undefined;
    let runClaimed = false;
    let autofillOnCompletion = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    try {
      const snapshot = await this.loadSnapshot(forgeSlug);
      const run = snapshot.runs.find((candidate) => candidate.id === runId);
      if (!run || !isActiveRun(run)) {
        return;
      }
      autofillOnCompletion = run.providerMetadata.schedulerAutofill === true;

      const runtime = this.getAgentRuntime(run.provider);
      try {
        assertOpenAISpendAvailable(snapshot, runtime.provider());
      } catch (error) {
        if (error instanceof RuntimeCommandError) {
          await this.failRun(forgeSlug, runId, error.message, [], {
            providerMetadata: {
              finalFailureCategory: "blocked_by_policy",
              openaiSpendLimitBlocked: true,
              openaiSpend: getOpenAISpendUsage(snapshot)
            }
          });
          return;
        }
        throw error;
      }
      runClaimed = await this.claimRunExecution(run);
      if (!runClaimed) {
        await this.failRun(forgeSlug, runId, "Run claim unavailable because the operation or worker is already claimed.");
        return;
      }
      throttleClaim = await this.providerThrottle.claim(run.provider);
      if (!(await this.isRunExecutionActive(forgeSlug, runId))) {
        terminalSeen = true;
        return;
      }
      const context = assembleRunContext(snapshot, run.operationId);
      if (context.operation.webAccessPolicy === "required" && !runtime.capabilities().supportsWebSearch) {
        await this.failRun(forgeSlug, runId, `${runtime.provider()} does not support required web search for this operation.`, [], {
          providerMetadata: {
            webEnabled: false,
            webAccessPolicy: context.operation.webAccessPolicy,
            webAccessBlocked: true
          }
        });
        return;
      }
      const providerPrompt = buildProviderPromptPackage(context);
      const routingEvent = createContextRoutedEvent(snapshot, run, context.accounting?.routing);
      let currentProviderPrompt = providerPrompt;
      let fileRequestPasses = 0;
      await this.patchRunSnapshot(forgeSlug, runId, (current, currentRun) =>
        appendEvents(
          updateRun(current, currentRun.id, {
            status: "running",
            startedAt: new Date().toISOString(),
            rateLimit: {
              ...currentRun.rateLimit,
              ...(throttleClaim && throttleClaim.waitedMs > 0 ? { retryAfterMs: throttleClaim.waitedMs, attempts: 1 } : {})
            },
            providerMetadata: mergeTraceSummary(currentRun.providerMetadata, {
              context: toContextTraceSummary(context.accounting, providerPrompt)
            })
          }),
          [
            routingEvent,
            {
              forgeId: current.forge.id,
              type: "run.started",
              actorType: "runtime",
              targetType: "run",
              targetId: currentRun.id,
              message: `${current.operations.find((operation) => operation.id === currentRun.operationId)?.title ?? "Operation"} started through ${currentRun.provider}.`,
              severity: "info",
              payload: { runId: currentRun.id, operationId: currentRun.operationId, workerId: currentRun.workerId, provider: currentRun.provider }
            }
          ]
        )
      );
      heartbeatTimer = this.startRunHeartbeat(forgeSlug, runId);
      for (;;) {
        await this.recordRunAttemptStarted(forgeSlug, runId, currentProviderPrompt.repairBrief);
        let retryWithRequestedContext = false;
        try {
          for await (const event of runtime.runOperation({ forgeId: run.forgeId, operationId: run.operationId, context, providerPrompt: currentProviderPrompt, instructions: context.instructionEnvelope })) {
            if (!(await this.isRunExecutionActive(forgeSlug, runId))) {
              terminalSeen = true;
              break;
            }

            const rawProviderOutputResult = extractProviderOutputs(event.payload);
            const isTerminalCompletion = event.type === "run.completed" || event.type === "operation.completed";
            const gatedProviderOutputResult = isTerminalCompletion ? applyWorkerHelpGateToProviderOutput(rawProviderOutputResult, event, run) : { ...rawProviderOutputResult, suppressionEvents: [] };
            const providerOutputResult = gatedProviderOutputResult;
            const providerOutputs = providerOutputResult.outputs;
            const hasContextRequests = providerOutputs.requestedFiles.length > 0 || providerOutputs.requestedSearches.length > 0 || providerOutputs.requestedArtifacts.length > 0;

            if (isTerminalCompletion && hasContextRequests && fileRequestPasses < MAX_FILE_REQUEST_PASSES) {
              const requestSnapshot = await this.loadSnapshot(forgeSlug);
              const requestResult = buildRequestedContextPrompt(requestSnapshot, currentProviderPrompt, providerOutputs, runId);
              fileRequestPasses += 1;

              await this.patchRunSnapshot(forgeSlug, runId, (current, currentRun) =>
                appendEvents(
                  updateRun(current, currentRun.id, {
                    status: "streaming",
                    providerMetadata: mergeTraceSummary(currentRun.providerMetadata, {
                      outputs: {
                        artifactCount: 0,
                        fileCount: 0,
                        handoffCount: 0,
                        blockerCount: 0,
                        dangerousActionCount: 0,
                        dependencyRequestCount: 0,
                        requestedFileCount: providerOutputs.requestedFiles.length,
                        requestedSearchCount: providerOutputs.requestedSearches.length,
                        requestedArtifactCount: providerOutputs.requestedArtifacts.length,
                        omittedCount: requestResult.omissions.length,
                        omissionReasons: requestResult.omissions.slice(0, 20)
                      }
                    })
                  }),
                  [
                    {
                      forgeId: current.forge.id,
                      type: "run.progress",
                      actorType: "runtime",
                      targetType: "run",
                      targetId: currentRun.id,
                      message: `Runtime supplied requested project context pass ${fileRequestPasses}.`,
                      severity: requestResult.addedFileCount > 0 || requestResult.addedArtifactCount > 0 || requestResult.searchResultCount > 0 ? "info" : "warning",
                      payload: {
                        runId: currentRun.id,
                        operationId: currentRun.operationId,
                        requestedFileCount: providerOutputs.requestedFiles.length,
                        requestedSearchCount: providerOutputs.requestedSearches.length,
                        requestedArtifactCount: providerOutputs.requestedArtifacts.length,
                        suppliedFileCount: requestResult.addedFileCount,
                        suppliedArtifactCount: requestResult.addedArtifactCount,
                        searchResultCount: requestResult.searchResultCount,
                        omittedCount: requestResult.omissions.length
                      }
                    }
                  ]
                )
              );

              if (requestResult.addedFileCount > 0 || requestResult.addedArtifactCount > 0 || requestResult.searchResultCount > 0) {
                currentProviderPrompt = requestResult.providerPrompt;
                retryWithRequestedContext = true;
                break;
              }
            }

            if (event.type === "run.failed" || event.type === "operation.failed") {
              const eventWithRun = this.createProviderEventWithRun(runId, event, providerOutputResult);
              const providerPatch = extractProviderRunPatch(event.payload);
              const repairBrief = await this.requestSelfRepairOrEscalate(forgeSlug, runId, {
                category: classifyProviderFailure(providerPatch),
                message: event.message,
                sanitizedErrors: [event.message],
                omissions: providerOutputs.omissions,
                providerEvents: [eventWithRun, ...providerOutputResult.suppressionEvents],
                providerPatch
              });
              if (repairBrief) {
                currentProviderPrompt = await this.withLatestRunCheckpointForPrompt(forgeSlug, runId, withRepairBrief(currentProviderPrompt, repairBrief));
                retryWithRequestedContext = true;
                break;
              }
              terminalSeen = true;
              break;
            }

            if (event.type === "run.canceled") {
              terminalSeen = (await this.projectProviderEvent(forgeSlug, runId, event)) || terminalSeen;
              break;
            }

            if (isTerminalCompletion) {
              const completionFailure = classifyCompletionFailure(event.payload, providerOutputs, isLeadTriageContext(context));
              if (completionFailure) {
                const eventWithRun = this.createProviderEventWithRun(runId, event, providerOutputResult);
                const repairBrief = await this.requestSelfRepairOrEscalate(forgeSlug, runId, {
                  ...completionFailure,
                  omissions: providerOutputs.omissions,
                  providerEvents: [eventWithRun, ...providerOutputResult.suppressionEvents],
                  providerPatch: extractProviderRunPatch(event.payload)
                });
                if (repairBrief) {
                  currentProviderPrompt = await this.withLatestRunCheckpointForPrompt(forgeSlug, runId, withRepairBrief(currentProviderPrompt, repairBrief));
                  retryWithRequestedContext = true;
                  break;
                }
                terminalSeen = true;
                break;
              }

              const verificationRepairBrief = await this.completeRun(forgeSlug, runId, [this.createProviderEventWithRun(runId, event, providerOutputResult), ...providerOutputResult.suppressionEvents], extractProviderRunPatch(event.payload), providerOutputs);
              if (verificationRepairBrief) {
                currentProviderPrompt = await this.withLatestRunCheckpointForPrompt(forgeSlug, runId, withRepairBrief(currentProviderPrompt, verificationRepairBrief));
                retryWithRequestedContext = true;
                break;
              }
              terminalSeen = true;
              break;
            }

            terminalSeen = (await this.projectProviderEvent(forgeSlug, runId, event)) || terminalSeen;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Operation execution failed.";
          if (!(await this.isRunExecutionActive(forgeSlug, runId))) {
            terminalSeen = true;
            break;
          }
          const repairBrief = await this.requestSelfRepairOrEscalate(forgeSlug, runId, {
            category: "runtime_exception",
            message,
            sanitizedErrors: [message],
            omissions: []
          });
          if (repairBrief) {
            currentProviderPrompt = await this.withLatestRunCheckpointForPrompt(forgeSlug, runId, withRepairBrief(currentProviderPrompt, repairBrief));
            retryWithRequestedContext = true;
          } else {
            terminalSeen = true;
          }
        }

        if (!retryWithRequestedContext) {
          break;
        }
      }

      if (!terminalSeen && (await this.isRunExecutionActive(forgeSlug, runId))) {
        await this.completeRun(forgeSlug, runId, [], {}, createEmptyProviderRunOutputs());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Operation execution failed.";
      await this.failRun(forgeSlug, runId, message, [], {
        providerMetadata: {
          finalFailureCategory: "runtime_exception"
        }
      });
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      throttleClaim?.release();
      if (runClaimed) {
        await this.persistence.releaseRunClaim?.(runId);
      }
      if (autofillOnCompletion && isExecutiveAutopilotEnabled()) {
        await this.autofillReadyRuns(forgeSlug);
      }
    }
  }

  private startRunHeartbeat(forgeSlug: string, runId: string) {
    const intervalMs = readPositiveInteger(process.env.FORGEOS_RUN_HEARTBEAT_INTERVAL_MS, 2000);
    const startedAt = Date.now();
    const timer = setInterval(() => {
      void this.recordRunHeartbeat(forgeSlug, runId, startedAt);
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  private async recordRunHeartbeat(forgeSlug: string, runId: string, startedAtMs: number) {
    await this.patchRunSnapshot(forgeSlug, runId, (snapshot, run) => {
      if (!isActiveRun(run)) {
        return snapshot;
      }

      const operation = snapshot.operations.find((candidate) => candidate.id === run.operationId);
      const currentProgress = operation?.progress ?? 0;
      const activeProgress = Math.min(90, Math.max(55, currentProgress + 5));
      const activeDurationMs = Math.max(0, Date.now() - startedAtMs);
      const providerMetadata = run.providerMetadata;
      const modelTier = readStringFromRecord(providerMetadata, "modelTier") ?? readStringFromRecord(providerMetadata, "modelSelectionTier");
      const model = readStringFromRecord(providerMetadata, "model");
      const failureCategory = readStringFromRecord(providerMetadata, "finalFailureCategory") ?? readStringFromRecord(providerMetadata, "category");
      const retryReason = readStringFromRecord(providerMetadata, "repairBriefSummary.failureCategory");
      const message = `${operation?.title ?? "Operation"} is still running through ${run.provider}.`;
      const checkpoint = shouldCreateRunContextCheckpoint(run, activeDurationMs) ? createRunContextCheckpoint(snapshot, run, activeDurationMs, message) : undefined;
      const heartbeatSnapshot = projectOrganizationalState({
        ...snapshot,
        operations: snapshot.operations.map((candidate) =>
          candidate.id === run.operationId
            ? {
                ...candidate,
                status: "running" as const,
                routingStage: "running" as const,
                progress: candidate.progress >= 100 ? 90 : activeProgress,
                blockedReason: retryReason ? `Retrying after ${retryReason}.` : candidate.blockedReason
              }
            : candidate
        ),
        workers: snapshot.workers.map((worker) =>
          worker.id === run.workerId
            ? {
                ...worker,
                status: "running" as const,
                currentTask: operation?.title
              }
            : worker
        )
      });
      const runPatchedSnapshot = checkpoint
        ? updateRun(heartbeatSnapshot, run.id, {
            providerMetadata: mergeTraceSummary(run.providerMetadata, { checkpoint })
          })
        : heartbeatSnapshot;

      return appendEvents(
        runPatchedSnapshot,
        [
          {
            forgeId: snapshot.forge.id,
            type: "run.progress",
            actorType: "runtime",
            targetType: "run",
            targetId: run.id,
            message,
            severity: "info",
            payload: {
              runId: run.id,
              operationId: run.operationId,
              workerId: run.workerId,
              provider: run.provider,
              heartbeat: true,
              activeDurationMs,
              progress: activeProgress,
              latestProgressMessage: message,
              ...(model ? { model } : {}),
              ...(modelTier ? { modelTier } : {}),
              ...(failureCategory ? { failureCategory } : {}),
              ...(retryReason ? { retryReason } : {})
            }
          },
          ...(checkpoint
            ? [
                {
                  forgeId: snapshot.forge.id,
                  type: "run.context_checkpointed" as const,
                  actorType: "runtime" as const,
                  targetType: "run" as const,
                  targetId: run.id,
                  message: checkpoint.summary,
                  severity: "info" as const,
                  payload: {
                    runId: run.id,
                    operationId: run.operationId,
                    workerId: run.workerId,
                    provider: run.provider,
                    checkpointNumber: checkpoint.checkpointNumber,
                    activeDurationMs: checkpoint.activeDurationMs,
                    latestActivity: checkpoint.latestActivity,
                    nextAction: checkpoint.nextAction,
                    risk: checkpoint.risk,
                    sourceEventSequenceStart: checkpoint.sourceEventSequenceStart,
                    sourceEventSequenceEnd: checkpoint.sourceEventSequenceEnd
                  }
                }
              ]
            : [])
        ]
      );
    });
  }

  private async isRunExecutionActive(forgeSlug: string, runId: string) {
    const snapshot = await this.loadSnapshot(forgeSlug);
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    return Boolean(run && isActiveRun(run) && snapshot.forge.status === "active");
  }

  private async claimRunExecution(run: AgentRun) {
    if (!this.persistence.claimRun) {
      return true;
    }

    const leaseExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    return this.persistence.claimRun({
      runId: run.id,
      forgeId: run.forgeId,
      operationId: run.operationId,
      workerId: run.workerId,
      provider: run.provider,
      claimedBy: `${process.pid}`,
      leaseExpiresAt
    });
  }

  private async projectProviderEvent(forgeSlug: string, runId: string, event: RuntimeEventDraft) {
    const providerPatch = extractProviderRunPatch(event.payload);
    const providerOutputResult = extractProviderOutputs(event.payload);
    const providerOutputs = providerOutputResult.outputs;
    const eventWithRun = {
      ...event,
      targetType: event.type.startsWith("run.") ? ("run" as const) : event.targetType,
      targetId: event.type.startsWith("run.") ? runId : event.targetId,
      payload: sanitizeProviderEventPayload(event.payload, runId, providerOutputResult)
    };

    if (event.type === "run.failed" || event.type === "operation.failed") {
      await this.failRun(forgeSlug, runId, event.message, [eventWithRun], providerPatch);
      return true;
    }

    if (event.type === "run.canceled") {
      await this.cancelRun(forgeSlug, runId, event.message, [eventWithRun], providerPatch);
      return true;
    }

    if (event.type === "run.completed" || event.type === "operation.completed") {
      await this.completeRun(forgeSlug, runId, [eventWithRun], providerPatch, providerOutputs);
      return true;
    }

    await this.patchRunSnapshot(forgeSlug, runId, (snapshot, run) => {
      const statusPatch = event.type === "run.progress" ? ({ status: "streaming" as const } satisfies Partial<AgentRun>) : {};
      return appendEvents(updateRun(snapshot, run.id, { ...statusPatch, ...providerPatch, providerMetadata: mergeProviderMetadata(run.providerMetadata, providerPatch.providerMetadata) }), [eventWithRun]);
    });
    return false;
  }

  private createProviderEventWithRun(runId: string, event: RuntimeEventDraft, outputResult = extractProviderOutputs(event.payload)): RuntimeEventDraft {
    return {
      ...event,
      targetType: event.type.startsWith("run.") ? ("run" as const) : event.targetType,
      targetId: event.type.startsWith("run.") ? runId : event.targetId,
      payload: sanitizeProviderEventPayload(event.payload, runId, outputResult)
    };
  }

  private async completeRun(
    forgeSlug: string,
    runId: string,
    providerEvents: RuntimeEventDraft[] = [],
    providerPatch: Partial<AgentRun> = {},
    providerOutputs: ProviderRunOutputs = createEmptyProviderRunOutputs()
  ): Promise<AgentRepairBrief | undefined> {
    let retryBrief: AgentRepairBrief | undefined;
    await this.patchRunSnapshot(forgeSlug, runId, async (snapshot, run) => {
      if (!isActiveRun(run)) {
        return snapshot;
      }

      const operation = snapshot.operations.find((candidate) => candidate.id === run.operationId);
      const completedAt = new Date().toISOString();
      const worker = run.workerId ? snapshot.workers.find((candidate) => candidate.id === run.workerId) : undefined;
      if (providerOutputs.recoveryActions.length > 0 && !isLeadRecoveryOperation(operation, worker)) {
        providerOutputs.omissions.push("recovery actions ignored because this was not a lead triage operation.");
        providerOutputs.recoveryActions = [];
      }
      const projectedOutputs = filterActionableProviderBlockers(providerOutputs, operation);
      const traceSummary = withLifecycleRetryCounts(toOutputTraceSummary(projectedOutputs, run.provider, "completed", completedAt), run.providerMetadata);
      const completedProviderPatch = {
        ...providerPatch,
        usage: enrichUsageMetrics(providerPatch.usage, run.providerMetadata, projectedOutputs)
      };
      let nextSnapshot: ForgeSnapshot = {
        ...updateRun(snapshot, run.id, {
          ...completedProviderPatch,
          providerMetadata: mergeTraceSummary(mergeProviderMetadata(run.providerMetadata, completedProviderPatch.providerMetadata), traceSummary),
          status: "completed",
          completedAt
        }),
        operations: snapshot.operations.map((candidate) =>
          candidate.id === run.operationId
            ? {
                ...candidate,
                status: "completed" as const,
                routingStage: "done" as const,
                progress: 100,
                blockedReason: undefined
              }
            : candidate
        ),
        workers: snapshot.workers.map((worker) =>
          worker.id === run.workerId
            ? {
                ...worker,
                status: "completed" as const,
                currentTask: undefined
              }
            : worker
        )
      };

      const projected = applyProviderOutputs(nextSnapshot, run, projectedOutputs, completedAt);
      nextSnapshot = projected.snapshot;
      const executiveReview = createExecutiveReviewRequests(nextSnapshot, run, projectedOutputs.dangerousActions, completedAt);
      nextSnapshot = executiveReview.snapshot;
      const dependencyReview = createDependencyReviewRequests(nextSnapshot, run, projectedOutputs.dependencyRequests);
      nextSnapshot = dependencyReview.snapshot;
      const executiveReplan = createExecutiveReplanRequests(nextSnapshot, run, projectedOutputs.blockers, completedAt);
      nextSnapshot = executiveReplan.snapshot;
      const verificationSummary = await this.createRuntimeVerificationSummary(nextSnapshot, run, projected, projectedOutputs, completedAt);
      if (verificationSummary.status === "failed" && canSelfRepair(run)) {
        retryBrief = createRepairBrief({
          operationGoal: operation?.description ?? operation?.title ?? run.operationId,
          category: "verification_failed",
          message: "Runtime verification failed after projecting provider outputs.",
          sanitizedErrors: sanitizeVerificationErrors(verificationSummary),
          omissions: verificationSummary.omittedReasons ?? [],
          previousAttemptSummary: `${operation?.title ?? "Operation"} produced outputs, but verification failed.`,
          projectedFileRefs: verificationSummary.projectedFileIds
        });
        return createSelfRepairSnapshot(nextSnapshot, run, retryBrief, {
          providerPatch: completedProviderPatch,
          verificationSummary,
          projectedEvents: projected.events,
          message: "Runtime verification failed; same worker self-repair requested."
        });
      }
      if (verificationSummary.status === "failed") {
        retryBrief = createRepairBrief({
          operationGoal: operation?.description ?? operation?.title ?? run.operationId,
          category: "verification_failed",
          message: "Runtime verification failed after projecting provider outputs.",
          sanitizedErrors: sanitizeVerificationErrors(verificationSummary),
          omissions: verificationSummary.omittedReasons ?? [],
          previousAttemptSummary: `${operation?.title ?? "Operation"} exhausted verification self-repair attempts.`,
          projectedFileRefs: verificationSummary.projectedFileIds
        });
        return createLeadEscalationSnapshot(nextSnapshot, run, {
          category: "verification_failed",
          message: "Runtime verification failed after projecting provider outputs. Division lead fix requested.",
          providerPatch: completedProviderPatch,
          projectedEvents: projected.events,
          verificationSummary,
          retryBrief
        });
      }
      const verificationGap = getRequiredVerificationGap(nextSnapshot, run, projected, projectedOutputs, verificationSummary);
      if (verificationGap && canSelfRepair(run)) {
        retryBrief = createRepairBrief({
          operationGoal: operation?.description ?? operation?.title ?? run.operationId,
          category: "verification_failed",
          message: verificationGap,
          sanitizedErrors: sanitizeVerificationErrors(verificationSummary),
          omissions: verificationSummary.omittedReasons ?? [],
          previousAttemptSummary: `${operation?.title ?? "Operation"} produced code output, but runtime verification did not pass.`,
          projectedFileRefs: verificationSummary.projectedFileIds
        });
        return createSelfRepairSnapshot(nextSnapshot, run, retryBrief, {
          providerPatch: completedProviderPatch,
          verificationSummary,
          projectedEvents: projected.events,
          message: "Runtime verification is required before this implementation operation can complete."
        });
      }
      if (verificationGap) {
        retryBrief = createRepairBrief({
          operationGoal: operation?.description ?? operation?.title ?? run.operationId,
          category: "verification_failed",
          message: verificationGap,
          sanitizedErrors: sanitizeVerificationErrors(verificationSummary),
          omissions: verificationSummary.omittedReasons ?? [],
          previousAttemptSummary: `${operation?.title ?? "Operation"} exhausted verification self-repair attempts.`,
          projectedFileRefs: verificationSummary.projectedFileIds
        });
        return createLeadEscalationSnapshot(nextSnapshot, run, {
          category: "verification_failed",
          message: verificationGap,
          providerPatch: completedProviderPatch,
          projectedEvents: projected.events,
          verificationSummary,
          retryBrief
        });
      }
      const finalTraceSummary = withLifecycleRetryCounts(toOutputTraceSummary(projectedOutputs, run.provider, "completed", completedAt), run.providerMetadata);
      nextSnapshot = updateRun(nextSnapshot, run.id, {
        providerMetadata: mergeRuntimeVerificationSummary(
          mergeTraceSummary(mergeProviderMetadata(run.providerMetadata, completedProviderPatch.providerMetadata), finalTraceSummary),
          verificationSummary
        )
      });
      const consumed = consumeAcceptedHandoffs(nextSnapshot, run, completedAt);
      nextSnapshot = consumed.snapshot;
      nextSnapshot = projectOrganizationalState(nextSnapshot);
      const unlocked = projectedOutputs.blockers.length > 0 ? { snapshot: nextSnapshot, events: [] } : unlockReadyOperations(nextSnapshot);
      nextSnapshot = projectOrganizationalState(unlocked.snapshot);
      const summarized = createRunSummaryDrafts(nextSnapshot, run, "completed", `${operation?.title ?? "Operation"} completed through ${run.provider}.`, projected, consumed, completedAt);
      nextSnapshot = summarized.snapshot;
      const terminalEvents = hasProviderEventType(providerEvents, "run.completed")
        ? providerEvents
        : [
            ...providerEvents,
            {
              forgeId: snapshot.forge.id,
              type: "run.completed" as const,
              actorType: "runtime" as const,
              targetType: "run" as const,
              targetId: run.id,
              message: `${operation?.title ?? "Operation"} completed through ${run.provider}.`,
              severity: "success" as const,
              payload: { runId: run.id, operationId: run.operationId, workerId: run.workerId, provider: run.provider }
            }
          ];

      return appendEvents(nextSnapshot, [
        ...terminalEvents,
          ...projected.events,
          ...executiveReview.events,
          ...dependencyReview.events,
          ...executiveReplan.events,
        ...consumed.events,
        ...unlocked.events,
        ...summarized.events
      ]);
    });
    return retryBrief;
  }

  private async createRuntimeVerificationSummary(
    snapshot: ForgeSnapshot,
    run: AgentRun,
    projected: { snapshot: ForgeSnapshot; events: RuntimeEventDraft[] },
    outputs: ProviderRunOutputs,
    completedAt: string
  ) {
    const projectedRefs = getProjectedOutputRefs(projected.events);
    const fallbackSummary: RuntimeVerificationSummary = {
      source: "runtime",
      status: "skipped",
      tier: selectRuntimeVerificationTier(snapshot, run),
      checkedAt: completedAt,
      providerShellAccess: false,
      projectedArtifactIds: projectedRefs.artifactIds,
      projectedFileIds: projectedRefs.fileIds,
      projectedHandoffIds: projectedRefs.handoffIds,
      blockerCount: outputs.blockers.length,
      omittedReasons: ["Runtime verification hook is not configured."]
    };

    if (!this.runtimeVerificationHook) {
      return fallbackSummary;
    }

    try {
      return sanitizeRuntimeVerificationSummary(
        await this.runtimeVerificationHook({
          snapshot,
          run,
          completedAt,
          projectedArtifactIds: projectedRefs.artifactIds,
          projectedFileIds: projectedRefs.fileIds,
          projectedHandoffIds: projectedRefs.handoffIds,
          blockerCount: outputs.blockers.length
        }),
        fallbackSummary
      );
    } catch (error) {
      return {
        ...fallbackSummary,
        status: "error" as const,
        omittedReasons: [`Runtime verification hook failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`]
      };
    }
  }

  private async recordRunAttemptStarted(forgeSlug: string, runId: string, repairBrief: AgentRepairBrief | undefined) {
    await this.patchRunSnapshot(forgeSlug, runId, (snapshot, run) => {
      if (!isActiveRun(run)) {
        return snapshot;
      }

      const startedAt = new Date().toISOString();
      const attempts = readRunAttempts(run.providerMetadata);
      if (!repairBrief && attempts.length > 0) {
        return snapshot;
      }
      const attemptNumber = attempts.length + 1;
      const attempt: AgentRunAttempt = {
        attemptNumber,
        triggerReason: repairBrief ? "self_repair" : "initial",
        ...(repairBrief ? { failureCategory: repairBrief.failureCategory, retryBrief: repairBrief } : {}),
        startedAt
      };

      const nextSnapshot = updateRun(snapshot, run.id, {
        providerMetadata: {
          ...run.providerMetadata,
          attempts: [...attempts, attempt],
          ...(repairBrief ? { repairBriefSummary: summarizeRepairBrief(repairBrief) } : {})
        }
      });

      if (!repairBrief) {
        return nextSnapshot;
      }

      return appendEvents(nextSnapshot, [
        {
          forgeId: snapshot.forge.id,
          type: "run.retry_started",
          actorType: "runtime",
          targetType: "run",
          targetId: run.id,
          message: `Self-repair attempt ${attemptNumber - 1} started.`,
          severity: "info",
          payload: {
            runId: run.id,
            operationId: run.operationId,
            workerId: run.workerId,
            attemptNumber,
            failureCategory: repairBrief.failureCategory
          }
        }
      ]);
    });
  }

  private async requestSelfRepairOrEscalate(
    forgeSlug: string,
    runId: string,
    failure: {
      category: AgentFailureCategory;
      message: string;
      sanitizedErrors: string[];
      omissions: string[];
      providerEvents?: RuntimeEventDraft[];
      providerPatch?: Partial<AgentRun>;
    }
  ): Promise<AgentRepairBrief | undefined> {
    let retryBrief: AgentRepairBrief | undefined;
    await this.patchRunSnapshot(forgeSlug, runId, (snapshot, run) => {
      if (!isActiveRun(run)) {
        return snapshot;
      }

      const operation = snapshot.operations.find((candidate) => candidate.id === run.operationId);
      retryBrief = createRepairBrief({
        operationGoal: operation?.description ?? operation?.title ?? run.operationId,
        category: failure.category,
        message: failure.message,
        sanitizedErrors: failure.sanitizedErrors,
        omissions: failure.omissions,
        previousAttemptSummary: `${operation?.title ?? "Operation"} failed before validated projection.`
      });

      if (canSelfRepair(run) && isSelfRepairableFailureCategory(failure.category)) {
        return createSelfRepairSnapshot(snapshot, run, retryBrief, {
          providerPatch: failure.providerPatch,
          providerEvents: failure.providerEvents,
          message: failure.message
        });
      }

      retryBrief = undefined;
      return createLeadEscalationSnapshot(snapshot, run, {
        category: failure.category,
        message: failure.message,
        providerPatch: failure.providerPatch,
        providerEvents: failure.providerEvents,
        retryBrief: createRepairBrief({
          operationGoal: operation?.description ?? operation?.title ?? run.operationId,
          category: failure.category,
          message: failure.message,
          sanitizedErrors: failure.sanitizedErrors,
          omissions: failure.omissions,
          previousAttemptSummary: `${operation?.title ?? "Operation"} exhausted self-repair attempts.`
        })
      });
    });
    return retryBrief;
  }

  private async failRun(forgeSlug: string, runId: string, message: string, providerEvents: RuntimeEventDraft[] = [], providerPatch: Partial<AgentRun> = {}) {
    await this.patchRunSnapshot(forgeSlug, runId, (snapshot, run) => {
      if (!isActiveRun(run)) {
        return snapshot;
      }

      const failedAt = new Date().toISOString();
      const failedSnapshot = updateRun(
        {
          ...snapshot,
          operations: snapshot.operations.map((candidate) =>
            candidate.id === run.operationId
              ? {
                  ...candidate,
                  status: "failed" as const,
                  routingStage: "done" as const,
                  blockedReason: message
                }
              : candidate
          ),
          workers: snapshot.workers.map((worker) =>
            worker.id === run.workerId
              ? {
                  ...worker,
                  status: "failed" as const,
                  currentTask: undefined
                }
              : worker
          )
        },
        run.id,
        {
          ...providerPatch,
          providerMetadata: mergeTraceSummary(mergeProviderMetadata(run.providerMetadata, providerPatch.providerMetadata), {
            lifecycle: { provider: run.provider, status: "failed", failedAt }
          }),
          status: "failed",
          failedAt,
          error: message
        }
      );

      const nextSnapshot = projectOrganizationalState(failedSnapshot);
      const summarized = createRunSummaryDrafts(nextSnapshot, run, "failed", message);
      const terminalEvents = [
        ...providerEvents,
        ...(hasProviderEventType(providerEvents, "run.failed")
          ? []
          : [
              {
                forgeId: snapshot.forge.id,
                type: "run.failed" as const,
                actorType: "runtime" as const,
                targetType: "run" as const,
                targetId: run.id,
                message,
                severity: "error" as const,
                payload: { runId: run.id, operationId: run.operationId, workerId: run.workerId, provider: run.provider }
              }
            ]),
        ...(hasProviderEventType(providerEvents, "operation.failed")
          ? []
          : [
              {
                forgeId: snapshot.forge.id,
                type: "operation.failed" as const,
                actorType: "runtime" as const,
                targetType: "operation" as const,
                targetId: run.operationId,
                message,
                severity: "error" as const,
                payload: { runId: run.id, operationId: run.operationId, workerId: run.workerId, provider: run.provider }
              }
            ])
      ];

      return appendEvents(summarized.snapshot, [
        ...terminalEvents,
        ...summarized.events
      ]);
    });
  }

  private async cancelRun(forgeSlug: string, runId: string, message: string, providerEvents: RuntimeEventDraft[] = [], providerPatch: Partial<AgentRun> = {}) {
    await this.patchRunSnapshot(forgeSlug, runId, (snapshot, run) => {
      if (!isActiveRun(run)) {
        return snapshot;
      }

      const canceledAt = new Date().toISOString();
      const canceledSnapshot = updateRun(
        {
          ...snapshot,
          operations: snapshot.operations.map((candidate) =>
            candidate.id === run.operationId
              ? {
                  ...candidate,
                  status: "canceled" as const,
                  blockedReason: message
                }
              : candidate
          ),
          workers: snapshot.workers.map((worker) =>
            worker.id === run.workerId
              ? {
                  ...worker,
                  status: "canceled" as const,
                  currentTask: undefined
                }
              : worker
          )
        },
        run.id,
        {
          ...providerPatch,
          providerMetadata: mergeTraceSummary(mergeProviderMetadata(run.providerMetadata, providerPatch.providerMetadata), {
            lifecycle: { provider: run.provider, status: "canceled", canceledAt }
          }),
          status: "canceled",
          canceledAt,
          error: message
        }
      );

      const nextSnapshot = projectOrganizationalState(canceledSnapshot);
      const summarized = createRunSummaryDrafts(nextSnapshot, run, "canceled", message);
      const terminalEvents = hasProviderEventType(providerEvents, "run.canceled")
        ? providerEvents
        : [
            ...providerEvents,
            {
              forgeId: snapshot.forge.id,
              type: "run.canceled" as const,
              actorType: "runtime" as const,
              targetType: "run" as const,
              targetId: run.id,
              message,
              severity: "warning" as const,
              payload: { runId: run.id, operationId: run.operationId, workerId: run.workerId, provider: run.provider }
            }
          ];

      return appendEvents(summarized.snapshot, [
        ...terminalEvents,
        ...summarized.events
      ]);
    });
  }

  private async patchRunSnapshot(forgeSlug: string, runId: string, patch: (snapshot: ForgeSnapshot, run: AgentRun) => ForgeSnapshot | Promise<ForgeSnapshot>) {
    await this.enqueueForgeCommand(forgeSlug, async () => {
      const loaded = await this.persistence.loadSnapshot(forgeSlug);
      if (!loaded) {
        return;
      }
      const snapshot = normalizeSnapshot(loaded);
      const run = snapshot.runs.find((candidate) => candidate.id === runId);
      if (!run) {
        return;
      }

      await this.persistence.saveSnapshot(await patch(snapshot, run));
    });
  }

  private async withLatestRunCheckpointForPrompt(forgeSlug: string, runId: string, providerPrompt: ProviderPromptPackage) {
    const snapshot = await this.loadSnapshot(forgeSlug);
    return withPromptRunContextCheckpoint(providerPrompt, snapshot.runs.find((candidate) => candidate.id === runId));
  }

  private getAgentRuntime(provider?: AgentProviderName) {
    const selectedProvider = provider ?? this.agentRuntime.provider();
    return this.agentRuntimes.get(selectedProvider) ?? this.agentRuntime;
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

    const readiness = calculateSnapshotOperationReadiness(snapshot, operation);

    if (operation.status === "blocked") {
      throw new RuntimeCommandError(operation.blockedReason ?? readiness.reason ?? "Operation is blocked until its dependencies complete.", 409);
    }

    if (operation.status !== "ready") {
      throw new RuntimeCommandError(`Operation cannot run from ${operation.status} status.`, 409);
    }

    const worker = operation.workerId ? snapshot.workers.find((candidate) => candidate.id === operation.workerId) : undefined;
    const runnableRoutingStage =
      worker?.kind === "lead" || worker?.kind === "executive"
        ? operation.routingStage === "lead_triaged" || operation.routingStage === "worker_ready"
        : operation.routingStage === "worker_ready";
    if (!runnableRoutingStage) {
      throw new RuntimeCommandError("Operation is waiting for division lead triage before it can run.", 409);
    }

    if (!readiness.ready) {
      throw new RuntimeCommandError(readiness.reason ?? "Operation is not ready to run.", 409);
    }

    const activeRuns = snapshot.runs.filter((run) => isActiveRun(run));
    if (activeRuns.some((run) => run.operationId === operation.id)) {
      throw new RuntimeCommandError("Operation already has an active run.", 409);
    }

    if (operation.workerId && activeRuns.some((run) => run.workerId === operation.workerId)) {
      throw new RuntimeCommandError("Worker already has an active run.", 409);
    }

    if (operation.workerId && snapshot.operations.some((candidate) => candidate.workerId === operation.workerId && candidate.id !== operation.id && candidate.status === "running")) {
      throw new RuntimeCommandError("Worker is already running another operation.", 409);
    }
  }
}

function shouldCreateRunContextCheckpoint(run: AgentRun, activeDurationMs: number) {
  const firstCheckpointMs = readPositiveInteger(process.env.FORGEOS_RUN_CHECKPOINT_FIRST_MS, 5 * 60 * 1000);
  const intervalMs = readPositiveInteger(process.env.FORGEOS_RUN_CHECKPOINT_INTERVAL_MS, 5 * 60 * 1000);
  if (activeDurationMs < firstCheckpointMs) {
    return false;
  }

  const previous = readRunContextCheckpoint(run.providerMetadata);
  return !previous || activeDurationMs - previous.activeDurationMs >= intervalMs;
}

function createRunContextCheckpoint(snapshot: ForgeSnapshot, run: AgentRun, activeDurationMs: number, fallbackActivity: string): RunContextCheckpoint {
  const previous = readRunContextCheckpoint(run.providerMetadata);
  const operation = snapshot.operations.find((candidate) => candidate.id === run.operationId);
  const worker = run.workerId ? snapshot.workers.find((candidate) => candidate.id === run.workerId) : undefined;
  const runEvents = snapshot.events.filter((event) => event.payload.runId === run.id || (event.targetType === "run" && event.targetId === run.id));
  const sourceEventSequenceStart = previous ? previous.sourceEventSequenceEnd + 1 : runEvents[0]?.sequence ?? snapshot.lastEventSequence + 1;
  const sourceEventSequenceEnd = snapshot.lastEventSequence;
  const latestActivity = runEvents.slice().reverse().find((event) => event.type !== "run.context_checkpointed")?.message ?? worker?.currentTask ?? fallbackActivity;
  const risk = getCheckpointRisk(run, operation);
  const nextAction = `Continue ${operation?.title ?? run.operationId} and emit bounded outputs, blockers, or requested context.`;

  return {
    checkpointNumber: (previous?.checkpointNumber ?? 0) + 1,
    activeDurationMs,
    summary: `${operation?.title ?? "Operation"} has been active for ${formatCheckpointDuration(activeDurationMs)} through ${run.provider}; latest activity: ${latestActivity}`,
    latestActivity,
    nextAction,
    risk,
    sourceEventSequenceStart,
    sourceEventSequenceEnd,
    createdAt: new Date().toISOString()
  };
}

function readRunContextCheckpoint(metadata: Record<string, unknown>): RunContextCheckpoint | undefined {
  const traceSummary = isTraceSummary(metadata.traceSummary) ? metadata.traceSummary : undefined;
  return traceSummary?.checkpoint;
}

function getCheckpointRisk(run: AgentRun, operation: Operation | undefined) {
  const traceSummary = isTraceSummary(run.providerMetadata.traceSummary) ? run.providerMetadata.traceSummary : undefined;
  const omittedCount = traceSummary?.context?.omittedReasons.length ?? 0;
  const retryReason = readStringFromRecord(run.providerMetadata, "repairBriefSummary.failureCategory");
  if (retryReason) {
    return `Retry in progress after ${retryReason}.`;
  }
  if (operation?.blockedReason) {
    return operation.blockedReason;
  }
  if (omittedCount > 0) {
    return `${omittedCount} context omission reason${omittedCount === 1 ? "" : "s"} recorded.`;
  }
  return "No new runtime risk detected.";
}

function formatCheckpointDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
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

function blockUnreadyReadyOperations(snapshot: ForgeSnapshot): { snapshot: ForgeSnapshot; events: RuntimeEventDraft[] } {
  const blocked = snapshot.operations
    .filter((operation) => operation.status === "ready")
    .map((operation) => ({ operation, readiness: calculateSnapshotOperationReadiness(snapshot, operation) }))
    .filter(
      (entry) =>
        !entry.readiness.ready &&
        isValidationOutputReadinessGate(entry.readiness.reason) &&
        !isMissingPrerequisiteOperation(entry.operation)
    );

  if (blocked.length === 0) {
    return { snapshot, events: [] };
  }

  const blockedReasons = new Map(blocked.map(({ operation, readiness }) => [operation.id, readiness.reason ?? "Waiting for dependencies."]));
  const operations = snapshot.operations.map((operation) =>
    blockedReasons.has(operation.id)
      ? {
          ...operation,
          status: "blocked" as const,
          blockedReason: blockedReasons.get(operation.id)
        }
      : operation
  );
  const events = blocked.map(({ operation }) => ({
    forgeId: snapshot.forge.id,
    type: "operation.blocked" as const,
    actorType: "runtime" as const,
    targetType: "operation" as const,
    targetId: operation.id,
    message: blockedReasons.get(operation.id) ?? "Operation is waiting for dependencies.",
    severity: "warning" as const,
    payload: { operationId: operation.id, reason: "readiness_gate" }
  }));

  return {
    snapshot: {
      ...snapshot,
      operations
    },
    events
  };
}

function isValidationOutputReadinessGate(reason: string | undefined) {
  return reason === "Waiting for implementation files before validation, QA, release, or deployment work can run." || reason?.startsWith("Waiting for deliverables from ");
}

function assertOpenAISpendAvailable(snapshot: ForgeSnapshot, provider: AgentProviderName) {
  const state = getOpenAISpendUsage(snapshot);
  if (!isOpenAIBackedProvider(provider) || state.limitMicros === undefined || state.spendMicros < state.limitMicros) {
    return;
  }

  throw new RuntimeCommandError(
    `OpenAI API spend limit reached for this Forge ($${(state.spendMicros / 1_000_000).toFixed(4)} used of $${(state.limitMicros / 1_000_000).toFixed(4)}). Raise or clear the limit before starting more OpenAI-backed runs.`,
    402
  );
}

function isOpenAISpendLimitReached(snapshot: ForgeSnapshot, provider: AgentProviderName) {
  const state = getOpenAISpendUsage(snapshot);
  return isOpenAIBackedProvider(provider) && state.limitMicros !== undefined && state.spendMicros >= state.limitMicros;
}

function getOpenAISpendUsage(snapshot: ForgeSnapshot) {
  const limitMicros = readOpenAISpendLimitMicros(snapshot);
  const spendMicros = snapshot.runs
    .filter((run) => isOpenAIBackedProvider(run.provider))
    .reduce((total, run) => total + readUsageCostMicros(run.usage?.costMicros), 0);
  return {
    spendMicros,
    limitMicros,
    remainingMicros: limitMicros === undefined ? undefined : Math.max(0, limitMicros - spendMicros)
  };
}

function readOpenAISpendLimitMicros(snapshot: ForgeSnapshot) {
  const value = snapshot.forge.openaiSpendLimitMicros;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readUsageCostMicros(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isOpenAIBackedProvider(provider: AgentProviderName) {
  return provider === "codex";
}

function resolveCommandMessage(snapshot: ForgeSnapshot, command: RuntimeCommand) {
  const inline = command.message?.trim() ?? "";
  const promptFile = findPromptFile(snapshot, command);
  if (!promptFile) {
    return inline;
  }

  const content =
    promptFile.content.length <= MAX_PROMPT_FILE_CHARS
      ? promptFile.content
      : `${promptFile.content.slice(0, MAX_PROMPT_FILE_CHARS).trimEnd()}\n\n[ForgeOS truncated this prompt file to ${MAX_PROMPT_FILE_CHARS} characters for Executive planning. Keep detailed references in workspace files for worker context.]`;
  const header = inline || `Use ${promptFile.path} as the project instructions.`;
  return `${header}\n\nAttached workspace prompt file: ${promptFile.path}\n\n${content}`;
}

function findPromptFile(snapshot: ForgeSnapshot, command: RuntimeCommand) {
  if (command.promptFileId) {
    const file = snapshot.files.find((candidate) => candidate.id === command.promptFileId);
    if (!file) {
      throw new RuntimeCommandError("Prompt file not found.", 404);
    }
    return file;
  }
  if (command.promptFilePath) {
    const path = normalizeVirtualPath(command.promptFilePath);
    const file = snapshot.files.find((candidate) => candidate.path === path);
    if (!file) {
      throw new RuntimeCommandError("Prompt file not found.", 404);
    }
    return file;
  }
  return undefined;
}

function hasProviderEventType(events: RuntimeEventDraft[], type: RuntimeEventDraft["type"]) {
  return events.some((event) => event.type === type);
}

function requirePendingProposal(snapshot: ForgeSnapshot, proposalId?: string) {
  if (!proposalId) {
    throw new RuntimeCommandError("Executive proposal id is required.", 400);
  }

  const proposal = snapshot.proposals.find((candidate) => candidate.id === proposalId);
  if (!proposal) {
    throw new RuntimeCommandError("Executive proposal not found.", 404);
  }
  if (proposal.status !== "pending") {
    throw new RuntimeCommandError("Executive proposal is not pending.", 409);
  }
  return proposal;
}

function getActiveExecutiveLoop(snapshot: ForgeSnapshot) {
  return snapshot.executiveLoops.find((loop) => !isTerminalExecutiveLoopStatus(loop.status));
}

interface PendingExecutiveQuestion {
  id: string;
  loopId: string;
  workerQuestionId?: string;
  question: string;
  reason: string;
  options: Array<{ id: string; label: string; description?: string }>;
  allowNotes: boolean;
}

interface PendingWorkerQuestion {
  id: string;
  runId: string;
  operationId: string;
  workerId?: string;
  leadWorkerId?: string;
  question: string;
  reason: string;
  scope?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  recommendedDefault?: string;
}

interface PendingDependencyRequest extends ProviderDependencyRequestDeclaration {
  id: string;
  runId: string;
  operationId: string;
  divisionId: string;
  workerId?: string;
  leadWorkerId?: string;
}

function getPendingExecutiveQuestion(snapshot: ForgeSnapshot, loopId?: string, questionId?: string): PendingExecutiveQuestion | undefined {
  const answeredQuestionIds = new Set(
    snapshot.events
      .filter((event) => event.type === "executive.user_input_answered")
      .map((event) => getEventPayloadString(event.payload, "questionId"))
      .filter((id): id is string => Boolean(id))
  );
  return snapshot.events
    .filter((event) => event.type === "executive.user_input_requested")
    .slice()
    .reverse()
    .flatMap((event) => {
      const id = getEventPayloadString(event.payload, "questionId");
      const eventLoopId = getEventPayloadString(event.payload, "loopId");
      const workerQuestionId = getEventPayloadString(event.payload, "workerQuestionId");
      const question = getEventPayloadString(event.payload, "question") ?? event.message;
      const reason = getEventPayloadString(event.payload, "reason") ?? "Executive AI needs operator input.";
      if (!id || !eventLoopId || answeredQuestionIds.has(id)) {
        return [];
      }
      if (loopId && eventLoopId !== loopId) {
        return [];
      }
      if (questionId && id !== questionId) {
        return [];
      }
      return [
        {
          id,
          loopId: eventLoopId,
          workerQuestionId,
          question,
          reason,
          options: getEventPayloadOptions(event.payload),
          allowNotes: event.payload.allowNotes !== false
        }
      ];
    })[0];
}

function hasEquivalentPendingExecutiveQuestion(snapshot: ForgeSnapshot, question: ExecutiveUserQuestion, loopId?: string) {
  const targetFingerprint = executiveQuestionFingerprint(question.question, question.reason, question.options ?? []);
  const answeredQuestionIds = new Set(
    snapshot.events
      .filter((event) => event.type === "executive.user_input_answered")
      .map((event) => getEventPayloadString(event.payload, "questionId"))
      .filter((id): id is string => Boolean(id))
  );

  return snapshot.events.some((event) => {
    if (event.type !== "executive.user_input_requested") {
      return false;
    }
    const questionId = getEventPayloadString(event.payload, "questionId");
    const eventLoopId = getEventPayloadString(event.payload, "loopId");
    if (!questionId || answeredQuestionIds.has(questionId)) {
      return false;
    }
    if (loopId && eventLoopId !== loopId) {
      return false;
    }
    return executiveQuestionFingerprint(getEventPayloadString(event.payload, "question") ?? event.message, getEventPayloadString(event.payload, "reason") ?? "", getEventPayloadOptions(event.payload)) === targetFingerprint;
  });
}

function executiveQuestionFingerprint(question: string, reason: string, options: Array<{ id: string; label: string; description?: string }>) {
  return JSON.stringify({
    question: normalizeName(question),
    reason: normalizeName(reason),
    options: options.map((option) => `${normalizeName(option.id)}:${normalizeName(option.label)}`).sort()
  });
}

function requirePendingWorkerQuestion(snapshot: ForgeSnapshot, workerQuestionId?: string): PendingWorkerQuestion {
  if (!workerQuestionId) {
    throw new RuntimeCommandError("Worker question id is required.", 400);
  }
  const pendingQuestion = getPendingWorkerQuestion(snapshot, workerQuestionId);
  if (!pendingQuestion) {
    throw new RuntimeCommandError("Worker question is not pending.", 404);
  }
  return pendingQuestion;
}

function getPendingWorkerQuestion(snapshot: ForgeSnapshot, workerQuestionId: string): PendingWorkerQuestion | undefined {
  const resolvedQuestionIds = new Set(
    snapshot.events
      .filter((event) => event.type === "worker.question_answered")
      .map((event) => getEventPayloadString(event.payload, "workerQuestionId"))
      .filter((id): id is string => Boolean(id))
  );
  if (resolvedQuestionIds.has(workerQuestionId)) {
    return undefined;
  }
  const event = snapshot.events.find((candidate) => candidate.type === "worker.question_requested" && getEventPayloadString(candidate.payload, "workerQuestionId") === workerQuestionId);
  if (!event) {
    return undefined;
  }
  const id = getEventPayloadString(event.payload, "workerQuestionId");
  const runId = getEventPayloadString(event.payload, "runId");
  const operationId = getEventPayloadString(event.payload, "operationId");
  const question = getEventPayloadString(event.payload, "question") ?? event.message;
  const reason = getEventPayloadString(event.payload, "reason") ?? "Worker needs division lead input.";
  if (!id || !runId || !operationId) {
    return undefined;
  }
  return {
    id,
    runId,
    operationId,
    workerId: getEventPayloadString(event.payload, "workerId"),
    leadWorkerId: getEventPayloadString(event.payload, "leadWorkerId"),
    question,
    reason,
    scope: getEventPayloadString(event.payload, "scope"),
    options: getEventPayloadOptions(event.payload),
    recommendedDefault: getEventPayloadString(event.payload, "recommendedDefault")
  };
}

function requirePendingDependencyRequest(snapshot: ForgeSnapshot, dependencyRequestId?: string): PendingDependencyRequest {
  if (!dependencyRequestId) {
    throw new RuntimeCommandError("Dependency request id is required.", 400);
  }
  const request = getPendingDependencyRequest(snapshot, dependencyRequestId);
  if (!request) {
    throw new RuntimeCommandError("Dependency request is not pending.", 404);
  }
  return request;
}

function getPendingDependencyRequest(snapshot: ForgeSnapshot, dependencyRequestId: string): PendingDependencyRequest | undefined {
  const resolvedRequestIds = new Set(
    snapshot.events
      .filter((event) => event.type === "dependency.approved" || event.type === "dependency.rejected" || event.type === "dependency.escalated")
      .map((event) => getEventPayloadString(event.payload, "dependencyRequestId"))
      .filter((id): id is string => Boolean(id))
  );
  if (resolvedRequestIds.has(dependencyRequestId)) {
    return undefined;
  }
  const event = snapshot.events.find((candidate) => candidate.type === "dependency.requested" && getEventPayloadString(candidate.payload, "dependencyRequestId") === dependencyRequestId);
  if (!event) {
    return undefined;
  }
  const id = getEventPayloadString(event.payload, "dependencyRequestId");
  const runId = getEventPayloadString(event.payload, "runId");
  const operationId = getEventPayloadString(event.payload, "operationId");
  const divisionId = getEventPayloadString(event.payload, "divisionId");
  const packageName = getEventPayloadString(event.payload, "packageName");
  const dependencyType = getEventPayloadDependencyType(event.payload, "dependencyType");
  const reason = getEventPayloadString(event.payload, "reason");
  if (!id || !runId || !operationId || !divisionId || !packageName || !dependencyType || !reason) {
    return undefined;
  }

  return {
    id,
    runId,
    operationId,
    divisionId,
    workerId: getEventPayloadString(event.payload, "workerId"),
    leadWorkerId: getEventPayloadString(event.payload, "leadWorkerId"),
    packageName,
    versionRange: getEventPayloadString(event.payload, "versionRange"),
    dependencyType,
    reason,
    usedByFiles: getEventPayloadStringArray(event.payload, "usedByFiles"),
    alternativesConsidered: getEventPayloadStringArray(event.payload, "alternativesConsidered"),
    requiresExecutive: event.payload.requiresExecutive === true
  };
}

function getEventPayloadDependencyType(payload: Record<string, unknown>, key: string): ProviderDependencyRequestType | undefined {
  const value = payload[key];
  return value === "dependency" || value === "devDependency" || value === "optionalDependency" ? value : undefined;
}

function getEventPayloadStringArray(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function createWorkerQuestionAnsweredEvent(
  snapshot: ForgeSnapshot,
  question: PendingWorkerQuestion,
  answer: {
    actorType: RuntimeEventDraft["actorType"];
    message: string;
    selectedOptionIds: string[];
    selectedLabels: string[];
    notes?: string;
    source: "division_lead" | "executive_auto" | "operator";
  }
): RuntimeEventDraft {
  return {
    forgeId: snapshot.forge.id,
    type: "worker.question_answered",
    actorType: answer.actorType,
    actorId: answer.actorType === "division" ? question.leadWorkerId : undefined,
    targetType: "operation",
    targetId: question.operationId,
    message: answer.message,
    severity: "success",
    payload: {
      workerQuestionId: question.id,
      runId: question.runId,
      operationId: question.operationId,
      workerId: question.workerId,
      leadWorkerId: question.leadWorkerId,
      question: question.question,
      selectedOptionIds: answer.selectedOptionIds,
      selectedLabels: answer.selectedLabels,
      ...(answer.notes ? { notes: answer.notes } : {}),
      source: answer.source
    }
  };
}

function getEventPayloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function validateDependencyRequestPolicy(request: ProviderDependencyRequestDeclaration): { ok: true } | { ok: false; reason: string } {
  if (!isValidPackageName(request.packageName)) {
    return { ok: false, reason: "Package name is malformed or high-risk." };
  }
  if (!request.reason.trim()) {
    return { ok: false, reason: "Dependency request reason is required." };
  }
  if (request.versionRange && isDisallowedDependencyVersionSpec(request.versionRange)) {
    return { ok: false, reason: "Local, path, git, URL, and tarball dependency specs are not allowed." };
  }
  return { ok: true };
}

function patchPackageJsonDependency(
  content: string,
  request: ProviderDependencyRequestDeclaration
): { ok: true; content: string } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, reason: "package.json is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "package.json must be a JSON object." };
  }
  const manifest = parsed as Record<string, unknown>;
  const sectionName = packageManifestSectionForDependencyType(request.dependencyType);
  const section = manifest[sectionName];
  if (section !== undefined && (!section || typeof section !== "object" || Array.isArray(section))) {
    return { ok: false, reason: `${sectionName} in package.json must be an object.` };
  }

  const nextSection = {
    ...((section as Record<string, unknown> | undefined) ?? {}),
    [request.packageName]: request.versionRange?.trim() || "latest"
  };
  const sortedSection = Object.fromEntries(Object.entries(nextSection).sort(([left], [right]) => left.localeCompare(right)));
  const orderedManifest = orderPackageManifestKeys({
    ...manifest,
    [sectionName]: sortedSection
  });

  return { ok: true, content: `${JSON.stringify(orderedManifest, null, 2)}\n` };
}

function packageManifestSectionForDependencyType(dependencyType: ProviderDependencyRequestType) {
  if (dependencyType === "devDependency") {
    return "devDependencies";
  }
  if (dependencyType === "optionalDependency") {
    return "optionalDependencies";
  }
  return "dependencies";
}

function orderPackageManifestKeys(manifest: Record<string, unknown>) {
  const preferred = [
    "name",
    "version",
    "private",
    "type",
    "scripts",
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies"
  ];
  const entries = Object.entries(manifest);
  const preferredEntries = preferred.flatMap((key) => (Object.prototype.hasOwnProperty.call(manifest, key) ? [[key, manifest[key]] as const] : []));
  const otherEntries = entries.filter(([key]) => !preferred.includes(key)).sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries([...preferredEntries, ...otherEntries]);
}

function isValidPackageName(packageName: string) {
  if (packageName.length > 214 || packageName.startsWith(".") || packageName.startsWith("_") || packageName.includes("..")) {
    return false;
  }
  if (/[\s:\\]|^(node_modules|favicon\.ico)$/i.test(packageName)) {
    return false;
  }
  const unscoped = /^(?![._-])[a-z0-9][a-z0-9._~-]*$/;
  const scoped = /^@[a-z0-9][a-z0-9._~-]*\/(?![._-])[a-z0-9][a-z0-9._~-]*$/;
  if (!unscoped.test(packageName) && !scoped.test(packageName)) {
    return false;
  }
  return true;
}

function isHighRiskPackageName(packageName: string) {
  return /(^|\/)(postinstall|preinstall|install|node-gyp|npm|pnpm|yarn|bun|sudo|curl|wget|ssh|openssl|keytar|dotenv|eval|exec)(-|$|\/)/i.test(packageName);
}

function isDisallowedDependencyVersionSpec(versionRange: string) {
  const normalized = versionRange.trim().toLowerCase();
  return /^(file:|link:|workspace:|git\+|https?:|ssh:|github:|gitlab:|bitbucket:)|\.tgz$|\.tar\.gz$/.test(normalized);
}

function getEventPayloadOptions(payload: Record<string, unknown>) {
  const options = payload.options;
  if (!Array.isArray(options)) {
    return [];
  }
  return options.flatMap((option) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      return [];
    }
    const candidate = option as Record<string, unknown>;
    const id = getEventPayloadString(candidate, "id");
    const label = getEventPayloadString(candidate, "label");
    const description = getEventPayloadString(candidate, "description");
    return id && label ? [{ id, label, ...(description ? { description } : {}) }] : [];
  });
}

function isTerminalExecutiveLoopStatus(status: ExecutiveLoop["status"]) {
  return status === "blocked" || status === "ready_for_test" || status === "completed" || status === "failed";
}

function applyExecutiveManagerDecision(snapshot: ForgeSnapshot, loop: ExecutiveLoop, cycleId: string, decision: ExecutiveManagerDecision) {
  const timestamp = new Date().toISOString();
  const operatorQuestion = decision.userQuestion && isOperatorFacingClarificationQuestion(decision.userQuestion) ? decision.userQuestion : undefined;
  const suppressedQuestion = decision.userQuestion && !operatorQuestion ? decision.userQuestion : undefined;
  const questionId = operatorQuestion ? `${snapshot.forge.slug}-exec-question-${Date.now()}` : undefined;
  const duplicatePendingQuestion = operatorQuestion ? hasEquivalentPendingExecutiveQuestion(snapshot, operatorQuestion, loop.id) : false;
  const plan = upsertExecutiveProjectPlan(snapshot, loop, decision, timestamp);
  const proposal: ExecutiveProposal = {
    id: `${snapshot.forge.slug}-exec-decision-${Date.now()}`,
    status: "applied",
    sourceMessageId: `${snapshot.forge.slug}-exec-loop-${loop.id}`,
    provider: "mock",
    summary: decision.summary,
    actions: decision.operationActions,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const planSnapshot = { ...snapshot, executivePlans: plan.plans };
  const applied = decision.operationActions.length > 0 ? applyProposalActions(planSnapshot, proposal, timestamp) : { snapshot: planSnapshot, events: [] };
  const createdOperationIds = applied.events.flatMap((event) => (event.type === "operation.created" && typeof event.payload.operationId === "string" ? [event.payload.operationId] : []));
  const nextLoopStatus: ExecutiveLoop["status"] =
    operatorQuestion ? "waiting_for_user" : decision.projectStatus === "blocked" ? "blocked" : decision.projectStatus === "ready_for_test" ? "ready_for_test" : decision.projectStatus === "completed" ? "completed" : "dispatching";
  const report = createExecutiveReport(applied.snapshot, loop.id, decision.projectStatus === "blocked" ? "blocker" : decision.projectStatus === "ready_for_test" ? "ready_for_test" : "progress", decision.userReport, timestamp);
  const message = createExecutiveReportMessage(report, timestamp);

  return appendEvents(
    {
      ...applied.snapshot,
      executiveLoops: applied.snapshot.executiveLoops.map((candidate) =>
        candidate.id === loop.id
          ? {
              ...candidate,
              status: nextLoopStatus,
              activePlanId: plan.activePlanId,
              lastReportId: report.id,
              blockerReason: decision.projectStatus === "blocked" ? decision.summary : undefined,
              updatedAt: timestamp,
              ...(nextLoopStatus === "completed" || nextLoopStatus === "ready_for_test" || nextLoopStatus === "blocked" ? { completedAt: timestamp } : {})
            }
          : candidate
      ),
      executiveCycles: applied.snapshot.executiveCycles.map((cycle) =>
        cycle.id === cycleId
          ? {
              ...cycle,
              status: decision.operationActions.length > 0 ? ("replanned" as const) : ("observed" as const),
              summary: decision.summary,
              createdOperationIds,
              completedAt: timestamp
            }
          : cycle
      ),
      executiveReports: [...applied.snapshot.executiveReports, report],
      messages: [...applied.snapshot.messages, message]
    },
    [
      ...applied.events,
      {
        forgeId: snapshot.forge.id,
        type: plan.created ? "executive.plan_created" : "executive.plan_updated",
        actorType: "executive",
        targetType: "forge",
        targetId: snapshot.forge.id,
        message: plan.created ? "Executive Manager created a project plan." : "Executive Manager updated the project plan.",
        severity: "info",
        payload: { loopId: loop.id, planId: plan.activePlanId, cycleId }
      },
      ...(operatorQuestion && duplicatePendingQuestion
        ? []
        : [
            {
              forgeId: snapshot.forge.id,
              type: operatorQuestion ? ("executive.user_input_requested" as const) : ("executive.progress_reported" as const),
              actorType: "executive" as const,
              targetType: "forge" as const,
              targetId: snapshot.forge.id,
              message: operatorQuestion?.question ?? decision.userReport,
              severity: decision.projectStatus === "blocked" ? ("warning" as const) : ("info" as const),
              payload: {
                loopId: loop.id,
                cycleId,
                reportId: report.id,
                projectStatus: decision.projectStatus,
                ...(suppressedQuestion
                  ? {
                      reason: "operator_question_suppressed_runtime_diagnostic",
                      suppressedQuestion: suppressedQuestion.question,
                      suppressedReason: suppressedQuestion.reason
                    }
                  : {}),
                ...(operatorQuestion
                  ? {
                      questionId,
                      reason: operatorQuestion.reason,
                      question: operatorQuestion.question,
                      options: operatorQuestion.options ?? [],
                      allowNotes: operatorQuestion.allowNotes ?? true
                    }
                  : {})
              }
            }
          ])
    ]
  );
}

function isOperatorFacingClarificationQuestion(question: ExecutiveUserQuestion) {
  const text = `${question.question} ${question.reason} ${(question.options ?? []).map((option) => `${option.label} ${option.description ?? ""}`).join(" ")}`;
  if (isRuntimeDiagnosticQuestionText(text)) {
    return false;
  }
  return /\b(direction|audience|tone|style|brand|scope|requirement|priority|constraint|acceptance|criteria|persona|user|market|preference|permission|approve|approval|authorize|authoritative source|source link)\b/i.test(text);
}

function upsertExecutiveProjectPlan(snapshot: ForgeSnapshot, loop: ExecutiveLoop, decision: ExecutiveManagerDecision, timestamp: string): { plans: ExecutiveProjectPlan[]; activePlanId: string; created: boolean } {
  const currentPlan = loop.activePlanId ? snapshot.executivePlans.find((plan) => plan.id === loop.activePlanId) : undefined;
  const patch = decision.planPatch ?? {};
  const activePlanId = currentPlan?.id ?? `${snapshot.forge.slug}-exec-plan-${Date.now()}`;
  const sourcePhases = patch.phases ?? currentPlan?.phases ?? [{ title: "Plan and build", objective: loop.userGoal, divisionIds: [] }];
  const plan: ExecutiveProjectPlan = {
    id: activePlanId,
    forgeId: snapshot.forge.id,
    loopId: loop.id,
    status: "active",
    goal: loop.userGoal,
    successCriteria: patch.successCriteria ?? currentPlan?.successCriteria ?? ["Produce a testable project implementation."],
    assumptions: patch.assumptions ?? currentPlan?.assumptions ?? [],
    phases: sourcePhases.map((phase, index) => {
      const rawStatus = "status" in phase ? phase.status : undefined;
      return {
        id: "id" in phase && typeof phase.id === "string" ? phase.id : `${activePlanId}-phase-${index + 1}`,
        title: phase.title,
        objective: phase.objective,
        divisionIds: Array.isArray(phase.divisionIds) ? phase.divisionIds : [],
        operationIds: "operationIds" in phase && Array.isArray(phase.operationIds) ? phase.operationIds : [],
        status: isExecutivePlanPhaseStatus(rawStatus) ? rawStatus : "pending"
      };
    }),
    risks: patch.risks ?? currentPlan?.risks ?? [],
    testStrategy: patch.testStrategy ?? currentPlan?.testStrategy ?? ["Run available verification before final completion."],
    createdAt: currentPlan?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
  return {
    activePlanId,
    created: !currentPlan,
    plans: currentPlan ? snapshot.executivePlans.map((candidate) => (candidate.id === currentPlan.id ? plan : candidate)) : [...snapshot.executivePlans, plan]
  };
}

function isExecutivePlanPhaseStatus(value: unknown): value is ExecutiveProjectPlan["phases"][number]["status"] {
  return value === "pending" || value === "running" || value === "blocked" || value === "completed";
}

function createExecutiveReport(snapshot: ForgeSnapshot, loopId: string, kind: "initial_plan" | "progress" | "blocker" | "ready_for_test" | "final", summary: string, timestamp: string) {
  const reportSummary = createExecutiveReportSummary({ operations: snapshot.operations, runs: snapshot.runs, files: snapshot.files, artifacts: snapshot.artifacts });
  return {
    id: `${snapshot.forge.slug}-exec-report-${Date.now()}`,
    loopId,
    forgeId: snapshot.forge.id,
    kind,
    summary,
    completed: snapshot.operations.filter((operation) => operation.status === "completed").map((operation) => operation.title).slice(0, 12),
    inProgress: snapshot.operations.filter((operation) => operation.status === "running" || operation.status === "ready").map((operation) => operation.title).slice(0, 12),
    blocked: snapshot.operations.filter((operation) => operation.status === "blocked" || operation.status === "failed").map((operation) => `${operation.title}: ${operation.blockedReason ?? operation.status}`).slice(0, 12),
    nextActions: reportSummary.sections.slice(0, 4) as string[],
    filesChanged: snapshot.files.filter((file) => file.operationId).map((file) => file.path).slice(-12),
    testsRun: snapshot.artifacts.filter((artifact) => /test|qa|verification/i.test(`${artifact.title} ${artifact.type} ${artifact.tags.join(" ")}`)).map((artifact) => artifact.title).slice(-8),
    createdAt: timestamp
  };
}

function createExecutiveReportMessage(report: ReturnType<typeof createExecutiveReport>, timestamp: string) {
  return {
    id: `msg-${Date.now()}-executive-report`,
    role: "executive" as const,
    kind: "executive_summary" as const,
    source: "executive_loop" as const,
    content: report.summary,
    status: report.kind,
    summary: {
      scope: "cycle" as const,
      status: report.kind,
      blockers: report.blocked,
      handoffIds: [],
      artifactIds: [],
      fileIds: [],
      metricDeltas: {
        completed: report.completed.length,
        inProgress: report.inProgress.length,
        blocked: report.blocked.length
      }
    },
    createdAt: timestamp
  };
}

function reportExecutiveProgress(snapshot: ForgeSnapshot, loopId: string, cycleId: string, kind: "progress" | "ready_for_test") {
  const timestamp = new Date().toISOString();
  const summary = createExecutiveReportSummary({ operations: snapshot.operations, runs: snapshot.runs, files: snapshot.files, artifacts: snapshot.artifacts });
  const report = createExecutiveReport(snapshot, loopId, kind, summary.text, timestamp);
  const message = createExecutiveReportMessage(report, timestamp);
  return appendEvents(
    {
      ...snapshot,
      executiveReports: [...snapshot.executiveReports, report],
      messages: [...snapshot.messages, message],
      executiveLoops: snapshot.executiveLoops.map((loop) => (loop.id === loopId ? { ...loop, status: kind === "ready_for_test" ? "ready_for_test" : "observing", lastReportId: report.id, updatedAt: timestamp } : loop)),
      executiveCycles: snapshot.executiveCycles.map((cycle) => (cycle.id === cycleId ? { ...cycle, status: "observed" as const, summary: summary.headline, completedAt: timestamp } : cycle))
    },
    [
      {
        forgeId: snapshot.forge.id,
        type: kind === "ready_for_test" ? "executive.loop_completed" : "executive.progress_reported",
        actorType: "executive",
        targetType: "forge",
        targetId: snapshot.forge.id,
        message: summary.headline,
        severity: kind === "ready_for_test" ? "success" : "info",
        payload: { loopId, cycleId, reportId: report.id, status: kind }
      }
    ]
  );
}

function completeExecutiveLoop(snapshot: ForgeSnapshot, loopId: string, cycleId: string, status: "completed" | "ready_for_test") {
  const timestamp = new Date().toISOString();
  const summary = createExecutiveReportSummary({ operations: snapshot.operations, runs: snapshot.runs, files: snapshot.files, artifacts: snapshot.artifacts });
  const report = createExecutiveReport(snapshot, loopId, status === "completed" ? "final" : "ready_for_test", summary.text, timestamp);
  const message = createExecutiveReportMessage(report, timestamp);
  return appendEvents(
    {
      ...snapshot,
      executiveReports: [...snapshot.executiveReports, report],
      messages: [...snapshot.messages, message],
      executiveLoops: snapshot.executiveLoops.map((loop) => (loop.id === loopId ? { ...loop, status, lastReportId: report.id, completedAt: timestamp, updatedAt: timestamp } : loop)),
      executiveCycles: snapshot.executiveCycles.map((cycle) => (cycle.id === cycleId ? { ...cycle, status: "completed" as const, summary: summary.headline, completedAt: timestamp } : cycle))
    },
    [
      {
        forgeId: snapshot.forge.id,
        type: "executive.loop_completed",
        actorType: "executive",
        targetType: "forge",
        targetId: snapshot.forge.id,
        message: summary.headline,
        severity: "success",
        payload: { loopId, cycleId, reportId: report.id, status }
      }
    ]
  );
}

function blockExecutiveLoop(snapshot: ForgeSnapshot, loop: ExecutiveLoop, reason: string) {
  const timestamp = new Date().toISOString();
  const report = createExecutiveReport(snapshot, loop.id, "blocker", reason, timestamp);
  const message = createExecutiveReportMessage(report, timestamp);
  return appendEvents(
    {
      ...snapshot,
      executiveReports: [...snapshot.executiveReports, report],
      messages: [...snapshot.messages, message],
      executiveLoops: snapshot.executiveLoops.map((candidate) => (candidate.id === loop.id ? { ...candidate, status: "blocked" as const, blockerReason: reason, lastReportId: report.id, completedAt: timestamp, updatedAt: timestamp } : candidate))
    },
    [
      {
        forgeId: snapshot.forge.id,
        type: "executive.loop_blocked",
        actorType: "executive",
        targetType: "forge",
        targetId: snapshot.forge.id,
        message: reason,
        severity: "warning",
        payload: { loopId: loop.id, reportId: report.id }
      }
    ]
  );
}

function getValidSupersededProposalIds(snapshot: ForgeSnapshot, proposalIds: string[] | undefined) {
  if (!proposalIds?.length) {
    return [];
  }

  const pendingProposalIds = new Set(snapshot.proposals.filter((proposal) => proposal.status === "pending").map((proposal) => proposal.id));
  return Array.from(new Set(proposalIds)).filter((proposalId) => pendingProposalIds.has(proposalId));
}

function findPendingExecutiveReview(snapshot: ForgeSnapshot, reviewId: string) {
  const resolvedReviewIds = new Set(
    snapshot.events
      .filter((event) => event.type === "executive.review_approved" || event.type === "executive.review_rejected")
      .map((event) => getPayloadStringValue(event.payload, "reviewId"))
      .filter((id): id is string => Boolean(id))
  );
  if (resolvedReviewIds.has(reviewId)) {
    return undefined;
  }
  return snapshot.events.find((event) => event.type === "executive.review_requested" && getPayloadStringValue(event.payload, "reviewId") === reviewId);
}

function hasPendingExecutiveReviewFor(snapshot: ForgeSnapshot, operationId: string | undefined, category: string | undefined) {
  if (!operationId || !category) {
    return false;
  }

  const resolvedReviewIds = new Set(
    snapshot.events
      .filter((event) => event.type === "executive.review_approved" || event.type === "executive.review_rejected")
      .map((event) => getPayloadStringValue(event.payload, "reviewId"))
      .filter((id): id is string => Boolean(id))
  );

  return snapshot.events.some((event) => {
    if (event.type !== "executive.review_requested") {
      return false;
    }
    const reviewId = getPayloadStringValue(event.payload, "reviewId");
    if (reviewId && resolvedReviewIds.has(reviewId)) {
      return false;
    }
    const eventOperationId = getPayloadStringValue(event.payload, "operationId");
    const eventCategory = getPayloadStringValue(event.payload, "category") ?? getPayloadStringValue(event.payload, "failureCategory");
    return eventOperationId === operationId && eventCategory === category;
  });
}

function getPayloadStringValue(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function validateExecutiveProposalQuality(draft: ExecutiveProposalDraft, snapshot: ForgeSnapshot, operatorMessage = "") {
  const issues: string[] = [];
  const createdWorkers = draft.actions.filter((action): action is Extract<ExecutiveProposalAction, { type: "create_worker" }> => action.type === "create_worker");
  const createdOperations = draft.actions.filter((action): action is Extract<ExecutiveProposalAction, { type: "create_operation" }> => action.type === "create_operation");

  for (const worker of createdWorkers) {
    const hasAssignedOperation = createdOperations.some(
      (operation) => operation.divisionId === worker.divisionId && normalizeName(operation.workerName) === normalizeName(worker.name) && isRunnableOperationAction(operation)
    );
    if (!hasAssignedOperation) {
      issues.push(`New worker "${worker.name}" must have a same-proposal ready operation assigned with workerName "${worker.name}".`);
    }
  }

  if (isProjectBuildRequest(operatorMessage) && snapshot.operations.length === 0) {
    const hasRunnableWorkerOperation = createdOperations.some(
      (operation) => canResolveWorkerForProposalOperation(snapshot, draft, operation)
    );
    if (!hasRunnableWorkerOperation) {
      issues.push("New project build requests must include at least one operation that can be assigned to an existing workerId, same-proposal workerName, or default division worker.");
    }
  }

  for (const operation of createdOperations) {
    if (operation.workerId && !isValidWorkerForDivision(snapshot, operation.workerId, operation.divisionId) && !canResolveWorkerForProposalOperation(snapshot, draft, operation)) {
      issues.push(`Operation "${operation.title}" references worker "${operation.workerId}" outside division "${operation.divisionId}" and no valid fallback worker is available.`);
    }
  }

  return issues;
}

function validateExecutiveProposalApprovalPath(snapshot: ForgeSnapshot, proposal: ExecutiveProposal, operatorMessage: string, timestamp: string) {
  try {
    applyProposalActions(snapshot, proposal, timestamp, {
      makeCreatedOperationsRunnable: snapshot.operations.length === 0 && isProjectBuildRequest(operatorMessage),
      prioritizeResearchBeforeDevelopment: isResearchBeforeDevelopmentRequest(operatorMessage)
    });
    return [];
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown approval error";
    return [`Executive proposal cannot be approved as generated: ${reason}`];
  }
}

function isRunnableOperationAction(operation: Extract<ExecutiveProposalAction, { type: "create_operation" }>) {
  return (operation.status ?? "planning") === "ready" && (operation.routingStage ?? "worker_ready") === "worker_ready";
}

function normalizeName(value: string | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function isProjectBuildRequest(message: string) {
  const normalized = message.toLowerCase();
  const asksToBuild = /\b(build|start|create|make|implement|launch|ship|generate)\b/.test(normalized);
  const explicitlyResearchOnly = /\b(research only|only research|just research|plan only|planning only|only plan|just plan|investigate only)\b/.test(normalized);
  return asksToBuild && !explicitlyResearchOnly;
}

function isResearchBeforeDevelopmentRequest(message: string) {
  const normalized = message.toLowerCase();
  return /\b(research|investigate|discover|analyze|analyse|study)\b/.test(normalized) && isProjectBuildRequest(message);
}

function isResearchOperationText(value: string) {
  const normalized = value.toLowerCase();
  return /\b(research|investigate|discovery|discover|analyze|analyse|study|requirements|source discovery|market|user needs|scope)\b/.test(normalized);
}

function isDevelopmentOperationText(value: string) {
  const normalized = value.toLowerCase();
  return /\b(build|implement|develop|code|create|generate|scaffold|bootstrap|setup|set up|package\.json|app shell|source files|styles|website|web app|frontend|backend|integration)\b/.test(normalized);
}

function canResolveWorkerForProposalOperation(snapshot: ForgeSnapshot, draft: ExecutiveProposalDraft, operation: Extract<ExecutiveProposalAction, { type: "create_operation" }>) {
  if (operation.workerId && snapshot.workers.some((worker) => worker.id === operation.workerId && worker.divisionId === operation.divisionId)) {
    return true;
  }
  const createdWorkerNames = new Set(
    draft.actions
      .filter((action): action is Extract<ExecutiveProposalAction, { type: "create_worker" }> => action.type === "create_worker" && action.divisionId === operation.divisionId)
      .map((worker) => normalizeName(worker.name))
  );
  if (createdWorkerNames.has(normalizeName(operation.workerName))) {
    return true;
  }
  return Boolean(selectDefaultWorkerForOperation(snapshot, operation.divisionId, operation.title, operation.description));
}

function applyProposalActions(
  snapshot: ForgeSnapshot,
  proposal: ExecutiveProposal,
  timestamp: string,
  options: { makeCreatedOperationsRunnable?: boolean; prioritizeResearchBeforeDevelopment?: boolean } = {}
) {
  let nextSnapshot = snapshot;
  const events: RuntimeEventDraft[] = [];
  const resolvedOperationIds = new Map<string, string>();
  const pendingDependencies: Array<{ operationId: string; action: Extract<ExecutiveProposalAction, { type: "create_operation" }> }> = [];
  const createdOperationActions: Array<{ operationId: string; action: Extract<ExecutiveProposalAction, { type: "create_operation" }> }> = [];
  const createdWorkerIdsByName = new Map(
    proposal.actions.flatMap((action, index) =>
      action.type === "create_worker" ? [[workerNameKey(action.divisionId, action.name), createProposedWorkerId(snapshot, action.name, index, timestamp)] as const] : []
    )
  );

  proposal.actions.forEach((rawAction, index) => {
    const action = resolveProposalActionReferences(nextSnapshot, rawAction, resolvedOperationIds);
    validateProposalAction(nextSnapshot, action);
    if (action.type === "create_worker") {
      const worker = {
        id: createProposedWorkerId(snapshot, action.name, index, timestamp),
        divisionId: action.divisionId,
        name: action.name,
        role: action.role,
        kind: "worker" as const,
        managerWorkerId: nextSnapshot.divisions.find((division) => division.id === action.divisionId)?.leadWorkerId,
        status: action.status ?? ("idle" as const),
        currentTask: action.currentTask,
        contextManifest: {
          objective: action.currentTask ? `${action.role}. ${action.currentTask}` : action.role,
          instructionSources: ["Executive AI staffing proposal", "ForgeOS role charter", "Dynamic specialist staffing request"],
          virtualFileRefs: [],
          artifactRefs: [],
          memorySnippets: [`Specialize as ${action.role}.`, action.currentTask ? `Primary focus: ${action.currentTask}` : "Await a specialist operation assignment."],
          recentEventSummary: ["Spawned by Executive AI to increase team capacity and expertise."],
          redactions: ["Provider raw prompts and hidden instructions are not displayed."]
        }
      };
      nextSnapshot = {
        ...nextSnapshot,
        workers: [...nextSnapshot.workers, worker]
      };
      events.push({
        forgeId: snapshot.forge.id,
        type: "worker.created",
        actorType: "executive",
        targetType: "worker",
        targetId: worker.id,
        message: `Executive proposal created worker: ${worker.name}.`,
        severity: "info",
        payload: { proposalId: proposal.id, workerId: worker.id, divisionId: worker.divisionId, role: worker.role }
      });
      return;
    }

    if (action.type === "create_operation") {
      const duplicate = findSimilarOperation(nextSnapshot, action);
      if (duplicate) {
        events.push(createDuplicateOperationSkippedEvent(snapshot, proposal.id, action, duplicate));
        return;
      }

      const workerAssignment = resolveCreatedOperationWorker(nextSnapshot, action, createdWorkerIdsByName);
      const assignedWorkerId = workerAssignment.workerId;
      const assignedWorker = assignedWorkerId ? nextSnapshot.workers.find((worker) => worker.id === assignedWorkerId) : undefined;
      const operationStatus = options.makeCreatedOperationsRunnable && action.status !== "blocked" ? ("ready" as const) : action.status ?? ("planning" as const);
      const operation = {
        id: `${snapshot.forge.slug}-op-${stableIdForPath(action.title)}-${Date.now()}-${index}`,
        divisionId: action.divisionId,
        workerId: assignedWorkerId,
        title: action.title,
        description: action.description,
        status: operationStatus,
        priority: action.priority ?? ("normal" as const),
        progress: 0,
        retryCount: 0,
        outputArtifactIds: [],
        routingStage: action.routingStage ?? inferCreatedOperationRoutingStage(operationStatus, assignedWorker?.kind),
        webAccessPolicy: action.webAccessPolicy ?? ("none" as const),
        webAccessPurpose: action.webAccessPurpose,
        allowedDomains: normalizeAllowedDomains(action.allowedDomains)
      };
      if (action.operationKey) {
        if (resolvedOperationIds.has(action.operationKey)) {
          throw new RuntimeCommandError(`Executive proposal has duplicate operation key ${action.operationKey}.`, 409);
        }
        resolvedOperationIds.set(action.operationKey, operation.id);
      }
      nextSnapshot = {
        ...nextSnapshot,
        operations: [...nextSnapshot.operations, operation]
      };
      if ((action.dependsOnOperationIds?.length ?? 0) > 0 || (action.dependsOnOperationKeys?.length ?? 0) > 0) {
        pendingDependencies.push({ operationId: operation.id, action });
      }
      createdOperationActions.push({ operationId: operation.id, action });
      events.push({
        forgeId: snapshot.forge.id,
        type: "operation.created",
        actorType: "executive",
        targetType: "operation",
        targetId: operation.id,
        message: `Executive proposal created operation: ${operation.title}.`,
        severity: "info",
        payload: {
          proposalId: proposal.id,
          operationId: operation.id,
          divisionId: operation.divisionId,
          workerId: operation.workerId,
          routingStage: operation.routingStage,
          operationKey: action.operationKey,
          dependsOnOperationIds: action.dependsOnOperationIds ?? [],
          dependsOnOperationKeys: action.dependsOnOperationKeys ?? [],
          ...(workerAssignment.workerReassigned
            ? {
                originalWorkerId: workerAssignment.originalWorkerId,
                workerReassigned: true
              }
            : {})
        }
      });
      return;
    }

    if (action.type === "update_operation") {
      nextSnapshot = {
        ...nextSnapshot,
        operations: nextSnapshot.operations.map((operation) =>
          operation.id === action.operationId
            ? {
                ...operation,
                title: action.title ?? operation.title,
                description: action.description ?? operation.description,
                divisionId: action.divisionId ?? operation.divisionId,
                workerId: action.workerId ?? operation.workerId,
                priority: action.priority ?? operation.priority,
                status: action.status ?? operation.status,
                blockedReason: action.blockedReason ?? (action.status && action.status !== "blocked" ? undefined : operation.blockedReason),
                routingStage: action.routingStage ?? operation.routingStage,
                webAccessPolicy: action.webAccessPolicy ?? operation.webAccessPolicy,
                webAccessPurpose: action.webAccessPurpose ?? operation.webAccessPurpose,
                allowedDomains: action.allowedDomains ? normalizeAllowedDomains(action.allowedDomains) : operation.allowedDomains
              }
            : operation
        )
      };
      events.push({
        forgeId: snapshot.forge.id,
        type: "operation.created",
        actorType: "executive",
        targetType: "operation",
        targetId: action.operationId,
        message: "Executive proposal updated operation routing.",
        severity: "info",
        payload: { proposalId: proposal.id, operationId: action.operationId, action: "update_operation" }
      });
      return;
    }

    if (action.type === "delete_operation") {
      const operation = nextSnapshot.operations.find((candidate) => candidate.id === action.operationId);
      if (!operation) {
        return;
      }
      const hasRunHistory = nextSnapshot.runs.some((run) => run.operationId === action.operationId);
      const removedDependencyIds = nextSnapshot.dependencies
        .filter((dependency) => dependency.operationId === action.operationId || dependency.dependsOnOperationId === action.operationId)
        .map((dependency) => dependency.id);
      const removedHandoffIds = nextSnapshot.handoffs
        .filter((handoff) => handoff.fromOperationId === action.operationId || handoff.targetOperationId === action.operationId || handoff.acceptedByOperationId === action.operationId)
        .map((handoff) => handoff.id);

      const cleanedSnapshot = {
        ...nextSnapshot,
        dependencies: nextSnapshot.dependencies.filter((dependency) => dependency.operationId !== action.operationId && dependency.dependsOnOperationId !== action.operationId),
        handoffs: nextSnapshot.handoffs.filter((handoff) => handoff.fromOperationId !== action.operationId && handoff.targetOperationId !== action.operationId && handoff.acceptedByOperationId !== action.operationId),
        workers: nextSnapshot.workers.map((worker) => (worker.currentTask === operation.title ? { ...worker, currentTask: undefined } : worker))
      };

      if (operation.status === "archived") {
        nextSnapshot = cleanedSnapshot;
        events.push({
          forgeId: snapshot.forge.id,
          type: "operation.archived",
          actorType: "executive",
          targetType: "operation",
          targetId: action.operationId,
          message: `Executive proposal kept archived operation cleaned up: ${operation.title}.`,
          severity: "info",
          payload: {
            proposalId: proposal.id,
            operationId: action.operationId,
            title: operation.title,
            reason: action.reason,
            alreadyArchived: true,
            removedDependencyIds,
            removedHandoffIds
          }
        });
        return;
      }

      if (hasRunHistory) {
        nextSnapshot = {
          ...cleanedSnapshot,
          operations: cleanedSnapshot.operations.map((candidate) =>
            candidate.id === action.operationId
              ? {
                  ...candidate,
                  status: "archived" as const,
                  routingStage: "done" as const,
                  blockedReason: `Archived by Executive cleanup: ${action.reason}`,
                  progress: Math.min(candidate.progress, 99)
                }
              : candidate
          )
        };
        events.push({
          forgeId: snapshot.forge.id,
          type: "operation.archived",
          actorType: "executive",
          targetType: "operation",
          targetId: action.operationId,
          message: `Executive proposal archived operation: ${operation.title}.`,
          severity: "warning",
          payload: {
            proposalId: proposal.id,
            operationId: action.operationId,
            title: operation.title,
            reason: action.reason,
            runHistoryPreserved: true,
            removedDependencyIds,
            removedHandoffIds
          }
        });
        return;
      }

      nextSnapshot = {
        ...cleanedSnapshot,
        operations: cleanedSnapshot.operations.filter((candidate) => candidate.id !== action.operationId)
      };
      events.push({
        forgeId: snapshot.forge.id,
        type: "operation.deleted",
        actorType: "executive",
        targetType: "operation",
        targetId: action.operationId,
        message: `Executive proposal deleted operation: ${operation.title}.`,
        severity: "warning",
        payload: {
          proposalId: proposal.id,
          operationId: action.operationId,
          title: operation.title,
          reason: action.reason,
          removedDependencyIds,
          removedHandoffIds
        }
      });
      return;
    }

    if (action.type === "create_handoff") {
      const handoff = {
        id: `${snapshot.forge.slug}-executive-handoff-${Date.now()}-${index}`,
        fromDivisionId: action.fromDivisionId,
        toDivisionId: action.toDivisionId,
        targetOperationId: action.targetOperationId,
        summary: action.summary,
        deliverables: action.deliverables ?? [],
        blockers: action.blockers ?? [],
        requiredContext: action.requiredContext ?? [],
        artifactIds: [],
        fileIds: [],
        status: "open" as const,
        confidence: action.confidence ?? 75,
        createdAt: timestamp
      };
      nextSnapshot = {
        ...nextSnapshot,
        handoffs: [...nextSnapshot.handoffs, handoff]
      };
      events.push({
        forgeId: snapshot.forge.id,
        type: "handoff.created",
        actorType: "executive",
        targetType: "handoff",
        targetId: handoff.id,
        message: "Executive proposal created a targeted handoff.",
        severity: "info",
        payload: {
          proposalId: proposal.id,
          handoffId: handoff.id,
          fromDivisionId: handoff.fromDivisionId,
          toDivisionId: handoff.toDivisionId,
          targetOperationId: handoff.targetOperationId
        }
      });
      return;
    }

    const operation = nextSnapshot.operations.find((candidate) => candidate.id === action.operationId);
    nextSnapshot = {
      ...nextSnapshot,
      operations: nextSnapshot.operations.map((candidate) =>
        candidate.id === action.operationId
          ? {
              ...candidate,
              status: "blocked" as const,
              blockedReason: action.reason
            }
          : candidate
      ),
      workers: operation?.workerId
        ? nextSnapshot.workers.map((worker) =>
            worker.id === operation.workerId
              ? {
                  ...worker,
                  status: "blocked" as const,
                  currentTask: undefined
                }
              : worker
          )
        : nextSnapshot.workers
    };
    events.push({
      forgeId: snapshot.forge.id,
      type: "operation.blocked",
      actorType: "executive",
      targetType: "operation",
      targetId: action.operationId,
      message: action.reason,
      severity: action.severity ?? "warning",
      payload: { proposalId: proposal.id, operationId: action.operationId }
    });
  });

  const researchFirst = options.prioritizeResearchBeforeDevelopment
    ? applyResearchBeforeDevelopmentDependencies(nextSnapshot, createdOperationActions, pendingDependencies, resolvedOperationIds)
    : { snapshot: nextSnapshot, dependencies: pendingDependencies, events: [] };
  const dependencyResult = applyProposalOperationDependencies(researchFirst.snapshot, proposal.id, researchFirst.dependencies, resolvedOperationIds);
  return { snapshot: dependencyResult.snapshot, events: [...events, ...researchFirst.events], dependencyCount: dependencyResult.dependencyCount };
}

function applyResearchBeforeDevelopmentDependencies(
  snapshot: ForgeSnapshot,
  createdOperations: Array<{ operationId: string; action: Extract<ExecutiveProposalAction, { type: "create_operation" }> }>,
  pendingDependencies: Array<{ operationId: string; action: Extract<ExecutiveProposalAction, { type: "create_operation" }> }>,
  resolvedOperationIds: Map<string, string>
) {
  const researchOperationIds = createdOperations
    .filter(({ operationId, action }) => {
      const operation = snapshot.operations.find((candidate) => candidate.id === operationId);
      return Boolean(operation && isResearchOperationText(`${operation?.title ?? action.title} ${operation?.description ?? action.description}`));
    })
    .map(({ operationId }) => operationId);

  if (researchOperationIds.length === 0) {
    return { snapshot, dependencies: pendingDependencies, events: [] };
  }

  const explicitDependencies = resolvePendingDependencyPairs(snapshot, pendingDependencies, resolvedOperationIds);
  const prospectiveDependencies = [
    ...snapshot.dependencies.filter((dependency) => dependency.type === "blocks").map((dependency) => ({ operationId: dependency.operationId, dependsOnOperationId: dependency.dependsOnOperationId })),
    ...explicitDependencies
  ];
  const existingDependencyKeys = new Set(prospectiveDependencies.map((dependency) => dependencyKey(dependency.operationId, dependency.dependsOnOperationId)));
  const inferredDependencies: Array<{ operationId: string; action: Extract<ExecutiveProposalAction, { type: "create_operation" }> }> = [];
  const gatedOperationIds = new Set<string>();

  for (const created of createdOperations) {
    const operation = snapshot.operations.find((candidate) => candidate.id === created.operationId);
    if (!operation || !isDevelopmentOperationText(`${operation.title} ${operation.description}`) || isResearchOperationText(`${operation.title} ${operation.description}`)) {
      continue;
    }
    const dependencyIds = researchOperationIds.filter((researchOperationId) => {
      if (researchOperationId === operation.id || existingDependencyKeys.has(dependencyKey(operation.id, researchOperationId))) {
        return false;
      }
      return !wouldCreateBlockingDependencyCycle(prospectiveDependencies, operation.id, researchOperationId);
    });
    if (dependencyIds.length === 0) {
      continue;
    }
    gatedOperationIds.add(operation.id);
    for (const dependencyId of dependencyIds) {
      prospectiveDependencies.push({ operationId: operation.id, dependsOnOperationId: dependencyId });
      existingDependencyKeys.add(dependencyKey(operation.id, dependencyId));
    }
    inferredDependencies.push({
      operationId: operation.id,
      action: {
        ...created.action,
        dependsOnOperationIds: [...(created.action.dependsOnOperationIds ?? []), ...dependencyIds]
      }
    });
  }

  if (inferredDependencies.length === 0) {
    return { snapshot, dependencies: pendingDependencies, events: [] };
  }

  const gatedSnapshot = {
    ...snapshot,
    operations: snapshot.operations.map((operation) =>
      gatedOperationIds.has(operation.id)
        ? {
            ...operation,
            status: "blocked" as const,
            blockedReason: "Waiting for research to complete before development starts."
          }
        : operation
    )
  };
  const events = [...gatedOperationIds].map((operationId) => ({
    forgeId: snapshot.forge.id,
    type: "operation.blocked" as const,
    actorType: "runtime" as const,
    targetType: "operation" as const,
    targetId: operationId,
    message: "Development operation gated behind same-proposal research.",
    severity: "info" as const,
    payload: { operationId, reason: "research_before_development", researchOperationIds }
  }));

  return { snapshot: gatedSnapshot, dependencies: [...pendingDependencies, ...inferredDependencies], events };
}

function resolvePendingDependencyPairs(
  snapshot: ForgeSnapshot,
  pendingDependencies: Array<{ operationId: string; action: Extract<ExecutiveProposalAction, { type: "create_operation" }> }>,
  resolvedOperationIds: Map<string, string>
) {
  return pendingDependencies.flatMap((pending) =>
    resolveProposalDependencyIds(snapshot, pending.operationId, pending.action, resolvedOperationIds).map((dependsOnOperationId) => ({
      operationId: pending.operationId,
      dependsOnOperationId
    }))
  );
}

function wouldCreateBlockingDependencyCycle(
  dependencies: Array<{ operationId: string; dependsOnOperationId: string }>,
  operationId: string,
  dependsOnOperationId: string
) {
  return hasBlockingDependencyCycleForPairs([...dependencies, { operationId, dependsOnOperationId }]);
}

function applyProposalOperationDependencies(
  snapshot: ForgeSnapshot,
  proposalId: string,
  pendingDependencies: Array<{ operationId: string; action: Extract<ExecutiveProposalAction, { type: "create_operation" }> }>,
  resolvedOperationIds: Map<string, string>
) {
  if (pendingDependencies.length === 0) {
    return { snapshot, dependencyCount: 0 };
  }

  const existingDependencyKeys = new Set(snapshot.dependencies.map((dependency) => dependencyKey(dependency.operationId, dependency.dependsOnOperationId)));
  const dependencies = [...snapshot.dependencies];
  let dependencyCount = 0;

  for (const pending of pendingDependencies) {
    const dependencyIds = resolveProposalDependencyIds(snapshot, pending.operationId, pending.action, resolvedOperationIds);
    for (const dependsOnOperationId of dependencyIds) {
      const key = dependencyKey(pending.operationId, dependsOnOperationId);
      if (existingDependencyKeys.has(key)) {
        continue;
      }
      existingDependencyKeys.add(key);
      dependencies.push({
        id: `${snapshot.forge.slug}-dep-${stableIdForPath(pending.operationId)}-${stableIdForPath(dependsOnOperationId)}`,
        operationId: pending.operationId,
        dependsOnOperationId,
        type: "blocks"
      });
      dependencyCount += 1;
    }
  }

  const nextSnapshot = { ...snapshot, dependencies };
  if (hasBlockingDependencyCycle(nextSnapshot)) {
    throw new RuntimeCommandError("Executive proposal creates a blocking dependency cycle.", 409);
  }

  return { snapshot: nextSnapshot, dependencyCount };
}

function resolveProposalDependencyIds(
  snapshot: ForgeSnapshot,
  operationId: string,
  action: Extract<ExecutiveProposalAction, { type: "create_operation" }>,
  resolvedOperationIds: Map<string, string>
) {
  const operationIds = (action.dependsOnOperationIds ?? []).map((candidate) => resolveProposalDependencyOperationId(snapshot, candidate, resolvedOperationIds));
  const keyedOperationIds = (action.dependsOnOperationKeys ?? []).map((key) => {
    const operationId = resolvedOperationIds.get(key);
    if (!operationId) {
      throw new RuntimeCommandError(`Executive proposal references unknown operation key ${key}.`, 409);
    }
    return operationId;
  });

  return Array.from(new Set([...operationIds, ...keyedOperationIds])).map((dependsOnOperationId) => {
    if (dependsOnOperationId === operationId) {
      throw new RuntimeCommandError("Executive proposal cannot create a self-dependency.", 409);
    }
    if (!snapshot.operations.some((operation) => operation.id === dependsOnOperationId)) {
      throw new RuntimeCommandError(`Executive proposal references unknown dependency operation ${dependsOnOperationId}.`, 409);
    }
    return dependsOnOperationId;
  });
}

function resolveProposalDependencyOperationId(snapshot: ForgeSnapshot, candidate: string, resolvedOperationIds: Map<string, string>) {
  const direct = resolvedOperationIds.get(candidate);
  if (direct || snapshot.operations.some((operation) => operation.id === candidate)) {
    return direct ?? candidate;
  }

  const normalizedCandidate = normalizeName(candidate);
  const aliased = Array.from(resolvedOperationIds.entries()).find(([operationKey]) => {
    const normalizedKey = normalizeName(operationKey);
    return normalizedCandidate === normalizedKey || normalizedCandidate.endsWith(`-${normalizedKey}`);
  });

  return aliased?.[1] ?? candidate;
}

function dependencyKey(operationId: string, dependsOnOperationId: string) {
  return `${operationId}:${dependsOnOperationId}:blocks`;
}

function hasBlockingDependencyCycle(snapshot: ForgeSnapshot) {
  return hasBlockingDependencyCycleForPairs(
    snapshot.dependencies
      .filter((dependency) => dependency.type === "blocks")
      .map((dependency) => ({ operationId: dependency.operationId, dependsOnOperationId: dependency.dependsOnOperationId })),
    snapshot.operations.map((operation) => operation.id)
  );
}

function hasBlockingDependencyCycleForPairs(dependencies: Array<{ operationId: string; dependsOnOperationId: string }>, operationIds?: string[]) {
  const graph = dependencies.reduce<Map<string, string[]>>((map, dependency) => {
    map.set(dependency.operationId, [...(map.get(dependency.operationId) ?? []), dependency.dependsOnOperationId]);
    return map;
  }, new Map());
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(operationId: string): boolean {
    if (visiting.has(operationId)) {
      return true;
    }
    if (visited.has(operationId)) {
      return false;
    }
    visiting.add(operationId);
    for (const dependencyId of graph.get(operationId) ?? []) {
      if (visit(dependencyId)) {
        return true;
      }
    }
    visiting.delete(operationId);
    visited.add(operationId);
    return false;
  }

  return (operationIds ?? [...graph.keys()]).some((operationId) => visit(operationId));
}

function repairBlockingDependencyCycles(snapshot: ForgeSnapshot): { snapshot: ForgeSnapshot; events: RuntimeEventDraft[] } {
  let dependencies = snapshot.dependencies;
  const removedDependencies: OperationDependency[] = [];
  const maxRepairs = snapshot.dependencies.length;

  for (let index = 0; index < maxRepairs; index += 1) {
    const cycle = findBlockingDependencyCycle({ ...snapshot, dependencies });
    if (cycle.length === 0) {
      break;
    }

    const dependency = selectBlockingDependencyCycleEdgeToRemove(snapshot, cycle);
    removedDependencies.push(dependency);
    dependencies = dependencies.filter((candidate) => candidate.id !== dependency.id);
  }

  if (removedDependencies.length === 0) {
    return { snapshot, events: [] };
  }

  const nextSnapshot = {
    ...snapshot,
    dependencies
  };
  const events = removedDependencies.map((dependency) => {
    const operation = snapshot.operations.find((candidate) => candidate.id === dependency.operationId);
    const dependsOnOperation = snapshot.operations.find((candidate) => candidate.id === dependency.dependsOnOperationId);
    return {
      forgeId: snapshot.forge.id,
      type: "operation.blocked" as const,
      actorType: "runtime" as const,
      targetType: "operation" as const,
      targetId: dependency.operationId,
      message: `Runtime removed cyclic blocking dependency from ${operation?.title ?? dependency.operationId} to ${dependsOnOperation?.title ?? dependency.dependsOnOperationId}.`,
      severity: "warning" as const,
      payload: {
        reason: "blocking_dependency_cycle_repaired",
        removedDependencyId: dependency.id,
        operationId: dependency.operationId,
        dependsOnOperationId: dependency.dependsOnOperationId
      }
    };
  });

  return { snapshot: nextSnapshot, events };
}

function findBlockingDependencyCycle(snapshot: ForgeSnapshot): OperationDependency[] {
  const blockingDependencies = snapshot.dependencies.filter((dependency) => dependency.type === "blocks");
  const graph = blockingDependencies.reduce<Map<string, string[]>>((map, dependency) => {
    map.set(dependency.operationId, [...(map.get(dependency.operationId) ?? []), dependency.dependsOnOperationId].sort());
    return map;
  }, new Map());
  const dependencyByKey = new Map(blockingDependencies.map((dependency) => [dependencyKey(dependency.operationId, dependency.dependsOnOperationId), dependency]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(operationId: string): OperationDependency[] {
    if (visiting.has(operationId)) {
      const startIndex = stack.indexOf(operationId);
      const cycleOperationIds = stack.slice(startIndex);
      return cycleOperationIds
        .map((current, index) => {
          const next = cycleOperationIds[(index + 1) % cycleOperationIds.length];
          return dependencyByKey.get(dependencyKey(current, next));
        })
        .filter((dependency): dependency is OperationDependency => Boolean(dependency));
    }
    if (visited.has(operationId)) {
      return [];
    }

    visiting.add(operationId);
    stack.push(operationId);
    for (const dependencyId of graph.get(operationId) ?? []) {
      const cycle = visit(dependencyId);
      if (cycle.length > 0) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(operationId);
    visited.add(operationId);
    return [];
  }

  for (const operationId of [...graph.keys()].sort()) {
    const cycle = visit(operationId);
    if (cycle.length > 0) {
      return cycle;
    }
  }

  return [];
}

function selectBlockingDependencyCycleEdgeToRemove(snapshot: ForgeSnapshot, cycle: OperationDependency[]) {
  const operations = new Map(snapshot.operations.map((operation) => [operation.id, operation]));

  return cycle
    .slice()
    .sort((left, right) => {
      const leftScore = scoreBlockingDependencyCycleEdge(operations, left);
      const rightScore = scoreBlockingDependencyCycleEdge(operations, right);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      return left.id.localeCompare(right.id);
    })[0];
}

function scoreBlockingDependencyCycleEdge(operations: Map<string, Operation>, dependency: OperationDependency) {
  const operation = operations.get(dependency.operationId);
  const dependsOnOperation = operations.get(dependency.dependsOnOperationId);
  let score = 0;

  if (dependsOnOperation && isNestedRepairOperation(dependsOnOperation)) {
    score += 200;
  }
  if (operation?.status === "ready" && dependsOnOperation?.status === "blocked") {
    score += 100;
  }
  if (operation && dependsOnOperation && isMissingPrerequisiteOperation(operation) && isMissingPrerequisiteOperation(dependsOnOperation)) {
    score += 50;
  }
  if (operation && isMissingPrerequisiteOperation(operation)) {
    score += 20;
  }
  if (operation?.status === "ready") {
    score += 10;
  }
  if (dependsOnOperation?.status !== "completed") {
    score += 5;
  }

  return score;
}

function isNestedRepairOperation(operation: Operation) {
  return /\brepair verification failure for\s+repair verification failure\b/i.test(operation.title);
}

function resolveProposalActionReferences(
  snapshot: ForgeSnapshot,
  action: ExecutiveProposalAction,
  resolvedOperationIds: Map<string, string>
): ExecutiveProposalAction {
  if (action.type === "update_operation") {
    const operationId = resolveProposalOperationId(snapshot, action.operationId, action.title, action.divisionId);
    if (operationId !== action.operationId) {
      resolvedOperationIds.set(action.operationId, operationId);
      return { ...action, operationId };
    }
    return action;
  }

  if (action.type === "create_blocker") {
    const operationId = resolvedOperationIds.get(action.operationId) ?? resolveProposalOperationId(snapshot, action.operationId, undefined, undefined);
    return operationId === action.operationId ? action : { ...action, operationId };
  }

  if (action.type === "delete_operation") {
    const operationId = resolveProposalOperationId(snapshot, action.operationId, undefined, undefined);
    return operationId === action.operationId ? action : { ...action, operationId };
  }

  if (action.type === "create_handoff" && action.targetOperationId) {
    const targetOperationId = resolvedOperationIds.get(action.targetOperationId) ?? resolveProposalOperationId(snapshot, action.targetOperationId, undefined, undefined);
    return targetOperationId === action.targetOperationId ? action : { ...action, targetOperationId };
  }

  return action;
}

function resolveProposalOperationId(snapshot: ForgeSnapshot, operationId: string, title: string | undefined, divisionId: string | undefined) {
  if (snapshot.operations.some((operation) => operation.id === operationId)) {
    return operationId;
  }

  const prefixMatches = snapshot.operations.filter((operation) => operation.id.startsWith(operationId));
  if (prefixMatches.length === 1) {
    return prefixMatches[0].id;
  }
  if (prefixMatches.length > 1) {
    throw new RuntimeCommandError(`Executive proposal references ambiguous operation prefix ${operationId}.`, 409);
  }

  const normalizedTitle = normalizeName(title);
  if (!normalizedTitle || !divisionId) {
    return operationId;
  }

  const matches = snapshot.operations.filter((operation) => operation.divisionId === divisionId && normalizeName(operation.title) === normalizedTitle);
  return matches.length === 1 ? matches[0].id : operationId;
}

function createProposedWorkerId(snapshot: ForgeSnapshot, name: string, index: number, timestamp: string) {
  return `${snapshot.forge.slug}-worker-${stableIdForPath(name)}-${stableIdForPath(timestamp)}-${index}`;
}

function createDuplicateOperationSkippedEvent(
  snapshot: ForgeSnapshot,
  proposalId: string,
  action: Extract<ExecutiveProposalAction, { type: "create_operation" }>,
  duplicate: OperationSimilarityMatch
): RuntimeEventDraft {
  return {
    forgeId: snapshot.forge.id,
    type: "operation.blocked",
    actorType: "runtime",
    targetType: "operation",
    targetId: duplicate.operation.id,
    message: `Executive proposal skipped similar operation: ${action.title}.`,
    severity: "warning",
    payload: {
      proposalId,
      action: "create_operation_skipped",
      reason: "similar_operation_exists",
      requestedTitle: action.title,
      existingOperationId: duplicate.operation.id,
      existingTitle: duplicate.operation.title,
      similarityScore: duplicate.score
    }
  };
}

type OperationSimilarityCandidate = Pick<Operation, "divisionId" | "title" | "description"> & { id?: string };
type OperationSimilarityMatch = { operation: Operation; score: number };

const OPERATION_SIMILARITY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "before",
  "for",
  "from",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "so",
  "the",
  "this",
  "to",
  "with",
  "work",
  "task",
  "operation",
  "operations",
  "create",
  "produce",
  "provide",
  "prepare",
  "implement",
  "build",
  "review",
  "validate",
  "validation",
  "context",
  "prerequisite",
  "implementation",
  "artifacts",
  "outputs",
  "evidence"
]);

function findSimilarOperation(
  snapshot: ForgeSnapshot,
  candidate: OperationSimilarityCandidate,
  options: { ignoredOperationIds?: string[] } = {}
): OperationSimilarityMatch | undefined {
  const ignoredOperationIds = new Set(options.ignoredOperationIds ?? []);
  const matches = snapshot.operations
    .filter((operation) => operation.divisionId === candidate.divisionId && operation.id !== candidate.id && !ignoredOperationIds.has(operation.id))
    .map((operation) => ({ operation, score: calculateOperationSimilarity(operation, candidate) }))
    .filter((match) => match.score >= 0.66)
    .sort((left, right) => right.score - left.score);

  return matches[0];
}

function findSimilarPrerequisiteOperation(
  snapshot: ForgeSnapshot,
  candidate: OperationSimilarityCandidate,
  options: { ignoredOperationIds?: string[] } = {}
): OperationSimilarityMatch | undefined {
  return (
    findSimilarOperation(snapshot, candidate, options) ??
    snapshot.operations
      .filter((operation) => operation.divisionId === candidate.divisionId && operation.id !== candidate.id && !(options.ignoredOperationIds ?? []).includes(operation.id))
      .filter((operation) => operation.status !== "completed" && isMissingPrerequisiteOperation(operation))
      .map((operation) => ({ operation, score: calculateOperationSimilarity(operation, candidate) }))
      .filter((match) => match.score >= 0.45)
      .sort((left, right) => right.score - left.score)[0]
  );
}

function calculateOperationSimilarity(left: OperationSimilarityCandidate, right: OperationSimilarityCandidate) {
  const leftTitle = operationTokenSet(left.title);
  const rightTitle = operationTokenSet(right.title);
  const leftText = operationTokenSet(`${left.title} ${left.description}`);
  const rightText = operationTokenSet(`${right.title} ${right.description}`);
  const titleScore = jaccardSimilarity(leftTitle, rightTitle);
  const textScore = jaccardSimilarity(leftText, rightText);

  if (normalizeName(left.title) === normalizeName(right.title)) {
    return 1;
  }

  return Math.max(titleScore, textScore);
}

function operationTokenSet(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !OPERATION_SIMILARITY_STOPWORDS.has(token))
      .map(normalizeOperationToken)
      .filter((token) => token.length >= 3)
  );
}

function normalizeOperationToken(token: string) {
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("ing") && token.length > 5) {
    return token.slice(0, -3);
  }
  if (token.endsWith("ed") && token.length > 4) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && token.length > 4) {
    return token.slice(0, -1);
  }
  return token;
}

function jaccardSimilarity(left: Set<string>, right: Set<string>) {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  const intersectionSize = [...left].filter((token) => right.has(token)).length;
  const unionSize = new Set([...left, ...right]).size;
  return unionSize === 0 ? 0 : Number((intersectionSize / unionSize).toFixed(3));
}

function validateProposalAction(snapshot: ForgeSnapshot, action: ExecutiveProposalAction) {
  if (action.type === "create_worker") {
    requireDivision(snapshot, action.divisionId);
    return;
  }

  if (action.type === "create_operation") {
    requireDivision(snapshot, action.divisionId);
    return;
  }

  if (action.type === "update_operation") {
    const operation = requireOperation(snapshot, action.operationId);
    if (action.divisionId) {
      requireDivision(snapshot, action.divisionId);
    }
    if (action.workerId) {
      requireWorker(snapshot, action.workerId, action.divisionId ?? operation.divisionId);
    }
    return;
  }

  if (action.type === "delete_operation") {
    const operation = requireOperation(snapshot, action.operationId);
    const activeRun = snapshot.runs.find((run) => run.operationId === action.operationId && isActiveRun(run));
    if (activeRun || operation.status === "running" || operation.status === "reviewing") {
      throw new RuntimeCommandError(`Executive proposal cannot delete active operation ${action.operationId}. Pause or cancel it first.`, 409);
    }
    if (operation.status === "completed") {
      throw new RuntimeCommandError(`Executive proposal cannot delete completed operation ${action.operationId}. Completed work remains part of the audit trail.`, 409);
    }
    return;
  }

  if (action.type === "create_handoff") {
    requireDivision(snapshot, action.fromDivisionId);
    requireDivision(snapshot, action.toDivisionId);
    if (action.targetOperationId) {
      requireOperation(snapshot, action.targetOperationId);
    }
    return;
  }

  requireOperation(snapshot, action.operationId);
}

function resolveWorkerIdByName(snapshot: ForgeSnapshot, workerName: string | undefined, divisionId: string, createdWorkerIdsByName: Map<string, string>) {
  const normalized = normalizeName(workerName);
  if (!normalized) {
    return undefined;
  }
  const createdWorkerId = createdWorkerIdsByName.get(workerNameKey(divisionId, workerName));
  if (createdWorkerId) {
    return createdWorkerId;
  }
  return snapshot.workers.find((worker) => worker.divisionId === divisionId && normalizeName(worker.name) === normalized)?.id;
}

function workerNameKey(divisionId: string, workerName: string | undefined) {
  return `${divisionId}:${normalizeName(workerName)}`;
}

function isValidWorkerForDivision(snapshot: ForgeSnapshot, workerId: string | undefined, divisionId: string) {
  return Boolean(workerId && snapshot.workers.some((worker) => worker.id === workerId && worker.divisionId === divisionId));
}

function resolveCreatedOperationWorker(
  snapshot: ForgeSnapshot,
  action: Extract<ExecutiveProposalAction, { type: "create_operation" }>,
  createdWorkerIdsByName: Map<string, string>
) {
  const workerId = isValidWorkerForDivision(snapshot, action.workerId, action.divisionId)
    ? action.workerId
    : resolveWorkerIdByName(snapshot, action.workerName, action.divisionId, createdWorkerIdsByName) ??
      selectDefaultWorkerForOperation(snapshot, action.divisionId, action.title, action.description)?.id ??
      snapshot.divisions.find((division) => division.id === action.divisionId)?.leadWorkerId;

  if (!workerId) {
    throw new RuntimeCommandError(`Executive proposal cannot resolve a worker for division ${action.divisionId}.`, 409);
  }

  return {
    workerId,
    originalWorkerId: action.workerId,
    workerReassigned: Boolean(action.workerId && action.workerId !== workerId)
  };
}

function selectDefaultWorkerForOperation(snapshot: ForgeSnapshot, divisionId: string, title: string, description: string) {
  const workers = snapshot.workers.filter((worker) => worker.divisionId === divisionId);
  const workerPool = workers.filter((worker) => worker.kind === "worker");
  const candidates = workerPool.length > 0 ? workerPool : workers;
  const searchable = `${title} ${description}`.toLowerCase();
  const preferredMarker = /\b(frontend|ui|ux|page|screen|website|web|component|style|css|html|react|next)\b/.test(searchable)
    ? "frontend"
    : /\b(test|qa|verify|validation|e2e|coverage|accessibility)\b/.test(searchable)
      ? "testing"
      : /\b(api|database|backend|server|auth|schema|data|integration|parser|sync)\b/.test(searchable)
        ? "backend"
        : undefined;
  return (
    (preferredMarker ? candidates.find((worker) => `${worker.id} ${worker.name} ${worker.role}`.toLowerCase().includes(preferredMarker)) : undefined) ??
    candidates.find((worker) => worker.kind === "worker") ??
    candidates[0]
  );
}

function createExecutiveProposalFailureDiagnostics(error: unknown, provider: { provider: ExecutiveProposal["provider"]; model?: string }) {
  const payload: Record<string, unknown> = {
    provider: provider.provider,
    ...(provider.model ? { model: provider.model } : {})
  };

  if (error instanceof ExecutiveProviderRequestError) {
    return {
      message: error.diagnostics.message,
      payload: {
        ...payload,
        category: error.diagnostics.category,
        message: error.diagnostics.message,
        ...(error.diagnostics.httpStatus ? { httpStatus: error.diagnostics.httpStatus } : {}),
        ...(error.diagnostics.providerErrorCode ? { providerErrorCode: error.diagnostics.providerErrorCode } : {}),
        ...(error.diagnostics.providerErrorType ? { providerErrorType: error.diagnostics.providerErrorType } : {})
      }
    };
  }

  if (error instanceof z.ZodError) {
    const issues = error.issues.slice(0, 8).map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message.slice(0, 160)
    }));
    const issueSummary = issues.map((issue) => `${issue.path || "(root)"}: ${issue.message}`).join("; ");
    return {
      message: `Executive AI provider returned a proposal that failed ForgeOS schema validation.${issueSummary ? ` ${issueSummary}` : ""}`,
      payload: {
        ...payload,
        category: "schema_validation_failed",
        issueCount: error.issues.length,
        issues
      }
    };
  }

  if (error instanceof ExecutiveProposalQualityError) {
    return {
      message: error.message,
      payload: {
        ...payload,
        category: "proposal_quality_failed",
        issues: error.issues.slice(0, 8)
      }
    };
  }

  return {
    message: "Executive AI proposal generation failed.",
    payload: {
      ...payload,
      category: "proposal_generation_failed"
    }
  };
}

function requireOperation(snapshot: ForgeSnapshot, operationId: string) {
  const operation = snapshot.operations.find((candidate) => candidate.id === operationId);
  if (!operation) {
    throw new RuntimeCommandError(`Executive proposal references unknown operation ${operationId}.`, 409);
  }
  return operation;
}

function requireDivision(snapshot: ForgeSnapshot, divisionId: string) {
  const division = snapshot.divisions.find((candidate) => candidate.id === divisionId);
  if (!division) {
    throw new RuntimeCommandError(`Executive proposal references unknown division ${divisionId}.`, 409);
  }
  return division;
}

function requireWorker(snapshot: ForgeSnapshot, workerId: string, divisionId: string) {
  const worker = snapshot.workers.find((candidate) => candidate.id === workerId);
  if (!worker || worker.divisionId !== divisionId) {
    throw new RuntimeCommandError(`Executive proposal references invalid worker ${workerId}.`, 409);
  }
  return worker;
}

function updateRun(snapshot: ForgeSnapshot, runId: string, patch: Partial<AgentRun>): ForgeSnapshot {
  return {
    ...snapshot,
    runs: snapshot.runs.map((run) => (run.id === runId ? { ...run, ...patch } : run))
  };
}

function withRepairBrief(providerPrompt: ProviderPromptPackage, repairBrief: AgentRepairBrief): ProviderPromptPackage {
  const prompt = {
    ...providerPrompt,
    repairBrief,
    context: {
      ...providerPrompt.context,
      operation: {
        ...providerPrompt.context.operation,
        retryCount: providerPrompt.context.operation.retryCount + 1
      }
    }
  } satisfies ProviderPromptPackage;

  return {
    ...prompt,
    estimatedTokens: estimateProviderPromptTokens(prompt)
  };
}

function withPromptRunContextCheckpoint(providerPrompt: ProviderPromptPackage, run: AgentRun | undefined): ProviderPromptPackage {
  const checkpoint = run ? readRunContextCheckpoint(run.providerMetadata) : undefined;
  if (!checkpoint) {
    return providerPrompt;
  }

  const prompt = {
    ...providerPrompt,
    context: {
      ...providerPrompt.context,
      longRunCheckpoint: checkpoint
    }
  } satisfies ProviderPromptPackage;

  return {
    ...prompt,
    estimatedTokens: estimateProviderPromptTokens(prompt)
  };
}

function readRunAttempts(metadata: Record<string, unknown>): AgentRunAttempt[] {
  return Array.isArray(metadata.attempts) ? (metadata.attempts.filter(isAgentRunAttempt) as AgentRunAttempt[]) : [];
}

function isAgentRunAttempt(value: unknown): value is AgentRunAttempt {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as AgentRunAttempt).attemptNumber === "number");
}

function canSelfRepair(run: AgentRun) {
  return getSelfRepairAttemptCount(run.providerMetadata) < MAX_SELF_REPAIR_RETRIES;
}

function getSelfRepairAttemptCount(metadata: Record<string, unknown>) {
  return readRunAttempts(metadata).filter((attempt) => attempt.triggerReason === "self_repair").length;
}

function createRepairBrief(input: {
  operationGoal: string;
  category: AgentFailureCategory;
  message: string;
  sanitizedErrors: string[];
  omissions: string[];
  previousAttemptSummary?: string;
  projectedFileRefs?: string[];
}): AgentRepairBrief {
  return {
    operationGoal: sanitizeBriefText(input.operationGoal, 500),
    failureCategory: input.category,
    whatFailed: sanitizeBriefText(input.message, 360),
    sanitizedErrors: input.sanitizedErrors.map((item) => sanitizeBriefText(item, 1000)).slice(0, 8),
    relevantOutputOmissions: input.omissions.map((item) => sanitizeBriefText(item, 240)).slice(0, 8),
    ...(input.previousAttemptSummary ? { previousAttemptSummary: sanitizeBriefText(input.previousAttemptSummary, 240) } : {}),
    ...(input.projectedFileRefs ? { projectedFileRefs: input.projectedFileRefs.slice(0, 20) } : {}),
    allowedNextActions: [
      "Return corrected artifacts, files, handoffs, or blockers using the declared output schema.",
      "Request bounded file/search context if missing context caused the failure.",
      "Declare a concrete blocker when the work cannot be repaired by the worker."
    ]
  };
}

function summarizeRepairBrief(brief: AgentRepairBrief) {
  return {
    failureCategory: brief.failureCategory,
    whatFailed: brief.whatFailed,
    sanitizedErrorCount: brief.sanitizedErrors.length,
    omissionCount: brief.relevantOutputOmissions.length,
    projectedFileRefs: brief.projectedFileRefs
  };
}

function createSelfRepairSnapshot(
  snapshot: ForgeSnapshot,
  run: AgentRun,
  repairBrief: AgentRepairBrief,
  options: {
    providerPatch?: Partial<AgentRun>;
    providerEvents?: RuntimeEventDraft[];
    projectedEvents?: RuntimeEventDraft[];
    verificationSummary?: RuntimeVerificationSummary;
    message: string;
  }
): ForgeSnapshot {
  const retryCount = getSelfRepairAttemptCount(run.providerMetadata) + 1;
  const attempts = completeLatestAttempt(readRunAttempts(run.providerMetadata), repairBrief.failureCategory);
  const providerMetadata = mergeRuntimeVerificationSummaryIfPresent(
    mergeTraceSummary(mergeProviderMetadata(run.providerMetadata, options.providerPatch?.providerMetadata), {
      lifecycle: {
        provider: run.provider,
        status: "streaming",
        selfRepairAttemptCount: retryCount,
        schemaRepairAttemptCount: repairBrief.failureCategory === "schema_validation_failed" || repairBrief.failureCategory === "invalid_json" ? retryCount : undefined
      }
    }),
    options.verificationSummary
  );
  const patched = updateRun(
    {
      ...snapshot,
      operations: snapshot.operations.map((operation) =>
        operation.id === run.operationId
          ? {
              ...operation,
              status: "running" as const,
              routingStage: "running" as const,
              retryCount: operation.retryCount + 1,
              blockedReason: undefined
            }
          : operation
      ),
      workers: snapshot.workers.map((worker) =>
        worker.id === run.workerId
          ? {
              ...worker,
              status: "running" as const,
              currentTask: snapshot.operations.find((operation) => operation.id === run.operationId)?.title
            }
          : worker
      )
    },
    run.id,
    {
      ...options.providerPatch,
      status: "streaming",
      error: undefined,
      providerMetadata: {
        ...providerMetadata,
        attempts,
        repairBriefSummary: summarizeRepairBrief(repairBrief)
      }
    }
  );

  return appendEvents(patched, [
    ...(options.providerEvents ?? []),
    ...(options.projectedEvents ?? []),
    {
      forgeId: snapshot.forge.id,
      type: "run.retry_requested" as const,
      actorType: "runtime" as const,
      targetType: "run" as const,
      targetId: run.id,
      message: `Self-repair requested for ${repairBrief.failureCategory}.`,
      severity: "warning" as const,
      payload: {
        runId: run.id,
        operationId: run.operationId,
        workerId: run.workerId,
        failureCategory: repairBrief.failureCategory,
        retryCount
      }
    }
  ]);
}

function createLeadEscalationSnapshot(
  snapshot: ForgeSnapshot,
  run: AgentRun,
  input: {
    category: AgentFailureCategory;
    message: string;
    providerPatch?: Partial<AgentRun>;
    providerEvents?: RuntimeEventDraft[];
    projectedEvents?: RuntimeEventDraft[];
    verificationSummary?: RuntimeVerificationSummary;
    retryBrief: AgentRepairBrief;
  }
): ForgeSnapshot {
  const operation = snapshot.operations.find((candidate) => candidate.id === run.operationId);
  if (operation && isLeadRecoveryOperation(operation, run.workerId ? snapshot.workers.find((worker) => worker.id === run.workerId) : undefined)) {
    const originalOperation = operation.escalatedFromOperationId ? (snapshot.operations.find((candidate) => candidate.id === operation.escalatedFromOperationId) ?? operation) : operation;
    const failedAt = new Date().toISOString();
    const attempts = completeLatestAttempt(readRunAttempts(run.providerMetadata), "lead_triage_failed");
    const failedSnapshot = updateRun(
      {
        ...snapshot,
        operations: snapshot.operations.map((candidate) =>
          candidate.id === run.operationId
            ? {
                ...candidate,
                status: "failed" as const,
                blockedReason: input.message,
                routingStage: "done" as const
              }
            : candidate
        ),
        workers: snapshot.workers.map((worker) => (worker.id === run.workerId ? { ...worker, status: "blocked" as const, currentTask: undefined } : worker))
      },
      run.id,
      {
        ...input.providerPatch,
        status: "failed",
        failedAt,
        error: input.message,
        providerMetadata: mergeRuntimeVerificationSummaryIfPresent(
          {
            ...mergeTraceSummary(mergeProviderMetadata(run.providerMetadata, input.providerPatch?.providerMetadata), {
              lifecycle: {
                provider: run.provider,
                status: "failed",
                failedAt,
                selfRepairAttemptCount: getSelfRepairAttemptCount(run.providerMetadata),
                escalationCount: (readFiniteNumber(run.providerMetadata.escalationCount) ?? 0) + 1,
                finalFailureCategory: "lead_triage_failed"
              }
            }),
            attempts,
            finalFailureCategory: "lead_triage_failed",
            repairBriefSummary: summarizeRepairBrief({ ...input.retryBrief, failureCategory: "lead_triage_failed" })
          },
          input.verificationSummary
        )
      }
    );
    const escalated = createExecutiveEscalation(failedSnapshot, {
      run,
      operation: originalOperation,
      category: "lead_triage_failed",
      reason: input.message,
      recommendedNextAction: "executive_review",
      timestamp: failedAt
    });
    return appendEvents(projectOrganizationalState(escalated.snapshot), [
      ...(input.providerEvents ?? []),
      ...(input.projectedEvents ?? []),
      {
        forgeId: snapshot.forge.id,
        type: "run.retry_exhausted",
        actorType: "runtime",
        targetType: "run",
        targetId: run.id,
        message: "Lead triage failed after repeated self-repair attempts.",
        severity: "error",
        payload: { runId: run.id, operationId: run.operationId, workerId: run.workerId, failureCategory: "lead_triage_failed", attemptHistory: summarizeAttempts(attempts) }
      },
      ...escalated.events
    ]);
  }
  const leadWorker = selectEscalationLeadWorker(snapshot, operation, run);
  const timestamp = new Date().toISOString();
  const attempts = completeLatestAttempt(readRunAttempts(run.providerMetadata), input.category);
  if (operation && !leadWorker) {
    const failedAt = timestamp;
    const failedSnapshot = updateRun(
      {
        ...snapshot,
        operations: snapshot.operations.map((candidate) =>
          candidate.id === run.operationId
            ? {
                ...candidate,
                status: "blocked" as const,
                blockedReason: input.message,
                routingStage: "done" as const
              }
            : candidate
        ),
        workers: snapshot.workers.map((worker) => (worker.id === run.workerId ? { ...worker, status: "blocked" as const, currentTask: undefined } : worker))
      },
      run.id,
      {
        ...input.providerPatch,
        status: "failed",
        failedAt,
        error: input.message,
        providerMetadata: mergeRuntimeVerificationSummaryIfPresent(
          {
            ...mergeTraceSummary(mergeProviderMetadata(run.providerMetadata, input.providerPatch?.providerMetadata), {
              lifecycle: {
                provider: run.provider,
                status: "failed",
                failedAt,
                selfRepairAttemptCount: getSelfRepairAttemptCount(run.providerMetadata),
                escalationCount: (readFiniteNumber(run.providerMetadata.escalationCount) ?? 0) + 1,
                finalFailureCategory: input.category
              }
            }),
            attempts,
            finalFailureCategory: input.category,
            escalationCount: (readFiniteNumber(run.providerMetadata.escalationCount) ?? 0) + 1,
            repairBriefSummary: summarizeRepairBrief(input.retryBrief)
          },
          input.verificationSummary
        )
      }
    );
    const escalated = createExecutiveEscalation(failedSnapshot, {
      run,
      operation,
      category: input.category,
      reason: `${input.message} No distinct division lead is available; the failing worker is already the lead path.`,
      recommendedNextAction: "Executive should decide whether to create repair operations, assign a different lead or worker, or ask the operator for permission.",
      timestamp: failedAt
    });
    return appendEvents(projectOrganizationalState(escalated.snapshot), [
      ...(input.providerEvents ?? []),
      ...(input.projectedEvents ?? []),
      {
        forgeId: snapshot.forge.id,
        type: "run.retry_exhausted" as const,
        actorType: "runtime" as const,
        targetType: "run" as const,
        targetId: run.id,
        message: `Self-repair exhausted for ${operation.title}; escalated to Executive because no distinct division lead is available.`,
        severity: "error" as const,
        payload: {
          runId: run.id,
          operationId: run.operationId,
          workerId: run.workerId,
          failureCategory: input.category,
          attemptHistory: summarizeAttempts(attempts),
          recommendedNextAction: "executive_review"
        }
      },
      ...escalated.events
    ]);
  }
  const attemptSummary = summarizeAttempts(attempts)
    .map((attempt) => `${attempt.triggerReason}:${attempt.failureCategory ?? "unknown"}`)
    .join(", ");
  const escalationCount = readFiniteNumber(run.providerMetadata.escalationCount) ?? 0;
  const failedAt = timestamp;
  const failedSnapshot = updateRun(
    {
      ...snapshot,
      operations: snapshot.operations.map((candidate) =>
          candidate.id === run.operationId
            ? {
                ...candidate,
                workerId: leadWorker?.id ?? candidate.workerId,
                description: [
                  candidate.description,
                  `Lead triage context: self-repair exhausted. Failure category: ${input.category}.`,
                  attemptSummary ? `Sanitized attempt history: ${attemptSummary}.` : "",
                  "Lead should revise this operation, request more context, or escalate to Executive without creating duplicate operations."
                ]
                  .filter(Boolean)
                  .join(" "),
                status: "ready" as const,
                blockedReason: undefined,
                routingStage: "lead_triaged" as const,
                escalationRunId: run.id,
                escalationFailureCategory: input.category
              }
            : candidate
        ),
      workers: snapshot.workers.map((worker) =>
        worker.id === run.workerId
          ? {
              ...worker,
              status: "blocked" as const,
              currentTask: undefined
            }
          : worker.id === leadWorker?.id
            ? {
                ...worker,
                status: "ready" as const,
                currentTask: operation?.title
              }
          : worker
      )
    },
    run.id,
    {
      ...input.providerPatch,
      status: "failed",
      failedAt,
      error: input.message,
      providerMetadata: mergeRuntimeVerificationSummaryIfPresent(
        {
          ...mergeTraceSummary(mergeProviderMetadata(run.providerMetadata, input.providerPatch?.providerMetadata), {
            lifecycle: {
              provider: run.provider,
              status: "failed",
              failedAt,
              selfRepairAttemptCount: getSelfRepairAttemptCount(run.providerMetadata),
              escalationCount: escalationCount + 1,
              finalFailureCategory: input.category
            }
          }),
          attempts,
          finalFailureCategory: input.category,
          escalationCount: escalationCount + 1,
          repairBriefSummary: summarizeRepairBrief(input.retryBrief)
        },
        input.verificationSummary
      )
    }
  );

  return appendEvents(projectOrganizationalState(failedSnapshot), [
    ...(input.providerEvents ?? []),
    ...(input.projectedEvents ?? []),
    {
      forgeId: snapshot.forge.id,
      type: "run.retry_exhausted" as const,
      actorType: "runtime" as const,
      targetType: "run" as const,
      targetId: run.id,
      message: `Self-repair exhausted for ${operation?.title ?? "operation"}.`,
      severity: "error" as const,
      payload: {
        runId: run.id,
        operationId: run.operationId,
        workerId: run.workerId,
        failureCategory: input.category,
        attemptHistory: summarizeAttempts(attempts)
      }
    },
    {
      forgeId: snapshot.forge.id,
      type: "operation.escalated" as const,
      actorType: "runtime" as const,
      targetType: "operation" as const,
      targetId: run.operationId,
      message: `Operation escalated to ${leadWorker?.name ?? "division lead"} after repeated self-repair failure.`,
      severity: "warning" as const,
      payload: {
        runId: run.id,
        operationId: run.operationId,
        workerId: run.workerId,
        leadWorkerId: leadWorker?.id,
        leadTriageOperationId: run.operationId,
        failureCategory: input.category,
        recommendedNextAction: "lead_triage"
      }
    }
  ]);
}

function selectEscalationLeadWorker(snapshot: ForgeSnapshot, operation: Operation | undefined, run: AgentRun) {
  if (!operation) {
    return undefined;
  }

  const division = snapshot.divisions.find((candidate) => candidate.id === operation.divisionId);
  const sameWorker = (worker: ForgeSnapshot["workers"][number] | undefined) => Boolean(worker?.id && worker.id === run.workerId);
  const isLeadCapable = (worker: ForgeSnapshot["workers"][number] | undefined) => Boolean(worker && (worker.kind === "lead" || worker.kind === "executive"));
  const divisionLead = division?.leadWorkerId ? snapshot.workers.find((worker) => worker.id === division.leadWorkerId) : undefined;
  if (isLeadCapable(divisionLead) && !sameWorker(divisionLead)) {
    return divisionLead;
  }

  const worker = run.workerId ? snapshot.workers.find((candidate) => candidate.id === run.workerId) : undefined;
  const manager = worker?.managerWorkerId ? snapshot.workers.find((candidate) => candidate.id === worker.managerWorkerId) : undefined;
  if (manager?.divisionId === operation.divisionId && isLeadCapable(manager) && !sameWorker(manager)) {
    return manager;
  }

  const peerLead = snapshot.workers.find((candidate) => candidate.divisionId === operation.divisionId && isLeadCapable(candidate) && !sameWorker(candidate));
  if (peerLead) {
    return peerLead;
  }

  return undefined;
}

function completeLatestAttempt(attempts: AgentRunAttempt[], failureCategory: AgentFailureCategory): AgentRunAttempt[] {
  if (attempts.length === 0) {
    return attempts;
  }
  const completedAt = new Date().toISOString();
  return attempts.map((attempt, index) =>
    index === attempts.length - 1
      ? {
          ...attempt,
          failureCategory,
          completedAt
        }
      : attempt
  );
}

function summarizeAttempts(attempts: AgentRunAttempt[]) {
  return attempts.slice(-5).map((attempt) => ({
    attemptNumber: attempt.attemptNumber,
    triggerReason: attempt.triggerReason,
    failureCategory: attempt.failureCategory,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt
  }));
}

function mergeRuntimeVerificationSummaryIfPresent(metadata: Record<string, unknown>, summary: RuntimeVerificationSummary | undefined) {
  return summary ? mergeRuntimeVerificationSummary(metadata, summary) : metadata;
}

function classifyCompletionFailure(payload: Record<string, unknown>, outputs: ProviderRunOutputs, acceptsRecoveryActions: boolean) {
  const hasOutputsPayload = Boolean(payload.outputs && typeof payload.outputs === "object" && !Array.isArray(payload.outputs));
  const outputKeys = hasOutputsPayload ? Object.keys(payload.outputs as Record<string, unknown>) : [];
  const hasDeclaredOutputs = outputKeys.length > 0;
  const usableOutputCount =
    outputs.artifacts.length +
    outputs.files.length +
    outputs.filePatches.length +
    outputs.handoffs.length +
    outputs.blockers.length +
    outputs.questionRequests.length +
    outputs.dangerousActions.length +
    outputs.dependencyRequests.length +
    (acceptsRecoveryActions ? outputs.recoveryActions.length : 0) +
    outputs.requestedFiles.length +
    outputs.requestedSearches.length +
    outputs.requestedArtifacts.length;

  if (hasDeclaredOutputs && usableOutputCount === 0 && outputs.omissions.length > 0) {
    return {
      category: "schema_validation_failed" as const,
      message: "Provider output did not contain any usable declarations after schema validation.",
      sanitizedErrors: outputs.omissions
    };
  }

  if (hasDeclaredOutputs && usableOutputCount === 0) {
    return {
      category: "empty_or_unusable_output" as const,
      message: "Provider completed with an empty output declaration.",
      sanitizedErrors: ["No artifacts, files, handoffs, blockers, context requests, or dangerous action declarations were usable."]
    };
  }

  return undefined;
}

function isLeadTriageContext(context: { operation: { escalatedFromOperationId?: string; escalationRunId?: string }; worker?: { kind?: string } }) {
  return context.worker?.kind === "lead" && Boolean(context.operation.escalationRunId || context.operation.escalatedFromOperationId);
}

function isLeadRecoveryOperation(operation: Operation | undefined, worker: ForgeSnapshot["workers"][number] | undefined) {
  return worker?.kind === "lead" && Boolean(operation?.escalationRunId || operation?.escalatedFromOperationId);
}

function classifyProviderFailure(providerPatch: Partial<AgentRun>): AgentFailureCategory {
  const terminalReason = providerPatch.rateLimit?.terminalReason;
  const metadataCategory = typeof providerPatch.providerMetadata?.category === "string" ? providerPatch.providerMetadata.category : undefined;
  const httpStatus = readFiniteNumber(providerPatch.providerMetadata?.httpStatus);
  if (terminalReason === "provider_timeout" || metadataCategory === "provider_timeout") {
    return "provider_timeout";
  }
  if (terminalReason === "network_error" || metadataCategory === "network_error") {
    return "network_error";
  }
  if (terminalReason === "insufficient_quota" || terminalReason === "retry_exhausted" || (metadataCategory === "provider_http_error" && httpStatus === 429)) {
    return "rate_limited";
  }
  if (metadataCategory === "provider_http_error" || (httpStatus !== undefined && httpStatus !== 429)) {
    return "provider_http_error";
  }
  return "provider_failed";
}

function isSelfRepairableFailureCategory(category: AgentFailureCategory) {
  return category !== "provider_timeout" && category !== "network_error" && category !== "rate_limited";
}

function withLifecycleRetryCounts(summary: RunTraceSummary, metadata: Record<string, unknown>): RunTraceSummary {
  const current = isTraceSummary(metadata.traceSummary) ? metadata.traceSummary : undefined;
  const countedSelfRepairAttempts = getSelfRepairAttemptCount(metadata);
  const selfRepairAttemptCount = current?.lifecycle?.selfRepairAttemptCount ?? (countedSelfRepairAttempts > 0 ? countedSelfRepairAttempts : undefined);
  return {
    ...summary,
    lifecycle: summary.lifecycle
      ? {
          ...summary.lifecycle,
          selfRepairAttemptCount,
          schemaRepairAttemptCount: current?.lifecycle?.schemaRepairAttemptCount ?? selfRepairAttemptCount,
          escalationCount: current?.lifecycle?.escalationCount,
          finalFailureCategory: current?.lifecycle?.finalFailureCategory
        }
      : summary.lifecycle
  };
}

function sanitizeVerificationErrors(summary: RuntimeVerificationSummary) {
  return [
    ...(summary.checks ?? []).map((check) => `${check.name}: ${check.message ?? check.status}${check.exitCode !== undefined ? ` (exitCode ${check.exitCode ?? "unknown"})` : ""}${check.outputTail ? ` Output tail: ${check.outputTail}` : ""}`),
    ...(summary.omittedReasons ?? [])
  ].slice(0, 8);
}

function getRequiredVerificationGap(
  snapshot: ForgeSnapshot,
  run: AgentRun,
  projected: { events: RuntimeEventDraft[] },
  outputs: ProviderRunOutputs,
  verificationSummary: RuntimeVerificationSummary
) {
  if (verificationSummary.status === "passed" || verificationSummary.status === "failed" || outputs.blockers.length > 0) {
    return undefined;
  }
  if (!requiresRuntimeVerification(snapshot, projected, outputs)) {
    return undefined;
  }

  const reason = verificationSummary.omittedReasons?.[0] ?? `Runtime verification returned ${verificationSummary.status}.`;
  return `Runtime verification is required for implementation output before this operation can complete. ${reason}`;
}

function requiresRuntimeVerification(snapshot: ForgeSnapshot, projected: { events: RuntimeEventDraft[] }, outputs: ProviderRunOutputs) {
  if (outputs.filePatches.some((patch) => isVerificationRequiredPath(patch.path))) {
    return true;
  }

  const projectedRefs = getProjectedOutputRefs(projected.events);
  const projectedFiles = snapshot.files.filter((file) => projectedRefs.fileIds.includes(file.id));
  return projectedFiles.some((file) => isVerificationRequiredPath(file.path));
}

function isVerificationRequiredPath(filePath: string) {
  const normalized = normalizeVirtualPath(filePath).toLowerCase();
  if (/^(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|tsconfig\.json|vite\.config\.|next\.config\.|vitest\.config\.|jest\.config\.)/.test(normalized)) {
    return true;
  }
  if (/\b(__tests__|tests?|specs?|e2e)\b/.test(normalized)) {
    return true;
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs|css|scss|html|vue|svelte|py|go|rs|java|kt|swift)$/.test(normalized)) {
    return true;
  }
  return false;
}

function sanitizeBriefText(value: string, maxLength: number) {
  return value
    .replace(/sk-[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/token|secret|credential|authorization|api.?key/gi, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function selectOneOperationPerWorker(operations: ForgeSnapshot["operations"]) {
  const claimedWorkerIds = new Set<string>();
  return operations.filter((operation) => {
    if (!operation.workerId) {
      return true;
    }

    if (claimedWorkerIds.has(operation.workerId)) {
      return false;
    }

    claimedWorkerIds.add(operation.workerId);
    return true;
  });
}

function readSchedulerSlotTarget() {
  const parsed = Number(process.env.FORGEOS_AGENT_MAX_CONCURRENT_RUNS ?? process.env.FORGEOS_CODEX_MAX_CONCURRENT_RUNS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 4;
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isExecutiveAutopilotEnabled() {
  return process.env.FORGEOS_EXECUTIVE_AUTOPILOT === "1" || process.env.FORGEOS_EXECUTIVE_AUTOPILOT === "true";
}

function acceptMatchingHandoffs(snapshot: ForgeSnapshot, operation: ForgeSnapshot["operations"][number], run: AgentRun, timestamp: string) {
  const acceptedIds = snapshot.handoffs
    .filter((handoff) => handoff.status === "open" && (handoff.targetOperationId === operation.id || (!handoff.targetOperationId && handoff.toDivisionId === operation.divisionId)))
    .map((handoff) => handoff.id);

  if (acceptedIds.length === 0) {
    return { snapshot, events: [] as RuntimeEventDraft[] };
  }

  const acceptedIdSet = new Set(acceptedIds);
  const handoffs = snapshot.handoffs.map((handoff) =>
    acceptedIdSet.has(handoff.id)
      ? {
          ...handoff,
          status: "accepted" as const,
          acceptedByOperationId: operation.id,
          acceptedAt: timestamp
        }
      : handoff
  );
  const events = handoffs
    .filter((handoff) => acceptedIdSet.has(handoff.id))
    .map((handoff) => ({
      forgeId: snapshot.forge.id,
      type: "handoff.accepted" as const,
      actorType: "runtime" as const,
      targetType: "handoff" as const,
      targetId: handoff.id,
      message: "Runtime accepted handoff for operation input.",
      severity: "info" as const,
      payload: { runId: run.id, operationId: operation.id, handoffId: handoff.id, fromDivisionId: handoff.fromDivisionId, toDivisionId: handoff.toDivisionId }
    }));

  return { snapshot: { ...snapshot, handoffs }, events };
}

function consumeAcceptedHandoffs(snapshot: ForgeSnapshot, run: AgentRun, timestamp: string) {
  const consumedIds = snapshot.handoffs.filter((handoff) => handoff.status === "accepted" && handoff.acceptedByOperationId === run.operationId).map((handoff) => handoff.id);

  if (consumedIds.length === 0) {
    return { snapshot, events: [] as RuntimeEventDraft[] };
  }

  const consumedIdSet = new Set(consumedIds);
  const handoffs = snapshot.handoffs.map((handoff) =>
    consumedIdSet.has(handoff.id)
      ? {
          ...handoff,
          status: "consumed" as const,
          consumedAt: timestamp
        }
      : handoff
  );
  const events = handoffs
    .filter((handoff) => consumedIdSet.has(handoff.id))
    .map((handoff) => ({
      forgeId: snapshot.forge.id,
      type: "handoff.consumed" as const,
      actorType: "runtime" as const,
      targetType: "handoff" as const,
      targetId: handoff.id,
      message: "Runtime marked handoff consumed by completed operation.",
      severity: "success" as const,
      payload: { runId: run.id, operationId: run.operationId, handoffId: handoff.id }
    }));

  return { snapshot: { ...snapshot, handoffs }, events };
}

function createRunSummaryDrafts(
  snapshot: ForgeSnapshot,
  run: AgentRun,
  status: string,
  content: string,
  projected: { events: RuntimeEventDraft[] } = { events: [] },
  consumed: { events: RuntimeEventDraft[] } = { events: [] },
  timestamp = new Date().toISOString()
): { snapshot: ForgeSnapshot; events: RuntimeEventDraft[] } {
  const operation = snapshot.operations.find((candidate) => candidate.id === run.operationId);
  const artifactIds = operation?.outputArtifactIds ?? [];
  const fileIds = snapshot.files.filter((file) => file.operationId === run.operationId).map((file) => file.id);
  const handoffIds = snapshot.handoffs.filter((handoff) => handoff.fromRunId === run.id || handoff.acceptedByOperationId === run.operationId).map((handoff) => handoff.id);
  const blockerMessages = [
    ...(operation?.blockedReason ? [operation.blockedReason] : []),
    ...projected.events.filter((event) => event.type === "operation.blocked").map((event) => event.message)
  ];
  const eventStartSequence = run.startedAt ? snapshot.events.find((event) => event.type === "run.started" && event.targetId === run.id)?.sequence : undefined;
  const eventEndSequence = snapshot.lastEventSequence + 2;
  const summarySnapshot = addExecutiveSummary(snapshot, {
    source: "run_terminal",
    scope: "run",
    status,
    runId: run.id,
    operationId: run.operationId,
    eventStartSequence,
    eventEndSequence,
    content,
    blockers: blockerMessages,
    handoffIds,
    artifactIds,
    fileIds,
    metricDeltas: {
      artifactCount: artifactIds.length,
      fileCount: fileIds.length,
      handoffCount: handoffIds.length,
      consumedHandoffCount: consumed.events.length
    },
    createdAt: timestamp
  });

  return {
    snapshot: summarySnapshot,
    events: [
      {
        forgeId: snapshot.forge.id,
        type: "executive.summary_created",
        actorType: "executive",
        targetType: "run",
        targetId: run.id,
        message: "Executive summary created for run terminal state.",
        severity: status === "completed" ? "success" : status === "failed" ? "error" : "warning",
        payload: { runId: run.id, operationId: run.operationId, source: "run_terminal", status, eventStartSequence, eventEndSequence }
      }
    ]
  };
}

function addExecutiveSummary(
  snapshot: ForgeSnapshot,
  input: {
    source: "run_terminal" | "cycle_terminal" | "full_flow_terminal";
    scope: "run" | "cycle" | "full_flow";
    status: string;
    content: string;
    runId?: string;
    operationId?: string;
    cycleId?: string;
    eventStartSequence?: number;
    eventEndSequence?: number;
    blockers?: string[];
    handoffIds?: string[];
    artifactIds?: string[];
    fileIds?: string[];
    metricDeltas?: Record<string, number>;
    createdAt?: string;
  }
): ForgeSnapshot {
  const summary = {
    scope: input.scope,
    status: input.status,
    runId: input.runId,
    operationId: input.operationId,
    cycleId: input.cycleId,
    eventStartSequence: input.eventStartSequence,
    eventEndSequence: input.eventEndSequence,
    blockers: input.blockers ?? [],
    handoffIds: input.handoffIds ?? [],
    artifactIds: input.artifactIds ?? [],
    fileIds: input.fileIds ?? [],
    metricDeltas: input.metricDeltas ?? {}
  };

  return {
    ...snapshot,
    messages: [
      ...snapshot.messages,
      {
        id: `exec-summary-${Date.now()}-${snapshot.messages.length + 1}`,
        role: "executive",
        kind: "executive_summary",
        source: input.source,
        content: input.content,
        runId: input.runId,
        operationId: input.operationId,
        cycleId: input.cycleId,
        eventStartSequence: input.eventStartSequence,
        eventEndSequence: input.eventEndSequence,
        status: input.status,
        summary,
        createdAt: input.createdAt ?? new Date().toISOString()
      }
    ]
  };
}

function getLatestCycleId(snapshot: ForgeSnapshot) {
  const event = snapshot.events
    .slice()
    .reverse()
    .find((candidate) => candidate.type === "cycle.started");
  return typeof event?.payload.cycleId === "string" ? event.payload.cycleId : undefined;
}

function findCycleStartSequence(snapshot: ForgeSnapshot, cycleId: string) {
  return snapshot.events.find((event) => event.type === "cycle.started" && event.payload.cycleId === cycleId)?.sequence;
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface RequestedContextPromptResult {
  providerPrompt: ProviderPromptPackage;
  addedFileCount: number;
  addedArtifactCount: number;
  searchResultCount: number;
  omissions: string[];
}

function buildRequestedContextPrompt(snapshot: ForgeSnapshot, providerPrompt: ProviderPromptPackage, outputs: ProviderRunOutputs, runId: string): RequestedContextPromptResult {
  const omissions: string[] = [];
  const requestedFiles = outputs.requestedFiles.slice(0, MAX_REQUESTED_FILES_PER_PASS);
  const requestedSearches = outputs.requestedSearches.slice(0, MAX_REQUESTED_SEARCHES_PER_PASS);
  const requestedArtifacts = outputs.requestedArtifacts.slice(0, MAX_REQUESTED_ARTIFACTS_PER_PASS);
  const searchPromptFiles = requestedSearches.map((request, index) => toSearchResultPromptFile(snapshot.files, request, index));
  const searchResultCount = searchPromptFiles.reduce((count, result) => count + result.resultCount, 0);
  const filePromptFiles = requestedFiles.flatMap((request) => {
    const file = findRequestedVirtualFile(snapshot.files, request);
    if (!file) {
      omissions.push(`requested file omitted because ${request.path ?? request.id ?? "unknown"} was not found.`);
      return [];
    }
    return [toRequestedPromptFile(file)];
  });
  const artifactPromptContexts = requestedArtifacts.flatMap((request) => {
    const artifact = findRequestedArtifact(snapshot.artifacts, request);
    if (!artifact) {
      omissions.push(`requested artifact omitted because ${request.id ?? request.title ?? request.type ?? "unknown"} was not found.`);
      return [];
    }
    return [toRequestedPromptArtifact(artifact)];
  });

  if (outputs.requestedFiles.length > requestedFiles.length) {
    omissions.push(`${outputs.requestedFiles.length - requestedFiles.length} requested files omitted after per-pass cap.`);
  }
  if (outputs.requestedSearches.length > requestedSearches.length) {
    omissions.push(`${outputs.requestedSearches.length - requestedSearches.length} requested searches omitted after per-pass cap.`);
  }
  if (outputs.requestedArtifacts.length > requestedArtifacts.length) {
    omissions.push(`${outputs.requestedArtifacts.length - requestedArtifacts.length} requested artifacts omitted after per-pass cap.`);
  }

  const additions = [...searchPromptFiles.map((result) => result.file), ...filePromptFiles];
  const contextFiles = mergeProviderPromptFiles(providerPrompt.context.files, additions);
  const contextArtifacts = mergeProviderPromptArtifacts(providerPrompt.context.artifacts, artifactPromptContexts);
  const nextPrompt = withPromptRunContextCheckpoint({
    ...providerPrompt,
    context: {
      ...providerPrompt.context,
      files: contextFiles,
      artifacts: contextArtifacts,
      omittedReasons: [...providerPrompt.context.omittedReasons, ...omissions].slice(0, 40)
    }
  } satisfies ProviderPromptPackage, snapshot.runs.find((candidate) => candidate.id === runId));

  return {
    providerPrompt: {
      ...nextPrompt,
      estimatedTokens: estimateProviderPromptTokens(nextPrompt)
    },
    addedFileCount: additions.length,
    addedArtifactCount: artifactPromptContexts.length,
    searchResultCount,
    omissions
  };
}

function findRequestedArtifact(artifacts: ProviderPromptArtifactSource[], request: ProviderArtifactRequestDeclaration) {
  if (request.id) {
    const byId = artifacts.find((artifact) => artifact.id === request.id);
    if (byId) {
      return byId;
    }
  }
  if (request.title) {
    const byTitle = artifacts.find((artifact) => artifact.title.toLowerCase() === request.title?.toLowerCase());
    if (byTitle) {
      return byTitle;
    }
  }
  return request.type ? artifacts.find((artifact) => artifact.type.toLowerCase() === request.type?.toLowerCase()) : undefined;
}

type ProviderPromptArtifactSource = ForgeSnapshot["artifacts"][number];

function toRequestedPromptArtifact(artifact: ProviderPromptArtifactSource): ProviderPromptPackage["context"]["artifacts"][number] {
  return {
    id: artifact.id,
    title: artifact.title,
    type: artifact.type,
    status: artifact.status,
    contentSummary: artifact.content.slice(0, MAX_REQUESTED_ARTIFACT_SUMMARY_CHARS),
    tags: artifact.tags.slice(0, 12)
  };
}

function findRequestedVirtualFile(files: VirtualFile[], request: ProviderFileReadRequestDeclaration) {
  if (request.id) {
    const byId = files.find((file) => file.id === request.id);
    if (byId) {
      return byId;
    }
  }
  return request.path ? files.find((file) => file.path === request.path) : undefined;
}

function toRequestedPromptFile(file: VirtualFile): ProviderPromptPackage["context"]["files"][number] {
  const excerpt = file.content.slice(0, MAX_REQUESTED_FILE_EXCERPT_CHARS);
  return {
    id: file.id,
    path: file.path,
    status: file.status,
    version: file.version,
    excerpt,
    truncated: file.content.length > excerpt.length
  };
}

function toSearchResultPromptFile(files: VirtualFile[], request: ProviderFileSearchRequestDeclaration, index: number) {
  const matches = searchVirtualFiles(files, request).slice(0, MAX_SEARCH_RESULTS_PER_REQUEST);
  const omittedCount = Math.max(0, searchVirtualFiles(files, request).length - matches.length);
  const excerpt =
    matches.length > 0
      ? [
          `Search query: ${request.query}`,
          request.glob ? `Glob: ${request.glob}` : undefined,
          ...matches.map((match) => `- ${match.path} (${match.id})\n${match.snippet}`)
        ]
          .filter(Boolean)
          .join("\n\n")
      : `Search query: ${request.query}\n${request.glob ? `Glob: ${request.glob}\n` : ""}No matching virtual workspace files were found.`;
  return {
    resultCount: matches.length,
    omittedCount,
    file: {
      id: `search-${stableIdForPath(`${request.query}-${request.glob ?? "all"}-${index}`)}`,
      path: `.forgeos/search-results/${stableIdForPath(`${request.query}-${index}`)}.md`,
      status: "generated" as const,
      version: 1,
      excerpt: omittedCount > 0 ? `${excerpt}\n\n${omittedCount} additional matches omitted after per-search cap.` : excerpt,
      truncated: omittedCount > 0
    }
  };
}

function searchVirtualFiles(files: VirtualFile[], request: ProviderFileSearchRequestDeclaration) {
  const normalizedQuery = request.query.trim().toLowerCase();
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  return files
    .filter((file) => matchesGlob(file.path, request.glob))
    .flatMap((file) => {
      const haystack = `${file.path}\n${file.content}`.toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) {
        return [];
      }
      return [
        {
          id: file.id,
          path: file.path,
          snippet: buildSearchSnippet(file.content, terms[0] ?? normalizedQuery)
        }
      ];
    });
}

function buildSearchSnippet(content: string, query: string) {
  const lowerContent = content.toLowerCase();
  const index = query ? lowerContent.indexOf(query) : -1;
  const start = index >= 0 ? Math.max(0, index - Math.floor(MAX_SEARCH_SNIPPET_CHARS / 3)) : 0;
  const snippet = content.slice(start, start + MAX_SEARCH_SNIPPET_CHARS);
  return `${start > 0 ? "..." : ""}${snippet}${start + MAX_SEARCH_SNIPPET_CHARS < content.length ? "..." : ""}`;
}

function matchesGlob(filePath: string, glob?: string) {
  if (!glob?.trim()) {
    return true;
  }
  const pattern = glob.trim().replace(/^\/+/, "");
  const regex = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*\\\*/g, ".*").replace(/\\\*/g, "[^/]*")}$`);
  return regex.test(filePath);
}

function mergeProviderPromptFiles(
  currentFiles: ProviderPromptPackage["context"]["files"],
  requestedFiles: ProviderPromptPackage["context"]["files"]
) {
  return [...currentFiles, ...requestedFiles].reduce<ProviderPromptPackage["context"]["files"]>((files, file) => {
    const existingIndex = files.findIndex((candidate) => candidate.id === file.id || candidate.path === file.path);
    if (existingIndex < 0) {
      return [...files, file];
    }
    return files.map((candidate, index) => (index === existingIndex ? file : candidate));
  }, []);
}

function mergeProviderPromptArtifacts(
  currentArtifacts: ProviderPromptPackage["context"]["artifacts"],
  requestedArtifacts: ProviderPromptPackage["context"]["artifacts"]
) {
  return [...currentArtifacts, ...requestedArtifacts].reduce<ProviderPromptPackage["context"]["artifacts"]>((artifacts, artifact) => {
    const existingIndex = artifacts.findIndex((candidate) => candidate.id === artifact.id || candidate.title === artifact.title);
    if (existingIndex < 0) {
      return [...artifacts, artifact];
    }
    return artifacts.map((candidate, index) => (index === existingIndex ? artifact : candidate));
  }, []);
}

function estimateProviderPromptTokens(prompt: ProviderPromptPackage) {
  return Math.ceil(JSON.stringify({ ...prompt, estimatedTokens: 0 }).length / CHARS_PER_ESTIMATED_TOKEN);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ProviderRunOutputs extends ProviderRunOutputDeclarations {
  omissions: string[];
}

interface ProviderOutputExtraction {
  outputs: ProviderRunOutputs;
}

function filterActionableProviderBlockers(outputs: ProviderRunOutputs, operation?: Operation): ProviderRunOutputs {
  const hasVerifiableOutputs = outputs.files.length > 0 || outputs.filePatches.length > 0;
  const actionableBlockers = outputs.blockers.filter(
    (blocker) => !isInformationalCoordinationBlocker(operation, blocker.reason) && !(hasVerifiableOutputs && isRuntimeOwnedVerificationBlocker(blocker.reason))
  );
  if (actionableBlockers.length === outputs.blockers.length) {
    return outputs;
  }

  const omittedReasons = outputs.blockers
    .flatMap((blocker) =>
      isInformationalCoordinationBlocker(operation, blocker.reason)
        ? [`informational coordination blocker ignored: ${sanitizeBriefText(blocker.reason, 240)}`]
        : hasVerifiableOutputs && isRuntimeOwnedVerificationBlocker(blocker.reason)
          ? [`runtime-owned verification blocker ignored: ${sanitizeBriefText(blocker.reason, 240)}`]
          : []
    );

  return {
    ...outputs,
    blockers: actionableBlockers,
    omissions: [...outputs.omissions, ...omittedReasons]
  };
}

function isInformationalCoordinationBlocker(operation: Operation | undefined, reason: string) {
  const operationText = `${operation?.title ?? ""} ${operation?.description ?? ""}`.toLowerCase();
  const reasonText = reason.toLowerCase();
  const isCoordinationOperation = /\b(coordinat|dependency routing|attention-needed|scheduler|handoff|operations?)\b/.test(operationText);
  const isDependencyStatus =
    /\b(no currently eligible operations|no eligible operations|scheduler reports no|work is dependency-gated|dependency-gated rather than blocked|not blocked by missing execution capacity)\b/.test(reasonText);
  return isCoordinationOperation && isDependencyStatus;
}

function isRuntimeOwnedVerificationBlocker(reason: string) {
  const normalized = reason.toLowerCase();
  const verificationSignal = /\b(executable|sandbox|runtime|launcher|verification|rerun|npm run|typecheck|lint|build|smoke|acceptance|test)\b/.test(normalized);
  const asksForRuntimeEvidence = /\b(no executable|not provided|missing|must execute|needs? forgeos|qa must execute|cannot truthfully claim|cannot confirm|rerun evidence|verification results?|verification output)\b/.test(normalized);
  return verificationSignal && asksForRuntimeEvidence;
}

function applyProviderFilePatches(
  snapshot: ForgeSnapshot,
  run: AgentRun,
  operation: Operation,
  patches: ProviderFilePatchDeclaration[],
  timestamp: string,
  omissions: string[]
) {
  const workerId = run.workerId ?? operation.workerId;
  const patchedFiles: VirtualFile[] = [];
  let nextFiles = snapshot.files;

  for (const patch of patches) {
    const existing = nextFiles.find((file) => file.path === patch.path);
    if (!existing) {
      omissions.push(`file patch omitted because ${patch.path} does not exist.`);
      continue;
    }

    const matchCount = countExactOccurrences(existing.content, patch.find);
    if (matchCount !== 1) {
      omissions.push(`file patch omitted because ${patch.path} matched ${matchCount} time${matchCount === 1 ? "" : "s"}; expected exactly once.`);
      continue;
    }

    const patchedFile = {
      ...existing,
      content: existing.content.replace(patch.find, patch.replace),
      status: "generated" as const,
      version: existing.version + 1,
      divisionId: operation.divisionId,
      workerId,
      operationId: operation.id,
      updatedAt: timestamp
    };
    nextFiles = nextFiles.map((file) => (file.id === existing.id ? patchedFile : file));
    patchedFiles.push(patchedFile);
  }

  return { files: nextFiles, patchedFiles };
}

function countExactOccurrences(content: string, needle: string) {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
}

function extractProviderRunPatch(payload: Record<string, unknown>): Partial<AgentRun> {
  const externalRunId = typeof payload.externalRunId === "string" && payload.externalRunId.trim() ? payload.externalRunId.trim() : undefined;
  const providerMetadata = sanitizeProviderMetadata(payload.providerMetadata);
  const usage = sanitizeRunUsage(payload.usage);
  const rateLimit = sanitizeRunRateLimit(payload.rateLimit);

  return {
    ...(externalRunId ? { externalRunId } : {}),
    ...(usage ? { usage } : {}),
    ...(rateLimit ? { rateLimit } : {}),
    ...(Object.keys(providerMetadata).length > 0 ? { providerMetadata } : {})
  };
}

function sanitizeProviderEventPayload(payload: Record<string, unknown>, runId: string, outputResult = extractProviderOutputs(payload)): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { runId };
  const providerPatch = extractProviderRunPatch(payload);

  if (typeof payload.operationId === "string") {
    sanitized.operationId = payload.operationId;
  }
  if (typeof providerPatch.externalRunId === "string") {
    sanitized.externalRunId = providerPatch.externalRunId;
  }
  if (providerPatch.providerMetadata && Object.keys(providerPatch.providerMetadata).length > 0) {
    sanitized.providerMetadata = providerPatch.providerMetadata;
  }
  if (providerPatch.usage) {
    sanitized.usage = providerPatch.usage;
  }
  if (providerPatch.rateLimit) {
    sanitized.rateLimit = providerPatch.rateLimit;
  }

  const outputs = outputResult.outputs;
  if (
    outputs.artifacts.length > 0 ||
    outputs.files.length > 0 ||
    outputs.filePatches.length > 0 ||
    outputs.requestedFiles.length > 0 ||
    outputs.requestedSearches.length > 0 ||
    outputs.requestedArtifacts.length > 0 ||
    outputs.handoffs.length > 0 ||
    outputs.blockers.length > 0 ||
    outputs.questionRequests.length > 0 ||
    outputs.verificationEvidence ||
    outputs.dangerousActions.length > 0 ||
    outputs.dependencyRequests.length > 0 ||
    outputs.recoveryActions.length > 0 ||
    outputs.omissions.length > 0
  ) {
    sanitized.outputs = {
      artifactCount: outputs.artifacts.length,
      fileCount: outputs.files.length,
      filePatchCount: outputs.filePatches.length,
      requestedFileCount: outputs.requestedFiles.length,
      requestedSearchCount: outputs.requestedSearches.length,
      requestedArtifactCount: outputs.requestedArtifacts.length,
      handoffCount: outputs.handoffs.length,
      blockerCount: outputs.blockers.length,
      questionRequestCount: outputs.questionRequests.length,
      verificationEvidence: outputs.verificationEvidence ? summarizeVerificationEvidence(outputs.verificationEvidence) : undefined,
      dangerousActionCount: outputs.dangerousActions.length,
      dependencyRequestCount: outputs.dependencyRequests.length,
      recoveryActionCount: outputs.recoveryActions.length,
      omittedCount: outputs.omissions.length
    };
  }

  return sanitized;
}

function sanitizeRunUsage(value: unknown): AgentRun["usage"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const usage = {
    inputTokens: readFiniteNumber(candidate.inputTokens),
    outputTokens: readFiniteNumber(candidate.outputTokens),
    cachedInputTokens: readFiniteNumber(candidate.cachedInputTokens),
    requestCount: readFiniteNumber(candidate.requestCount) ?? 1,
    costMicros: readFiniteNumber(candidate.costMicros),
    costSource: candidate.costSource === "provider" || candidate.costSource === "estimated" || candidate.costSource === "unknown" ? candidate.costSource : undefined,
    contextCompressionRatio: readFiniteNumber(candidate.contextCompressionRatio),
    cachedTokenRatio: readFiniteNumber(candidate.cachedTokenRatio),
    outputArtifactsPerInputToken: readFiniteNumber(candidate.outputArtifactsPerInputToken),
    outputFilesPerInputToken: readFiniteNumber(candidate.outputFilesPerInputToken),
    retryOverhead: readFiniteNumber(candidate.retryOverhead),
    webEstimatedTokenImpact: readFiniteNumber(candidate.webEstimatedTokenImpact)
  } satisfies AgentRun["usage"];

  return usage;
}

function enrichUsageMetrics(usage: AgentRun["usage"] | undefined, metadata: Record<string, unknown>, outputs: ProviderRunOutputs): AgentRun["usage"] | undefined {
  if (!usage) {
    return undefined;
  }
  const traceSummary = isTraceSummary(metadata.traceSummary) ? metadata.traceSummary : undefined;
  const contextCompressionRatio = traceSummary?.context?.compressionRatio;
  const inputTokens = usage.inputTokens ?? 0;
  return {
    ...usage,
    contextCompressionRatio,
    cachedTokenRatio: inputTokens > 0 && usage.cachedInputTokens !== undefined ? Number((usage.cachedInputTokens / inputTokens).toFixed(4)) : usage.cachedTokenRatio,
    outputArtifactsPerInputToken: inputTokens > 0 ? Number((outputs.artifacts.length / inputTokens).toFixed(6)) : undefined,
    outputFilesPerInputToken: inputTokens > 0 ? Number(((outputs.files.length + outputs.filePatches.length) / inputTokens).toFixed(6)) : undefined,
    retryOverhead: usage.retryOverhead ?? Math.max(0, (usage.requestCount ?? 1) - 1),
    webEstimatedTokenImpact: usage.webEstimatedTokenImpact ?? readFiniteNumber(metadata.webEstimatedTokenImpact)
  };
}

function sanitizeRunRateLimit(value: unknown): AgentRun["rateLimit"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  return {
    quotaSource: typeof candidate.quotaSource === "string" ? candidate.quotaSource.slice(0, 80) : undefined,
    limit: readFiniteNumber(candidate.limit),
    remaining: readFiniteNumber(candidate.remaining),
    resetAt: typeof candidate.resetAt === "string" ? candidate.resetAt : undefined,
    retryAfterMs: readFiniteNumber(candidate.retryAfterMs),
    attempts: readFiniteNumber(candidate.attempts),
    terminalReason: typeof candidate.terminalReason === "string" ? candidate.terminalReason.slice(0, 120) : undefined
  };
}

function readFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringFromRecord(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result = key.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);

  return typeof result === "string" && result.trim() ? result.trim().slice(0, 160) : undefined;
}

function sanitizeProviderMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((metadata, [key, item]) => {
    if (isSensitiveProviderMetadataKey(key) || !isPublicProviderMetadataValue(item)) {
      return metadata;
    }

    return {
      ...metadata,
      [key]: item
    };
  }, {});
}

function isSensitiveProviderMetadataKey(key: string) {
  return /token|secret|credential|authorization|api.?key|raw|prompt|context|payload/i.test(key);
}

function isPublicProviderMetadataValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      Object.entries(item).every(([key, nested]) => /^(url|title|domain)$/.test(key) && (typeof nested === "string" || nested === undefined))
  );
}

function extractProviderOutputs(payload: Record<string, unknown>): ProviderOutputExtraction {
  const outputs = payload.outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
    return { outputs: createEmptyProviderRunOutputs() };
  }

  const candidate = outputs as { artifacts?: unknown; files?: unknown; filePatches?: unknown; file_patches?: unknown; patches?: unknown };
  const omissions: string[] = [];
  const files = Array.isArray(candidate.files) ? candidate.files.flatMap((value) => toProviderFileOutput(value, omissions)) : [];
  const filePatches = readFilePatchCandidates(candidate).flatMap((value) => toProviderFilePatchOutput(value, omissions));
  const artifacts = Array.isArray(candidate.artifacts) ? candidate.artifacts.flatMap((value) => toProviderArtifactOutput(value, omissions)) : [];
  return {
    outputs: {
      artifacts: artifacts.length > 0 ? artifacts : files.map(toFileBackedArtifactOutput),
      files,
      filePatches,
      requestedFiles: readFileRequestCandidates(candidate).flatMap((value) => toProviderFileReadRequestOutput(value, omissions)),
      requestedSearches: readFileSearchCandidates(candidate).flatMap((value) => toProviderFileSearchRequestOutput(value, omissions)),
      requestedArtifacts: readArtifactRequestCandidates(candidate).flatMap((value) => toProviderArtifactRequestOutput(value, omissions)),
      handoffs: Array.isArray((candidate as { handoffs?: unknown }).handoffs)
        ? (candidate as { handoffs: unknown[] }).handoffs.flatMap((value) => toProviderHandoffOutput(value, omissions))
        : [],
      blockers: Array.isArray((candidate as { blockers?: unknown }).blockers)
        ? (candidate as { blockers: unknown[] }).blockers.flatMap((value) => toProviderBlockerOutput(value, omissions))
        : [],
      questionRequests: readQuestionRequestCandidates(candidate).flatMap((value) => toProviderWorkerQuestionRequestOutput(value, omissions)),
      verificationEvidence: toProviderVerificationEvidenceOutput((candidate as Record<string, unknown>).verificationEvidence ?? (candidate as Record<string, unknown>).verification ?? (candidate as Record<string, unknown>).verification_evidence, omissions),
      dangerousActions: readDangerousActionCandidates(candidate).flatMap((value) => toProviderDangerousActionOutput(value, omissions)),
      dependencyRequests: readDependencyRequestCandidates(candidate).flatMap((value) => toProviderDependencyRequestOutput(value, omissions)),
      recoveryActions: readRecoveryActionCandidates(candidate).flatMap((value) => toProviderRecoveryActionOutput(value, omissions)),
      omissions
    }
  };
}

function applyWorkerHelpGateToProviderOutput(result: ProviderOutputExtraction, event: RuntimeEventDraft, run: AgentRun) {
  if (result.outputs.questionRequests.length === 0) {
    return { ...result, suppressionEvents: [] };
  }

  const suppressed: ProviderWorkerQuestionRequestDeclaration[] = [];
  const allowed = result.outputs.questionRequests.filter((question) => {
    if (shouldSuppressWorkerHelpQuestion(question)) {
      suppressed.push(question);
      return false;
    }
    return true;
  });

  if (suppressed.length === 0) {
    return { ...result, suppressionEvents: [] };
  }

  const suppressionEvents = suppressed.map((question): RuntimeEventDraft => ({
    forgeId: event.forgeId,
    type: "run.progress",
    actorType: "runtime",
    targetType: "run",
    targetId: run.id,
    message: "Runtime suppressed a worker question that asked a lead to solve implementation work.",
    severity: "info",
    payload: {
      runId: run.id,
      operationId: run.operationId,
      workerId: run.workerId,
      reason: "worker_help_request_suppressed",
      question: sanitizeBriefText(question.question, 240)
    }
  }));

  return {
    outputs: {
      ...result.outputs,
      questionRequests: allowed,
      omissions: [
        ...result.outputs.omissions,
        ...suppressed.map((question) => `implementation-help question suppressed: ${sanitizeBriefText(question.question, 180)}`)
      ]
    },
    suppressionEvents
  };
}

function shouldSuppressWorkerHelpQuestion(question: ProviderWorkerQuestionRequestDeclaration) {
  if (isLegacyScopeApprovalQuestion(question)) {
    return false;
  }
  if (question.category && (!question.attemptsMade || question.attemptsMade.length === 0 || !question.whySelfSolveInsufficient)) {
    return true;
  }
  if (question.category) {
    return false;
  }
  return isImplementationHelpQuestion(question);
}

function isLegacyScopeApprovalQuestion(question: ProviderWorkerQuestionRequestDeclaration) {
  const text = `${question.question} ${question.reason} ${question.scope ?? ""}`.toLowerCase();
  return /\b(outside[-_\s]?scope|scope approval|shared files?|outside this operation scope|outside the assigned operation scope)\b/.test(text);
}

function isImplementationHelpQuestion(question: ProviderWorkerQuestionRequestDeclaration) {
  const text = `${question.question} ${question.reason} ${question.scope ?? ""} ${(question.options ?? []).map((option) => `${option.label} ${option.description ?? ""}`).join(" ")}`.toLowerCase();
  const leadSignal = /\b(lead|division lead|executive|manager)\b/.test(text);
  const helpSignal = /\b(debug|fix|solve|tell me what to try|what should i try|what should i do|how should i proceed|help me|implementation strategy|code change|typescript failure|test failure|build failure)\b/.test(text);
  return leadSignal && helpSignal;
}

function createEmptyProviderRunOutputs(): ProviderRunOutputs {
  return { artifacts: [], files: [], filePatches: [], requestedFiles: [], requestedSearches: [], requestedArtifacts: [], handoffs: [], blockers: [], questionRequests: [], dangerousActions: [], dependencyRequests: [], recoveryActions: [], omissions: [] };
}

function toProviderVerificationEvidenceOutput(value: unknown, omissions: string[]): ProviderVerificationEvidenceDeclaration | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    const summary = sanitizeBriefText(value, 500);
    return summary ? { commands: [], expectedScripts: [], summary, knownGaps: [] } : undefined;
  }
  if (Array.isArray(value) || typeof value !== "object") {
    omissions.push("verification evidence omitted because it was not an object or summary string.");
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const commands = toSanitizedEvidenceList(candidate.commands, 8, 160);
  const expectedScripts = toSanitizedEvidenceList(candidate.expectedScripts ?? candidate.scripts, 8, 80);
  const knownGaps = toSanitizedEvidenceList(candidate.knownGaps ?? candidate.gaps, 8, 240);
  const summary = firstNonEmptyString(candidate.summary, candidate.result, candidate.notes);
  const evidence = {
    commands,
    expectedScripts,
    ...(summary ? { summary: sanitizeBriefText(summary, 500) } : {}),
    knownGaps
  };

  if (commands.length === 0 && expectedScripts.length === 0 && !evidence.summary && knownGaps.length === 0) {
    omissions.push("verification evidence omitted because it contained no usable commands, scripts, summary, or gaps.");
    return undefined;
  }
  return evidence;
}

function summarizeVerificationEvidence(evidence: ProviderVerificationEvidenceDeclaration) {
  return {
    commandCount: evidence.commands.length,
    expectedScripts: evidence.expectedScripts,
    summary: evidence.summary,
    knownGapCount: evidence.knownGaps.length
  };
}

function toSanitizedEvidenceList(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(hasNonEmptyString).map((item) => sanitizeBriefText(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

function toProviderArtifactOutput(value: unknown, omissions: string[]): ProviderArtifactDeclaration[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    omissions.push("artifact omitted because it was not an object.");
    return [];
  }

  const candidate = value as Record<string, unknown>;
  const title = firstNonEmptyString(candidate.title, candidate.name, candidate.path);
  const type = firstNonEmptyString(candidate.type, candidate.kind, candidate.category);
  const content = firstNonEmptyString(candidate.content, candidate.markdown, candidate.text, candidate.summary, candidate.description);
  if (!title || !type || !content) {
    omissions.push("artifact omitted because title, type, or content was invalid.");
    return [];
  }

  return [
    {
      title: title.slice(0, 160),
      type: type.slice(0, 80),
      content: content.slice(0, 20000),
      tags: Array.isArray(candidate.tags) ? candidate.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 12) : []
    }
  ];
}

function firstNonEmptyString(...values: unknown[]) {
  for (const value of values) {
    if (hasNonEmptyString(value)) {
      return value.trim();
    }
  }
  return undefined;
}

function toFileBackedArtifactOutput(file: ProviderFileDeclaration): ProviderArtifactDeclaration {
  return {
    title: `Generated file: ${file.path}`,
    type: inferArtifactTypeFromPath(file.path),
    content: file.content.slice(0, 20000),
    tags: ["generated-file"]
  };
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

function toProviderFileOutput(value: unknown, omissions: string[]): ProviderFileDeclaration[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    omissions.push("file omitted because it was not an object.");
    return [];
  }

  const candidate = value as Record<string, unknown>;
  if (!hasNonEmptyString(candidate.path) || typeof candidate.content !== "string") {
    omissions.push("file omitted because path or content was invalid.");
    return [];
  }

  try {
    const path = normalizeVirtualPath(candidate.path);
    if (path.replace(/^\.\//, "") === "package.json" && packageJsonHasDependencyInstallScript(candidate.content)) {
      omissions.push("file omitted because package.json scripts cannot contain dependency install commands; use dependencyRequests instead.");
      return [];
    }
    return [
      {
        path,
        content: candidate.content.slice(0, 50000)
      }
    ];
  } catch {
    omissions.push("file omitted because virtual path was invalid.");
    return [];
  }
}

function readFilePatchCandidates(candidate: Record<string, unknown>) {
  for (const key of ["filePatches", "file_patches", "patches"]) {
    const value = candidate[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function toProviderFilePatchOutput(value: unknown, omissions: string[]): ProviderFilePatchDeclaration[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    omissions.push("file patch omitted because it was not an object.");
    return [];
  }

  const candidate = value as Record<string, unknown>;
  if (!hasNonEmptyString(candidate.path) || typeof candidate.find !== "string" || typeof candidate.replace !== "string") {
    omissions.push("file patch omitted because path, find, or replace was invalid.");
    return [];
  }

  if (candidate.find.length === 0) {
    omissions.push("file patch omitted because find text was empty.");
    return [];
  }

  try {
    const path = normalizeVirtualPath(candidate.path);
    if (path.replace(/^\.\//, "") === "package.json" && isDependencyInstallCommand(candidate.replace)) {
      omissions.push("file patch omitted because package.json scripts cannot contain dependency install commands; use dependencyRequests instead.");
      return [];
    }
    return [
      {
        path,
        find: candidate.find.slice(0, 20000),
        replace: candidate.replace.slice(0, 50000)
      }
    ];
  } catch {
    omissions.push("file patch omitted because virtual path was invalid.");
    return [];
  }
}

function packageJsonHasDependencyInstallScript(content: string) {
  try {
    const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
    return Boolean(
      parsed.scripts &&
        typeof parsed.scripts === "object" &&
        Object.values(parsed.scripts).some((value) => typeof value === "string" && isDependencyInstallCommand(value))
    );
  } catch {
    return false;
  }
}

function readFileRequestCandidates(candidate: Record<string, unknown>) {
  for (const key of ["requestedFiles", "requested_files", "fileRequests", "file_requests", "readFiles", "read_files"]) {
    const value = candidate[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function toProviderFileReadRequestOutput(value: unknown, omissions: string[]): ProviderFileReadRequestDeclaration[] {
  if (typeof value === "string") {
    try {
      return [{ path: normalizeVirtualPath(value) }];
    } catch {
      omissions.push("requested file omitted because virtual path was invalid.");
      return [];
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    omissions.push("requested file omitted because it was not a string or object.");
    return [];
  }

  const candidate = value as Record<string, unknown>;
  const id = hasNonEmptyString(candidate.id) ? candidate.id.trim().slice(0, 160) : undefined;
  let requestedPath: string | undefined;
  if (hasNonEmptyString(candidate.path)) {
    try {
      requestedPath = normalizeVirtualPath(candidate.path);
    } catch {
      omissions.push("requested file omitted because virtual path was invalid.");
      return [];
    }
  }

  if (!id && !requestedPath) {
    omissions.push("requested file omitted because id or path was missing.");
    return [];
  }

  return [
    {
      ...(id ? { id } : {}),
      ...(requestedPath ? { path: requestedPath } : {}),
      ...(hasNonEmptyString(candidate.reason) ? { reason: candidate.reason.trim().slice(0, 240) } : {})
    }
  ];
}

function readFileSearchCandidates(candidate: Record<string, unknown>) {
  for (const key of ["requestedSearches", "requested_searches", "fileSearches", "file_searches", "searchFiles", "search_files"]) {
    const value = candidate[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function toProviderFileSearchRequestOutput(value: unknown, omissions: string[]): ProviderFileSearchRequestDeclaration[] {
  if (typeof value === "string") {
    const query = value.trim();
    return query ? [{ query: query.slice(0, 160) }] : [];
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    omissions.push("requested search omitted because it was not a string or object.");
    return [];
  }

  const candidate = value as Record<string, unknown>;
  const query = firstNonEmptyString(candidate.query, candidate.text, candidate.pattern, candidate.term);
  if (!query) {
    omissions.push("requested search omitted because query was missing.");
    return [];
  }

  return [
    {
      query: query.slice(0, 160),
      ...(hasNonEmptyString(candidate.glob) ? { glob: candidate.glob.trim().slice(0, 120) } : {}),
      ...(hasNonEmptyString(candidate.reason) ? { reason: candidate.reason.trim().slice(0, 240) } : {})
    }
  ];
}

function readArtifactRequestCandidates(candidate: Record<string, unknown>) {
  for (const key of ["requestedArtifacts", "requested_artifacts", "artifactRequests", "artifact_requests", "readArtifacts", "read_artifacts"]) {
    const value = candidate[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function toProviderArtifactRequestOutput(value: unknown, omissions: string[]): ProviderArtifactRequestDeclaration[] {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? [{ id: id.slice(0, 160) }] : [];
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    omissions.push("requested artifact omitted because it was not a string or object.");
    return [];
  }

  const candidate = value as Record<string, unknown>;
  const id = hasNonEmptyString(candidate.id) ? candidate.id.trim().slice(0, 160) : undefined;
  const title = hasNonEmptyString(candidate.title) ? candidate.title.trim().slice(0, 160) : undefined;
  const type = hasNonEmptyString(candidate.type) ? candidate.type.trim().slice(0, 80) : undefined;
  if (!id && !title && !type) {
    omissions.push("requested artifact omitted because id, title, or type was missing.");
    return [];
  }

  return [
    {
      ...(id ? { id } : {}),
      ...(title ? { title } : {}),
      ...(type ? { type } : {}),
      ...(hasNonEmptyString(candidate.reason) ? { reason: candidate.reason.trim().slice(0, 240) } : {})
    }
  ];
}

function toProviderHandoffOutput(value: unknown, omissions: string[]): ProviderHandoffDeclaration[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    omissions.push("handoff omitted because it was not an object.");
    return [];
  }

  const candidate = value as Record<string, unknown>;
  if (!hasNonEmptyString(candidate.toDivisionId) || !hasNonEmptyString(candidate.summary)) {
    omissions.push("handoff omitted because destination division or summary was invalid.");
    return [];
  }

  return [
    {
      toDivisionId: candidate.toDivisionId.trim(),
      ...(hasNonEmptyString(candidate.targetOperationId) ? { targetOperationId: candidate.targetOperationId.trim() } : {}),
      summary: candidate.summary.trim().slice(0, 1000),
      deliverables: toStringList(candidate.deliverables, 12, 240),
      blockers: toStringList(candidate.blockers, 12, 240),
      requiredContext: toStringList(candidate.requiredContext, 12, 240),
      artifactIds: toStringList(candidate.artifactIds, 24, 160),
      fileIds: toStringList(candidate.fileIds, 24, 160),
      confidence: typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence) ? Math.max(0, Math.min(100, Math.round(candidate.confidence))) : 75
    }
  ];
}

function toProviderBlockerOutput(value: unknown, omissions: string[]): ProviderBlockerDeclaration[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    omissions.push("blocker omitted because it was not an object.");
    return [];
  }

  const candidate = value as Record<string, unknown>;
  if (!hasNonEmptyString(candidate.reason)) {
    omissions.push("blocker omitted because reason was invalid.");
    return [];
  }

  return [
    {
      reason: candidate.reason.trim().slice(0, 1000),
      severity: candidate.severity === "error" ? "error" : "warning",
      attemptsMade: toStringList(candidate.attemptsMade ?? candidate.attempts_made, 8, 240),
      ...(hasNonEmptyString(candidate.whySelfSolveInsufficient) || hasNonEmptyString(candidate.why_self_solve_insufficient)
        ? { whySelfSolveInsufficient: firstNonEmptyString(candidate.whySelfSolveInsufficient, candidate.why_self_solve_insufficient)?.slice(0, 500) }
        : {})
    }
  ];
}

function readQuestionRequestCandidates(candidate: Record<string, unknown>) {
  for (const key of ["questionRequests", "question_requests", "questions", "approvalRequests", "approval_requests"]) {
    const value = candidate[key];
    if (Array.isArray(value)) {
      return value.slice(0, 8);
    }
  }
  return [];
}

function toProviderWorkerQuestionRequestOutput(value: unknown, omissions: string[]): ProviderWorkerQuestionRequestDeclaration[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    omissions.push("worker question omitted because it was not an object.");
    return [];
  }

  const candidate = value as Record<string, unknown>;
  const question = firstNonEmptyString(candidate.question, candidate.prompt, candidate.summary);
  const reason = firstNonEmptyString(candidate.reason, candidate.rationale, candidate.description);
  if (!question || !reason) {
    omissions.push("worker question omitted because question or reason was invalid.");
    return [];
  }

  return [
    {
      question: question.slice(0, 500),
      reason: reason.slice(0, 500),
      ...(toProviderWorkerQuestionCategory(candidate.category) ? { category: toProviderWorkerQuestionCategory(candidate.category) } : {}),
      ...(hasNonEmptyString(candidate.scope) ? { scope: candidate.scope.trim().slice(0, 160) } : {}),
      options: readProviderQuestionOptions(candidate.options),
      needsExecutive: candidate.needsExecutive === true || candidate.needs_executive === true,
      ...(hasNonEmptyString(candidate.recommendedDefault) ? { recommendedDefault: candidate.recommendedDefault.trim().slice(0, 500) } : {}),
      attemptsMade: toStringList(candidate.attemptsMade ?? candidate.attempts_made, 8, 240),
      ...(hasNonEmptyString(candidate.whySelfSolveInsufficient) || hasNonEmptyString(candidate.why_self_solve_insufficient)
        ? { whySelfSolveInsufficient: firstNonEmptyString(candidate.whySelfSolveInsufficient, candidate.why_self_solve_insufficient)?.slice(0, 500) }
        : {})
    }
  ];
}

function toProviderWorkerQuestionCategory(value: unknown): ProviderWorkerQuestionRequestDeclaration["category"] | undefined {
  if (!hasNonEmptyString(value)) {
    return undefined;
  }
  const normalized = stableIdForPath(value.trim());
  return ["scope_approval", "product_decision", "policy_exception", "external_authority", "upstream_dependency"].includes(normalized)
    ? (normalized as ProviderWorkerQuestionRequestDeclaration["category"])
    : undefined;
}

function isRuntimeDiagnosticQuestion(question: ProviderWorkerQuestionRequestDeclaration) {
  return isRuntimeDiagnosticQuestionText(`${question.question} ${question.reason} ${question.scope ?? ""} ${(question.options ?? []).map((option) => `${option.label} ${option.description ?? ""}`).join(" ")}`);
}

function isRuntimeDiagnosticQuestionText(value: string) {
  const normalized = value.toLowerCase();
  const askSignal = /\b(provide|send|share|paste|give|need|show|upload|attach)\b/.test(normalized);
  const diagnosticSignal = /\b(log|logs|tail|stderr|stdout|stack trace|trace|error code|exit code|verification output|launcher output|runtime check|build output|test output|console output)\b/.test(normalized);
  return askSignal && diagnosticSignal;
}

function readProviderQuestionOptions(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((option) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      return [];
    }
    const candidate = option as Record<string, unknown>;
    const id = firstNonEmptyString(candidate.id, candidate.value, candidate.label);
    const label = firstNonEmptyString(candidate.label, candidate.title, candidate.id);
    const description = firstNonEmptyString(candidate.description, candidate.reason);
    return id && label ? [{ id: stableIdForPath(id).slice(0, 120), label: label.slice(0, 160), ...(description ? { description: description.slice(0, 240) } : {}) }] : [];
  });
}

function readDangerousActionCandidates(candidate: Record<string, unknown>) {
  for (const key of ["dangerousActions", "dangerous_actions", "requestedActions", "requested_actions"]) {
    const value = candidate[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function toProviderDangerousActionOutput(value: unknown, omissions: string[]): ProviderDangerousActionDeclaration[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    omissions.push("dangerous action omitted because it was not an object.");
    return [];
  }

  const candidate = value as Record<string, unknown>;
  const action = firstNonEmptyString(candidate.action, candidate.type, candidate.name, candidate.command);
  const reason = firstNonEmptyString(candidate.reason, candidate.rationale, candidate.description, candidate.summary);
  if (!action || !reason) {
    omissions.push("dangerous action omitted because action or reason was invalid.");
    return [];
  }
  const command = hasNonEmptyString(candidate.command) ? candidate.command.trim().slice(0, 240) : undefined;
  if (command && isDependencyInstallCommand(command)) {
    omissions.push("dangerous action omitted because dependency install commands must be declared as dependencyRequests.");
    return [];
  }

  return [
    {
      action: action.slice(0, 160),
      reason: reason.slice(0, 1000),
      ...(command ? { command } : {})
    }
  ];
}

function isDependencyInstallCommand(command: string) {
  return /\b(npm\s+(install|i|add)|pnpm\s+add|yarn\s+add|bun\s+add)\b/i.test(command);
}

function readDependencyRequestCandidates(candidate: Record<string, unknown>) {
  for (const key of ["dependencyRequests", "dependency_requests", "packageRequests", "package_requests"]) {
    const value = candidate[key];
    if (Array.isArray(value)) {
      return value.slice(0, 8);
    }
  }
  return [];
}

function toProviderDependencyRequestOutput(value: unknown, omissions: string[]): ProviderDependencyRequestDeclaration[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    omissions.push("dependency request omitted because it was not an object.");
    return [];
  }

  const candidate = value as Record<string, unknown>;
  const packageName = firstNonEmptyString(candidate.packageName, candidate.name, candidate.package);
  const dependencyType = toProviderDependencyRequestType(candidate.dependencyType);
  const reason = firstNonEmptyString(candidate.reason, candidate.rationale, candidate.description);
  if (!packageName || !dependencyType || !reason) {
    omissions.push("dependency request omitted because packageName, dependencyType, or reason was invalid.");
    return [];
  }

  const request = {
    packageName: packageName.slice(0, 120),
    versionRange: firstNonEmptyString(candidate.versionRange, candidate.version, candidate.range)?.slice(0, 80),
    dependencyType,
    reason: reason.slice(0, 1000),
    usedByFiles: toStringList(candidate.usedByFiles, 12, 240),
    alternativesConsidered: toStringList(candidate.alternativesConsidered, 12, 240),
    requiresExecutive: candidate.requiresExecutive === true || candidate.requires_executive === true
  };
  const policy = validateDependencyRequestPolicy(request);
  if (!policy.ok) {
    omissions.push(`dependency request for ${sanitizeBriefText(packageName, 120)} omitted: ${policy.reason}`);
    return [];
  }
  return [request];
}

function toProviderDependencyRequestType(value: unknown): ProviderDependencyRequestType | undefined {
  return value === "devDependency" || value === "optionalDependency" || value === "dependency" ? value : undefined;
}

function readRecoveryActionCandidates(candidate: Record<string, unknown>) {
  for (const key of ["recoveryActions", "recovery_actions"]) {
    const value = candidate[key];
    if (Array.isArray(value)) {
      return value.slice(0, 4);
    }
  }
  return [];
}

function toProviderRecoveryActionOutput(value: unknown, omissions: string[]): ProviderRecoveryActionDeclaration[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    omissions.push("recovery action omitted because it was not an object.");
    return [];
  }

  const candidate = value as Record<string, unknown>;
  const type = hasNonEmptyString(candidate.type) ? candidate.type.trim() : "";
  const targetOperationId = hasNonEmptyString(candidate.targetOperationId) ? candidate.targetOperationId.trim().slice(0, 120) : "";
  const title = hasNonEmptyString(candidate.title) ? candidate.title.trim().slice(0, 160) : undefined;
  const description = hasNonEmptyString(candidate.description) ? candidate.description.trim().slice(0, 1000) : undefined;
  const workerId = hasNonEmptyString(candidate.workerId) ? candidate.workerId.trim().slice(0, 120) : undefined;
  const reason = hasNonEmptyString(candidate.reason) ? candidate.reason.trim().slice(0, 500) : undefined;
  const recommendedNextAction = hasNonEmptyString(candidate.recommendedNextAction) ? candidate.recommendedNextAction.trim().slice(0, 500) : undefined;

  if (type === "create_replacement_operation") {
    if (!title || !description) {
      omissions.push("recovery action omitted because replacement title or description was missing.");
      return [];
    }
    return [{ type, title, description, workerId, reason, priority: toOperationPriority(candidate.priority) }];
  }

  if (!targetOperationId) {
    omissions.push("recovery action omitted because targetOperationId was missing.");
    return [];
  }
  if (type === "revise_operation") {
    if (!title && !description && !workerId) {
      omissions.push("recovery action omitted because no operation revision fields were present.");
      return [];
    }
    return [{ type, targetOperationId, title, description, workerId, reason }];
  }
  if (type === "request_more_context") {
    if (!reason) {
      omissions.push("recovery action omitted because missing-context reason was missing.");
      return [];
    }
    return [{ type, targetOperationId, reason }];
  }
  if (type === "escalate_to_executive") {
    if (!reason) {
      omissions.push("recovery action omitted because escalation reason was missing.");
      return [];
    }
    return [{ type, targetOperationId, reason, recommendedNextAction }];
  }

  omissions.push("recovery action omitted because type was unsupported.");
  return [];
}

function toOperationPriority(value: unknown) {
  return value === "low" || value === "normal" || value === "high" || value === "critical" ? value : undefined;
}

function applyProviderOutputs(
  snapshot: ForgeSnapshot,
  run: AgentRun,
  outputs: ProviderRunOutputs,
  timestamp: string
): { snapshot: ForgeSnapshot; events: RuntimeEventDraft[] } {
  if (
    outputs.artifacts.length === 0 &&
    outputs.files.length === 0 &&
    outputs.filePatches.length === 0 &&
    outputs.handoffs.length === 0 &&
    outputs.blockers.length === 0 &&
    outputs.questionRequests.length === 0 &&
    outputs.recoveryActions.length === 0
  ) {
    return { snapshot, events: [] };
  }

  const operation = snapshot.operations.find((candidate) => candidate.id === run.operationId);
  if (!operation) {
    return { snapshot, events: [] };
  }

  const workerId = run.workerId ?? operation.workerId;
  const divisionId = operation.divisionId;
  const patchResult = applyProviderFilePatches(snapshot, run, operation, outputs.filePatches, timestamp, outputs.omissions);
  const createdFiles = outputs.files.map((file) => {
    const existing = patchResult.files.find((candidate) => candidate.path === file.path);
    return {
      id: existing?.id ?? `${snapshot.forge.slug}-provider-file-${stableIdForPath(file.path)}-${Date.now()}`,
      path: file.path,
      content: file.content,
      status: "generated" as const,
      version: existing ? existing.version + 1 : 1,
      divisionId,
      workerId,
      operationId: operation.id,
      artifactIds: existing?.artifactIds ?? [],
      updatedAt: timestamp
    };
  });
  const fileIds = createdFiles.map((file) => file.id);
  const createdArtifacts = outputs.artifacts.map((artifact, index) => ({
    id: `${snapshot.forge.slug}-provider-artifact-${stableIdForPath(artifact.title)}-${Date.now()}-${index}`,
    title: artifact.title,
    type: artifact.type,
    divisionId,
    workerId,
    operationId: operation.id,
    content: artifact.content,
    status: "generated" as const,
    version: 1,
    tags: artifact.tags ?? [],
    fileIds,
    createdAt: timestamp,
    updatedAt: timestamp
  }));
  const artifactIds = createdArtifacts.map((artifact) => artifact.id);
  const validHandoffs = outputs.handoffs.filter((handoff) => {
    const validDivision = snapshot.divisions.some((division) => division.id === handoff.toDivisionId);
    const validTarget = !handoff.targetOperationId || snapshot.operations.some((candidate) => candidate.id === handoff.targetOperationId);
    if (!validDivision) {
      outputs.omissions.push(`handoff omitted because destination division ${handoff.toDivisionId} does not exist.`);
    }
    if (!validTarget) {
      outputs.omissions.push(`handoff omitted because target operation ${handoff.targetOperationId} does not exist.`);
    }
    return validDivision && validTarget;
  });
  const createdHandoffs = validHandoffs.map((handoff, index) => ({
    id: `${snapshot.forge.slug}-provider-handoff-${Date.now()}-${index}`,
    fromDivisionId: divisionId,
    toDivisionId: handoff.toDivisionId,
    fromOperationId: operation.id,
    fromRunId: run.id,
    targetOperationId: handoff.targetOperationId,
    summary: handoff.summary,
    deliverables: handoff.deliverables ?? [],
    blockers: handoff.blockers ?? [],
    requiredContext: handoff.requiredContext ?? [],
    ...resolveHandoffContextAttachments(snapshot, handoff, artifactIds, fileIds, outputs.omissions),
    status: "open" as const,
    confidence: handoff.confidence ?? 75,
    createdAt: timestamp
  }));
  const blocker = outputs.blockers[0];
  const divisionLead = snapshot.divisions.find((division) => division.id === divisionId)?.leadWorkerId;
  const nextFiles = [
    ...patchResult.files.filter((file) => !createdFiles.some((createdFile) => createdFile.id === file.id)),
    ...createdFiles.map((file) => ({
      ...file,
      artifactIds: file.version > 1 ? file.artifactIds : mergeStringLists(file.artifactIds, artifactIds)
    }))
  ];

  let nextSnapshot = {
    ...snapshot,
    artifacts: [...snapshot.artifacts, ...createdArtifacts],
    files: nextFiles,
    handoffs: [...snapshot.handoffs, ...createdHandoffs],
    operations: snapshot.operations.map((candidate) =>
      candidate.id === operation.id
        ? {
            ...candidate,
            outputArtifactIds: [...candidate.outputArtifactIds, ...artifactIds],
            ...(blocker
              ? {
                  status: "blocked" as const,
                  blockedReason: blocker.reason,
                  routingStage: "worker_ready" as const,
                  progress: Math.min(candidate.progress, 90)
                }
              : {})
          }
        : candidate
    ),
    workers: blocker
      ? snapshot.workers.map((worker) =>
          worker.id === workerId
            ? {
                ...worker,
                status: "blocked" as const,
                currentTask: undefined
              }
            : worker
        )
      : snapshot.workers
  };
  let events: RuntimeEventDraft[] = [
    ...[...patchResult.patchedFiles, ...createdFiles].map((file) => ({
      forgeId: snapshot.forge.id,
      type: "file.updated" as const,
      actorType: "worker" as const,
      actorId: workerId,
      targetType: "file" as const,
      targetId: file.id,
      message: `Worker updated virtual file: ${file.path}.`,
      severity: "success" as const,
      payload: {
        runId: run.id,
        operationId: operation.id,
        fileId: file.id,
        path: file.path,
        version: file.version,
        patched: patchResult.patchedFiles.some((patchedFile) => patchedFile.id === file.id)
      }
    })),
    ...createdArtifacts.map((artifact) => ({
      forgeId: snapshot.forge.id,
      type: "artifact.created" as const,
      actorType: "worker" as const,
      actorId: workerId,
      targetType: "artifact" as const,
      targetId: artifact.id,
      message: `Worker declared artifact: ${artifact.title}.`,
      severity: "success" as const,
      payload: {
        runId: run.id,
        operationId: operation.id,
        artifactId: artifact.id,
        divisionId: artifact.divisionId,
        workerId: artifact.workerId,
        fileIds: artifact.fileIds
      }
    })),
    ...createdHandoffs.map((handoff) => ({
      forgeId: snapshot.forge.id,
      type: "handoff.created" as const,
      actorType: "worker" as const,
      actorId: workerId,
      targetType: "handoff" as const,
      targetId: handoff.id,
      message: "Worker declared a validated handoff.",
      severity: "info" as const,
      payload: {
        runId: run.id,
        operationId: operation.id,
        handoffId: handoff.id,
        fromDivisionId: handoff.fromDivisionId,
        toDivisionId: handoff.toDivisionId,
        targetOperationId: handoff.targetOperationId,
        artifactIds: handoff.artifactIds,
        fileIds: handoff.fileIds,
        contextAttachmentSource: handoff.contextAttachmentSource
      }
    })),
    ...(blocker
      ? [
          {
            forgeId: snapshot.forge.id,
            type: "operation.blocked" as const,
            actorType: "worker" as const,
            actorId: workerId,
            targetType: "operation" as const,
            targetId: operation.id,
            message: blocker.reason,
            severity: blocker.severity ?? ("warning" as const),
            payload: { runId: run.id, operationId: operation.id, workerId, provider: run.provider }
          }
        ]
      : [])
  ];

  const questionEvents = outputs.questionRequests.flatMap((question, index) => {
    if (isRuntimeDiagnosticQuestion(question)) {
      outputs.omissions.push(`diagnostic/runtime-log question suppressed: ${sanitizeBriefText(question.question, 180)}`);
      return [
        {
          forgeId: snapshot.forge.id,
          type: "run.progress" as const,
          actorType: "runtime" as const,
          targetType: "run" as const,
          targetId: run.id,
          message: "Runtime suppressed a worker question that asked the operator for logs or error output.",
          severity: "info" as const,
          payload: {
            runId: run.id,
            operationId: operation.id,
            workerId,
            reason: "diagnostic_question_suppressed",
            question: sanitizeBriefText(question.question, 240)
          }
        }
      ];
    }
    const workerQuestionId = `${snapshot.forge.slug}-worker-question-${stableIdForPath(operation.id)}-${Date.now()}-${index}`;
    const basePayload = {
      workerQuestionId,
      runId: run.id,
      operationId: operation.id,
      workerId,
      leadWorkerId: divisionLead,
      question: question.question,
      reason: question.reason,
      scope: question.scope,
      options: question.options ?? [],
      recommendedDefault: question.recommendedDefault
    };
    const requestedEvent: RuntimeEventDraft = {
      forgeId: snapshot.forge.id,
      type: "worker.question_requested",
      actorType: "worker",
      actorId: workerId,
      targetType: "operation",
      targetId: operation.id,
      message: question.question,
      severity: question.needsExecutive ? "warning" : "info",
      payload: basePayload
    };
    if (!question.needsExecutive) {
      return [requestedEvent];
    }
    const pendingQuestion: PendingWorkerQuestion = {
      id: workerQuestionId,
      runId: run.id,
      operationId: operation.id,
      workerId,
      leadWorkerId: divisionLead,
      question: question.question,
      reason: question.reason,
      scope: question.scope,
      options: question.options ?? [],
      recommendedDefault: question.recommendedDefault
    };
    if (isExecutiveAutopilotEnabled()) {
      return [
        requestedEvent,
        {
          forgeId: snapshot.forge.id,
          type: "worker.question_escalated" as const,
          actorType: "runtime" as const,
          targetType: "operation" as const,
          targetId: operation.id,
          message: "Worker question marked for Executive input.",
          severity: "warning" as const,
          payload: basePayload
        },
        createWorkerQuestionAnsweredEvent(snapshot, pendingQuestion, {
          actorType: "executive",
          message: "Executive answered worker question automatically.",
          selectedOptionIds: [],
          selectedLabels: [],
          notes: question.recommendedDefault ?? "Executive approved the conservative scoped answer.",
          source: "executive_auto"
        })
      ];
    }
    return [
      requestedEvent,
      {
        forgeId: snapshot.forge.id,
        type: "worker.question_escalated" as const,
        actorType: "runtime" as const,
        targetType: "operation" as const,
        targetId: operation.id,
        message: "Worker question marked for Executive input.",
        severity: "warning" as const,
        payload: basePayload
      },
      {
        forgeId: snapshot.forge.id,
        type: "executive.user_input_requested" as const,
        actorType: "executive" as const,
        targetType: "operation" as const,
        targetId: operation.id,
        message: question.question,
        severity: "warning" as const,
        payload: {
          questionId: `${workerQuestionId}-executive`,
          loopId: "worker-question",
          ...basePayload,
          allowNotes: true
        }
      }
    ];
  });
  events = [...events, ...questionEvents];

  const recovery = applyLeadRecoveryActions(nextSnapshot, run, outputs.recoveryActions, timestamp, outputs.omissions);
  nextSnapshot = recovery.snapshot;
  events = [...events, ...recovery.events];

  return {
    snapshot: nextSnapshot,
    events
  };
}

function resolveHandoffContextAttachments(
  snapshot: ForgeSnapshot,
  handoff: ProviderHandoffDeclaration,
  sameRunArtifactIds: string[],
  sameRunFileIds: string[],
  omissions: string[]
) {
  const hasExplicitArtifacts = Boolean(handoff.artifactIds && handoff.artifactIds.length > 0);
  const hasExplicitFiles = Boolean(handoff.fileIds && handoff.fileIds.length > 0);
  if (!hasExplicitArtifacts && !hasExplicitFiles) {
    return {
      artifactIds: sameRunArtifactIds,
      fileIds: sameRunFileIds,
      contextAttachmentSource: "inferred" as const
    };
  }

  const validArtifactIds = new Set([...snapshot.artifacts.map((artifact) => artifact.id), ...sameRunArtifactIds]);
  const validFileIds = new Set([...snapshot.files.map((file) => file.id), ...sameRunFileIds]);
  const artifactIds = (handoff.artifactIds ?? []).filter((id) => validArtifactIds.has(id));
  const fileIds = (handoff.fileIds ?? []).filter((id) => validFileIds.has(id));
  for (const id of handoff.artifactIds ?? []) {
    if (!validArtifactIds.has(id)) {
      omissions.push(`handoff artifact attachment ${id} omitted because it does not exist.`);
    }
  }
  for (const id of handoff.fileIds ?? []) {
    if (!validFileIds.has(id)) {
      omissions.push(`handoff file attachment ${id} omitted because it does not exist.`);
    }
  }

  return {
    artifactIds,
    fileIds,
    contextAttachmentSource: "explicit" as const
  };
}

function applyLeadRecoveryActions(
  snapshot: ForgeSnapshot,
  run: AgentRun,
  actions: ProviderRecoveryActionDeclaration[],
  timestamp: string,
  omissions: string[]
): { snapshot: ForgeSnapshot; events: RuntimeEventDraft[] } {
  if (actions.length === 0) {
    return { snapshot, events: [] };
  }

  const triageOperation = snapshot.operations.find((candidate) => candidate.id === run.operationId);
  const leadWorker = run.workerId ? snapshot.workers.find((worker) => worker.id === run.workerId) : undefined;
  const originalOperationId = triageOperation?.escalatedFromOperationId;
  const originalOperation = originalOperationId ? snapshot.operations.find((candidate) => candidate.id === originalOperationId) : triageOperation?.escalationRunId ? triageOperation : undefined;
  if (!triageOperation || !originalOperation || leadWorker?.kind !== "lead") {
    omissions.push("recovery actions ignored because this run was not a lead triage operation.");
    return { snapshot, events: [] };
  }

  let nextSnapshot = snapshot;
  const events: RuntimeEventDraft[] = [];
  for (const action of actions.slice(0, 4)) {
    if (action.type !== "create_replacement_operation" && action.targetOperationId !== originalOperation.id) {
      omissions.push("recovery action omitted because targetOperationId did not match the escalated operation.");
      continue;
    }

    if (action.type === "revise_operation") {
      const nextWorkerId = action.workerId && snapshot.workers.some((worker) => worker.id === action.workerId && worker.divisionId === originalOperation.divisionId && worker.kind === "worker")
        ? action.workerId
        : originalOperation.workerId;
      nextSnapshot = {
        ...nextSnapshot,
        operations: nextSnapshot.operations.map((operation) =>
          operation.id === originalOperation.id
            ? {
                ...operation,
                title: action.title ?? operation.title,
                description: action.description ?? operation.description,
                workerId: nextWorkerId,
                status: "ready" as const,
                routingStage: "worker_ready" as const,
                blockedReason: undefined,
                retryCount: 0
              }
            : operation
        ),
        workers: nextSnapshot.workers.map((worker) =>
          worker.id === nextWorkerId ? { ...worker, status: "ready" as const, currentTask: originalOperation.title } : worker
        )
      };
      events.push({
        forgeId: snapshot.forge.id,
        type: "operation.ready",
        actorType: "division",
        actorId: leadWorker.id,
        targetType: "operation",
        targetId: originalOperation.id,
        message: "Division lead revised the escalated operation and returned it to worker-ready.",
        severity: "success",
        payload: { runId: run.id, operationId: originalOperation.id, leadTriageOperationId: triageOperation.id, action: action.type, reason: action.reason }
      });
      continue;
    }

    if (action.type === "create_replacement_operation") {
      const replacementWorkerId = action.workerId && snapshot.workers.some((worker) => worker.id === action.workerId && worker.divisionId === originalOperation.divisionId && worker.kind === "worker")
        ? action.workerId
        : originalOperation.workerId;
      nextSnapshot = {
        ...nextSnapshot,
        operations: nextSnapshot.operations.map((operation) =>
          operation.id === originalOperation.id
            ? {
                ...operation,
                title: action.title,
                description: action.description,
                workerId: replacementWorkerId,
                priority: action.priority ?? operation.priority,
                status: "ready" as const,
                routingStage: "worker_ready" as const,
                blockedReason: undefined,
                retryCount: 0,
                escalatedFromOperationId: undefined,
                escalationRunId: undefined,
                escalationFailureCategory: undefined
              }
            : operation
        )
      };
      events.push({
        forgeId: snapshot.forge.id,
        type: "operation.ready",
        actorType: "division",
        actorId: leadWorker.id,
        targetType: "operation",
        targetId: originalOperation.id,
        message: "Division lead converted the replacement plan into the existing operation.",
        severity: "info",
        payload: { runId: run.id, operationId: originalOperation.id, leadTriageOperationId: triageOperation.id, action: action.type, reason: action.reason }
      });
      continue;
    }

    if (action.type === "request_more_context") {
      nextSnapshot = {
        ...nextSnapshot,
        operations: nextSnapshot.operations.map((operation) =>
          operation.id === originalOperation.id
            ? { ...operation, status: "blocked" as const, blockedReason: sanitizeBriefText(action.reason, 500), routingStage: "done" as const }
            : operation
        )
      };
      events.push({
        forgeId: snapshot.forge.id,
        type: "operation.blocked",
        actorType: "division",
        actorId: leadWorker.id,
        targetType: "operation",
        targetId: originalOperation.id,
        message: sanitizeBriefText(action.reason, 500),
        severity: "warning",
        payload: { runId: run.id, operationId: originalOperation.id, leadTriageOperationId: triageOperation.id, action: action.type }
      });
      continue;
    }

    const escalated = createExecutiveEscalation(nextSnapshot, {
      run,
      operation: originalOperation,
      category: triageOperation.escalationFailureCategory ?? "provider_failed",
      reason: action.reason,
      recommendedNextAction: action.recommendedNextAction ?? "executive_review",
      timestamp
    });
    nextSnapshot = escalated.snapshot;
    events.push(...escalated.events);
  }

  return { snapshot: nextSnapshot, events };
}

function createExecutiveReviewRequests(snapshot: ForgeSnapshot, run: AgentRun, dangerousActions: ProviderDangerousActionDeclaration[], timestamp: string) {
  if (dangerousActions.length === 0) {
    return { snapshot, events: [] as RuntimeEventDraft[] };
  }

  const operation = snapshot.operations.find((candidate) => candidate.id === run.operationId);
  const reviewId = `${snapshot.forge.slug}-review-${run.id}-${Date.now()}`;
  const summarizedActions = dangerousActions.slice(0, 5).map((action) => ({
    action: action.action,
    reason: action.reason,
    ...(action.command ? { command: action.command } : {})
  }));
  const content = `Executive review required: ${dangerousActions[0].action}. Runtime blocked ${dangerousActions.length} dangerous action request${dangerousActions.length === 1 ? "" : "s"} from ${operation?.title ?? "operation"}.`;
  const message = {
    id: `${reviewId}-message`,
    role: "executive" as const,
    kind: "executive_summary" as const,
    source: "run_terminal" as const,
    content,
    runId: run.id,
    operationId: run.operationId,
    status: "review_requested",
    createdAt: timestamp
  };
  const events: RuntimeEventDraft[] = [
    {
      forgeId: snapshot.forge.id,
      type: "executive.review_requested",
      actorType: "runtime",
      targetType: "run",
      targetId: run.id,
      message: content,
      severity: "warning",
      payload: {
        reviewId,
        runId: run.id,
        operationId: run.operationId,
        workerId: run.workerId,
        provider: run.provider,
        actionCount: dangerousActions.length,
        actions: summarizedActions,
        providerShellAccess: false
      }
    }
  ];

  return {
    snapshot: {
      ...snapshot,
      messages: [...snapshot.messages, message]
    },
    events
  };
}

function createDependencyReviewRequests(snapshot: ForgeSnapshot, run: AgentRun, dependencyRequests: ProviderDependencyRequestDeclaration[]) {
  if (dependencyRequests.length === 0) {
    return { snapshot, events: [] as RuntimeEventDraft[] };
  }

  const operation = snapshot.operations.find((candidate) => candidate.id === run.operationId);
  if (!operation) {
    return { snapshot, events: [] as RuntimeEventDraft[] };
  }
  const leadWorkerId = snapshot.divisions.find((division) => division.id === operation.divisionId)?.leadWorkerId;
  const events: RuntimeEventDraft[] = dependencyRequests.map((request, index) => {
    const requiresExecutive = request.requiresExecutive === true || isExecutiveDependencyReviewRequired(request);
    const dependencyRequestId = `${snapshot.forge.slug}-dependency-request-${stableIdForPath(operation.id)}-${Date.now()}-${index}`;
    return {
      forgeId: snapshot.forge.id,
      type: requiresExecutive ? "dependency.escalated" : "dependency.requested",
      actorType: "worker",
      actorId: run.workerId ?? operation.workerId,
      targetType: "operation",
      targetId: operation.id,
      message: requiresExecutive ? `Dependency request escalated for Executive review: ${request.packageName}.` : `Worker requested dependency: ${request.packageName}.`,
      severity: requiresExecutive ? "warning" : "info",
      payload: {
        dependencyRequestId,
        runId: run.id,
        operationId: operation.id,
        divisionId: operation.divisionId,
        workerId: run.workerId ?? operation.workerId,
        leadWorkerId,
        packageName: request.packageName,
        versionRange: request.versionRange,
        dependencyType: request.dependencyType,
        reason: request.reason,
        usedByFiles: request.usedByFiles ?? [],
        alternativesConsidered: request.alternativesConsidered ?? [],
        requiresExecutive,
        requestedRunId: run.id
      }
    };
  });

  return { snapshot, events };
}

function isExecutiveDependencyReviewRequired(request: ProviderDependencyRequestDeclaration) {
  if (isHighRiskPackageName(request.packageName)) {
    return true;
  }
  const normalized = `${request.packageName} ${request.reason}`.toLowerCase();
  return /\b(auth|oauth|jwt|session|password|crypto|encrypt|security|database|postgres|prisma|orm|build|bundler|webpack|vite|next|compiler|typescript|eslint|deployment|runtime|server)\b/.test(normalized);
}

function createExecutiveReplanRequests(snapshot: ForgeSnapshot, run: AgentRun, blockers: ProviderBlockerDeclaration[], timestamp: string) {
  const blocker = blockers.find((candidate) => isRepairableDependencyBlocker(candidate.reason));
  if (!blocker) {
    return { snapshot, events: [] as RuntimeEventDraft[] };
  }

  const operation = snapshot.operations.find((candidate) => candidate.id === run.operationId);
  const reviewId = `${snapshot.forge.slug}-executive-replan-${run.id}-${Date.now()}`;
  const safeReason = sanitizeBriefText(blocker.reason, 500);
  const category = getRepairableBlockerCategory(blocker.reason);
  if (hasPendingExecutiveReviewFor(snapshot, run.operationId, category)) {
    return { snapshot, events: [] as RuntimeEventDraft[] };
  }

  const verificationRepair = isVerificationRepairBlocker(blocker.reason);
  const recommendedNextAction = verificationRepair
    ? "Executive should route implementation repair work using the failed verification output, add blocking dependencies, then retry the blocked QA or release operation."
    : "Executive should create the missing prerequisite work, add blocking dependencies, then retry the blocked operation.";
  const content = verificationRepair
    ? `Executive replanning required: ${operation?.title ?? "operation"} is blocked because runtime verification failed. Reason: ${safeReason}. Recommended next action: create implementation repair work from the failed checks, add dependency edges, and retry this operation.`
    : `Executive replanning required: ${operation?.title ?? "operation"} is blocked because prerequisite work or context is missing. Reason: ${safeReason}. Recommended next action: create the missing prerequisite work, add dependency edges, and retry or replace this operation.`;

  const message = {
    id: `${reviewId}-message`,
    role: "executive" as const,
    kind: "executive_summary" as const,
    source: "run_terminal" as const,
    content,
    runId: run.id,
    operationId: run.operationId,
    status: "review_requested",
    createdAt: timestamp
  };

  const events: RuntimeEventDraft[] = [
    {
      forgeId: snapshot.forge.id,
      type: "executive.review_requested",
      actorType: "runtime",
      targetType: "operation",
      targetId: run.operationId,
      message: content,
      severity: "warning",
      payload: {
        reviewId,
        runId: run.id,
        operationId: run.operationId,
        workerId: run.workerId,
        category,
        failureCategory: verificationRepair ? "verification_failed" : "missing_requested_context",
        blockerReason: safeReason,
        recommendedNextAction
      }
    }
  ];

  const repaired = ensureMissingPrerequisiteOperations({
    ...snapshot,
    messages: [...snapshot.messages, message]
  });

  return {
    snapshot: repaired.snapshot,
    events: [...events, ...repaired.events]
  };
}

function isMissingProjectStructureBlocker(reason: string) {
  const normalized = reason.toLowerCase();
  const missingSignal = /\b(no|missing|not found|not available|could not find|cannot find|was not found|were not available|doesn't exist|does not exist)\b/.test(normalized);
  const projectStructureSignal = /\b(package\.json|package manifest|app shell|source files|workspace source|components?|entry points?|framework|project structure|data contract)\b/.test(normalized);
  return missingSignal && projectStructureSignal;
}

function isMissingPrerequisiteBlocker(reason: string) {
  if (isMissingProjectStructureBlocker(reason)) {
    return true;
  }

  const normalized = reason.toLowerCase();
  const missingSignal = /\b(no|missing|not found|not available|could not find|cannot find|was not found|were not available|doesn't exist|does not exist|cannot safely|can't safely|unable to)\b/.test(normalized);
  const prerequisiteSignal = /\b(prerequisite|upstream|dependency|handoff|implementation context|implementation files|implementation output|workspace context|actual mvp plan|project context|source context|verification output|executable verification|runtime context|deliverables?|built anything|missing implementation)\b/.test(normalized);
  return missingSignal && prerequisiteSignal;
}

function isVerificationRepairBlocker(reason: string) {
  const normalized = reason.toLowerCase();
  const verificationSignal = /\b(runtime verification|verification|test|typecheck|lint|build|smoke|e2e|acceptance|release readiness|readiness)\b/.test(normalized);
  const failureSignal = /\b(failed|failure|cannot confirm|can't confirm|could not confirm|cannot be confirmed|not confirmed|defect|compile|render|broken|unresolved)\b/.test(normalized);
  const repairSignal = /\b(implementation|project|app|source|runtime|release|qa|readiness|checks?)\b/.test(normalized);
  return verificationSignal && failureSignal && repairSignal;
}

function isRepairableDependencyBlocker(reason: string) {
  return isMissingPrerequisiteBlocker(reason) || isVerificationRepairBlocker(reason);
}

function getRepairableBlockerCategory(reason: string) {
  if (isVerificationRepairBlocker(reason)) {
    return "verification_repair_required";
  }
  return isMissingProjectStructureBlocker(reason) ? "missing_project_structure" : "missing_prerequisite_context";
}

function ensureMissingPrerequisiteOperations(snapshot: ForgeSnapshot): { snapshot: ForgeSnapshot; events: RuntimeEventDraft[] } {
  const blockedOperations = snapshot.operations.filter((operation) => operation.status === "blocked" && operation.blockedReason && isRepairableDependencyBlocker(operation.blockedReason));
  if (blockedOperations.length === 0) {
    return { snapshot, events: [] };
  }

  let nextSnapshot = snapshot;
  const events: RuntimeEventDraft[] = [];

  for (const blockedOperation of blockedOperations) {
    if (hasOpenPrerequisiteFor(nextSnapshot, blockedOperation)) {
      continue;
    }

    const operation = createMissingPrerequisiteOperation(nextSnapshot, blockedOperation);
    const duplicate = findSimilarPrerequisiteOperation(nextSnapshot, operation, { ignoredOperationIds: [blockedOperation.id] });
    if (duplicate) {
      const existingDependency = nextSnapshot.dependencies.some((dependency) => dependency.operationId === blockedOperation.id && dependency.dependsOnOperationId === duplicate.operation.id && dependency.type === "blocks");
      const wouldCycle =
        !existingDependency &&
        duplicate.operation.status !== "completed" &&
        isMissingPrerequisiteOperation(duplicate.operation) &&
        wouldCreateBlockingDependencyCycle(
          nextSnapshot.dependencies
            .filter((dependency) => dependency.type === "blocks")
            .map((dependency) => ({ operationId: dependency.operationId, dependsOnOperationId: dependency.dependsOnOperationId })),
          blockedOperation.id,
          duplicate.operation.id
        );
      const dependency =
        !existingDependency && !wouldCycle && duplicate.operation.status !== "completed" && isMissingPrerequisiteOperation(duplicate.operation)
          ? {
              id: `${nextSnapshot.forge.slug}-dep-${stableIdForPath(blockedOperation.id)}-${stableIdForPath(duplicate.operation.id)}`,
              operationId: blockedOperation.id,
              dependsOnOperationId: duplicate.operation.id,
              type: "blocks" as const
            }
          : undefined;
      nextSnapshot = dependency
        ? {
            ...nextSnapshot,
            dependencies: [...nextSnapshot.dependencies, dependency]
          }
        : nextSnapshot;
      events.push(
        {
          forgeId: snapshot.forge.id,
          type: "operation.blocked",
          actorType: "runtime",
          targetType: "operation",
          targetId: blockedOperation.id,
          message: `${blockedOperation.title} already has similar prerequisite work: ${duplicate.operation.title}.`,
          severity: "warning",
          payload: {
            operationId: blockedOperation.id,
            existingOperationId: duplicate.operation.id,
            existingTitle: duplicate.operation.title,
            reason: "similar_prerequisite_exists",
            similarityScore: duplicate.score,
            ...(wouldCycle ? { dependencySkippedReason: "blocking_dependency_cycle" } : {}),
            ...(dependency ? { dependencyId: dependency.id } : {})
          }
        }
      );
      continue;
    }
    const prerequisiteReason = blockedOperation.blockedReason ? getRepairableBlockerCategory(blockedOperation.blockedReason) : "missing_prerequisite_context";
    const dependency = {
      id: `${nextSnapshot.forge.slug}-dep-${stableIdForPath(blockedOperation.id)}-${stableIdForPath(operation.id)}`,
      operationId: blockedOperation.id,
      dependsOnOperationId: operation.id,
      type: "blocks" as const
    };

    nextSnapshot = {
      ...nextSnapshot,
      operations: [...nextSnapshot.operations, operation],
      dependencies: [...nextSnapshot.dependencies, dependency]
    };
    events.push(
      {
        forgeId: snapshot.forge.id,
        type: "operation.created",
        actorType: "executive",
        targetType: "operation",
        targetId: operation.id,
        message: `Executive created prerequisite operation: ${operation.title}.`,
        severity: "info",
        payload: {
          operationId: operation.id,
          blockedOperationId: blockedOperation.id,
          divisionId: operation.divisionId,
          workerId: operation.workerId,
          reason: prerequisiteReason
        }
      },
      {
        forgeId: snapshot.forge.id,
        type: "operation.blocked",
        actorType: "runtime",
        targetType: "operation",
        targetId: blockedOperation.id,
        message: `${blockedOperation.title} is waiting for prerequisite work from ${operation.title}.`,
        severity: "warning",
        payload: {
          operationId: blockedOperation.id,
          prerequisiteOperationId: operation.id,
          dependencyId: dependency.id,
          reason: prerequisiteReason
        }
      }
    );
  }

  return { snapshot: nextSnapshot, events };
}

function hasOpenPrerequisiteFor(snapshot: ForgeSnapshot, operation: Operation) {
  const dependencyIds = new Set(
    snapshot.dependencies
      .filter((dependency) => dependency.operationId === operation.id && dependency.type === "blocks")
      .map((dependency) => dependency.dependsOnOperationId)
  );
  return snapshot.operations.some((candidate) => dependencyIds.has(candidate.id) && candidate.status !== "completed" && isMissingPrerequisiteOperation(candidate));
}

function isMissingPrerequisiteOperation(operation: Operation) {
  return /\b(scaffold|project structure|package manifest|package\.json|app shell|data contract|prerequisite|implementation context|upstream deliverable|verification failure|failed runtime checks|implementation repair|compile|render defect)\b/i.test(`${operation.title} ${operation.description}`);
}

function createMissingPrerequisiteOperation(snapshot: ForgeSnapshot, blockedOperation: Operation): Operation {
  const projectStructure = blockedOperation.blockedReason ? isMissingProjectStructureBlocker(blockedOperation.blockedReason) : false;
  const verificationRepair = blockedOperation.blockedReason ? isVerificationRepairBlocker(blockedOperation.blockedReason) : false;
  const divisionId = selectPrerequisiteDivisionId(snapshot, blockedOperation, projectStructure);
  const title = (
    verificationRepair
      ? `Repair verification failure for ${blockedOperation.title}`
      : projectStructure
        ? `Create project scaffold and data contract for ${blockedOperation.title}`
        : `Produce prerequisite implementation context for ${blockedOperation.title}`
  ).slice(0, 160);
  const description = [
    verificationRepair
      ? `Repair the implementation defects that caused runtime verification to fail before "${blockedOperation.title}" can confirm readiness.`
      : projectStructure
        ? `Create the missing prerequisite project structure required before "${blockedOperation.title}" can run.`
        : `Produce the missing upstream deliverables or implementation context required before "${blockedOperation.title}" can run.`,
    verificationRepair
      ? "Inspect the failed runtime checks, verification output, generated files, and likely compile or render defects. Patch the implementation and hand off concrete fixed files plus rerun evidence to the blocked QA or release operation."
      : projectStructure
        ? "Produce package.json, an app shell entry point, component/source directories, and any data-consumer contract needed by the blocked operation."
        : "Create concrete virtual workspace files, artifacts, and handoffs that let the blocked downstream operation verify real implementation output instead of guessing.",
    blockedOperation.blockedReason ? `Original blocker: ${blockedOperation.blockedReason}` : undefined
  ]
    .filter((item): item is string => Boolean(item))
    .join(" ")
    .slice(0, 1000);
  const worker = selectDefaultWorkerForOperation(snapshot, divisionId, title, description) ?? snapshot.workers.find((candidate) => candidate.id === snapshot.divisions.find((division) => division.id === divisionId)?.leadWorkerId);
  const operation = {
    id: `${snapshot.forge.slug}-op-${stableIdForPath(title)}-${Date.now()}`,
    divisionId,
    workerId: worker?.id,
    title,
    description,
    status: "ready" as const,
    priority: blockedOperation.priority === "critical" ? ("critical" as const) : ("high" as const),
    progress: 0,
    retryCount: 0,
    outputArtifactIds: [],
    routingStage: inferCreatedOperationRoutingStage("ready", worker?.kind),
    webAccessPolicy: blockedOperation.webAccessPolicy,
    webAccessPurpose: blockedOperation.webAccessPurpose,
    allowedDomains: blockedOperation.allowedDomains
  };
  return operation;
}

function selectPrerequisiteDivisionId(snapshot: ForgeSnapshot, blockedOperation: Operation, projectStructure: boolean) {
  const blockedDivision = snapshot.divisions.find((division) => division.id === blockedOperation.divisionId);
  const blockedText = `${blockedOperation.title} ${blockedOperation.description} ${blockedDivision?.name ?? ""}`.toLowerCase();
  const upstreamDivision = snapshot.divisions.find((division) => {
    const text = `${division.id} ${division.name}`.toLowerCase();
    if (division.id === blockedOperation.divisionId) {
      return false;
    }
    if (/\bqa|quality|release|deploy|presentation|launch\b/.test(text)) {
      return false;
    }
    return /\bengineering|implementation|build|product|runtime|development|app\b/.test(text);
  });

  if (projectStructure || /\bqa|quality|validate|test|release|deploy|launch|review\b/.test(blockedText)) {
    return upstreamDivision?.id ?? blockedOperation.divisionId;
  }

  return blockedOperation.divisionId;
}

function createExecutiveEscalation(
  snapshot: ForgeSnapshot,
  input: {
    run: AgentRun;
    operation: Operation;
    category: AgentFailureCategory;
    reason: string;
    recommendedNextAction: string;
    timestamp: string;
  }
): { snapshot: ForgeSnapshot; events: RuntimeEventDraft[] } {
  const escalationId = `${snapshot.forge.slug}-executive-escalation-${stableIdForPath(input.operation.id)}-${Date.now()}`;
  const reviewId = `${escalationId}-review`;
  const safeReason = sanitizeBriefText(input.reason, 500);
  const safeNextAction = sanitizeBriefText(input.recommendedNextAction, 500);
  const attempts = summarizeAttempts(readRunAttempts(input.run.providerMetadata));
  const content = `Executive escalation: ${input.operation.title}. Failure category: ${input.category}. Reason: ${safeReason}. Recommended next action: ${safeNextAction}.`;
  const message = {
    id: `${escalationId}-message`,
    role: "executive" as const,
    kind: "executive_summary" as const,
    source: "run_terminal" as const,
    content,
    runId: input.run.id,
    operationId: input.operation.id,
    status: "escalated",
    createdAt: input.timestamp
  };

  return {
    snapshot: {
      ...snapshot,
      messages: [...snapshot.messages, message]
    },
    events: [
      {
        forgeId: snapshot.forge.id,
        type: "operation.escalated",
        actorType: "runtime",
        targetType: "operation",
        targetId: input.operation.id,
        message: "Operation escalated to Executive for recovery decision.",
        severity: "error",
        payload: {
          reviewId,
          escalationId,
          runId: input.run.id,
          operationId: input.operation.id,
          workerId: input.run.workerId,
          failureCategory: input.category,
          recommendedNextAction: safeNextAction,
          attemptHistory: attempts
        }
      },
      {
        forgeId: snapshot.forge.id,
        type: "executive.review_requested",
        actorType: "runtime",
        targetType: "operation",
        targetId: input.operation.id,
        message: content,
        severity: "warning",
        payload: {
          reviewId,
          escalationId,
          runId: input.run.id,
          operationId: input.operation.id,
          failureCategory: input.category,
          recommendedNextAction: safeNextAction,
          attemptHistory: attempts
        }
      }
    ]
  };
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toStringList(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(hasNonEmptyString).map((item) => item.trim().slice(0, maxLength)).slice(0, maxItems);
}

function mergeStringLists(left: string[], right: string[]) {
  return Array.from(new Set([...left, ...right]));
}

function createContextRoutedEvent(snapshot: ForgeSnapshot, run: AgentRun, routing: RunContextAccounting["routing"] | undefined): RuntimeEventDraft {
  return {
    forgeId: snapshot.forge.id,
    type: "context.routed",
    actorType: "runtime",
    targetType: "run",
    targetId: run.id,
    message: "Runtime routed artifact and virtual file context for the run.",
    severity: "info",
    payload: {
      runId: run.id,
      operationId: run.operationId,
      selectedArtifactIds: routing?.selectedArtifactIds ?? [],
      selectedFileIds: routing?.selectedFileIds ?? [],
      omittedArtifactIds: routing?.omittedArtifactIds ?? [],
      omittedFileIds: routing?.omittedFileIds ?? [],
      routingReasons: routing?.routingReasons ?? {}
    }
  };
}

function toContextTraceSummary(accounting: RunContextAccounting | undefined, providerPrompt?: { estimatedTokens: number }): RunTraceSummary["context"] | undefined {
  if (!accounting) {
    return undefined;
  }
  const providerEstimatedTokens = providerPrompt?.estimatedTokens;
  const compressionRatio = providerEstimatedTokens && accounting.estimatedTokens > 0 ? Number((providerEstimatedTokens / accounting.estimatedTokens).toFixed(4)) : undefined;

  return {
    estimatedTokens: accounting.estimatedTokens,
    providerEstimatedTokens,
    budgetTokens: accounting.budget.totalTokens,
    compressionRatio,
    sections: Object.values(accounting.sections).map((section) => ({
      section: section.section,
      allocatedTokens: section.allocatedTokens,
      usedTokens: section.usedTokens,
      selectedItems: section.selectedItems,
      omittedItems: section.omittedItems,
      truncatedItems: section.truncatedItems
    })),
    omittedReasons: accounting.omittedReasons.slice(0, 20),
    routedArtifacts: accounting.routing?.selectedArtifactIds.slice(0, 20),
    routedFiles: accounting.routing?.selectedFileIds.slice(0, 20),
    omittedArtifacts: accounting.routing?.omittedArtifactIds.slice(0, 20),
    omittedFiles: accounting.routing?.omittedFileIds.slice(0, 20),
    routingReasons: accounting.routing ? Object.fromEntries(Object.entries(accounting.routing.routingReasons).slice(0, 40)) : undefined
  };
}

function toOutputTraceSummary(outputs: ProviderRunOutputs, provider: AgentProviderName, status: AgentRun["status"], completedAt?: string): RunTraceSummary {
  return {
    outputs: {
      artifactCount: outputs.artifacts.length,
      fileCount: outputs.files.length,
      filePatchCount: outputs.filePatches.length,
      handoffCount: outputs.handoffs.length,
      blockerCount: outputs.blockers.length,
      questionRequestCount: outputs.questionRequests.length,
      dangerousActionCount: outputs.dangerousActions.length,
      dependencyRequestCount: outputs.dependencyRequests.length,
      recoveryActionCount: outputs.recoveryActions.length,
      requestedFileCount: outputs.requestedFiles.length,
      requestedSearchCount: outputs.requestedSearches.length,
      requestedArtifactCount: outputs.requestedArtifacts.length,
      verificationEvidence: outputs.verificationEvidence,
      omittedCount: outputs.omissions.length,
      omissionReasons: outputs.omissions.slice(0, 20)
    },
    lifecycle: {
      provider,
      status,
      completedAt
    }
  };
}

function mergeTraceSummary(metadata: Record<string, unknown>, patch: RunTraceSummary): Record<string, unknown> {
  const current = isTraceSummary(metadata.traceSummary) ? metadata.traceSummary : {};
  return {
    ...metadata,
    traceSummary: {
      ...current,
      ...patch,
      context: patch.context ?? current.context,
      outputs: mergeTraceOutputs(current.outputs, patch.outputs),
      lifecycle: patch.lifecycle ?? current.lifecycle,
      checkpoint: patch.checkpoint ?? current.checkpoint
    }
  };
}

function mergeTraceOutputs(current: RunTraceSummary["outputs"] | undefined, patch: RunTraceSummary["outputs"] | undefined): RunTraceSummary["outputs"] | undefined {
  if (!patch) {
    return current;
  }
  if (!current) {
    return patch;
  }
  return {
    ...patch,
    requestedFileCount: (current.requestedFileCount ?? 0) + (patch.requestedFileCount ?? 0),
    requestedSearchCount: (current.requestedSearchCount ?? 0) + (patch.requestedSearchCount ?? 0),
    requestedArtifactCount: (current.requestedArtifactCount ?? 0) + (patch.requestedArtifactCount ?? 0),
    recoveryActionCount: (current.recoveryActionCount ?? 0) + (patch.recoveryActionCount ?? 0),
    verificationEvidence: patch.verificationEvidence ?? current.verificationEvidence,
    omittedCount: current.omittedCount + patch.omittedCount,
    omissionReasons: mergeStringLists(current.omissionReasons, patch.omissionReasons).slice(0, 20)
  };
}

function mergeRuntimeVerificationSummary(metadata: Record<string, unknown>, summary: RuntimeVerificationSummary): Record<string, unknown> {
  return {
    ...metadata,
    verificationSummary: summary
  };
}

function getProjectedOutputRefs(events: RuntimeEventDraft[]) {
  return events.reduce(
    (refs, event) => ({
      artifactIds: event.type === "artifact.created" && typeof event.payload.artifactId === "string" ? [...refs.artifactIds, event.payload.artifactId] : refs.artifactIds,
      fileIds: Array.isArray(event.payload.fileIds) ? mergeStringLists(refs.fileIds, event.payload.fileIds.filter((id): id is string => typeof id === "string")) : refs.fileIds,
      handoffIds: event.type === "handoff.created" && typeof event.payload.handoffId === "string" ? [...refs.handoffIds, event.payload.handoffId] : refs.handoffIds
    }),
    { artifactIds: [] as string[], fileIds: [] as string[], handoffIds: [] as string[] }
  );
}

function sanitizeRuntimeVerificationSummary(summary: RuntimeVerificationSummary, fallback: RuntimeVerificationSummary): RuntimeVerificationSummary {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return fallback;
  }

    return {
      source: "runtime",
      tier: isRuntimeVerificationTier(summary.tier) ? summary.tier : fallback.tier,
      status: isRuntimeVerificationStatus(summary.status) ? summary.status : fallback.status,
      checkedAt: typeof summary.checkedAt === "string" ? summary.checkedAt.slice(0, 80) : fallback.checkedAt,
    providerShellAccess: false,
    projectedArtifactIds: toStringList(summary.projectedArtifactIds, 50, 160),
    projectedFileIds: toStringList(summary.projectedFileIds, 50, 160),
    projectedHandoffIds: toStringList(summary.projectedHandoffIds, 50, 160),
    blockerCount: readFiniteNumber(summary.blockerCount) ?? fallback.blockerCount,
    checks: sanitizeRuntimeVerificationChecks(summary.checks),
    omittedReasons: toStringList(summary.omittedReasons, 20, 240)
  };
}

function sanitizeRuntimeVerificationChecks(value: unknown): RuntimeVerificationSummary["checks"] {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const checks = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    if (!hasNonEmptyString(candidate.name) || !isRuntimeVerificationStatus(candidate.status)) {
      return [];
    }

    return [
      {
        name: candidate.name.trim().slice(0, 120),
        status: candidate.status,
        ...(hasNonEmptyString(candidate.message) ? { message: candidate.message.trim().slice(0, 500) } : {}),
        ...(typeof candidate.exitCode === "number" || candidate.exitCode === null ? { exitCode: candidate.exitCode } : {}),
        ...(typeof candidate.timedOut === "boolean" ? { timedOut: candidate.timedOut } : {}),
        ...(hasNonEmptyString(candidate.outputTail) ? { outputTail: sanitizeBriefText(candidate.outputTail, 2000) } : {})
      }
    ];
  });

  return checks.length > 0 ? checks.slice(0, 20) : undefined;
}

function summarizeCommandOutputTail(stdout: string | undefined, stderr: string | undefined) {
  const output = [stdout, stderr].filter(hasNonEmptyString).join("\n").trim();
  return output ? output.slice(-2000) : undefined;
}

function isRuntimeVerificationStatus(value: unknown): value is RuntimeVerificationSummary["status"] {
  return value === "passed" || value === "failed" || value === "skipped" || value === "error";
}

function isRuntimeVerificationTier(value: unknown): value is RuntimeVerificationSummary["tier"] {
  return value === "development" || value === "acceptance";
}

function mergeProviderMetadata(current: Record<string, unknown>, patch: Record<string, unknown> | undefined) {
  if (!patch || Object.keys(patch).length === 0) {
    return current;
  }

  return {
    ...current,
    ...patch,
    traceSummary: current.traceSummary
  };
}

function isTraceSummary(value: unknown): value is RunTraceSummary {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stableIdForPath(filePath: string) {
  return filePath.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "root";
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

function inferCreatedOperationRoutingStage(status: RuntimeStatus | undefined, workerKind: ForgeSnapshot["workers"][number]["kind"] | undefined) {
  if (status === "ready") {
    return workerKind === "lead" || workerKind === "executive" ? ("lead_triaged" as const) : ("worker_ready" as const);
  }
  return workerKind === "lead" || workerKind === "executive" ? ("lead_triaged" as const) : ("executive_planned" as const);
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
  return typeof value === "string" && ["idle", "planning", "ready", "running", "blocked", "reviewing", "paused", "completed", "failed", "canceled", "archived"].includes(value);
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
  if (process.env.NODE_ENV === "test") {
    return new InMemoryRuntimePersistence();
  }

  if (process.env.DATABASE_URL) {
    return new PrismaRuntimePersistence();
  }

  return new FileRuntimePersistence(process.env.FORGEOS_RUNTIME_STORE_PATH);
}

function allowsDatabaseStorageReset() {
  return process.env.FORGEOS_ALLOW_DATABASE_CLEAR === "1" || process.env.FORGEOS_ALLOW_DATABASE_CLEAR === "true";
}

function createDefaultRuntimeVerificationHook(): RuntimeVerificationHook {
  return async ({ snapshot, run, completedAt, projectedArtifactIds, projectedFileIds, projectedHandoffIds, blockerCount }) => {
    const projectedFiles = snapshot.files.filter((file) => projectedFileIds.includes(file.id));
    if (projectedFiles.length === 0) {
      return {
        source: "runtime",
        status: "skipped",
        tier: selectRuntimeVerificationTier(snapshot, run),
        checkedAt: completedAt,
        providerShellAccess: false,
        projectedArtifactIds,
        projectedFileIds,
        projectedHandoffIds,
        blockerCount,
        omittedReasons: ["No provider-generated files were available for automatic verification."]
      };
    }
    const files = selectVerificationWorkspaceFiles(snapshot.files, projectedFileIds);

    const verification = await verifyGeneratedFiles({
      workspaceRoot: getExecutionWorkspaceRoot(),
      forgeId: snapshot.forge.id,
      runId: run.id,
      files,
      tier: selectRuntimeVerificationTier(snapshot, run),
      timeoutMs: readPositiveInteger(process.env.FORGEOS_VERIFICATION_TIMEOUT_MS, 120000)
    });

    return {
      source: "runtime",
      status: verification.status,
      tier: verification.tier,
      checkedAt: completedAt,
      providerShellAccess: false,
      projectedArtifactIds,
      projectedFileIds,
      projectedHandoffIds,
      blockerCount,
      checks: verification.commands?.map((command) => ({
        name: command.command,
        status: command.exitCode === 0 && !command.timedOut ? ("passed" as const) : ("failed" as const),
        exitCode: command.exitCode,
        timedOut: command.timedOut,
        message: command.timedOut
          ? "Verification command timed out."
          : command.exitCode === 0
            ? "Verification command passed."
            : `Verification command failed with exit code ${command.exitCode ?? "unknown"}.`,
        outputTail: summarizeCommandOutputTail(command.stdout, command.stderr)
      })),
      omittedReasons: verification.reason ? [verification.reason] : undefined
    };
  };
}

async function cleanupDeletedForgeWorkspaces(snapshots: ForgeSnapshot[]) {
  const removedPaths: string[] = [];
  const failedPaths: Array<{ path: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const snapshot of snapshots) {
    const candidates = [
      ...createForgeWorkspaceCleanupCandidates(getExecutionWorkspaceRoot(), [snapshot.forge.id, snapshot.forge.slug]),
      ...(shouldDeleteLauncherWorkspaces()
        ? createForgeWorkspaceCleanupCandidates(launcherService.getDefaultLauncherWorkspaceRoot(), [snapshot.forge.slug, snapshot.forge.id])
        : [])
    ];
    if (shouldDeleteLauncherWorkspaces()) {
      await launcherService.stopForgePreviews(snapshot.forge.id);
    }

    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      try {
        await rm(candidate, { recursive: true, force: true });
        removedPaths.push(sanitizeLocalCleanupPath(candidate));
      } catch (error) {
        failedPaths.push({
          path: sanitizeLocalCleanupPath(candidate),
          reason: error instanceof Error ? error.message.slice(0, 240) : "Workspace cleanup failed."
        });
      }
    }
  }

  return { removedPaths, failedPaths };
}

function getExecutionWorkspaceRoot() {
  return process.env.FORGEOS_EXECUTION_WORKSPACE_ROOT ?? path.join(process.cwd(), ".forgeos", "workspaces");
}

function shouldDeleteLauncherWorkspaces() {
  return process.env.FORGEOS_DELETE_LAUNCHER_WORKSPACES === "1" || process.env.FORGEOS_DELETE_LAUNCHER_WORKSPACES === "true";
}

function createForgeWorkspaceCleanupCandidates(rootDir: string, names: string[]) {
  const root = path.resolve(rootDir);
  return Array.from(new Set(names)).flatMap((name) => {
    const candidate = path.resolve(root, name);
    if (candidate !== root && candidate.startsWith(`${root}${path.sep}`)) {
      return [candidate];
    }
    return [];
  });
}

function sanitizeLocalCleanupPath(filePath: string) {
  const relative = path.relative(process.cwd(), filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : "[workspace]";
}

function selectVerificationWorkspaceFiles(files: VirtualFile[], projectedFileIds: string[]) {
  const projectedIds = new Set(projectedFileIds);
  const byPath = new Map<string, VirtualFile>();
  for (const file of files.slice().sort(compareVerificationFilePriority(projectedIds))) {
    if (!byPath.has(file.path)) {
      byPath.set(file.path, file);
    }
  }
  return Array.from(byPath.values());
}

function compareVerificationFilePriority(projectedIds: Set<string>) {
  return (left: VirtualFile, right: VirtualFile) => {
    const projectedDelta = Number(projectedIds.has(right.id)) - Number(projectedIds.has(left.id));
    return projectedDelta || right.updatedAt.localeCompare(left.updatedAt) || left.path.localeCompare(right.path) || left.id.localeCompare(right.id);
  };
}

function selectRuntimeVerificationTier(snapshot: ForgeSnapshot, run: AgentRun): VerificationTier {
  const operation = snapshot.operations.find((candidate) => candidate.id === run.operationId);
  const division = operation ? snapshot.divisions.find((candidate) => candidate.id === operation.divisionId) : undefined;
  const worker = run.workerId ? snapshot.workers.find((candidate) => candidate.id === run.workerId) : undefined;
  const searchable = `${operation?.title ?? ""} ${operation?.description ?? ""} ${division?.name ?? ""} ${worker?.name ?? ""} ${worker?.role ?? ""}`.toLowerCase();
  if (/\b(qa|quality|acceptance|release|launch|deploy|deployment|ship|production|sign[ -]?off|final)\b/.test(searchable)) {
    return "acceptance";
  }
  return "development";
}

const globalForRuntime = globalThis as unknown as { forgeRuntimeStore?: RuntimeStore };

export const runtimeStore = globalForRuntime.forgeRuntimeStore ?? new RuntimeStore();

if (process.env.NODE_ENV !== "production") {
  globalForRuntime.forgeRuntimeStore = runtimeStore;
}
