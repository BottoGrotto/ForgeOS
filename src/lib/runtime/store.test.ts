import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutiveProviderRequestError } from "@/lib/llm/provider";
import { createDemoSnapshot, createEmptyForgeSnapshot } from "@/lib/mock/seed";
import { encryptSecret } from "@/lib/security/tokens";
import { RuntimeCommandError, RuntimeStore } from "./store";
import { MockRuntime } from "./mock-runtime";
import { InMemoryRuntimePersistence } from "./persistence";
import { ProviderThrottle } from "./provider-throttle";
import { isActiveRun } from "./runs";
import type {
  AgentRunStatus,
  AgentRuntime,
  ExecutiveIntentProvider,
  ExecutiveManagerDecision,
  ExecutiveProposalDraft,
  ProviderCapabilities,
  RunOperationInput,
  RuntimeEventDraft,
  RuntimeStatus,
  RuntimeVerificationHook,
  RuntimeVerificationSummary
} from "./types";

function createTestStore() {
  return new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new MockRuntime());
}

class ProposalProvider implements ExecutiveIntentProvider {
  constructor(private readonly proposal: ExecutiveProposalDraft | ((input: Parameters<ExecutiveIntentProvider["proposeOperationChanges"]>[0]) => ExecutiveProposalDraft)) {}

  getProviderInfo() {
    return { provider: "mock" as const };
  }

  async proposeOperationChanges(input: Parameters<ExecutiveIntentProvider["proposeOperationChanges"]>[0]) {
    return typeof this.proposal === "function" ? this.proposal(input) : this.proposal;
  }
}

class ExecutiveManagerProvider extends ProposalProvider {
  constructor(private readonly decision: ExecutiveManagerDecision) {
    super({ summary: "fallback", actions: [] });
  }

  async decideNextExecutiveAction() {
    return this.decision;
  }
}

class SequencedExecutiveManagerProvider extends ProposalProvider {
  readonly inputs: Array<Parameters<NonNullable<ExecutiveIntentProvider["decideNextExecutiveAction"]>>[0]> = [];
  private index = 0;

  constructor(private readonly decisions: ExecutiveManagerDecision[]) {
    super({ summary: "fallback", actions: [] });
  }

  async decideNextExecutiveAction(input: Parameters<NonNullable<ExecutiveIntentProvider["decideNextExecutiveAction"]>>[0]): Promise<ExecutiveManagerDecision> {
    this.inputs.push(input);
    const decision = this.decisions[Math.min(this.index, this.decisions.length - 1)];
    this.index += 1;
    return decision;
  }
}

class FailingProposalProvider implements ExecutiveIntentProvider {
  getProviderInfo() {
    return { provider: "mock" as const };
  }

  async proposeOperationChanges(): Promise<ExecutiveProposalDraft> {
    throw new Error("provider unavailable");
  }
}

class FailingOpenAIProposalProvider implements ExecutiveIntentProvider {
  getProviderInfo() {
    return { provider: "openai" as const, model: "gpt-test" };
  }

  async proposeOperationChanges(): Promise<ExecutiveProposalDraft> {
    throw new ExecutiveProviderRequestError({
      category: "provider_http_error",
      message: "Executive AI provider request failed with HTTP 403: insufficient_quota: billing_error: Quota exceeded.",
      httpStatus: 403,
      providerErrorCode: "insufficient_quota",
      providerErrorType: "billing_error"
    });
  }
}

class InvalidExecutiveDecisionProvider extends ProposalProvider {
  constructor() {
    super({ summary: "fallback", actions: [] });
  }

  async decideNextExecutiveAction() {
    return {
      summary: "Invalid decision",
      projectStatus: "running",
      userReport: "Invalid decision",
      operationActions: [
        {
          type: "create_operation",
          title: "Missing description",
          divisionId: "engineering"
        }
      ],
      dispatchPolicy: { maxRuns: 1, priority: "critical_first" }
    } as unknown as ExecutiveManagerDecision;
  }
}

class ThrowingExecutiveDecisionProvider extends ProposalProvider {
  constructor() {
    super({ summary: "fallback", actions: [] });
  }

  async decideNextExecutiveAction(): Promise<ExecutiveManagerDecision> {
    throw new Error("provider returned an unusable plan");
  }
}

class DeferredRuntime implements AgentRuntime {
  private started = 0;
  private canceled = 0;
  private readonly gates: Array<() => void> = [];

  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  get startedCount() {
    return this.started;
  }

  get canceledCount() {
    return this.canceled;
  }

  releaseNext() {
    this.gates.shift()?.();
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    this.started += 1;
    yield {
      forgeId: input.forgeId,
      type: "operation.started",
      actorType: "runtime",
      targetType: "operation",
      targetId: input.operationId,
      message: "Deferred runtime started operation execution.",
      severity: "info",
      payload: { operationId: input.operationId }
    };

    await new Promise<void>((resolve) => this.gates.push(resolve));

    yield {
      forgeId: input.forgeId,
      type: "operation.completed",
      actorType: "runtime",
      targetType: "operation",
      targetId: input.operationId,
      message: "Deferred runtime completed operation execution.",
      severity: "success",
      payload: { operationId: input.operationId }
    };
  }

  async cancelOperation() {
    this.canceled += 1;
    return Promise.resolve();
  }
}

class PostPauseStreamingRuntime extends DeferredRuntime {
  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.progress",
      actorType: "runtime",
      targetType: "run",
      message: "Provider started a stream.",
      severity: "info",
      payload: { operationId: input.operationId }
    };

    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    yield {
      forgeId: input.forgeId,
      type: "run.progress",
      actorType: "runtime",
      targetType: "run",
      message: "Late provider progress after pause.",
      severity: "info",
      payload: { operationId: input.operationId }
    };

    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Late provider completion after pause.",
      severity: "success",
      payload: { operationId: input.operationId, outputs: { artifacts: [{ title: "Late", type: "note", content: "Too late." }] } }
    };
  }
}

class CostedCodexRuntime implements AgentRuntime {
  started = 0;

  provider() {
    return "codex" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: true
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    this.started += 1;
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Codex completed with usage.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        usage: {
          requestCount: 1,
          inputTokens: 1000,
          outputTokens: 500,
          costMicros: 2500,
          costSource: "estimated"
        },
        outputs: {
          artifacts: [{ title: "Result", type: "summary", content: "Done.", tags: ["test"] }],
          files: [],
          requestedFiles: [],
          requestedSearches: [],
          handoffs: [],
          blockers: [],
          dangerousActions: [],
          recoveryActions: []
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class FailingRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(): AsyncIterable<RuntimeEventDraft> {
    throw new Error("Provider exploded.");
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class CancelingRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.canceled",
      actorType: "runtime",
      targetType: "run",
      message: "Provider canceled the run.",
      severity: "warning",
      payload: { operationId: input.operationId, providerMetadata: { traceId: "cancel-trace" } }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class RecordingRuntime implements AgentRuntime {
  inputs: RunOperationInput[] = [];

  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    this.inputs = [...this.inputs, input];
    yield {
      forgeId: input.forgeId,
      type: "operation.completed",
      actorType: "runtime",
      targetType: "operation",
      targetId: input.operationId,
      message: "Recording runtime completed operation execution.",
      severity: "success",
      payload: { operationId: input.operationId }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class ProjectContextRequestRuntime implements AgentRuntime {
  inputs: RunOperationInput[] = [];

  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    this.inputs = [...this.inputs, input];
    if (this.inputs.length === 1) {
      yield {
        forgeId: input.forgeId,
        type: "run.completed",
        actorType: "runtime",
        targetType: "run",
        message: "Provider needs more project context.",
        severity: "success",
        payload: {
          operationId: input.operationId,
          outputs: {
            requestedSearches: [{ query: "AGENT_LOOP_SENTINEL", glob: "docs/*.md", reason: "Find the request loop brief." }],
            requestedFiles: [{ path: "docs/agent-loop.md", reason: "Read the selected implementation brief." }],
            requestedArtifacts: [{ id: "artifact-strategy", reason: "Read the upstream strategy artifact." }]
          }
        }
      };
      return;
    }

    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed after reading requested context.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          artifacts: [
            {
              title: "Agent Loop Implementation Notes",
              type: "implementation_notes",
              content: "The worker used requested project context before producing output."
            }
          ],
          files: [
            {
              path: "docs/agent-loop-result.md",
              content: "# Result\n\nImplemented after reading requested project context."
            }
          ]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class CheckpointedContextRequestRuntime implements AgentRuntime {
  inputs: RunOperationInput[] = [];
  private readonly gates: Array<() => void> = [];

  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  releaseNext() {
    this.gates.shift()?.();
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    this.inputs = [...this.inputs, input];
    if (this.inputs.length === 1) {
      yield {
        forgeId: input.forgeId,
        type: "run.progress",
        actorType: "runtime",
        targetType: "run",
        message: "Provider is planning requested context.",
        severity: "info",
        payload: { operationId: input.operationId }
      };
      await new Promise<void>((resolve) => this.gates.push(resolve));
      yield {
        forgeId: input.forgeId,
        type: "run.completed",
        actorType: "runtime",
        targetType: "run",
        message: "Provider needs checkpointed project context.",
        severity: "success",
        payload: {
          operationId: input.operationId,
          outputs: {
            requestedFiles: [{ path: "docs/agent-loop.md", reason: "Read the selected implementation brief." }]
          }
        }
      };
      return;
    }

    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed after checkpointed context.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          files: [{ path: "docs/checkpointed-result.md", content: "# Result\n\nCompleted after checkpointed context." }]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class OpenClawContractRuntime implements AgentRuntime {
  provider() {
    return "openclaw" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.progress",
      actorType: "runtime",
      targetType: "run",
      message: "OpenClaw accepted the run.",
      severity: "info",
      payload: {
        operationId: input.operationId,
        externalRunId: "openclaw-run-1",
        providerMetadata: {
          model: "openclaw-coder",
          traceId: "trace-1",
          rawPrompt: "hidden prompt",
          ["to" + "ken"]: "test-provider-token"
        },
        context: input.context
      }
    };

    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "OpenClaw completed the run.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          artifacts: [
            {
              title: "OpenClaw Runtime Notes",
              type: "implementation_notes",
              content: "OpenClaw produced a bounded implementation note from the run context.",
              tags: ["openclaw", "runtime"]
            }
          ],
          files: [
            {
              path: "notes/openclaw-runtime.md",
              content: "# OpenClaw Runtime\n\nProvider output projected into the virtual workspace."
            }
          ],
          handoffs: [
            {
              toDivisionId: "qa",
              summary: "Runtime contracts are ready for QA validation.",
              deliverables: ["Runtime notes", "Virtual workspace output"],
              requiredContext: ["Inspect generated runtime notes"],
              confidence: 88
            }
          ],
          blockers: [
            {
              reason: "QA must validate runtime output projection before release."
            }
          ]
        },
        rawProviderPayload: "hidden completion payload"
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class CoordinationStatusRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Coordination completed.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          artifacts: [
            {
              title: "Operations coordination status",
              type: "coordination_status",
              content: "Follow-on work is routed and dependency-gated."
            }
          ],
          handoffs: [
            {
              toDivisionId: "engineering",
              summary: "Engineering work remains queued behind prerequisites.",
              deliverables: ["Dependency routing status"],
              confidence: 82
            }
          ],
          blockers: [
            {
              reason: "Scheduler reports no currently eligible operations beyond the routed attention/dependency items; work is dependency-gated rather than blocked by missing execution capacity."
            }
          ]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class MissingProjectStructureRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed with missing project structure blocker.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          artifacts: [
            {
              title: "Implementation blocked by missing project structure",
              type: "implementation-summary",
              content: "Could not implement because app shell and package manifest were missing."
            }
          ],
          files: [],
          requestedFiles: [{ path: "package.json", reason: "Find the project package manifest." }],
          requestedSearches: [{ query: "app shell", glob: "**/*", reason: "Find the app shell." }],
          handoffs: [],
          blockers: [
            {
              reason: "No existing workspace source files for the app shell, components, or package manifest were available.",
              severity: "warning"
            }
          ],
          dangerousActions: [],
          recoveryActions: []
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class VerificationFailedReadinessRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed with failed verification blocker.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          artifacts: [],
          files: [],
          requestedFiles: [],
          requestedSearches: [],
          handoffs: [],
          blockers: [
            {
              reason: "Runtime verification for the implementation already failed, so release readiness cannot be confirmed.",
              severity: "error"
            }
          ],
          dangerousActions: [],
          recoveryActions: []
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class InvalidOutputsRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed with mixed output quality.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          artifacts: [
            { title: "", type: "note", content: "missing title" },
            { title: "Valid Note", type: "note", content: "valid provider artifact" }
          ],
          files: [
            { path: "../secret.txt", content: "invalid path" },
            { path: "notes/valid.md", content: "valid provider file" }
          ],
          handoffs: [
            { toDivisionId: "", summary: "invalid handoff" },
            { toDivisionId: "qa", summary: "Valid QA handoff" }
          ],
          blockers: [
            { reason: "" },
            { reason: "Valid blocker reason" }
          ]
        },
        rawProviderPayload: "hidden mixed payload"
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class SelfRepairingInvalidOutputRuntime implements AgentRuntime {
  prompts: RunOperationInput[] = [];

  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    this.prompts.push(input);
    if (!input.providerPrompt.repairBrief) {
      yield {
        forgeId: input.forgeId,
        type: "run.completed",
        actorType: "runtime",
        targetType: "run",
        message: "Provider completed with unusable output.",
        severity: "success",
        payload: {
          operationId: input.operationId,
          outputs: {
            artifacts: [{ title: "", type: "note", content: "" }]
          },
          rawProviderPayload: "secret raw output"
        }
      };
      return;
    }

    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider repaired output.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          artifacts: [{ title: "Repaired Note", type: "note", content: "Corrected output." }]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class AlwaysInvalidOutputRuntime extends SelfRepairingInvalidOutputRuntime {
  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    this.prompts.push(input);
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed with unusable output.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          artifacts: [{ title: "", type: "note", content: "" }]
        },
        rawProviderPayload: "secret raw output"
      }
    };
  }
}

class ProviderFailureRuntime implements AgentRuntime {
  constructor(private readonly payload: Record<string, unknown>) {}

  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.failed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider failed.",
      severity: "error",
      payload: { operationId: input.operationId, ...this.payload }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class LeadRecoveryRuntime implements AgentRuntime {
  inputs: RunOperationInput[] = [];

  constructor(private readonly action: Record<string, unknown>) {}

  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    this.inputs.push(input);
    if (!input.providerPrompt.context.operation.escalationRunId && !input.providerPrompt.context.operation.escalatedFromOperationId) {
      yield {
        forgeId: input.forgeId,
        type: "run.completed",
        actorType: "runtime",
        targetType: "run",
        message: "Worker exhausted.",
        severity: "success",
        payload: { operationId: input.operationId, outputs: { artifacts: [{ title: "", type: "note", content: "" }] } }
      };
      return;
    }

    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Lead produced recovery action.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          recoveryActions: [this.action]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class FileOnlyRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed with generated files only.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          files: [
            {
              path: "package.json",
              content: JSON.stringify({ scripts: { test: `${process.execPath} -e "console.log('file-only verification passed')"` } })
            },
            {
              path: "app/menu-search.tsx",
              content: "export function MenuSearch() { return <main>Menu search</main>; }"
            }
          ],
          verificationEvidence: {
            expectedScripts: ["test"],
            commands: ["npm test"],
            summary: "Menu search output includes a runnable package test script."
          }
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class UnverifiedCodeRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed with unverified code.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          files: [{ path: "src/unverified.ts", content: "export const value = 1;" }],
          verificationEvidence: {
            commands: ["npm test"],
            expectedScripts: ["test"],
            summary: "Worker expected npm test to run, but did not provide package scripts."
          }
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class GeneratedPackageRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed with a generated package.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          files: [
            {
              path: "package.json",
              content: JSON.stringify({ scripts: { test: "node verify-env.js" } })
            },
            {
              path: "verify-env.js",
              content:
                "const secret = process.env.FORGEOS_FAKE_HOST_SECRET;\n" +
                "console.log(secret ? `secret:${secret}` : 'secret:missing');\n" +
                "process.exit(secret ? 1 : 0);\n"
            }
          ],
          verificationEvidence: {
            commands: ["npm test"],
            expectedScripts: ["test"],
            summary: "Generated package includes a test script that proves host secrets are not visible.",
            knownGaps: []
          }
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class PackageUsingExistingWorkspaceFileRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed with a package check that reads an existing workspace file.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          files: [
            {
              path: "package.json",
              content: JSON.stringify({ scripts: { test: "node verify-existing.js" } })
            }
          ]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class AcceptanceRepairRuntime implements AgentRuntime {
  attempts = 0;

  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    this.attempts += 1;
    const buildScript =
      this.attempts === 1
        ? `${process.execPath} -e "console.error('acceptance build failed'); process.exit(1)"`
        : `${process.execPath} -e "console.log('acceptance build passed')"`;
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed with an acceptance package.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          files: [
            {
              path: "package.json",
              content: JSON.stringify({
                scripts: {
                  test: `${process.execPath} -e "console.log('acceptance test passed')"`,
                  build: buildScript
                }
              })
            },
            {
              path: "src/index.js",
              content: "console.log('app');"
            }
          ]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class AcceptanceFailureRuntime implements AgentRuntime {
  attempts = 0;

  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    this.attempts += 1;
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed with a failing acceptance package.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          files: [
            {
              path: "package.json",
              content: JSON.stringify({
                scripts: {
                  test: `${process.execPath} -e "console.error('acceptance test failed'); process.exit(1)"`
                }
              })
            },
            {
              path: "src/index.js",
              content: "console.log('app');"
            }
          ]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class TargetedHandoffRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed targeted handoff run.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs:
          input.operationId === "op-runtime"
            ? {
                artifacts: [{ title: "Runtime Handoff Notes", type: "handoff_notes", content: "Runtime notes for QA.", tags: ["runtime"] }],
                files: [{ path: "notes/runtime-handoff.md", content: "# Runtime Handoff\n\nQA should validate this." }],
                handoffs: [
                  {
                    toDivisionId: "qa",
                    targetOperationId: "op-tests",
                    summary: "Runtime output is ready for QA.",
                    deliverables: ["Runtime Handoff Notes"],
                    requiredContext: ["Use notes/runtime-handoff.md"],
                    confidence: 91
                  }
                ]
              }
            : {}
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class InvalidTargetHandoffRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed with invalid targeted handoff.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          handoffs: [{ toDivisionId: "qa", targetOperationId: "missing-operation", summary: "Invalid target handoff" }]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class ExplicitContextHandoffRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider completed explicit context handoff run.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          artifacts: [{ title: "New Runtime Note", type: "note", content: "New note should not be attached to explicit handoff." }],
          files: [{ path: "notes/new-runtime-note.md", content: "# New note" }],
          handoffs: [
            {
              toDivisionId: "qa",
              targetOperationId: "op-tests",
              summary: "Use explicitly declared existing context.",
              artifactIds: ["artifact-strategy"],
              fileIds: ["file-plan"],
              confidence: 88
            }
          ]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class ExistingFileUpdateRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider updated an existing file.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          files: [
            {
              path: "docs/project-plan.md",
              content: "# Updated Project Plan\n"
            }
          ]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class FilePatchRuntime implements AgentRuntime {
  constructor(private readonly filePatches: Array<{ path: string; find: string; replace: string }>) {}

  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider patched files.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          artifacts: [{ title: "Patch Summary", type: "implementation_note", content: "Patched existing virtual files." }],
          filePatches: this.filePatches
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class VerificationEvidenceBlockerPatchRuntime extends FilePatchRuntime {
  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider patched files but deferred verification evidence to ForgeOS.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          artifacts: [{ title: "Patch Summary", type: "implementation_note", content: "Patched existing virtual files." }],
          filePatches: [
            {
              path: "docs/project-plan.md",
              find: "ForgeOS command center, runtime, and release pipeline.",
              replace: "ForgeOS command center, runtime, launcher patching, and release pipeline."
            }
          ],
          blockers: [
            {
              reason:
                "No executable sandbox verification results were provided in the bounded runtime context, so I cannot truthfully claim rerun evidence; QA must execute npm run typecheck, npm run lint, npm run build, npm run smoke, and npm run acceptance after the config repairs.",
              severity: "warning"
            }
          ]
        }
      }
    };
  }
}

class DangerousActionRuntime implements AgentRuntime {
  constructor(private readonly command: string) {}

  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider requested gated shell access.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          dangerousActions: [
            {
              action: "run shell command",
              reason: "Provider wants to perform a destructive runtime-owned verification step.",
              command: this.command
            }
          ],
          requestedActions: [
            {
              action: "external network request",
              reason: "Provider wants to call a deployment endpoint."
            }
          ]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class WorkerQuestionRuntime implements AgentRuntime {
  constructor(private readonly needsExecutive = false) {}

  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider requested division lead input.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          questionRequests: [
            {
              question: "Can I use shared UI files outside this operation scope?",
              reason: "The scoped operation needs an existing shared component decision before editing.",
              scope: "outside_scope_files",
              options: [
                { id: "approve", label: "Approve", description: "Allow scoped use of the shared files." },
                { id: "deny", label: "Deny", description: "Keep work inside the current operation scope." }
              ],
              needsExecutive: this.needsExecutive,
              recommendedDefault: "Approve read-only inspection and require another question before edits."
            }
          ]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class DiagnosticLogQuestionRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider requested diagnostic logs from the operator.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          questionRequests: [
            {
              question: "Please provide the failing launcher or verification log tail for the Chrome extension runtime check.",
              reason: "I need the exact error code before patching the scaffold.",
              needsExecutive: true,
              options: [{ id: "provide_logs", label: "Provide logs" }]
            }
          ]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class ImplementationHelpQuestionRuntime implements AgentRuntime {
  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider requested implementation help from the lead.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          questionRequests: [
            {
              question: "Can the division lead debug this implementation and tell me what to try next?",
              reason: "I am not sure how to fix the TypeScript failure.",
              options: [{ id: "debug", label: "Debug it" }]
            }
          ]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class SelfRepairingImplementationHelpRuntime implements AgentRuntime {
  private attempts = 0;

  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    this.attempts += 1;
    if (this.attempts === 1) {
      yield {
        forgeId: input.forgeId,
        type: "run.completed",
        actorType: "runtime",
        targetType: "run",
        message: "Provider requested implementation help from the lead.",
        severity: "success",
        payload: {
          operationId: input.operationId,
          outputs: {
            questionRequests: [
              {
                question: "Can the lead debug this failing implementation?",
                reason: "I need help deciding what code to change next."
              }
            ]
          }
        }
      };
      return;
    }

    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider self-repaired and completed independently.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          artifacts: [{ title: "Independent fix", type: "report", content: "Solved without lead implementation help." }]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

class DependencyRequestRuntime implements AgentRuntime {
  constructor(
    private readonly request: Record<string, unknown>,
    private readonly packageJson?: Record<string, unknown>
  ) {}

  provider() {
    return "mock" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: false,
      supportsRetries: true,
      supportsWorkspaceRefs: true,
      supportsWebSearch: false
    };
  }

  async *runOperation(input: RunOperationInput): AsyncIterable<RuntimeEventDraft> {
    yield {
      forgeId: input.forgeId,
      type: "run.completed",
      actorType: "runtime",
      targetType: "run",
      message: "Provider requested dependency review.",
      severity: "success",
      payload: {
        operationId: input.operationId,
        outputs: {
          artifacts: [{ title: "Dependency request", type: "implementation_note", content: "Requested package review." }],
          files: this.packageJson ? [{ path: "package.json", content: JSON.stringify(this.packageJson, null, 2) }] : [],
          dependencyRequests: [this.request]
        }
      }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}

const originalTokenSecret = process.env.FORGEOS_TOKEN_SECRET;
const originalAgentProvider = process.env.FORGEOS_AGENT_PROVIDER;
const originalExecutiveAutopilot = process.env.FORGEOS_EXECUTIVE_AUTOPILOT;
const originalAgentMaxConcurrentRuns = process.env.FORGEOS_AGENT_MAX_CONCURRENT_RUNS;
const originalExecutionWorkspaceRoot = process.env.FORGEOS_EXECUTION_WORKSPACE_ROOT;
const originalLauncherWorkspaceRoot = process.env.FORGEOS_LAUNCHER_WORKSPACE_ROOT;
const originalDeleteLauncherWorkspaces = process.env.FORGEOS_DELETE_LAUNCHER_WORKSPACES;
const originalFakeHostSecret = process.env.FORGEOS_FAKE_HOST_SECRET;
let tempDirs: string[] = [];

describe("runtimeStore", () => {
  beforeEach(() => {
    process.env.FORGEOS_AGENT_PROVIDER = "mock";
    delete process.env.FORGEOS_EXECUTIVE_AUTOPILOT;
    delete process.env.FORGEOS_AGENT_MAX_CONCURRENT_RUNS;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs = [];
    if (originalTokenSecret) {
      process.env.FORGEOS_TOKEN_SECRET = originalTokenSecret;
    } else {
      delete process.env.FORGEOS_TOKEN_SECRET;
    }
    if (originalAgentProvider) {
      process.env.FORGEOS_AGENT_PROVIDER = originalAgentProvider;
    } else {
      delete process.env.FORGEOS_AGENT_PROVIDER;
    }
    if (originalExecutiveAutopilot) {
      process.env.FORGEOS_EXECUTIVE_AUTOPILOT = originalExecutiveAutopilot;
    } else {
      delete process.env.FORGEOS_EXECUTIVE_AUTOPILOT;
    }
    if (originalAgentMaxConcurrentRuns) {
      process.env.FORGEOS_AGENT_MAX_CONCURRENT_RUNS = originalAgentMaxConcurrentRuns;
    } else {
      delete process.env.FORGEOS_AGENT_MAX_CONCURRENT_RUNS;
    }
    if (originalExecutionWorkspaceRoot) {
      process.env.FORGEOS_EXECUTION_WORKSPACE_ROOT = originalExecutionWorkspaceRoot;
    } else {
      delete process.env.FORGEOS_EXECUTION_WORKSPACE_ROOT;
    }
    if (originalLauncherWorkspaceRoot) {
      process.env.FORGEOS_LAUNCHER_WORKSPACE_ROOT = originalLauncherWorkspaceRoot;
    } else {
      delete process.env.FORGEOS_LAUNCHER_WORKSPACE_ROOT;
    }
    if (originalDeleteLauncherWorkspaces) {
      process.env.FORGEOS_DELETE_LAUNCHER_WORKSPACES = originalDeleteLauncherWorkspaces;
    } else {
      delete process.env.FORGEOS_DELETE_LAUNCHER_WORKSPACES;
    }
    if (originalFakeHostSecret) {
      process.env.FORGEOS_FAKE_HOST_SECRET = originalFakeHostSecret;
    } else {
      delete process.env.FORGEOS_FAKE_HOST_SECRET;
    }
  });

  it("creates isolated Forges from names with generated slugs", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence());

    const first = await runtimeStore.createForge({ name: "Alpha Forge" });
    const second = await runtimeStore.createForge({ name: "Beta Forge" });
    const firstSnapshot = await runtimeStore.getSnapshot(first.slug);
    const secondSnapshot = await runtimeStore.getSnapshot(second.slug);

    expect(first).toMatchObject({ slug: "alpha-forge", name: "Alpha Forge" });
    expect(second).toMatchObject({ slug: "beta-forge", name: "Beta Forge" });
    expect(firstSnapshot.forge.id).not.toBe(secondSnapshot.forge.id);
    expect(firstSnapshot.divisions.map((division) => division.name)).toEqual([
      "Strategy Division",
      "Operations Division",
      "Engineering Division",
      "Presentation Division",
      "QA Division",
      "Release Division"
    ]);
    expect(firstSnapshot.workers).toHaveLength(11);
    expect(firstSnapshot.divisions.every((division) => division.status === "idle" && division.progress === 0)).toBe(true);
    expect(firstSnapshot.workers.every((worker) => worker.status === "idle")).toBe(true);
    expect(firstSnapshot.operations).toEqual([]);
    expect(secondSnapshot.operations).toEqual([]);
  });

  it("rejects duplicate Forge slugs", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence());

    await runtimeStore.createForge({ name: "Alpha Forge" });

    await expect(runtimeStore.createForge({ name: "Alpha   Forge!" })).rejects.toMatchObject({
      status: 409,
      message: "A Forge with this slug already exists."
    });
  });

  it("isolates commands, resets, and idempotency keys per Forge", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence());
    const alpha = await runtimeStore.createForge({ name: "Scoped Alpha", template: "demo" });
    const beta = await runtimeStore.createForge({ name: "Scoped Beta", template: "demo" });
    const alphaRuntime = (await runtimeStore.getSnapshot(alpha.slug)).operations.find((operation) => operation.title === "Implement runtime contracts")!;
    const betaRuntime = (await runtimeStore.getSnapshot(beta.slug)).operations.find((operation) => operation.title === "Implement runtime contracts")!;

    await runtimeStore.dispatch(alpha.slug, { type: "run_operation", operationId: alphaRuntime.id, idempotencyKey: "same-key" });
    const betaAfterSameKey = await runtimeStore.dispatch(beta.slug, { type: "run_operation", operationId: betaRuntime.id, idempotencyKey: "same-key" });
    const betaCompleted = await waitForOperationStatus(runtimeStore, beta.slug, betaRuntime.id, "completed");
    await runtimeStore.dispatch(alpha.slug, {
      type: "connect_repository",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "main",
      idempotencyKey: "connect-alpha"
    });
    const resetBeta = await runtimeStore.dispatch(beta.slug, { type: "reset_demo_state", idempotencyKey: "reset-beta" });
    const alphaSnapshot = await runtimeStore.getSnapshot(alpha.slug);

    expect(betaAfterSameKey.operations.find((operation) => operation.id === betaRuntime.id)?.status).toBe("running");
    expect(betaCompleted.operations.find((operation) => operation.id === betaRuntime.id)?.status).toBe("completed");
    expect(alphaSnapshot.repository?.repo).toBe("ForgeOS");
    expect(resetBeta.repository).toBeUndefined();
    expect(alphaSnapshot.repository).toBeDefined();
  });

  it("clears memory-backed development storage", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence());
    await runtimeStore.createForge({ name: "Memory Forge" });

    await expect(runtimeStore.clearLocalForges()).resolves.toBeUndefined();
    await expect(runtimeStore.listForges()).resolves.toHaveLength(0);
  });

  it("does not clear database-backed development storage without an explicit opt-in", async () => {
    const persistence = new InMemoryRuntimePersistence();
    Object.defineProperty(persistence, "mode", { value: "database" });
    const runtimeStore = new RuntimeStore(persistence);
    await runtimeStore.createForge({ name: "Database Safe Forge" });

    expect(runtimeStore.getStorageInfo()).toMatchObject({ mode: "database", resettable: false });
    await expect(runtimeStore.clearLocalForges()).rejects.toMatchObject({
      status: 403,
      message: "Forge storage reset is available only in development storage modes that support clearing."
    });
    await expect(runtimeStore.listForges()).resolves.toHaveLength(1);
  });

  it("deletes selected Forges without clearing the rest", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence());
    const alpha = await runtimeStore.createForge({ name: "Delete Alpha" });
    const beta = await runtimeStore.createForge({ name: "Delete Beta" });
    const keep = await runtimeStore.createForge({ name: "Keep Gamma" });

    const result = await runtimeStore.deleteForges({ slugs: [alpha.slug, beta.slug] });

    expect(result.deletedSlugs).toEqual([alpha.slug, beta.slug]);
    expect(result.forges.map((forge) => forge.slug)).toEqual([keep.slug]);
    await expect(runtimeStore.getSnapshot(alpha.slug)).rejects.toMatchObject({ status: 404 });
    await expect(runtimeStore.getSnapshot(keep.slug)).resolves.toMatchObject({ forge: { slug: keep.slug } });
  });

  it("deletes selected Forge execution workspaces without removing launcher assets by default", async () => {
    const executionRoot = await createTempDir();
    const launcherRoot = await createTempDir();
    process.env.FORGEOS_EXECUTION_WORKSPACE_ROOT = executionRoot;
    process.env.FORGEOS_LAUNCHER_WORKSPACE_ROOT = launcherRoot;
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence());
    const deleted = await runtimeStore.createForge({ name: "Workspace Delete Forge" });
    const kept = await runtimeStore.createForge({ name: "Workspace Keep Forge" });
    const deletedSnapshot = await runtimeStore.getSnapshot(deleted.slug);
    const keptSnapshot = await runtimeStore.getSnapshot(kept.slug);
    const deletedExecutionDir = path.join(executionRoot, deletedSnapshot.forge.id);
    const legacyDeletedExecutionDir = path.join(executionRoot, deletedSnapshot.forge.slug);
    const deletedLauncherDir = path.join(launcherRoot, deletedSnapshot.forge.slug);
    const keptExecutionDir = path.join(executionRoot, keptSnapshot.forge.id);
    const keptLauncherDir = path.join(launcherRoot, keptSnapshot.forge.slug);

    await Promise.all([deletedExecutionDir, legacyDeletedExecutionDir, deletedLauncherDir, keptExecutionDir, keptLauncherDir].map((dir) => mkdir(dir, { recursive: true })));

    const result = await runtimeStore.deleteForges({ slugs: [deleted.slug] });

    expect(result.deletedSlugs).toEqual([deleted.slug]);
    expect(result.workspaceCleanup.failedPaths).toEqual([]);
    await expect(access(deletedExecutionDir)).rejects.toThrow();
    await expect(access(legacyDeletedExecutionDir)).rejects.toThrow();
    await expect(access(deletedLauncherDir)).resolves.toBeUndefined();
    await expect(access(keptExecutionDir)).resolves.toBeUndefined();
    await expect(access(keptLauncherDir)).resolves.toBeUndefined();
  });

  it("deletes selected Forge launcher workspaces when launcher cleanup is explicitly enabled", async () => {
    const executionRoot = await createTempDir();
    const launcherRoot = await createTempDir();
    process.env.FORGEOS_EXECUTION_WORKSPACE_ROOT = executionRoot;
    process.env.FORGEOS_LAUNCHER_WORKSPACE_ROOT = launcherRoot;
    process.env.FORGEOS_DELETE_LAUNCHER_WORKSPACES = "1";
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence());
    const forge = await runtimeStore.createForge({ name: "Launcher Delete Forge" });
    const snapshot = await runtimeStore.getSnapshot(forge.slug);
    const launcherDir = path.join(launcherRoot, snapshot.forge.slug);

    await mkdir(launcherDir, { recursive: true });
    await runtimeStore.deleteForges({ slugs: [forge.slug] });

    await expect(access(launcherDir)).rejects.toThrow();
  });

  it("recreates a deleted Forge with the same slug as a fresh workspace identity", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence());
    const first = await runtimeStore.createForge({ name: "Reusable Forge" });
    const firstSnapshot = await runtimeStore.dispatch(first.slug, {
      type: "operator_message",
      message: "Create a disposable plan.",
      idempotencyKey: "first-disposable-plan"
    });

    await runtimeStore.deleteForges({ slugs: [first.slug] });
    const second = await runtimeStore.createForge({ name: "Reusable Forge" });
    const secondSnapshot = await runtimeStore.getSnapshot(second.slug);

    expect(second.slug).toBe(first.slug);
    expect(second.id).not.toBe(first.id);
    expect(secondSnapshot.forge.id).not.toBe(firstSnapshot.forge.id);
    expect(secondSnapshot.operations).toHaveLength(0);
    expect(secondSnapshot.proposals).toHaveLength(0);
    expect(secondSnapshot.messages).toHaveLength(0);
  });

  it("stores GitHub OAuth tokens outside snapshots and syncs repository files per Forge", async () => {
    process.env.FORGEOS_TOKEN_SECRET = "test-secret";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ tree: [{ path: "README.md", type: "blob", size: 10 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("# Synced\n", { status: 200 }));
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence());
    const alpha = await runtimeStore.createForge({ name: "GitHub Alpha" });
    const beta = await runtimeStore.createForge({ name: "GitHub Beta" });

    await runtimeStore.connectGitHubAccount(alpha.slug, {
      accountLogin: "octocat",
      accountId: "123",
      scopes: ["repo", "read:user"],
      tokenType: "bearer",
      encryptedAccessToken: encryptSecret("gho_secret")
    });
    const snapshot = await runtimeStore.syncGitHubRepository(alpha.slug, { owner: "BottoGrotto", repo: "ForgeOS", ref: "main" });
    const betaSnapshot = await runtimeStore.getSnapshot(beta.slug);

    expect(snapshot.repository).toMatchObject({ owner: "BottoGrotto", repo: "ForgeOS", syncStatus: "completed", syncedFileCount: 1 });
    expect(snapshot.files.find((file) => file.path === "repo/README.md")?.content).toBe("# Synced\n");
    expect(JSON.stringify(snapshot)).not.toContain("gho_secret");
    expect(betaSnapshot.repository).toBeUndefined();
    expect(betaSnapshot.files.some((file) => file.path === "repo/README.md")).toBe(false);
  });

  it("appends ordered events and refreshes snapshot after a runtime command", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset" });
    const before = (await runtimeStore.getSnapshot("demo")).lastEventSequence;
    const snapshot = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "test-op-runtime" });

    expect(snapshot.lastEventSequence).toBeGreaterThan(before);
    expect(snapshot.events.at(-1)?.sequence).toBe(snapshot.lastEventSequence);
  });

  it("deduplicates commands with the same idempotency key", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-2" });
    const first = await runtimeStore.dispatch("demo", { type: "operator_message", message: "Status?", idempotencyKey: "same-key" });
    const second = await runtimeStore.dispatch("demo", { type: "operator_message", message: "Status?", idempotencyKey: "same-key" });

    expect(second.lastEventSequence).toBe(first.lastEventSequence);
  });

  it("stores validated Executive operation proposals without mutating operations before approval", async () => {
    const provider = new ProposalProvider({
      summary: "Route QA validation behind runtime contracts.",
      actions: [
        {
          type: "create_operation",
          title: "Validate runtime contract proposal",
          description: "QA should validate the runtime contract after engineering completes implementation.",
          divisionId: "qa",
          workerId: "qa-runner-alpha",
          priority: "high"
        },
        {
          type: "update_operation",
          operationId: "op-runtime",
          priority: "critical"
        },
        {
          type: "create_handoff",
          fromDivisionId: "engineering",
          toDivisionId: "qa",
          targetOperationId: "op-tests",
          summary: "Engineering runtime work should feed QA validation.",
          deliverables: ["Runtime contract summary"],
          requiredContext: ["Read operation op-runtime"],
          confidence: 82
        },
        {
          type: "create_blocker",
          operationId: "op-tests",
          reason: "QA validation waits for runtime contract completion.",
          severity: "warning"
        }
      ]
    });
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), undefined, provider);
    const before = await runtimeStore.getSnapshot("demo");

    const snapshot = await runtimeStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Route QA behind runtime contracts.",
      idempotencyKey: "proposal-create"
    });

    expect(snapshot.operations).toEqual(before.operations);
    expect(snapshot.handoffs).toEqual(before.handoffs);
    expect(snapshot.proposals).toHaveLength(1);
    expect(snapshot.proposals[0]).toMatchObject({
      status: "pending",
      summary: "Route QA validation behind runtime contracts.",
      provider: "mock",
      actions: expect.arrayContaining([
        expect.objectContaining({ type: "create_operation", title: "Validate runtime contract proposal" }),
        expect.objectContaining({ type: "update_operation", operationId: "op-runtime", priority: "critical" })
      ])
    });
    expect(snapshot.messages.map((message) => message.kind)).toEqual(expect.arrayContaining(["operator_prompt", "executive_reply"]));
    expect(snapshot.events.map((event) => event.type)).toEqual(expect.arrayContaining(["executive.proposal_created"]));
  });

  it("lets Executive proposal commands read large prompts from workspace files", async () => {
    let providerMessage = "";
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      new MockRuntime(),
      new ProposalProvider((input) => {
        providerMessage = input.message;
        return {
          summary: "Read workspace instructions.",
          actions: []
        };
      })
    );
    await runtimeStore.upsertVirtualFile("demo", {
      path: "instructions.md",
      content: "# Review Brief\n\nSummarize meal planning notes with offline support considerations."
    });

    const snapshot = await runtimeStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Use the attached brief.",
      promptFilePath: "instructions.md",
      idempotencyKey: "proposal-from-file"
    });

    expect(providerMessage).toContain("Use the attached brief.");
    expect(providerMessage).toContain("Attached workspace prompt file: instructions.md");
    expect(providerMessage).toContain("Summarize meal planning notes with offline support considerations.");
    expect(snapshot.proposals[0]).toMatchObject({ summary: "Read workspace instructions.", status: "pending" });
  });

  it("lets Executive revise a pending proposal with operator-provided source links", async () => {
    const persistence = new InMemoryRuntimePersistence(createEmptyForgeSnapshot({ id: "forge-revise", slug: "revise", name: "Revise Forge", prefixEntityIds: true }));
    const firstStore = new RuntimeStore(
      persistence,
      undefined,
      new ProposalProvider({
        summary: "Build a field operations dashboard.",
        actions: [
          {
            type: "create_operation",
            title: "Build field operations dashboard",
            description: "Create a mobile-first website for tracking field service work.",
            divisionId: "revise-engineering",
            workerId: "revise-frontend-worker",
            priority: "high",
            status: "ready"
          }
        ]
      })
    );
    const first = await firstStore.dispatch("revise", {
      type: "propose_operation_changes",
      message: "Build the field service tracking site.",
      idempotencyKey: "revise-first"
    });
    const originalProposalId = first.proposals[0].id;

    const secondStore = new RuntimeStore(
      persistence,
      undefined,
      new ProposalProvider((input) => ({
        summary: "Build a field operations dashboard using the supplied source endpoint.",
        supersedesProposalIds: [input.snapshot.proposals.find((proposal) => proposal.status === "pending")!.id],
        actions: [
          {
            type: "create_operation",
            title: "Build field operations dashboard",
            description: "Create a mobile-first website for tracking field service work. Use https://example.com/source-feed as the source endpoint.",
            divisionId: "revise-engineering",
            workerId: "revise-frontend-worker",
            priority: "high",
            status: "ready"
          }
        ]
      }))
    );
    const revised = await secondStore.dispatch("revise", {
      type: "propose_operation_changes",
      message: "Use https://example.com/source-feed as the source.",
      idempotencyKey: "revise-second"
    });

    expect(revised.proposals.find((proposal) => proposal.id === originalProposalId)).toMatchObject({ status: "superseded" });
    expect(revised.proposals.filter((proposal) => proposal.status === "pending")).toHaveLength(1);
    expect(revised.proposals.find((proposal) => proposal.status === "pending")).toMatchObject({
      supersedesProposalIds: [originalProposalId],
      actions: [
        expect.objectContaining({
          description: expect.stringContaining("https://example.com/source-feed")
        })
      ]
    });
    expect(revised.events.map((event) => event.type)).toEqual(expect.arrayContaining(["executive.proposal_created", "executive.proposal_superseded"]));
  });

  it("applies approved Executive proposals into operations, handoffs, blockers, and audit events", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      undefined,
      new ProposalProvider({
        summary: "Route QA validation behind runtime contracts.",
        actions: [
          {
            type: "create_operation",
            title: "Validate runtime contract proposal",
            description: "QA should validate the runtime contract after engineering completes implementation.",
            divisionId: "qa",
            workerId: "qa-runner-alpha",
            priority: "high"
          },
          {
            type: "update_operation",
            operationId: "op-runtime",
            priority: "critical"
          },
          {
            type: "create_handoff",
            fromDivisionId: "engineering",
            toDivisionId: "qa",
            targetOperationId: "op-tests",
            summary: "Engineering runtime work should feed QA validation."
          },
          {
            type: "create_blocker",
            operationId: "op-tests",
            reason: "QA validation waits for runtime contract completion.",
            severity: "warning"
          }
        ]
      })
    );
    const proposed = await runtimeStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Route QA behind runtime contracts.",
      idempotencyKey: "proposal-apply-create"
    });
    const proposalId = proposed.proposals[0].id;

    const applied = await runtimeStore.dispatch("demo", {
      type: "apply_operation_proposal",
      proposalId,
      idempotencyKey: "proposal-apply"
    });

    expect(applied.proposals.find((proposal) => proposal.id === proposalId)).toMatchObject({ status: "applied" });
    expect(applied.operations.find((operation) => operation.title === "Validate runtime contract proposal")).toMatchObject({
      divisionId: "qa",
      workerId: "qa-runner-alpha",
      priority: "high",
      status: "planning"
    });
    expect(applied.operations.find((operation) => operation.id === "op-runtime")?.priority).toBe("critical");
    expect(applied.operations.find((operation) => operation.id === "op-tests")).toMatchObject({
      status: "blocked",
      blockedReason: "QA validation waits for runtime contract completion."
    });
    expect(applied.handoffs.some((handoff) => handoff.summary === "Engineering runtime work should feed QA validation.")).toBe(true);
    expect(applied.events.map((event) => event.type)).toEqual(expect.arrayContaining(["operation.created", "operation.blocked", "handoff.created", "executive.proposal_applied"]));
  });

  it("resolves unique truncated operation ids in Executive proposals before approval", async () => {
    const baseSnapshot = createDemoSnapshot();
    const longOperationId = "random-chrome-extension-op-repair-verification-failure-for-validate-the-implemented-extension-for-correctne-1779824877485";
    const snapshot = {
      ...baseSnapshot,
      operations: [
        ...baseSnapshot.operations,
        {
          ...baseSnapshot.operations.find((operation) => operation.id === "op-runtime")!,
          id: longOperationId,
          title: "Repair verification failure for Validate the implemented extension for correctness",
          description: "Repair failed runtime verification for the Chrome extension.",
          divisionId: "engineering",
          status: "blocked" as const,
          blockedReason: "Runtime verification failed.",
          progress: 90
        }
      ]
    };
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(snapshot),
      undefined,
      new ProposalProvider({
        summary: "Unblock the existing repair operation.",
        actions: [
          {
            type: "update_operation",
            operationId: longOperationId.slice(0, -1),
            title: "Repair verification failure for Validate the implemented extension for correctness",
            divisionId: "engineering",
            status: "ready"
          }
        ]
      })
    );

    const proposed = await runtimeStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Update the stale repair operation reference.",
      idempotencyKey: "proposal-truncated-operation-id"
    });
    const applied = await runtimeStore.dispatch("demo", {
      type: "apply_operation_proposal",
      proposalId: proposed.proposals[0].id,
      idempotencyKey: "proposal-truncated-operation-id-apply"
    });

    expect(applied.operations.find((operation) => operation.id === longOperationId)).toMatchObject({
      status: "ready",
      blockedReason: undefined
    });
    expect(applied.events.find((event) => event.type === "executive.proposal_applied" && event.payload.proposalId === proposed.proposals[0].id)).toBeDefined();
  });

  it("lets approved Executive proposals delete inactive duplicate operations and clean links", async () => {
    const baseSnapshot = createDemoSnapshot();
    const duplicate = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-runtime")!,
      id: "duplicate-runtime",
      title: "Duplicate runtime cleanup task",
      description: "Duplicate blocked operation that should be removed from the operations board.",
      status: "blocked" as const,
      blockedReason: "Duplicate of existing runtime work.",
      progress: 0,
      outputArtifactIds: []
    };
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence({
        ...baseSnapshot,
        operations: [...baseSnapshot.operations, duplicate],
        dependencies: [
          ...baseSnapshot.dependencies,
          { id: "dep-duplicate-qa", operationId: "op-tests", dependsOnOperationId: "duplicate-runtime", type: "blocks" as const }
        ],
        handoffs: [
          ...baseSnapshot.handoffs,
          {
            id: "handoff-duplicate",
            fromDivisionId: "engineering",
            toDivisionId: "qa",
            fromOperationId: "duplicate-runtime",
            targetOperationId: "op-tests",
            summary: "Duplicate handoff",
            deliverables: [],
            blockers: [],
            requiredContext: [],
            artifactIds: [],
            fileIds: [],
            status: "open",
            confidence: 50,
            createdAt: new Date().toISOString()
          }
        ]
      }),
      undefined,
      new ProposalProvider({
        summary: "Clean duplicate operations.",
        actions: [{ type: "delete_operation", operationId: "duplicate-runtime", reason: "Duplicate blocked operation superseded by op-runtime." }]
      })
    );

    const proposed = await runtimeStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Remove duplicate operations.",
      idempotencyKey: "delete-operation-proposal"
    });
    const applied = await runtimeStore.dispatch("demo", {
      type: "apply_operation_proposal",
      proposalId: proposed.proposals[0].id,
      idempotencyKey: "delete-operation-apply"
    });

    expect(applied.operations.some((operation) => operation.id === "duplicate-runtime")).toBe(false);
    expect(applied.dependencies.some((dependency) => dependency.dependsOnOperationId === "duplicate-runtime" || dependency.operationId === "duplicate-runtime")).toBe(false);
    expect(applied.handoffs.some((handoff) => handoff.fromOperationId === "duplicate-runtime")).toBe(false);
    expect(applied.events.find((event) => event.type === "operation.deleted" && event.targetId === "duplicate-runtime")?.payload).toMatchObject({
      proposalId: proposed.proposals[0].id,
      reason: "Duplicate blocked operation superseded by op-runtime.",
      removedDependencyIds: ["dep-duplicate-qa"],
      removedHandoffIds: ["handoff-duplicate"]
    });
  });

  it("rejects Executive proposals that try to delete completed operations", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      undefined,
      new ProposalProvider({
        summary: "Delete completed work.",
        actions: [{ type: "delete_operation", operationId: "op-strategy-plan", reason: "Clean board." }]
      })
    );

    const snapshot = await runtimeStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Delete completed work.",
      idempotencyKey: "delete-completed-proposal"
    });

    expect(snapshot.proposals).toHaveLength(0);
    expect(snapshot.operations.some((operation) => operation.id === "op-strategy-plan")).toBe(true);
    expect(snapshot.messages.at(-1)?.content).toContain("cannot delete completed operation");
  });

  it("archives delete proposals when run history references the operation", async () => {
    const baseSnapshot = createDemoSnapshot();
    const duplicate = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-runtime")!,
      id: "duplicate-with-run",
      title: "Duplicate with run history",
      status: "blocked" as const,
      blockedReason: "Duplicate operation with persisted run history.",
      outputArtifactIds: []
    };
    const snapshot = {
      ...baseSnapshot,
      operations: [...baseSnapshot.operations, duplicate],
      dependencies: [
        ...baseSnapshot.dependencies,
        { id: "dep-duplicate-with-run", operationId: "op-tests", dependsOnOperationId: "duplicate-with-run", type: "blocks" as const }
      ],
      handoffs: [
        ...baseSnapshot.handoffs,
        {
          id: "handoff-duplicate-with-run",
          fromDivisionId: "engineering",
          toDivisionId: "qa",
          fromOperationId: "duplicate-with-run",
          targetOperationId: "op-tests",
          summary: "Duplicate handoff with history",
          deliverables: [],
          blockers: [],
          requiredContext: [],
          artifactIds: [],
          fileIds: [],
          status: "open" as const,
          confidence: 50,
          createdAt: new Date().toISOString()
        }
      ],
      runs: [
        ...baseSnapshot.runs,
        {
          id: "run-duplicate-with-history",
          forgeId: baseSnapshot.forge.id,
          operationId: "duplicate-with-run",
          workerId: "backend-worker",
          provider: "mock" as const,
          status: "failed" as const,
          capabilities: new MockRuntime().capabilities(),
          queuedAt: new Date().toISOString(),
          providerMetadata: {}
        }
      ],
      messages: [
        ...baseSnapshot.messages,
        {
          id: "delete-message",
          role: "executive" as const,
          kind: "executive_reply" as const,
          source: "manual" as const,
          content: "Prepared proposal: Delete duplicate with run history.",
          status: "proposal_pending" as const,
          createdAt: new Date().toISOString()
        }
      ],
      proposals: [
        ...baseSnapshot.proposals,
        {
          id: "proposal-delete-with-run",
          status: "pending" as const,
          sourceMessageId: "delete-message",
          provider: "mock" as const,
          summary: "Delete duplicate with run history.",
          actions: [{ type: "delete_operation" as const, operationId: "duplicate-with-run", reason: "Clean duplicate." }],
          createdAt: new Date().toISOString()
        }
      ]
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new MockRuntime());

    const applied = await runtimeStore.dispatch("demo", {
      type: "apply_operation_proposal",
      proposalId: "proposal-delete-with-run",
      idempotencyKey: "delete-with-run-apply"
    });

    const archived = applied.operations.find((operation) => operation.id === "duplicate-with-run");
    expect(archived).toMatchObject({
      status: "archived",
      routingStage: "done",
      blockedReason: "Archived by Executive cleanup: Clean duplicate."
    });
    expect(applied.runs.some((run) => run.operationId === "duplicate-with-run")).toBe(true);
    expect(applied.dependencies.some((dependency) => dependency.dependsOnOperationId === "duplicate-with-run" || dependency.operationId === "duplicate-with-run")).toBe(false);
    expect(applied.handoffs.some((handoff) => handoff.fromOperationId === "duplicate-with-run")).toBe(false);
    expect(applied.events.find((event) => event.type === "operation.archived" && event.targetId === "duplicate-with-run")?.payload).toMatchObject({
      proposalId: "proposal-delete-with-run",
      reason: "Clean duplicate.",
      removedDependencyIds: ["dep-duplicate-with-run"],
      removedHandoffIds: ["handoff-duplicate-with-run"]
    });
  });

  it("treats delete proposals for already archived operations as idempotent cleanup", async () => {
    const baseSnapshot = createDemoSnapshot();
    const archivedOperation = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-runtime")!,
      id: "already-archived-duplicate",
      title: "Already archived duplicate",
      status: "archived" as const,
      routingStage: "done" as const,
      blockedReason: "Archived by Executive cleanup: duplicate work.",
      outputArtifactIds: []
    };
    const snapshot = {
      ...baseSnapshot,
      operations: [...baseSnapshot.operations, archivedOperation],
      dependencies: [
        ...baseSnapshot.dependencies,
        { id: "dep-already-archived", operationId: "op-tests", dependsOnOperationId: "already-archived-duplicate", type: "blocks" as const }
      ],
      messages: [
        ...baseSnapshot.messages,
        {
          id: "delete-archived-message",
          role: "executive" as const,
          kind: "executive_reply" as const,
          source: "manual" as const,
          content: "Prepared proposal: Delete already archived duplicate.",
          status: "proposal_pending" as const,
          createdAt: new Date().toISOString()
        }
      ],
      proposals: [
        ...baseSnapshot.proposals,
        {
          id: "proposal-delete-archived",
          status: "pending" as const,
          sourceMessageId: "delete-archived-message",
          provider: "mock" as const,
          summary: "Delete already archived duplicate.",
          actions: [{ type: "delete_operation" as const, operationId: "already-archived-duplicate", reason: "Clean duplicate again." }],
          createdAt: new Date().toISOString()
        }
      ]
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new MockRuntime());

    const applied = await runtimeStore.dispatch("demo", {
      type: "apply_operation_proposal",
      proposalId: "proposal-delete-archived",
      idempotencyKey: "delete-archived-apply"
    });

    expect(applied.proposals.find((proposal) => proposal.id === "proposal-delete-archived")?.status).toBe("applied");
    expect(applied.operations.find((operation) => operation.id === "already-archived-duplicate")).toMatchObject({
      status: "archived",
      blockedReason: "Archived by Executive cleanup: duplicate work."
    });
    expect(applied.dependencies.some((dependency) => dependency.dependsOnOperationId === "already-archived-duplicate" || dependency.operationId === "already-archived-duplicate")).toBe(false);
    expect(applied.events.find((event) => event.type === "operation.archived" && event.targetId === "already-archived-duplicate")?.payload).toMatchObject({
      proposalId: "proposal-delete-archived",
      alreadyArchived: true,
      removedDependencyIds: ["dep-already-archived"]
    });
  });

  it("applies same-proposal operation dependencies and gates QA until upstream files exist", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      new FileOnlyRuntime(),
      new ProposalProvider({
        summary: "Build menu search before QA.",
        actions: [
          {
            type: "create_operation",
            operationKey: "build_menu_search",
            title: "Build menu search app",
            description: "Create concrete app source files for the menu search experience.",
            divisionId: "engineering",
            workerId: "backend-worker",
            priority: "critical",
            status: "ready",
            routingStage: "worker_ready"
          },
          {
            type: "create_operation",
            operationKey: "qa_menu_search",
            title: "QA validate menu search app",
            description: "Validate generated menu search files after implementation is complete.",
            divisionId: "qa",
            workerId: "qa-runner-alpha",
            priority: "high",
            status: "blocked",
            routingStage: "worker_ready",
            dependsOnOperationKeys: ["build_menu_search"]
          }
        ]
      })
    );
    const proposed = await runtimeStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Build the app, then QA it.",
      idempotencyKey: "proposal-dependency-create"
    });
    const proposalId = proposed.proposals[0].id;

    const applied = await runtimeStore.dispatch("demo", {
      type: "apply_operation_proposal",
      proposalId,
      idempotencyKey: "proposal-dependency-apply"
    });
    const build = applied.operations.find((operation) => operation.title === "Build menu search app")!;
    const qa = applied.operations.find((operation) => operation.title === "QA validate menu search app")!;

    expect(applied.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: qa.id,
          dependsOnOperationId: build.id,
          type: "blocks"
        })
      ])
    );

    await expect(
      runtimeStore.dispatch("demo", {
        type: "run_operation",
        operationId: qa.id,
        idempotencyKey: "proposal-dependency-qa-too-early"
      })
    ).rejects.toMatchObject({
      status: 409
    });

    await runtimeStore.dispatch("demo", {
      type: "run_operation",
      operationId: build.id,
      idempotencyKey: "proposal-dependency-build-run"
    });
    const completed = await waitForOperationStatus(runtimeStore, "demo", build.id, "completed");

    expect(completed.files.some((file) => file.operationId === build.id && file.path === "app/menu-search.tsx")).toBe(true);
    expect(completed.operations.find((operation) => operation.id === qa.id)).toMatchObject({
      status: "ready",
      blockedReason: undefined
    });
  });

  it("does not unlock QA dependencies when upstream completion only produced artifacts", async () => {
    const baseSnapshot = createDemoSnapshot();
    const engineeringOperation = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-runtime")!,
      id: "op-artifact-only-build",
      title: "Build artifact-only app plan",
      description: "Implement the app plan without source files.",
      status: "completed" as const,
      outputArtifactIds: ["artifact-only-build"]
    };
    const qaOperation = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-tests")!,
      id: "op-artifact-only-qa",
      title: "QA validate artifact-only app",
      description: "Validate the generated app after implementation output exists.",
      status: "blocked" as const,
      blockedReason: "Waiting for implementation files.",
      routingStage: "worker_ready" as const
    };
    const snapshot = {
      ...baseSnapshot,
      operations: [...baseSnapshot.operations, engineeringOperation, qaOperation],
      dependencies: [
        ...baseSnapshot.dependencies,
        {
          id: "dep-artifact-only-qa",
          operationId: qaOperation.id,
          dependsOnOperationId: engineeringOperation.id,
          type: "blocks" as const
        }
      ],
      artifacts: [
        ...baseSnapshot.artifacts,
        {
          id: "artifact-only-build",
          title: "Implementation summary",
          type: "implementation_note",
          divisionId: "engineering",
          workerId: "frontend-worker",
          operationId: engineeringOperation.id,
          content: "No source files were generated.",
          status: "generated" as const,
          version: 1,
          tags: [],
          fileIds: [],
          createdAt: "2026-05-25T12:00:00.000Z",
          updatedAt: "2026-05-25T12:00:00.000Z"
        }
      ]
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new MockRuntime());

    const scheduled = await runtimeStore.dispatch("demo", {
      type: "scheduler_tick",
      idempotencyKey: "artifact-only-qa-scheduler"
    });

    expect(scheduled.operations.find((operation) => operation.id === qaOperation.id)).toMatchObject({
      status: "blocked"
    });
    expect(scheduled.runs.some((run) => run.operationId === qaOperation.id && isActiveRun(run))).toBe(false);
  });

  it("resolves provider-guessed dependency operation ids through same-proposal operation keys", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(
        createEmptyForgeSnapshot({
          id: "custom-forge",
          slug: "custom",
          name: "Custom Forge",
          prefixEntityIds: true
        })
      ),
      undefined,
      new ProposalProvider({
        summary: "Create keyed work with provider-guessed dependency ids.",
        actions: [
          {
            type: "create_operation",
            operationKey: "eng-architecture-and-schema",
            title: "Design technical architecture and data schema",
            description: "Define the MVP technical architecture and data schema.",
            divisionId: "custom-engineering",
            workerId: "custom-eng-director",
            status: "ready"
          },
          {
            type: "create_operation",
            operationKey: "eng-scraper-discovery",
            title: "Reverse engineer scraping approach",
            description: "Research the scraping approach.",
            divisionId: "custom-engineering",
            workerId: "custom-backend-worker",
            status: "ready"
          },
          {
            type: "create_operation",
            operationKey: "qa-plan",
            title: "Define MVP QA and data-accuracy validation plan",
            description: "Create a validation plan after architecture and scraping discovery.",
            divisionId: "custom-qa",
            workerId: "custom-qa-runner-alpha",
            status: "blocked",
            dependsOnOperationIds: ["custom-eng-architecture-and-schema", "custom-eng-scraper-discovery"],
            dependsOnOperationKeys: ["eng-architecture-and-schema", "eng-scraper-discovery"]
          }
        ]
      })
    );
    const proposed = await runtimeStore.dispatch("custom", {
      type: "propose_operation_changes",
      message: "Plan the project.",
      idempotencyKey: "proposal-guessed-dependency-create"
    });

    const applied = await runtimeStore.dispatch("custom", {
      type: "apply_operation_proposal",
      proposalId: proposed.proposals[0].id,
      idempotencyKey: "proposal-guessed-dependency-apply"
    });

    const qaOperation = applied.operations.find((operation) => operation.title === "Define MVP QA and data-accuracy validation plan");
    expect(qaOperation).toBeDefined();
    expect(applied.dependencies.filter((dependency) => dependency.operationId === qaOperation!.id)).toHaveLength(2);
    expect(applied.proposals.find((proposal) => proposal.id === proposed.proposals[0].id)).toMatchObject({ status: "applied" });
  });

  it("rejects Executive proposal dependencies that reference missing keys or create cycles", async () => {
    const missingKeyStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      undefined,
      new ProposalProvider({
        summary: "Create an invalid dependency.",
        actions: [
          {
            type: "create_operation",
            operationKey: "qa_missing_key",
            title: "QA validate missing dependency",
            description: "Validate after a missing operation.",
            divisionId: "qa",
            workerId: "qa-runner-alpha",
            status: "blocked",
            dependsOnOperationKeys: ["missing_build"]
          }
        ]
      })
    );
    const missingKeyProposal = await missingKeyStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Create a bad dependency.",
      idempotencyKey: "missing-key-proposal"
    });
    expect(missingKeyProposal.proposals).toHaveLength(0);
    expect(missingKeyProposal.messages.at(-1)?.content).toContain("unknown operation key");
    expect(missingKeyProposal.events.map((event) => event.type)).toEqual(expect.arrayContaining(["executive.proposal_failed"]));

    const cycleStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      undefined,
      new ProposalProvider({
        summary: "Create a cycle.",
        actions: [
          {
            type: "create_operation",
            operationKey: "first",
            title: "Implement alpha feature shell",
            description: "Create the alpha source files.",
            divisionId: "engineering",
            workerId: "backend-worker",
            status: "ready",
            dependsOnOperationKeys: ["second"]
          },
          {
            type: "create_operation",
            operationKey: "second",
            title: "Prepare beta integration scaffold",
            description: "Create the beta integration source files.",
            divisionId: "engineering",
            workerId: "eng-director",
            status: "ready",
            dependsOnOperationKeys: ["first"]
          }
        ]
      })
    );
    const cycleProposal = await cycleStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Create cyclic work.",
      idempotencyKey: "cycle-proposal"
    });
    expect(cycleProposal.proposals).toHaveLength(0);
    expect(cycleProposal.messages.at(-1)?.content).toContain("cycle");
    expect(cycleProposal.events.map((event) => event.type)).toEqual(expect.arrayContaining(["executive.proposal_failed"]));
  });

  it("auto-reassigns new operations when Executive supplies workers from another division", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      undefined,
      new ProposalProvider({
        summary: "Route division-owned work with mismatched workers.",
        actions: [
          {
            type: "create_operation",
            title: "Validate data quality risks",
            description: "QA should validate correctness, freshness, and usability before release.",
            divisionId: "qa",
            workerId: "testing-worker",
            priority: "high",
            status: "ready",
            routingStage: "worker_ready"
          },
          {
            type: "create_operation",
            title: "Prepare launch checklist",
            description: "Release should prepare launch packaging notes and deployment checklist.",
            divisionId: "release",
            workerId: "frontend-worker",
            priority: "normal",
            status: "ready",
            routingStage: "worker_ready"
          }
        ]
      })
    );
    const proposed = await runtimeStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Add QA validation.",
      idempotencyKey: "proposal-mismatched-worker-create"
    });
    const proposalId = proposed.proposals[0].id;

    const applied = await runtimeStore.dispatch("demo", {
      type: "apply_operation_proposal",
      proposalId,
      idempotencyKey: "proposal-mismatched-worker-apply"
    });

    expect(applied.operations.find((operation) => operation.title === "Validate data quality risks")).toMatchObject({
      divisionId: "qa",
      workerId: "qa-runner-alpha",
      status: "ready",
      routingStage: "worker_ready"
    });
    expect(applied.operations.find((operation) => operation.title === "Prepare launch checklist")).toMatchObject({
      divisionId: "release",
      workerId: "release-director",
      status: "ready",
      routingStage: "worker_ready"
    });
    expect(applied.events.find((event) => event.type === "operation.created" && event.message.includes("Validate data quality risks"))?.payload).toMatchObject({
      proposalId,
      workerId: "qa-runner-alpha",
      originalWorkerId: "testing-worker",
      workerReassigned: true
    });
    expect(applied.events.find((event) => event.type === "operation.created" && event.message.includes("Prepare launch checklist"))?.payload).toMatchObject({
      proposalId,
      workerId: "release-director",
      originalWorkerId: "frontend-worker",
      workerReassigned: true
    });
  });

  it("keeps update_operation worker validation strict across divisions", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      undefined,
      new ProposalProvider({
        summary: "Move QA operation to an invalid worker.",
        actions: [
          {
            type: "update_operation",
            operationId: "op-qa",
            divisionId: "qa",
            workerId: "testing-worker",
            status: "ready"
          }
        ]
      })
    );
    const proposed = await runtimeStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Route QA work.",
      idempotencyKey: "proposal-invalid-update-worker-create"
    });

    expect(proposed.proposals).toHaveLength(0);
    expect(proposed.messages.at(-1)?.content).toContain("invalid worker testing-worker");
  });

  it("resolves stale proposal operation ids by matching title and division", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      undefined,
      new ProposalProvider({
        summary: "Update QA operation with a stale id.",
        actions: [
          {
            type: "update_operation",
            operationId: "stale-op-qa-id",
            title: "Run organizational review",
            divisionId: "qa",
            workerId: "qa-runner-alpha",
            status: "blocked",
            blockedReason: "Waiting on Engineering implementation evidence."
          },
          {
            type: "create_handoff",
            fromDivisionId: "engineering",
            toDivisionId: "qa",
            targetOperationId: "stale-op-qa-id",
            summary: "Engineering should provide evidence for QA review."
          }
        ]
      })
    );
    const proposed = await runtimeStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Update QA review.",
      idempotencyKey: "proposal-stale-operation-create"
    });

    const applied = await runtimeStore.dispatch("demo", {
      type: "apply_operation_proposal",
      proposalId: proposed.proposals[0].id,
      idempotencyKey: "proposal-stale-operation-apply"
    });

    expect(applied.operations.find((operation) => operation.id === "op-qa")).toMatchObject({
      status: "blocked",
      blockedReason: "Waiting on Engineering implementation evidence."
    });
    expect(applied.handoffs.find((handoff) => handoff.summary === "Engineering should provide evidence for QA review.")).toMatchObject({
      targetOperationId: "op-qa"
    });
  });

  it("skips Executive-created operations that are similar to existing work", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      undefined,
      new ProposalProvider({
        summary: "Create duplicate runtime work.",
        actions: [
          {
            type: "create_operation",
            title: "Implement runtime contract pass",
            description: "Create another runtime contract implementation task for the same backend contract work.",
            divisionId: "engineering",
            workerId: "backend-worker",
            priority: "high",
            status: "ready"
          }
        ]
      })
    );
    const proposed = await runtimeStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Add runtime contract work.",
      idempotencyKey: "proposal-duplicate-operation-create"
    });

    const applied = await runtimeStore.dispatch("demo", {
      type: "apply_operation_proposal",
      proposalId: proposed.proposals[0].id,
      idempotencyKey: "proposal-duplicate-operation-apply"
    });

    expect(applied.operations.some((operation) => operation.title === "Implement runtime contract pass")).toBe(false);
    expect(applied.proposals.find((proposal) => proposal.id === proposed.proposals[0].id)).toMatchObject({ status: "applied" });
    expect(applied.events.find((event) => event.payload.action === "create_operation_skipped")).toMatchObject({
      type: "operation.blocked",
      payload: {
        reason: "similar_operation_exists",
        existingOperationId: "op-runtime"
      }
    });
  });

  it("applies Executive staffing proposals into new workers", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createEmptyForgeSnapshot({ id: "forge-staffing", slug: "staffing", name: "Staffing Forge", prefixEntityIds: true })),
      undefined,
      new ProposalProvider({
        summary: "Add a data integration specialist.",
        actions: [
          {
            type: "create_worker",
            name: "Data Integration Specialist",
            role: "external source data analyst",
            divisionId: "staffing-engineering",
            currentTask: "Map external source data feeds.",
            status: "idle"
          },
          {
            type: "create_operation",
            title: "Map external data sources",
            description: "Implement the initial source map for downstream ingestion.",
            divisionId: "staffing-engineering",
            workerName: "Data Integration Specialist",
            priority: "high",
            status: "ready",
            routingStage: "worker_ready"
          }
        ]
      })
    );
    const proposed = await runtimeStore.dispatch("staffing", {
      type: "propose_operation_changes",
      message: "Add a data specialist.",
      idempotencyKey: "staffing-proposal"
    });
    const proposalId = proposed.proposals[0].id;

    const applied = await runtimeStore.dispatch("staffing", {
      type: "apply_operation_proposal",
      proposalId,
      idempotencyKey: "staffing-apply"
    });

    expect(applied.workers.find((worker) => worker.name === "Data Integration Specialist")).toMatchObject({
      divisionId: "staffing-engineering",
      role: "external source data analyst",
      status: "idle",
      contextManifest: {
        objective: "external source data analyst. Map external source data feeds.",
        instructionSources: expect.arrayContaining(["Dynamic specialist staffing request"]),
        memorySnippets: expect.arrayContaining(["Specialize as external source data analyst.", "Primary focus: Map external source data feeds."])
      }
    });
    expect(applied.events.map((event) => event.type)).toEqual(expect.arrayContaining(["worker.created", "executive.proposal_applied"]));
  });

  it("rejects staffing proposals that create workers without runnable assigned operations", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createEmptyForgeSnapshot({ id: "forge-unused-worker", slug: "unused-worker", name: "Unused Worker Forge", prefixEntityIds: true })),
      undefined,
      new ProposalProvider({
        summary: "Add a data integration specialist.",
        actions: [
          {
            type: "create_worker",
            name: "Data Integration Specialist",
            role: "external source data analyst",
            divisionId: "unused-worker-engineering",
            currentTask: "Map external source data feeds.",
            status: "idle"
          }
        ]
      })
    );

    const snapshot = await runtimeStore.dispatch("unused-worker", {
      type: "propose_operation_changes",
      message: "Build a field service tracking website with a specialist.",
      idempotencyKey: "unused-worker-proposal"
    });

    expect(snapshot.proposals).toHaveLength(0);
    expect(snapshot.workers.some((worker) => worker.name === "Data Integration Specialist")).toBe(false);
    expect(snapshot.messages.at(-1)?.content).toContain("must have a same-proposal ready operation");
    expect(snapshot.events.map((event) => event.type)).toEqual(expect.arrayContaining(["executive.proposal_failed"]));
  });

  it("assigns same-proposal operations to newly created workers by workerName", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createEmptyForgeSnapshot({ id: "forge-worker-name", slug: "worker-name", name: "Worker Name Forge", prefixEntityIds: true })),
      undefined,
      new ProposalProvider({
        summary: "Add and use a data integration specialist.",
        actions: [
          {
            type: "create_operation",
            title: "Implement source data ingestion",
            description: "Build the source data ingestion module and normalized search dataset.",
            divisionId: "worker-name-engineering",
            workerName: "Data Integration Specialist",
            priority: "critical",
            status: "ready",
            routingStage: "worker_ready"
          },
          {
            type: "create_worker",
            name: "Data Integration Specialist",
            role: "external source data analyst",
            divisionId: "worker-name-engineering",
            currentTask: "Implement source data ingestion.",
            status: "ready"
          }
        ]
      })
    );
    const proposed = await runtimeStore.dispatch("worker-name", {
      type: "propose_operation_changes",
      message: "Build a field service tracking website with a specialist.",
      idempotencyKey: "worker-name-proposal"
    });
    const applied = await runtimeStore.dispatch("worker-name", {
      type: "apply_operation_proposal",
      proposalId: proposed.proposals[0].id,
      idempotencyKey: "worker-name-apply"
    });

    const worker = applied.workers.find((candidate) => candidate.name === "Data Integration Specialist");
    expect(worker).toBeDefined();
    expect(applied.operations.find((operation) => operation.title === "Implement source data ingestion")).toMatchObject({
      workerId: worker?.id,
      status: "ready",
      routingStage: "worker_ready"
    });
  });

  it("allows new project build proposals to start with assigned runnable research work", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createEmptyForgeSnapshot({ id: "forge-research-only", slug: "research-only", name: "Research Only Forge", prefixEntityIds: true })),
      undefined,
      new ProposalProvider({
        summary: "Research field service workflow requirements.",
        actions: [
          {
            type: "create_operation",
            title: "Research field service workflow requirements",
            description: "Research source systems and plan the product scope before implementation.",
            divisionId: "research-only-strategy",
            priority: "normal"
          }
        ]
      })
    );

    const snapshot = await runtimeStore.dispatch("research-only", {
      type: "propose_operation_changes",
      message: "Build a field service tracking website.",
      idempotencyKey: "research-only-proposal"
    });

    const applied = await runtimeStore.dispatch("research-only", {
      type: "apply_operation_proposal",
      proposalId: snapshot.proposals[0].id,
      idempotencyKey: "research-only-apply"
    });

    expect(snapshot.proposals).toHaveLength(1);
    expect(applied.operations.find((operation) => operation.title === "Research field service workflow requirements")).toMatchObject({
      workerId: "research-only-research-analyst",
      status: "ready",
      routingStage: "worker_ready"
    });
  });

  it("gates development behind same-proposal research when operator asks to research then build", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createEmptyForgeSnapshot({ id: "forge-research-first", slug: "research-first", name: "Research First Forge", prefixEntityIds: true })),
      undefined,
      new ProposalProvider({
        summary: "Research then build a field service site.",
        actions: [
          {
            type: "create_operation",
            operationKey: "research-market",
            title: "Research field service workflow requirements",
            description: "Research source systems, user needs, and data accuracy risks before implementation.",
            divisionId: "research-first-strategy",
            priority: "high",
            status: "ready",
            routingStage: "worker_ready"
          },
          {
            type: "create_operation",
            operationKey: "build-scaffold",
            title: "Create project scaffold",
            description: "Create package.json, app shell, source files, and styles for the website.",
            divisionId: "research-first-engineering",
            workerId: "research-first-frontend-worker",
            priority: "critical",
            status: "ready",
            routingStage: "worker_ready"
          }
        ]
      })
    );

    const proposed = await runtimeStore.dispatch("research-first", {
      type: "propose_operation_changes",
      message: "Research the market and user needs, then build the field service tracking website.",
      idempotencyKey: "research-first-proposal"
    });
    const applied = await runtimeStore.dispatch("research-first", {
      type: "apply_operation_proposal",
      proposalId: proposed.proposals[0].id,
      idempotencyKey: "research-first-apply"
    });

    const research = applied.operations.find((operation) => operation.title === "Research field service workflow requirements")!;
    const scaffold = applied.operations.find((operation) => operation.title === "Create project scaffold")!;
    expect(scaffold).toMatchObject({
      status: "blocked",
      blockedReason: expect.stringContaining("research")
    });
    expect(applied.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: scaffold.id,
          dependsOnOperationId: research.id,
          type: "blocks"
        })
      ])
    );

    const scheduled = await runtimeStore.dispatch("research-first", {
      type: "scheduler_tick",
      idempotencyKey: "research-first-scheduler"
    });
    expect(scheduled.runs.map((run) => run.operationId)).toContain(research.id);
    expect(scheduled.runs.map((run) => run.operationId)).not.toContain(scaffold.id);
  });

  it("does not create dependency cycles while inferring research-before-development gates", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createEmptyForgeSnapshot({ id: "forge-research-cycle", slug: "research-cycle", name: "Research Cycle Forge", prefixEntityIds: true })),
      undefined,
      new ProposalProvider({
        summary: "Research then build with provider reverse dependency.",
        actions: [
          {
            type: "create_operation",
            operationKey: "research-market",
            title: "Research field service workflow requirements",
            description: "Research source systems and product scope before implementation.",
            divisionId: "research-cycle-strategy",
            priority: "high",
            status: "ready",
            routingStage: "worker_ready",
            dependsOnOperationKeys: ["build-scaffold"]
          },
          {
            type: "create_operation",
            operationKey: "build-scaffold",
            title: "Create project scaffold",
            description: "Create package.json, app shell, source files, and styles for the website.",
            divisionId: "research-cycle-engineering",
            workerId: "research-cycle-frontend-worker",
            priority: "critical",
            status: "ready",
            routingStage: "worker_ready"
          }
        ]
      })
    );

    const proposed = await runtimeStore.dispatch("research-cycle", {
      type: "propose_operation_changes",
      message: "Research the market, then build the field service tracking website.",
      idempotencyKey: "research-cycle-proposal"
    });

    expect(proposed.proposals).toHaveLength(1);
    expect(proposed.events.map((event) => event.type)).not.toContain("executive.proposal_failed");
  });

  it("allows explicitly research-only proposals to stage research before implementation", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createEmptyForgeSnapshot({ id: "forge-research-explicit", slug: "research-explicit", name: "Research Explicit Forge", prefixEntityIds: true })),
      undefined,
      new ProposalProvider({
        summary: "Research field service workflow requirements.",
        actions: [
          {
            type: "create_operation",
            title: "Research field service workflow requirements",
            description: "Research source systems and plan the product scope before implementation.",
            divisionId: "research-explicit-strategy",
            priority: "normal",
            status: "ready",
            routingStage: "worker_ready"
          }
        ]
      })
    );

    const snapshot = await runtimeStore.dispatch("research-explicit", {
      type: "propose_operation_changes",
      message: "Only research a field service tracking website for now.",
      idempotencyKey: "research-explicit-proposal"
    });

    expect(snapshot.proposals).toHaveLength(1);
    expect(snapshot.proposals[0]).toMatchObject({ status: "pending", summary: "Research field service workflow requirements." });
  });

  it("assigns ready implementation operations to existing workers when Executive omits workerId", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createEmptyForgeSnapshot({ id: "forge-auto-worker", slug: "auto-worker", name: "Auto Worker Forge", prefixEntityIds: true })),
      undefined,
      new ProposalProvider({
        summary: "Build an inventory search UI.",
        actions: [
          {
            type: "create_operation",
            title: "Build inventory search page",
            description: "Implement a responsive frontend website for searching inventory items.",
            divisionId: "auto-worker-engineering",
            priority: "high",
            status: "ready",
            routingStage: "worker_ready"
          }
        ]
      })
    );
    const proposed = await runtimeStore.dispatch("auto-worker", {
      type: "propose_operation_changes",
      message: "Build an inventory search website.",
      idempotencyKey: "auto-worker-proposal"
    });
    const applied = await runtimeStore.dispatch("auto-worker", {
      type: "apply_operation_proposal",
      proposalId: proposed.proposals[0].id,
      idempotencyKey: "auto-worker-apply"
    });

    expect(applied.operations.find((operation) => operation.title === "Build inventory search page")).toMatchObject({
      workerId: "auto-worker-frontend-worker",
      status: "ready",
      routingStage: "worker_ready"
    });
  });

  it("keeps scheduler dispatch within configured run slots and auto-fills after completion", async () => {
    const originalMax = process.env.FORGEOS_AGENT_MAX_CONCURRENT_RUNS;
    const originalAutopilot = process.env.FORGEOS_EXECUTIVE_AUTOPILOT;
    process.env.FORGEOS_AGENT_MAX_CONCURRENT_RUNS = "1";
    process.env.FORGEOS_EXECUTIVE_AUTOPILOT = "1";
    const runtime = new DeferredRuntime();
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createEmptyForgeSnapshot({ id: "forge-autofill", slug: "autofill", name: "Autofill Forge", prefixEntityIds: true })),
      runtime,
      new ProposalProvider({
        summary: "Create two ready operations.",
        actions: [
          {
            type: "create_operation",
            title: "Collect source feed requirements",
            description: "Find and summarize source feed data requirements.",
            divisionId: "autofill-engineering",
            workerId: "autofill-backend-worker",
            priority: "critical",
            status: "ready"
          },
          {
            type: "create_operation",
            title: "Design mobile item search",
            description: "Create mobile-first item search UI plan.",
            divisionId: "autofill-engineering",
            workerId: "autofill-frontend-worker",
            priority: "high",
            status: "ready"
          }
        ]
      })
    );

    try {
      const proposed = await runtimeStore.dispatch("autofill", {
        type: "propose_operation_changes",
        message: "Create parallel work.",
        idempotencyKey: "autofill-proposal"
      });
      const applied = await runtimeStore.dispatch("autofill", {
        type: "apply_operation_proposal",
        proposalId: proposed.proposals[0].id,
        idempotencyKey: "autofill-apply"
      });
      const firstOperationId = applied.operations.find((operation) => operation.title === "Collect source feed requirements")!.id;

      const scheduled = await runtimeStore.dispatch("autofill", { type: "scheduler_tick", idempotencyKey: "autofill-schedule" });
      expect(scheduled.runs.filter(isActiveRun)).toHaveLength(1);
      expect(scheduled.runs.find(isActiveRun)?.operationId).toBe(firstOperationId);

      await vi.waitFor(() => expect(runtime.startedCount).toBe(1));
      runtime.releaseNext();
      await vi.waitFor(async () => {
        const snapshot = await runtimeStore.getSnapshot("autofill");
        expect(snapshot.operations.find((operation) => operation.id === firstOperationId)?.status).toBe("completed");
        expect(snapshot.runs.filter(isActiveRun)).toHaveLength(1);
        expect(snapshot.runs.find(isActiveRun)?.operationId).not.toBe(firstOperationId);
      });

      await vi.waitFor(() => expect(runtime.startedCount).toBe(2));
      runtime.releaseNext();
      await vi.waitFor(async () => {
        const snapshot = await runtimeStore.getSnapshot("autofill");
        expect(snapshot.runs.filter(isActiveRun)).toHaveLength(0);
        expect(snapshot.events.some((event) => event.type === "cycle.progress" && event.message.includes("Executive autopilot"))).toBe(true);
      });
    } finally {
      if (originalMax) {
        process.env.FORGEOS_AGENT_MAX_CONCURRENT_RUNS = originalMax;
      } else {
        delete process.env.FORGEOS_AGENT_MAX_CONCURRENT_RUNS;
      }
      if (originalAutopilot) {
        process.env.FORGEOS_EXECUTIVE_AUTOPILOT = originalAutopilot;
      } else {
        delete process.env.FORGEOS_EXECUTIVE_AUTOPILOT;
      }
    }
  });

  it("blocks premature validation work instead of silently leaving it ready and unschedulable", async () => {
    const snapshot = createEmptyForgeSnapshot({ id: "forge-gated", slug: "gated", name: "Gated Forge", prefixEntityIds: true });
    const qaOperation = {
      id: "gated-op-qa",
      divisionId: "gated-qa",
      workerId: "gated-qa-runner-alpha",
      title: "Validate website launch readiness",
      description: "Run QA validation and launch checks against implementation output.",
      status: "ready" as const,
      priority: "normal" as const,
      progress: 0,
      retryCount: 0,
      outputArtifactIds: [],
      routingStage: "lead_triaged" as const,
      webAccessPolicy: "none" as const
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence({ ...snapshot, operations: [qaOperation] }), new DeferredRuntime());

    const scheduled = await runtimeStore.dispatch("gated", { type: "scheduler_tick", idempotencyKey: "gate-premature-validation" });

    expect(scheduled.operations.find((operation) => operation.id === qaOperation.id)).toMatchObject({
      status: "blocked",
      blockedReason: "Waiting for implementation files before validation, QA, release, or deployment work can run."
    });
    expect(scheduled.runs).toHaveLength(0);
    expect(scheduled.events.some((event) => event.type === "operation.blocked" && event.targetId === qaOperation.id)).toBe(true);
  });

  it("emits heartbeat progress while a provider run is active", async () => {
    const originalHeartbeat = process.env.FORGEOS_RUN_HEARTBEAT_INTERVAL_MS;
    process.env.FORGEOS_RUN_HEARTBEAT_INTERVAL_MS = "20";
    const runtime = new DeferredRuntime();
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);

    try {
      const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "heartbeat-runtime" });
      const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;

      await vi.waitFor(async () => {
        const snapshot = await runtimeStore.getSnapshot("demo");
        const heartbeat = snapshot.events.find((event) => event.type === "run.progress" && event.payload.heartbeat === true && event.payload.runId === run.id);
        expect(heartbeat).toBeTruthy();
        expect(snapshot.operations.find((operation) => operation.id === "op-runtime")?.progress).toBeGreaterThan(0);
        expect(snapshot.operations.find((operation) => operation.id === "op-runtime")?.progress).toBeLessThan(100);
      });

      runtime.releaseNext();
      const completed = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
      const progressAfterCompletion = completed.events.filter((event) => event.type === "run.progress" && event.payload.heartbeat === true && event.payload.runId === run.id).length;
      await new Promise((resolve) => setTimeout(resolve, 40));
      const later = await runtimeStore.getSnapshot("demo");

      expect(later.events.filter((event) => event.type === "run.progress" && event.payload.heartbeat === true && event.payload.runId === run.id)).toHaveLength(progressAfterCompletion);
      expect(later.operations.find((operation) => operation.id === "op-runtime")?.progress).toBe(100);
    } finally {
      if (originalHeartbeat === undefined) {
        delete process.env.FORGEOS_RUN_HEARTBEAT_INTERVAL_MS;
      } else {
        process.env.FORGEOS_RUN_HEARTBEAT_INTERVAL_MS = originalHeartbeat;
      }
    }
  });

  it("emits compact context checkpoints while a provider run is active", async () => {
    const originalHeartbeat = process.env.FORGEOS_RUN_HEARTBEAT_INTERVAL_MS;
    const originalFirstCheckpoint = process.env.FORGEOS_RUN_CHECKPOINT_FIRST_MS;
    const originalCheckpointInterval = process.env.FORGEOS_RUN_CHECKPOINT_INTERVAL_MS;
    process.env.FORGEOS_RUN_HEARTBEAT_INTERVAL_MS = "20";
    process.env.FORGEOS_RUN_CHECKPOINT_FIRST_MS = "10";
    process.env.FORGEOS_RUN_CHECKPOINT_INTERVAL_MS = "20";
    const runtime = new DeferredRuntime();
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);

    try {
      const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "checkpoint-runtime" });
      const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;

      await vi.waitFor(async () => {
        const snapshot = await runtimeStore.getSnapshot("demo");
        const checkpointEvent = snapshot.events.find((event) => event.type === "run.context_checkpointed" && event.payload.runId === run.id);
        const activeRun = snapshot.runs.find((candidate) => candidate.id === run.id);
        expect(checkpointEvent).toBeTruthy();
        expect(activeRun?.providerMetadata.traceSummary).toMatchObject({
          checkpoint: expect.objectContaining({
            checkpointNumber: expect.any(Number),
            summary: expect.stringContaining("Implement runtime contracts"),
            nextAction: expect.stringContaining("bounded outputs"),
            risk: expect.any(String)
          })
        });
        expect(checkpointEvent?.payload).not.toHaveProperty("context");
      });

      runtime.releaseNext();
      const completed = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
      const checkpointCount = completed.events.filter((event) => event.type === "run.context_checkpointed" && event.payload.runId === run.id).length;
      await new Promise((resolve) => setTimeout(resolve, 40));
      const later = await runtimeStore.getSnapshot("demo");
      expect(later.events.filter((event) => event.type === "run.context_checkpointed" && event.payload.runId === run.id)).toHaveLength(checkpointCount);
    } finally {
      restoreEnv("FORGEOS_RUN_HEARTBEAT_INTERVAL_MS", originalHeartbeat);
      restoreEnv("FORGEOS_RUN_CHECKPOINT_FIRST_MS", originalFirstCheckpoint);
      restoreEnv("FORGEOS_RUN_CHECKPOINT_INTERVAL_MS", originalCheckpointInterval);
    }
  });

  it("carries the latest run checkpoint into requested-context reruns", async () => {
    const originalHeartbeat = process.env.FORGEOS_RUN_HEARTBEAT_INTERVAL_MS;
    const originalFirstCheckpoint = process.env.FORGEOS_RUN_CHECKPOINT_FIRST_MS;
    const originalCheckpointInterval = process.env.FORGEOS_RUN_CHECKPOINT_INTERVAL_MS;
    process.env.FORGEOS_RUN_HEARTBEAT_INTERVAL_MS = "20";
    process.env.FORGEOS_RUN_CHECKPOINT_FIRST_MS = "10";
    process.env.FORGEOS_RUN_CHECKPOINT_INTERVAL_MS = "20";
    const runtime = new CheckpointedContextRequestRuntime();
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);
    await runtimeStore.upsertVirtualFile("demo", {
      path: "docs/agent-loop.md",
      content: "# Agent Loop\n\nCheckpointed context handoff."
    });

    try {
      const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "checkpoint-context-rerun" });
      const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;

      await vi.waitFor(async () => {
        const snapshot = await runtimeStore.getSnapshot("demo");
        expect(snapshot.events.some((event) => event.type === "run.context_checkpointed" && event.payload.runId === run.id)).toBe(true);
      });

      runtime.releaseNext();
      await waitForRunStatus(runtimeStore, "demo", run.id, "completed");

      expect(runtime.inputs).toHaveLength(2);
      expect(runtime.inputs[1].providerPrompt.context.longRunCheckpoint).toMatchObject({
        checkpointNumber: expect.any(Number),
        summary: expect.stringContaining("Implement runtime contracts"),
        nextAction: expect.stringContaining("bounded outputs")
      });
    } finally {
      restoreEnv("FORGEOS_RUN_HEARTBEAT_INTERVAL_MS", originalHeartbeat);
      restoreEnv("FORGEOS_RUN_CHECKPOINT_FIRST_MS", originalFirstCheckpoint);
      restoreEnv("FORGEOS_RUN_CHECKPOINT_INTERVAL_MS", originalCheckpointInterval);
    }
  });

  it("starts an Executive Manager loop that creates a plan, reports, and dispatches work", async () => {
    const snapshot = createEmptyForgeSnapshot({ id: "forge-manager", slug: "manager", name: "Manager Forge", prefixEntityIds: true });
    const provider = new ExecutiveManagerProvider({
      summary: "Plan the test project.",
      projectStatus: "planning",
      userReport: "Executive created an initial plan and dispatched engineering work.",
      planPatch: {
        successCriteria: ["The generated project can be tested."],
        phases: [{ title: "Implement", objective: "Build the requested project.", divisionIds: ["manager-engineering"] }],
        testStrategy: ["Run the available verification suite."]
      },
      operationActions: [
        {
          type: "create_operation",
          title: "Implement testable project slice",
          description: "Create the first testable implementation slice.",
          divisionId: "manager-engineering",
          priority: "critical",
          status: "ready",
          routingStage: "worker_ready"
        }
      ],
      dispatchPolicy: { maxRuns: 1, priority: "critical_first" }
    });
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new MockRuntime(), provider);

    const started = await runtimeStore.dispatch("manager", {
      type: "start_executive_loop",
      message: "Build a stable test project.",
      idempotencyKey: "manager-loop-start"
    });

    expect(started.executiveLoops).toHaveLength(1);
    expect(started.executivePlans).toHaveLength(1);
    expect(started.executiveReports.length).toBeGreaterThanOrEqual(1);
    expect(started.messages.some((message) => message.kind === "executive_summary" && message.source === "executive_loop")).toBe(true);
    expect(started.operations.find((operation) => operation.title === "Implement testable project slice")).toMatchObject({
      status: "running",
      priority: "critical"
    });
    expect(started.runs).toHaveLength(1);
    expect(started.events.map((event) => event.type)).toEqual(expect.arrayContaining(["executive.loop_started", "executive.plan_created", "executive.progress_reported", "run.queued"]));
  });

  it("pauses and resumes an active Executive Manager loop", async () => {
    const snapshot = createEmptyForgeSnapshot({ id: "forge-pause-loop", slug: "pause-loop", name: "Pause Loop Forge", prefixEntityIds: true });
    const provider = new ExecutiveManagerProvider({
      summary: "Observe only.",
      projectStatus: "running",
      userReport: "Executive is observing current work.",
      operationActions: [],
      dispatchPolicy: { maxRuns: 0 }
    });
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new MockRuntime(), provider);

    await runtimeStore.dispatch("pause-loop", { type: "start_executive_loop", message: "Build a project.", idempotencyKey: "pause-loop-start" });
    const paused = await runtimeStore.dispatch("pause-loop", { type: "pause_executive_loop", idempotencyKey: "pause-loop-pause" });
    const resumed = await runtimeStore.dispatch("pause-loop", { type: "resume_executive_loop", idempotencyKey: "pause-loop-resume" });

    expect(paused.executiveLoops[0].status).toBe("paused");
    expect(resumed.executiveLoops[0].status).not.toBe("paused");
    expect(resumed.events.map((event) => event.type)).toEqual(expect.arrayContaining(["executive.progress_reported"]));
  });

  it("blocks an Executive Manager loop on a structured operator question", async () => {
    const snapshot = createEmptyForgeSnapshot({ id: "forge-question-loop", slug: "question-loop", name: "Question Loop Forge", prefixEntityIds: true });
    const provider = new ExecutiveManagerProvider({
      summary: "Need operator taste input.",
      projectStatus: "planning",
      userReport: "Executive needs one answer before creating the project plan.",
      operationActions: [],
      dispatchPolicy: { maxRuns: 0 },
      userQuestion: {
        reason: "The requested project depends on audience tone.",
        question: "Who should this project feel built for?",
        options: [
          { id: "founders", label: "Startup founders", description: "Optimize for fast evaluation and launch." },
          { id: "enterprise", label: "Enterprise teams" }
        ],
        allowNotes: true
      }
    });
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new MockRuntime(), provider);

    const result = await runtimeStore.dispatch("question-loop", {
      type: "start_executive_loop",
      message: "Build a personalized landing page.",
      idempotencyKey: "question-loop-start"
    });
    const questionEvent = result.events.find((event) => event.type === "executive.user_input_requested");

    expect(result.executiveLoops[0]).toMatchObject({ status: "waiting_for_user" });
    expect(result.runs).toHaveLength(0);
    expect(questionEvent?.payload).toMatchObject({
      reason: "The requested project depends on audience tone.",
      question: "Who should this project feel built for?",
      allowNotes: true,
      options: [
        { id: "founders", label: "Startup founders", description: "Optimize for fast evaluation and launch." },
        { id: "enterprise", label: "Enterprise teams" }
      ]
    });
    expect(typeof questionEvent?.payload.questionId).toBe("string");
  });

  it("does not block the Executive loop on diagnostic log requests", async () => {
    const snapshot = createEmptyForgeSnapshot({ id: "forge-diagnostic-question", slug: "diagnostic-question", name: "Diagnostic Question Forge", prefixEntityIds: true });
    const provider = new ExecutiveManagerProvider({
      summary: "Need runtime logs.",
      projectStatus: "running",
      userReport: "Executive should inspect ForgeOS diagnostics instead of asking the operator for logs.",
      operationActions: [],
      dispatchPolicy: { maxRuns: 0 },
      userQuestion: {
        reason: "The launcher failed and I need the error log.",
        question: "Please provide the failing launcher or verification log tail.",
        options: [{ id: "logs", label: "Provide logs" }],
        allowNotes: true
      }
    });
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new MockRuntime(), provider);

    const result = await runtimeStore.dispatch("diagnostic-question", {
      type: "start_executive_loop",
      message: "Fix the preview.",
      idempotencyKey: "diagnostic-question-start"
    });

    expect(result.executiveLoops[0].status).not.toBe("waiting_for_user");
    expect(result.events.some((event) => event.type === "executive.user_input_requested")).toBe(false);
    expect(result.events.some((event) => event.type === "executive.progress_reported" && event.payload.reason === "operator_question_suppressed_runtime_diagnostic")).toBe(true);
  });

  it("does not emit duplicate pending Executive questions for repeated manager decisions", async () => {
    const snapshot = createEmptyForgeSnapshot({ id: "forge-duplicate-question", slug: "duplicate-question", name: "Duplicate Question Forge", prefixEntityIds: true });
    const duplicateQuestionDecision = {
      summary: "Need operator input.",
      projectStatus: "planning" as const,
      userReport: "Executive needs one answer before continuing.",
      operationActions: [],
      dispatchPolicy: { maxRuns: 0 },
      userQuestion: {
        reason: "The requested project depends on audience tone.",
        question: "Who should this project feel built for?",
        options: [{ id: "founders", label: "Startup founders" }],
        allowNotes: true
      }
    };
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(snapshot),
      new MockRuntime(),
      new SequencedExecutiveManagerProvider([duplicateQuestionDecision, duplicateQuestionDecision])
    );

    const first = await runtimeStore.dispatch("duplicate-question", {
      type: "start_executive_loop",
      message: "Build a personalized landing page.",
      idempotencyKey: "duplicate-question-start"
    });
    const loopWaiting = {
      ...first,
      executiveLoops: first.executiveLoops.map((loop) => ({ ...loop, status: "observing" as const }))
    };
    const secondStore = new RuntimeStore(new InMemoryRuntimePersistence(loopWaiting), new MockRuntime(), new SequencedExecutiveManagerProvider([duplicateQuestionDecision]));
    const second = await secondStore.dispatch("duplicate-question", {
      type: "continue_executive_loop",
      idempotencyKey: "duplicate-question-continue"
    });

    const questionEvents = second.events.filter((event) => event.type === "executive.user_input_requested" && event.payload.question === "Who should this project feel built for?");
    expect(questionEvents).toHaveLength(1);
  });

  it("answers a pending Executive question, records notes, and continues the loop", async () => {
    const snapshot = createEmptyForgeSnapshot({ id: "forge-answer-loop", slug: "answer-loop", name: "Answer Loop Forge", prefixEntityIds: true });
    const provider = new SequencedExecutiveManagerProvider([
      {
        summary: "Need operator taste input.",
        projectStatus: "planning",
        userReport: "Executive needs one answer before creating the project plan.",
        operationActions: [],
        dispatchPolicy: { maxRuns: 0 },
        userQuestion: {
          reason: "The requested project depends on audience tone.",
          question: "Who should this project feel built for?",
          options: [{ id: "founders", label: "Startup founders" }],
          allowNotes: true
        }
      },
      {
        summary: "Operator answer received.",
        projectStatus: "running",
        userReport: "Executive incorporated the operator answer.",
        operationActions: [],
        dispatchPolicy: { maxRuns: 0 }
      }
    ]);
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new MockRuntime(), provider);
    const waiting = await runtimeStore.dispatch("answer-loop", {
      type: "start_executive_loop",
      message: "Build a personalized landing page.",
      idempotencyKey: "answer-loop-start"
    });
    const questionId = waiting.events.find((event) => event.type === "executive.user_input_requested")?.payload.questionId;

    const answered = await runtimeStore.dispatch("answer-loop", {
      type: "answer_executive_question",
      questionId,
      selectedOptionIds: ["founders"],
      notes: "Use confident but practical copy.",
      idempotencyKey: "answer-loop-answer"
    });

    expect(answered.events.map((event) => event.type)).toEqual(expect.arrayContaining(["executive.user_input_answered", "executive.cycle_started"]));
    expect(answered.executiveLoops[0].status).not.toBe("waiting_for_user");
    expect(answered.messages.some((message) => message.role === "operator" && message.content.includes("Use confident but practical copy."))).toBe(true);
    expect(JSON.stringify(provider.inputs.at(-1)?.snapshot.messages)).toContain("Startup founders");
  });

  it("reports Executive Manager schema validation details instead of a generic blocker", async () => {
    const snapshot = createEmptyForgeSnapshot({ id: "forge-invalid-manager", slug: "invalid-manager", name: "Invalid Manager Forge", prefixEntityIds: true });
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new MockRuntime(), new InvalidExecutiveDecisionProvider());

    const result = await runtimeStore.dispatch("invalid-manager", {
      type: "start_executive_loop",
      message: "Build a project.",
      idempotencyKey: "invalid-manager-loop"
    });

    const blocker = result.executiveReports.find((report) => report.kind === "blocker");
    expect(blocker?.summary).toContain("failed ForgeOS schema validation");
    expect(blocker?.summary).toContain("operationActions.0.description");
    expect(blocker?.summary).not.toContain("undefined");
  });

  it("reports Executive Manager thrown errors without rendering undefined", async () => {
    const snapshot = createEmptyForgeSnapshot({ id: "forge-throwing-manager", slug: "throwing-manager", name: "Throwing Manager Forge", prefixEntityIds: true });
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new MockRuntime(), new ThrowingExecutiveDecisionProvider());

    const result = await runtimeStore.dispatch("throwing-manager", {
      type: "start_executive_loop",
      message: "Build a project.",
      idempotencyKey: "throwing-manager-loop"
    });

    const blocker = result.executiveReports.find((report) => report.kind === "blocker");
    expect(blocker?.summary).toContain("Executive AI proposal generation failed");
    expect(blocker?.summary).not.toContain("undefined");
  });

  it("rejects Executive proposals without mutating operations", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      undefined,
      new ProposalProvider({
        summary: "Escalate runtime work.",
        actions: [{ type: "update_operation", operationId: "op-runtime", priority: "critical" }]
      })
    );
    const proposed = await runtimeStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Escalate runtime work.",
      idempotencyKey: "proposal-reject-create"
    });
    const proposalId = proposed.proposals[0].id;

    const rejected = await runtimeStore.dispatch("demo", {
      type: "reject_operation_proposal",
      proposalId,
      idempotencyKey: "proposal-reject"
    });

    expect(rejected.proposals.find((proposal) => proposal.id === proposalId)).toMatchObject({ status: "rejected" });
    expect(rejected.operations.find((operation) => operation.id === "op-runtime")?.priority).toBe("high");
    expect(rejected.events.map((event) => event.type)).toEqual(expect.arrayContaining(["executive.proposal_rejected"]));
  });

  it("records Executive proposal provider failures without mutating operations", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), undefined, new FailingProposalProvider());
    const before = await runtimeStore.getSnapshot("demo");

    const snapshot = await runtimeStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Route QA behind runtime contracts.",
      idempotencyKey: "proposal-provider-failure"
    });

    expect(snapshot.operations).toEqual(before.operations);
    expect(snapshot.proposals).toHaveLength(0);
    expect(snapshot.messages.at(-1)).toMatchObject({
      role: "executive",
      kind: "executive_reply",
      status: "failed"
    });
    expect(snapshot.events.map((event) => event.type)).toEqual(expect.arrayContaining(["executive.proposal_failed"]));
    expect(JSON.stringify(snapshot)).not.toContain("provider unavailable");
  });

  it("records sanitized Executive API failure diagnostics in proposal failure events", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), undefined, new FailingOpenAIProposalProvider());

    const snapshot = await runtimeStore.dispatch("demo", {
      type: "propose_operation_changes",
      message: "Route QA behind runtime contracts.",
      idempotencyKey: "proposal-openai-provider-failure"
    });
    const event = snapshot.events.find((candidate) => candidate.type === "executive.proposal_failed");

    expect(event?.payload).toMatchObject({
      provider: "openai",
      model: "gpt-test",
      category: "provider_http_error",
      httpStatus: 403,
      providerErrorCode: "insufficient_quota",
      providerErrorType: "billing_error",
      message: expect.stringContaining("HTTP 403")
    });
    expect(JSON.stringify(event?.payload)).not.toContain("sk-");
    expect(JSON.stringify(event?.payload)).not.toContain("operatorMessage");
  });

  it("rejects blocked operations by default", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-3" });

    await expect(
      runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-tests", idempotencyKey: "blocked-op" })
    ).rejects.toMatchObject({
      status: 409,
      message: "Waiting for runtime contracts"
    });
  });

  it("repairs stale ready operation routing stages before running", async () => {
    const baseSnapshot = createDemoSnapshot();
    const staleSnapshot = {
      ...baseSnapshot,
      operations: baseSnapshot.operations.map((operation) =>
        operation.id === "op-runtime"
          ? {
              ...operation,
              status: "ready" as const,
              routingStage: "done" as const
            }
          : operation
      )
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(staleSnapshot), new MockRuntime());

    const snapshot = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "stale-ready-routing" });

    expect(snapshot.operations.find((operation) => operation.id === "op-runtime")).toMatchObject({
      status: "running",
      routingStage: "running"
    });
  });

  it("unlocks dependent operations after blocking dependencies complete", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-4" });

    const snapshot = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "unlock-runtime" });
    const completed = await waitForOperationStatus(runtimeStore, "demo", "op-runtime", "completed");

    expect(snapshot.operations.find((operation) => operation.id === "op-runtime")?.status).toBe("running");
    expect(completed.operations.find((operation) => operation.id === "op-runtime")?.status).toBe("completed");
    expect(completed.operations.find((operation) => operation.id === "op-tests")?.status).toBe("ready");
    expect(completed.events.some((event) => event.type === "operation.ready" && event.targetId === "op-tests")).toBe(true);
  });

  it("unlocks stale blocked operations before manual run when readiness is clear", async () => {
    const baseSnapshot = createDemoSnapshot();
    const staleBlockedSnapshot = {
      ...baseSnapshot,
      operations: baseSnapshot.operations.map((operation) =>
        operation.id === "op-research"
          ? {
              ...operation,
              status: "blocked" as const,
              blockedReason: "Stale blocker text remains after prerequisites were resolved.",
              routingStage: "worker_ready" as const
            }
          : operation
      )
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(staleBlockedSnapshot), new DeferredRuntime());

    const queued = await runtimeStore.dispatch("demo", {
      type: "run_operation",
      operationId: "op-research",
      idempotencyKey: "manual-unlock-stale-blocked"
    });

    expect(queued.operations.find((operation) => operation.id === "op-research")).toMatchObject({
      status: "running",
      blockedReason: undefined
    });
    expect(queued.workers.find((worker) => worker.id === "research-analyst")).toMatchObject({
      status: "running",
      currentTask: "Research sponsor alignment"
    });
    expect(queued.divisions.find((division) => division.id === "strategy")).toMatchObject({
      status: "running"
    });
    expect(queued.events.map((event) => event.type)).toEqual(expect.arrayContaining(["operation.ready", "run.queued"]));
  });

  it("serializes concurrent commands per Forge before loading and mutating snapshots", async () => {
    const runtime = new DeferredRuntime();
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-concurrent" });

    const first = runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "concurrent-runtime-1" });
    const second = runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "concurrent-runtime-2" });
    second.catch(() => undefined);
    await vi.waitFor(() => expect(runtime.startedCount).toBe(1));

    const settled = await Promise.allSettled([first, second]);
    runtime.releaseNext();

    expect(runtime.startedCount).toBe(1);
    expect(settled[0].status).toBe("fulfilled");
    expect(settled[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        status: 409,
        message: "Operation cannot run from running status."
      })
    });
    const snapshot = await waitForOperationStatus(runtimeStore, "demo", "op-runtime", "completed");
    expect(snapshot.events.filter((event) => event.type === "operation.started" && event.targetId === "op-runtime")).toHaveLength(1);
  });

  it("records durable run lifecycle state for operation execution", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-runs" });

    const snapshot = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "run-lifecycle-runtime" });
    const run = snapshot.runs.find((candidate) => candidate.operationId === "op-runtime");

    expect(run).toMatchObject({
      forgeId: "demo-forge",
      operationId: "op-runtime",
      workerId: "backend-worker",
      provider: "mock",
      status: "queued",
      capabilities: runtimeStore.getAgentRuntimeCapabilities()
    });
    expect(run?.startedAt).toBeUndefined();
    expect(run?.completedAt).toBeUndefined();
    expect(snapshot.events.map((event) => event.type)).toEqual(expect.arrayContaining(["run.queued"]));
    const completed = await waitForRunStatus(runtimeStore, "demo", run!.id, "completed");
    expect(completed.runs.find((candidate) => candidate.id === run?.id)?.completedAt).toEqual(expect.any(String));
    expect(completed.runs.find((candidate) => candidate.id === run?.id)?.startedAt).toEqual(expect.any(String));
    expect(completed.events.map((event) => event.type)).toEqual(expect.arrayContaining(["run.started"]));
    expect(completed.events.some((event) => "context" in event.payload)).toBe(false);
  });

  it("blocks new OpenAI-backed runs when a Forge spend limit is reached", async () => {
    const runtime = new CostedCodexRuntime();
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);

    const limited = await runtimeStore.dispatch("demo", {
      type: "set_openai_spend_limit",
      openaiSpendLimitUsd: 0,
      idempotencyKey: "set-zero-openai-limit"
    });

    expect(limited.forge.openaiSpendLimitMicros).toBe(0);
    await expect(
      runtimeStore.dispatch("demo", {
        type: "run_operation",
        operationId: "op-runtime",
        agentProvider: "codex",
        idempotencyKey: "blocked-by-openai-spend-limit"
      })
    ).rejects.toMatchObject({
      status: 402,
      message: expect.stringContaining("OpenAI API spend limit reached")
    });
    expect(runtime.started).toBe(0);
  });

  it("allows OpenAI-backed runs until local estimated usage reaches the Forge spend limit", async () => {
    const runtime = new CostedCodexRuntime();
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);

    await runtimeStore.dispatch("demo", {
      type: "set_openai_spend_limit",
      openaiSpendLimitUsd: 0.01,
      idempotencyKey: "set-openai-limit"
    });
    const queued = await runtimeStore.dispatch("demo", {
      type: "run_operation",
      operationId: "op-runtime",
      agentProvider: "codex",
      idempotencyKey: "first-openai-run-under-limit"
    });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;

    const completed = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");

    expect(runtime.started).toBe(1);
    expect(completed.runs.find((candidate) => candidate.id === run.id)?.usage?.costMicros).toBe(2500);
  });

  it("passes assembled context to the provider for manual operation runs", async () => {
    const runtime = new RecordingRuntime();
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);

    await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "manual-context-runtime" });
    await vi.waitFor(() => expect(runtime.inputs).toHaveLength(1));

    expect(runtime.inputs[0]).toMatchObject({
      forgeId: "demo-forge",
      operationId: "op-runtime",
      context: {
        operation: { id: "op-runtime", title: "Implement runtime contracts" },
        worker: { id: "backend-worker" },
        division: { id: "engineering" }
      }
    });
    expect(runtime.inputs[0].context.files.some((file) => file.path === "docs/project-plan.md" && file.excerpt.includes("ForgeOS command center"))).toBe(true);
    expect(runtime.inputs[0].providerPrompt).toMatchObject({
      version: "forgeos-provider-prompt-v1",
      instructions: {
        operationId: "op-runtime",
        divisionId: "engineering"
      },
      context: {
        operation: { id: "op-runtime" },
        files: expect.arrayContaining([expect.objectContaining({ path: "docs/project-plan.md" })])
      }
    });
    expect(JSON.stringify(runtime.inputs[0].providerPrompt)).not.toContain("accounting");
    expect(runtime.inputs[0].providerPrompt.estimatedTokens).toBeLessThan(runtime.inputs[0].context.accounting?.estimatedTokens ?? Number.POSITIVE_INFINITY);
  });

  it("lets workers search and read project files through a bounded request loop", async () => {
    const runtime = new ProjectContextRequestRuntime();
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);
    await runtimeStore.upsertVirtualFile("demo", {
      path: "docs/agent-loop.md",
      content: "# Agent Loop\n\nAGENT_LOOP_SENTINEL workers can request searches and then read selected files."
    });

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "project-context-request-loop" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const completed = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const secondPromptFiles = runtime.inputs[1].providerPrompt.context.files;
    const secondPromptArtifacts = runtime.inputs[1].providerPrompt.context.artifacts;
    const completedRun = completed.runs.find((candidate) => candidate.id === run.id)!;

    expect(runtime.inputs).toHaveLength(2);
    expect(secondPromptFiles.find((file) => file.path === "docs/agent-loop.md")?.excerpt).toContain("AGENT_LOOP_SENTINEL");
    expect(secondPromptFiles.find((file) => file.path.startsWith(".forgeos/search-results/"))?.excerpt).toContain("docs/agent-loop.md");
    expect(secondPromptArtifacts.find((artifact) => artifact.id === "artifact-strategy")?.contentSummary).toContain("AI organization runtime");
    expect(completed.files.find((file) => file.path === "docs/agent-loop-result.md")).toMatchObject({
      operationId: "op-runtime",
      workerId: "backend-worker"
    });
    expect(completedRun.providerMetadata.traceSummary).toMatchObject({
      outputs: expect.objectContaining({
        requestedFileCount: 1,
        requestedSearchCount: 1,
        requestedArtifactCount: 1,
        fileCount: 1
      })
    });
    expect(completed.events.some((event) => event.type === "run.progress" && event.message.includes("requested project context"))).toBe(true);
  });

  it("passes assembled context to the provider for scheduler dispatched runs", async () => {
    const runtime = new RecordingRuntime();
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);

    await runtimeStore.dispatch("demo", { type: "scheduler_tick", idempotencyKey: "scheduler-context-runtime" });
    await vi.waitFor(() => expect(runtime.inputs).toHaveLength(1));

    expect(runtime.inputs[0].operationId).toBe("op-runtime");
    expect(runtime.inputs[0].context.operation.id).toBe("op-runtime");
    expect(runtime.inputs[0].context.dependencies[0].operation.id).toBe("op-handoff-eng");
  });

  it("treats OpenClaw as a first-class provider and stores only sanitized correlation metadata", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new OpenClawContractRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "openclaw-contract" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const completed = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const completedRun = completed.runs.find((candidate) => candidate.id === run.id);
    const serialized = JSON.stringify(completed);

    expect(run.provider).toBe("openclaw");
    expect(completedRun).toMatchObject({
      externalRunId: "openclaw-run-1",
      providerMetadata: {
        model: "openclaw-coder",
        traceId: "trace-1"
      }
    });
    expect(serialized).not.toContain("hidden prompt");
    expect(serialized).not.toContain("test-provider-token");
    expect(serialized).not.toContain("rawProviderPayload");
    expect(completed.events.some((event) => "context" in event.payload)).toBe(false);
  });

  it("selects an operation runtime from agentProvider instead of repository provider", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new RecordingRuntime());

    const queued = await runtimeStore.dispatch("demo", {
      type: "run_operation",
      operationId: "op-runtime",
      agentProvider: "openclaw",
      idempotencyKey: "select-openclaw-provider"
    });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const completed = await waitForRunStatus(runtimeStore, "demo", run.id, "failed");

    expect(run.provider).toBe("openclaw");
    expect(completed.runs.find((candidate) => candidate.id === run.id)).toMatchObject({
      provider: "openclaw",
      status: "failed",
      error: "OpenClaw provider is not configured."
    });
  });

  it("projects provider-declared artifacts and files through the runtime contract", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new OpenClawContractRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "openclaw-outputs" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const artifact = snapshot.artifacts.find((candidate) => candidate.title === "OpenClaw Runtime Notes");
    const file = snapshot.files.find((candidate) => candidate.path === "notes/openclaw-runtime.md");
    const serializedEvents = JSON.stringify(snapshot.events);

    expect(artifact).toMatchObject({
      type: "implementation_notes",
      operationId: "op-runtime",
      workerId: "backend-worker",
      status: "generated",
      tags: ["openclaw", "runtime"]
    });
    expect(file).toMatchObject({
      operationId: "op-runtime",
      workerId: "backend-worker",
      status: "generated"
    });
    expect(artifact?.fileIds).toEqual(file ? [file.id] : []);
    expect(snapshot.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "artifact.created",
          targetId: artifact?.id,
          payload: expect.objectContaining({ artifactId: artifact?.id, operationId: "op-runtime" })
        })
      ])
    );
    expect(serializedEvents).not.toContain("Provider output projected into the virtual workspace.");
  });

  it("projects provider-declared handoffs, blockers, and sanitized trace summaries", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new OpenClawContractRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "openclaw-team-effects" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const completedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;
    const handoff = snapshot.handoffs.find((candidate) => candidate.summary === "Runtime contracts are ready for QA validation.");
    const operation = snapshot.operations.find((candidate) => candidate.id === "op-runtime");
    const worker = snapshot.workers.find((candidate) => candidate.id === "backend-worker");
    const serialized = JSON.stringify(snapshot);

    expect(handoff).toMatchObject({
      fromDivisionId: "engineering",
      toDivisionId: "qa",
      deliverables: ["Runtime notes", "Virtual workspace output"],
      confidence: 88
    });
    expect(operation).toMatchObject({
      status: "blocked",
      blockedReason: "QA must validate runtime output projection before release.",
      routingStage: "worker_ready"
    });
    expect(operation?.progress).toBeLessThan(100);
    expect(worker).toMatchObject({ status: "blocked" });
    expect(completedRun.providerMetadata.traceSummary).toMatchObject({
      outputs: {
        artifactCount: 1,
        fileCount: 1,
        handoffCount: 1,
        blockerCount: 1,
        omittedCount: 0
      }
    });
    expect(snapshot.events.map((event) => event.type)).toEqual(expect.arrayContaining(["handoff.created", "operation.blocked"]));
    expect(snapshot.events.filter((event) => event.type === "run.completed" && event.payload.runId === run.id)).toHaveLength(1);
    expect(serialized).not.toContain("hidden completion payload");
  });

  it("does not convert informational coordination status into a hard blocker", async () => {
    const baseSnapshot = createDemoSnapshot();
    const snapshotWithCoordinationOperation = {
      ...baseSnapshot,
      operations: baseSnapshot.operations.map((operation) =>
        operation.id === "op-runtime"
          ? {
              ...operation,
              title: "Coordinate attention-needed operations and dependency routing for MVP execution",
              description: "Use the current operations set to identify items needing attention, unblock follow-on work, and keep the build queued for later execution."
            }
          : operation
      )
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshotWithCoordinationOperation), new CoordinationStatusRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "coordination-status" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const operation = snapshot.operations.find((candidate) => candidate.id === "op-runtime");

    expect(operation).toMatchObject({
      status: "completed",
      blockedReason: undefined,
      progress: 100
    });
    expect(snapshot.events.filter((event) => event.type === "operation.blocked" && event.targetId === "op-runtime")).toHaveLength(0);
    expect(snapshot.events.map((event) => event.type)).toEqual(expect.arrayContaining(["artifact.created", "handoff.created"]));
    expect(snapshot.runs.find((candidate) => candidate.id === run.id)?.providerMetadata.traceSummary).toMatchObject({
      outputs: {
        blockerCount: 0,
        omittedCount: 1
      }
    });
  });

  it("repairs existing completed coordination operations saved with informational blockers", async () => {
    const baseSnapshot = createDemoSnapshot();
    const blockedOperation = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-runtime")!,
      title: "Coordinate attention-needed operations and dependency routing for MVP execution",
      description: "Use the current operations set to identify items needing attention, unblock follow-on work, and keep the build queued for later execution.",
      status: "blocked" as const,
      routingStage: "worker_ready" as const,
      progress: 90,
      blockedReason: "Scheduler reports no currently eligible operations beyond the routed attention/dependency items; work is dependency-gated rather than blocked by missing execution capacity."
    };
    const repairedSnapshot = {
      ...baseSnapshot,
      operations: baseSnapshot.operations.map((operation) => (operation.id === blockedOperation.id ? blockedOperation : operation)),
      runs: [
        ...baseSnapshot.runs,
        {
          id: "coordination-run",
          forgeId: baseSnapshot.forge.id,
          operationId: blockedOperation.id,
          workerId: blockedOperation.workerId,
          provider: "mock" as const,
          status: "completed" as const,
          queuedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          capabilities: new MockRuntime().capabilities(),
          providerMetadata: {}
        }
      ]
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(repairedSnapshot), new MockRuntime());

    const snapshot = await runtimeStore.getSnapshot("demo");

    expect(snapshot.operations.find((operation) => operation.id === blockedOperation.id)).toMatchObject({
      status: "completed",
      progress: 100,
      blockedReason: undefined,
      routingStage: "done"
    });
  });

  it("routes missing project-structure blockers back to Executive for replanning", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new MissingProjectStructureRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "missing-structure-run" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");

    expect(snapshot.operations.find((candidate) => candidate.id === "op-runtime")).toMatchObject({
      status: "blocked",
      blockedReason: expect.stringContaining("package manifest")
    });
    const prerequisite = snapshot.operations.find((candidate) => candidate.title.includes("Create project scaffold and data contract"));
    expect(prerequisite).toMatchObject({
      status: "ready",
      priority: "high"
    });
    expect(snapshot.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "op-runtime",
          dependsOnOperationId: prerequisite?.id,
          type: "blocks"
        })
      ])
    );
    expect(snapshot.events.some((event) => event.type === "executive.review_requested" && event.payload.runId === run.id && event.payload.category === "missing_project_structure")).toBe(true);
    expect(snapshot.messages.some((message) => message.kind === "executive_summary" && message.status === "review_requested" && message.content.includes("create the missing prerequisite work"))).toBe(true);
  });

  it("routes provider-declared verification readiness blockers into implementation repair work", async () => {
    const baseSnapshot = createDemoSnapshot();
    const snapshot = {
      ...baseSnapshot,
      operations: baseSnapshot.operations.map((operation) =>
        operation.id === "op-tests"
          ? {
              ...operation,
              status: "ready" as const,
              routingStage: "worker_ready" as const,
              blockedReason: undefined
            }
          : operation.id === "op-runtime"
            ? {
                ...operation,
                status: "completed" as const,
                progress: 100
              }
            : operation
      )
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new VerificationFailedReadinessRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-tests", idempotencyKey: "verification-readiness-blocker" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-tests")!;
    const completed = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const repair = completed.operations.find((operation) => operation.title.includes("Repair verification failure"));

    expect(completed.operations.find((operation) => operation.id === "op-tests")).toMatchObject({
      status: "blocked",
      blockedReason: expect.stringContaining("release readiness cannot be confirmed")
    });
    expect(repair).toMatchObject({
      status: "ready",
      divisionId: "engineering",
      workerId: expect.any(String)
    });
    expect(completed.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "op-tests",
          dependsOnOperationId: repair?.id
        })
      ])
    );
    expect(completed.events.some((event) => event.type === "executive.review_requested" && event.payload.runId === run.id && event.payload.category === "verification_repair_required")).toBe(true);
    expect(completed.events.some((event) => event.type === "operation.created" && event.payload.reason === "verification_repair_required")).toBe(true);
  });

  it("creates missing prerequisite work on scheduler tick for already-blocked operations", async () => {
    const snapshot = {
      ...createDemoSnapshot(),
      operations: createDemoSnapshot().operations.map((operation) =>
        operation.id === "op-runtime"
          ? {
              ...operation,
              status: "blocked" as const,
              blockedReason: "No existing workspace source files for the app shell, components, or package manifest were available.",
              progress: 90
            }
          : operation
      )
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new DeferredRuntime());

    const scheduled = await runtimeStore.dispatch("demo", { type: "scheduler_tick", idempotencyKey: "missing-prerequisite-scheduler" });
    const prerequisite = scheduled.operations.find((operation) => operation.title.includes("Create project scaffold and data contract"));

    expect(prerequisite).toMatchObject({ status: "running" });
    expect(scheduled.runs.find((run) => run.operationId === prerequisite?.id && isActiveRun(run))).toBeDefined();
    expect(scheduled.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "op-runtime",
          dependsOnOperationId: prerequisite?.id
        })
      ])
    );
  });

  it("links similar open prerequisite work instead of creating duplicate operations", async () => {
    const baseSnapshot = createDemoSnapshot();
    const existingPrerequisite = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-runtime")!,
      id: "existing-project-scaffold",
      title: "Create project scaffold and data contract for initial QA",
      description: "Create package.json, app shell entry point, component directories, and the data contract needed before QA can verify the project.",
      divisionId: "engineering",
      workerId: "backend-worker",
      status: "blocked" as const,
      blockedReason: "Waiting for implementation details.",
      progress: 20,
      outputArtifactIds: []
    };
    const blockedQa = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-tests")!,
      status: "blocked" as const,
      blockedReason: "No package manifest, app shell, or source files were available for QA verification.",
      progress: 90
    };
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence({
        ...baseSnapshot,
        operations: [...baseSnapshot.operations.map((operation) => (operation.id === "op-tests" ? blockedQa : operation)), existingPrerequisite]
      }),
      new DeferredRuntime()
    );

    const scheduled = await runtimeStore.dispatch("demo", { type: "scheduler_tick", idempotencyKey: "reuse-existing-prerequisite" });
    const scaffoldOperations = scheduled.operations.filter((operation) => operation.title.includes("Create project scaffold and data contract"));

    expect(scaffoldOperations).toHaveLength(1);
    expect(scheduled.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "op-tests",
          dependsOnOperationId: "existing-project-scaffold"
        })
      ])
    );
    expect(scheduled.events.some((event) => event.type === "operation.created" && event.payload.blockedOperationId === "op-tests")).toBe(false);
  });

  it("does not emit duplicate Executive replan requests for the same unresolved blocker", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new MissingProjectStructureRuntime());

    const firstQueued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "missing-structure-first" });
    const firstRun = firstQueued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    await waitForRunStatus(runtimeStore, "demo", firstRun.id, "completed");
    const readyAgain = await runtimeStore.getSnapshot("demo");
    const blockedOperation = readyAgain.operations.find((operation) => operation.id === "op-runtime")!;
    const secondStore = new RuntimeStore(
      new InMemoryRuntimePersistence({
        ...readyAgain,
        dependencies: readyAgain.dependencies.filter((dependency) => dependency.operationId !== "op-runtime"),
        operations: readyAgain.operations.map((operation) =>
          operation.id === "op-runtime"
            ? {
                ...blockedOperation,
                status: "ready" as const,
                routingStage: "worker_ready" as const,
                blockedReason: undefined
              }
            : operation
        )
      }),
      new MissingProjectStructureRuntime()
    );

    const secondQueued = await secondStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "missing-structure-second" });
    const secondRun = secondQueued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(secondStore, "demo", secondRun.id, "completed");
    const reviewEvents = snapshot.events.filter((event) => event.type === "executive.review_requested" && event.payload.operationId === "op-runtime" && event.payload.category === "missing_project_structure");

    expect(reviewEvents).toHaveLength(1);
  });

  it("creates upstream prerequisite work for blocked validation operations missing implementation context", async () => {
    const baseSnapshot = createDemoSnapshot();
    const snapshot = {
      ...baseSnapshot,
      operations: baseSnapshot.operations.map((operation) =>
        operation.id === "op-tests"
          ? {
              ...operation,
              status: "blocked" as const,
              blockedReason: "Missing implementation context prevents concrete QA verification of real output.",
              progress: 90
            }
          : operation
      )
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new DeferredRuntime());

    const scheduled = await runtimeStore.dispatch("demo", { type: "scheduler_tick", idempotencyKey: "missing-implementation-context-scheduler" });
    const prerequisite = scheduled.operations.find((operation) => operation.title.includes("Produce prerequisite implementation context"));

    expect(prerequisite).toMatchObject({
      status: "ready",
      divisionId: "engineering",
      workerId: expect.any(String)
    });
    expect(scheduled.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "op-tests",
          dependsOnOperationId: prerequisite?.id
        })
      ])
    );
    expect(scheduled.events.some((event) => event.type === "operation.created" && event.payload.reason === "missing_prerequisite_context")).toBe(true);
  });

  it("creates implementation repair work for blocked validation operations with failed runtime verification", async () => {
    const baseSnapshot = createDemoSnapshot();
    const snapshot = {
      ...baseSnapshot,
      operations: baseSnapshot.operations.map((operation) =>
        operation.id === "op-tests"
          ? {
              ...operation,
              status: "blocked" as const,
              blockedReason: "Runtime verification for the implementation already failed, so release readiness cannot be confirmed.",
              progress: 90
            }
          : operation
      )
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new DeferredRuntime());

    const scheduled = await runtimeStore.dispatch("demo", { type: "scheduler_tick", idempotencyKey: "verification-repair-scheduler" });
    const repair = scheduled.operations.find((operation) => operation.title.includes("Repair verification failure"));

    expect(repair).toMatchObject({
      status: "ready",
      divisionId: "engineering",
      workerId: expect.any(String),
      priority: "high"
    });
    expect(repair?.description).toContain("Inspect the failed runtime checks");
    expect(scheduled.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "op-tests",
          dependsOnOperationId: repair?.id
        })
      ])
    );
    expect(scheduled.events.some((event) => event.type === "operation.created" && event.payload.reason === "verification_repair_required")).toBe(true);
  });

  it("repairs cyclic blocking dependencies before scheduling ready repair work", async () => {
    const baseSnapshot = createDemoSnapshot();
    const primaryRepair = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-runtime")!,
      id: "primary-verification-repair",
      title: "Repair verification failure for QA validation",
      description: "Inspect failed runtime checks, patch the implementation defect, and rerun verification.",
      status: "ready" as const,
      routingStage: "worker_ready" as const,
      priority: "high" as const,
      progress: 90,
      blockedReason: "Runtime verification evidence is missing."
    };
    const nestedRepair = {
      ...primaryRepair,
      id: "nested-verification-repair",
      title: "Repair verification failure for Repair verification failure for QA validation",
      status: "blocked" as const,
      progress: 20,
      blockedReason: "Waiting for Repair verification failure for QA validation."
    };
    const snapshot = {
      ...baseSnapshot,
      operations: [
        ...baseSnapshot.operations.map((operation) =>
          operation.id === "op-tests"
            ? {
                ...operation,
                status: "blocked" as const,
                blockedReason: "Runtime verification for the implementation already failed, so release readiness cannot be confirmed.",
                progress: 90
              }
            : {
                ...operation,
                status: "completed" as const,
                routingStage: "done" as const,
                progress: 100,
                blockedReason: undefined
              }
        ),
        primaryRepair,
        nestedRepair
      ],
      dependencies: [
        ...baseSnapshot.dependencies,
        {
          id: "dep-qa-primary-repair",
          operationId: "op-tests",
          dependsOnOperationId: primaryRepair.id,
          type: "blocks" as const
        },
        {
          id: "dep-primary-nested-repair",
          operationId: primaryRepair.id,
          dependsOnOperationId: nestedRepair.id,
          type: "blocks" as const
        },
        {
          id: "dep-nested-primary-repair",
          operationId: nestedRepair.id,
          dependsOnOperationId: primaryRepair.id,
          type: "blocks" as const
        }
      ]
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new DeferredRuntime());

    const scheduled = await runtimeStore.dispatch("demo", { type: "scheduler_tick", idempotencyKey: "cyclic-repair-dependencies" });

    expect(scheduled.dependencies).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "dep-primary-nested-repair"
        })
      ])
    );
    expect(scheduled.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "operation.blocked",
          payload: expect.objectContaining({
            reason: "blocking_dependency_cycle_repaired",
            removedDependencyId: "dep-primary-nested-repair"
          })
        })
      ])
    );
    expect(scheduled.operations.find((operation) => operation.id === primaryRepair.id)).toMatchObject({ status: "running" });
    expect(scheduled.runs.find((run) => run.operationId === primaryRepair.id && isActiveRun(run))).toBeDefined();
  });

  it("does not recreate cyclic duplicate repair dependencies after approval repair routing", async () => {
    const baseSnapshot = createDemoSnapshot();
    const primaryRepair = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-runtime")!,
      id: "primary-verification-repair",
      title: "Repair verification failure for QA validation",
      description: "Repair failed runtime verification for the QA validation operation.",
      status: "blocked" as const,
      routingStage: "worker_ready" as const,
      priority: "high" as const,
      progress: 90,
      blockedReason: "Verification cannot be completed because runtime evidence is missing."
    };
    const nestedRepair = {
      ...primaryRepair,
      id: "nested-verification-repair",
      title: "Repair verification failure for Repair verification failure for QA validation",
      blockedReason: "Waiting for missing implementation context from the original repair operation."
    };
    const reviewId = "review-duplicate-repair-loop";
    const snapshot = {
      ...baseSnapshot,
      operations: [
        ...baseSnapshot.operations.map((operation) => ({
          ...operation,
          status: "completed" as const,
          routingStage: "done" as const,
          progress: 100,
          blockedReason: undefined
        })),
        primaryRepair,
        nestedRepair
      ],
      dependencies: [
        {
          id: "dep-primary-nested-repair",
          operationId: primaryRepair.id,
          dependsOnOperationId: nestedRepair.id,
          type: "blocks" as const
        },
        {
          id: "dep-nested-primary-repair",
          operationId: nestedRepair.id,
          dependsOnOperationId: primaryRepair.id,
          type: "blocks" as const
        }
      ],
      events: [
        ...baseSnapshot.events,
        {
          id: "event-review-duplicate-repair-loop",
          forgeId: baseSnapshot.forge.id,
          sequence: baseSnapshot.lastEventSequence + 1,
          type: "executive.review_requested" as const,
          actorType: "executive" as const,
          targetType: "operation" as const,
          targetId: nestedRepair.id,
          message: "Executive replanning required: repair work needs missing implementation context.",
          severity: "warning" as const,
          payload: {
            reviewId,
            operationId: nestedRepair.id,
            category: "missing_prerequisite_context"
          },
          createdAt: new Date().toISOString()
        }
      ],
      lastEventSequence: baseSnapshot.lastEventSequence + 1
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new DeferredRuntime());

    const approved = await runtimeStore.dispatch("demo", {
      type: "approve_executive_review",
      reviewId,
      idempotencyKey: "approve-duplicate-repair-loop"
    });

    expect(approved.dependencies).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "dep-primary-nested-repair" })]));
    expect(approved.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ id: "dep-nested-primary-repair" })]));
    expect(approved.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "operation.blocked",
          payload: expect.objectContaining({
            reason: "blocking_dependency_cycle_repaired",
            removedDependencyId: "dep-primary-nested-repair"
          })
        })
      ])
    );

    const scheduled = await runtimeStore.dispatch("demo", {
      type: "scheduler_tick",
      idempotencyKey: "schedule-after-duplicate-repair-loop"
    });

    expect(scheduled.operations.find((operation) => operation.id === primaryRepair.id)).toMatchObject({ status: "running" });
    expect(scheduled.dependencies).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "dep-primary-nested-repair" })]));
  });

  it("stamps, accepts, and consumes targeted handoffs through the team loop", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new TargetedHandoffRuntime());

    await runtimeStore.dispatch("demo", { type: "run_bounded_cycle", maxRuns: 2, idempotencyKey: "targeted-cycle" });
    const snapshot = await waitForCycleCompleted(runtimeStore, "demo", "max_runs_reached");
    const handoff = snapshot.handoffs.find((candidate) => candidate.summary === "Runtime output is ready for QA.");
    const qaRun = snapshot.runs.find((candidate) => candidate.operationId === "op-tests");
    const summary = snapshot.messages.find((message) => message.kind === "executive_summary" && message.source === "cycle_terminal");

    expect(snapshot.runs.filter((run) => run.status === "completed")).toHaveLength(2);
    expect(handoff).toMatchObject({
      fromDivisionId: "engineering",
      fromOperationId: "op-runtime",
      fromRunId: expect.stringContaining("op-runtime"),
      targetOperationId: "op-tests",
      status: "consumed",
      acceptedByOperationId: "op-tests",
      artifactIds: expect.arrayContaining([expect.stringContaining("provider-artifact")]),
      fileIds: expect.arrayContaining([expect.stringContaining("provider-file")]),
      contextAttachmentSource: "inferred"
    });
    expect(qaRun?.status).toBe("completed");
    expect(snapshot.events.map((event) => event.type)).toEqual(expect.arrayContaining(["cycle.started", "cycle.progress", "cycle.completed", "handoff.accepted", "handoff.consumed", "executive.summary_created"]));
    expect(snapshot.events.some((event) => event.type === "context.routed" && event.payload.runId === qaRun?.id)).toBe(true);
    expect(summary?.summary).toMatchObject({ scope: "cycle", status: "max_runs_reached", metricDeltas: { completedRuns: 2, maxRuns: 2 } });
  });

  it("omits provider handoffs with invalid target operations", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new InvalidTargetHandoffRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "invalid-target-handoff" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const completedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;

    expect(snapshot.handoffs.some((handoff) => handoff.summary === "Invalid target handoff")).toBe(false);
    expect(completedRun.providerMetadata.traceSummary).toMatchObject({
      outputs: {
        handoffCount: 1,
        omittedCount: 1,
        omissionReasons: [expect.stringContaining("target operation missing-operation")]
      }
    });
  });

  it("preserves explicit handoff artifact and file attachments without inferring same-run outputs", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new ExplicitContextHandoffRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "explicit-context-handoff" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const handoff = snapshot.handoffs.find((candidate) => candidate.summary === "Use explicitly declared existing context.");

    expect(handoff).toMatchObject({
      artifactIds: ["artifact-strategy"],
      fileIds: ["file-plan"],
      contextAttachmentSource: "explicit"
    });
    expect(handoff?.artifactIds.some((id) => id.includes("provider-artifact"))).toBe(false);
    expect(handoff?.fileIds.some((id) => id.includes("provider-file"))).toBe(false);
  });

  it("omits invalid provider outputs and records validation omissions in trace summary", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new InvalidOutputsRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "invalid-output-trace" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const completedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.artifacts.some((artifact) => artifact.title === "Valid Note")).toBe(true);
    expect(snapshot.artifacts.some((artifact) => artifact.content === "missing title")).toBe(false);
    expect(snapshot.files.some((file) => file.path === "notes/valid.md")).toBe(true);
    expect(snapshot.files.some((file) => file.path.includes("secret"))).toBe(false);
    expect(snapshot.handoffs.some((handoff) => handoff.summary === "Valid QA handoff")).toBe(true);
    expect(snapshot.handoffs.some((handoff) => handoff.summary === "invalid handoff")).toBe(false);
    expect(completedRun.providerMetadata.traceSummary).toMatchObject({
      outputs: {
        artifactCount: 1,
        fileCount: 1,
        handoffCount: 1,
        blockerCount: 1,
        omittedCount: 4
      }
    });
    expect(serialized).not.toContain("hidden mixed payload");
    expect(serialized).not.toContain("invalid path");
  });

  it("retries unusable worker output with a sanitized same-worker repair brief", async () => {
    const runtime = new SelfRepairingInvalidOutputRuntime();
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "self-repair-invalid-output" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const completedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;
    const repairedPrompt = runtime.prompts[1]?.providerPrompt;
    const serialized = JSON.stringify(snapshot);

    expect(runtime.prompts).toHaveLength(2);
    expect(repairedPrompt.repairBrief).toMatchObject({
      failureCategory: "schema_validation_failed",
      whatFailed: expect.stringContaining("usable declarations")
    });
    expect(snapshot.operations.find((operation) => operation.id === "op-runtime")?.retryCount).toBe(1);
    expect(snapshot.artifacts.some((artifact) => artifact.title === "Repaired Note")).toBe(true);
    expect(snapshot.events.some((event) => event.type === "run.retry_requested" && event.payload.failureCategory === "schema_validation_failed")).toBe(true);
    expect(snapshot.events.some((event) => event.type === "run.retry_started" && event.payload.failureCategory === "schema_validation_failed")).toBe(true);
    expect(completedRun.providerMetadata).toMatchObject({
      repairBriefSummary: {
        failureCategory: "schema_validation_failed"
      },
      traceSummary: {
        lifecycle: {
          selfRepairAttemptCount: 1
        }
      }
    });
    expect(serialized).not.toContain("secret raw output");
  });

  it("escalates to the division lead after two failed self-repair attempts", async () => {
    const runtime = new AlwaysInvalidOutputRuntime();
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "self-repair-exhausted" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "failed");
    const failedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;
    const operation = snapshot.operations.find((candidate) => candidate.id === "op-runtime")!;

    expect(runtime.prompts).toHaveLength(3);
    expect(operation).toMatchObject({
      status: "ready",
      retryCount: 2,
      workerId: "eng-director",
      routingStage: "lead_triaged",
      escalationRunId: run.id,
      escalationFailureCategory: "schema_validation_failed"
    });
    expect(snapshot.operations.some((candidate) => candidate.title === "Lead triage: Implement runtime contracts")).toBe(false);
    expect(snapshot.events.some((event) => event.type === "run.retry_exhausted" && event.payload.failureCategory === "schema_validation_failed")).toBe(true);
    expect(snapshot.events.some((event) => event.type === "operation.escalated" && event.payload.leadWorkerId === "eng-director")).toBe(true);
    expect(failedRun.providerMetadata).toMatchObject({
      finalFailureCategory: "schema_validation_failed",
      traceSummary: {
        lifecycle: {
          escalationCount: 1,
          finalFailureCategory: "schema_validation_failed"
        }
      }
    });
  });

  it("classifies pure provider failures without same-worker self-repair", async () => {
    const cases = [
      {
        name: "timeout",
        payload: { rateLimit: { terminalReason: "provider_timeout" }, providerMetadata: { category: "provider_timeout" } },
        category: "provider_timeout"
      },
      {
        name: "network",
        payload: { rateLimit: { terminalReason: "network_error" }, providerMetadata: { category: "network_error" } },
        category: "network_error"
      },
      {
        name: "rate",
        payload: { rateLimit: { terminalReason: "retry_exhausted", attempts: 4 } },
        category: "rate_limited"
      },
      {
        name: "http",
        payload: { providerMetadata: { category: "provider_http_error", httpStatus: 500, providerErrorCode: "server_error" } },
        category: "provider_http_error",
        selfRepairable: true
      }
    ];

    for (const item of cases) {
      const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new ProviderFailureRuntime(item.payload));
      const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: `provider-${item.name}` });
      const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
      const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "failed");

      expect(snapshot.runs.find((candidate) => candidate.id === run.id)?.providerMetadata).toMatchObject({
        finalFailureCategory: item.category
      });
      expect(snapshot.operations.find((operation) => operation.id === "op-runtime")).toMatchObject({
        status: "ready",
        workerId: "eng-director",
        retryCount: item.selfRepairable ? 2 : 0,
        routingStage: "lead_triaged",
        escalationRunId: run.id,
        escalationFailureCategory: item.category
      });
      expect(snapshot.operations.some((operation) => operation.title.startsWith("Lead triage:"))).toBe(false);
      expect(snapshot.events.some((event) => event.type === "run.retry_requested" && event.payload.failureCategory === item.category)).toBe(item.selfRepairable === true);
      expect(snapshot.events.some((event) => event.type === "operation.escalated" && event.payload.failureCategory === item.category)).toBe(true);
    }
  });

  it("lets a lead revise the original operation and return it to worker-ready", async () => {
    const runtime = new LeadRecoveryRuntime({
      type: "revise_operation",
      targetOperationId: "op-runtime",
      title: "Implement runtime contracts safely",
      description: "Retry with a narrower contract implementation brief.",
      workerId: "backend-worker",
      reason: "Original brief was too broad."
    });
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "lead-revise-original" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const escalated = await waitForRunStatus(runtimeStore, "demo", run.id, "failed");
    const leadTriage = escalated.operations.find((operation) => operation.id === "op-runtime")!;
    await runtimeStore.dispatch("demo", { type: "run_operation", operationId: leadTriage.id, idempotencyKey: "lead-revise-triage" });
    const snapshot = await waitForOperationStatus(runtimeStore, "demo", leadTriage.id, "ready");

    expect(runtime.inputs.at(-1)?.providerPrompt.context.operation).toMatchObject({
      escalationRunId: run.id,
      escalationFailureCategory: "schema_validation_failed"
    });
    expect(JSON.stringify(runtime.inputs.at(-1)?.providerPrompt)).not.toContain("secret raw output");
    expect(snapshot.operations.find((operation) => operation.id === "op-runtime")).toMatchObject({
      status: "ready",
      routingStage: "worker_ready",
      title: "Implement runtime contracts safely",
      retryCount: 0
    });
    expect(snapshot.events.some((event) => event.type === "operation.ready" && event.payload.action === "revise_operation")).toBe(true);
  });

  it("lets a lead create same-division replacement work", async () => {
    const runtime = new LeadRecoveryRuntime({
      type: "create_replacement_operation",
      title: "Replacement runtime contract pass",
      description: "Create a narrower worker-ready implementation task.",
      workerId: "backend-worker",
      reason: "Replace failed work with scoped follow-up."
    });
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "lead-replacement-original" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const escalated = await waitForRunStatus(runtimeStore, "demo", run.id, "failed");
    const leadTriage = escalated.operations.find((operation) => operation.id === "op-runtime")!;
    await runtimeStore.dispatch("demo", { type: "run_operation", operationId: leadTriage.id, idempotencyKey: "lead-replacement-triage" });
    const snapshot = await waitForOperationStatus(runtimeStore, "demo", leadTriage.id, "ready");
    const replacement = snapshot.operations.find((operation) => operation.id === "op-runtime")!;

    expect(replacement).toMatchObject({
      divisionId: "engineering",
      workerId: "backend-worker",
      status: "ready",
      routingStage: "worker_ready",
      title: "Replacement runtime contract pass"
    });
    expect(snapshot.operations.filter((operation) => operation.title === "Replacement runtime contract pass")).toHaveLength(1);
  });

  it("escalates repeated lead triage failure to Executive", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new AlwaysInvalidOutputRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "lead-fail-original" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const escalated = await waitForRunStatus(runtimeStore, "demo", run.id, "failed");
    const leadTriage = escalated.operations.find((operation) => operation.id === "op-runtime")!;
    const leadQueued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: leadTriage.id, idempotencyKey: "lead-fail-triage" });
    const leadRun = leadQueued.runs.filter((candidate) => candidate.operationId === leadTriage.id).at(-1)!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", leadRun.id, "failed");

    expect(snapshot.runs.find((candidate) => candidate.id === leadRun.id)?.providerMetadata).toMatchObject({
      finalFailureCategory: "lead_triage_failed"
    });
    expect(snapshot.events.some((event) => event.type === "executive.review_requested" && event.payload.failureCategory === "lead_triage_failed")).toBe(true);
    expect(snapshot.messages.some((message) => message.status === "escalated" && message.operationId === "op-runtime")).toBe(true);
  });

  it("creates asset artifacts for provider-generated files even when artifacts are omitted", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new FileOnlyRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "file-only-output" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const file = snapshot.files.find((candidate) => candidate.path === "app/menu-search.tsx");
    const artifact = snapshot.artifacts.find((candidate) => candidate.title === "Generated file: app/menu-search.tsx");
    const completedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;

    expect(file).toMatchObject({
      operationId: "op-runtime",
      artifactIds: artifact ? expect.arrayContaining([artifact.id]) : []
    });
    expect(artifact).toMatchObject({
      type: "implementation_file",
      operationId: "op-runtime",
      fileIds: file ? expect.arrayContaining([file.id]) : []
    });
    expect(completedRun.providerMetadata.traceSummary).toMatchObject({
      outputs: {
        artifactCount: 2,
        fileCount: 2
      }
    });
    expect(snapshot.events.map((event) => event.type)).toEqual(expect.arrayContaining(["artifact.created"]));
  });

  it("runs automatic verification without exposing host secrets to provider-generated scripts", async () => {
    const workspaceRoot = await createTempDir();
    process.env.FORGEOS_EXECUTION_WORKSPACE_ROOT = workspaceRoot;
    process.env.FORGEOS_FAKE_HOST_SECRET = "forgeos-store-host-secret-12345";
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new GeneratedPackageRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "default-verification-env-isolated" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const completedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;

    expect(completedRun.providerMetadata.verificationSummary).toMatchObject({
      source: "runtime",
      status: "passed",
      providerShellAccess: false,
      checks: [
        {
          name: "npm test",
          status: "passed",
          message: "Verification command passed."
        }
      ]
    });
    expect(completedRun.providerMetadata.traceSummary).toMatchObject({
      outputs: {
        verificationEvidence: {
          commands: ["npm test"],
          expectedScripts: ["test"],
          summary: "Generated package includes a test script that proves host [redacted]s are not visible.",
          knownGaps: []
        }
      }
    });
    expect(JSON.stringify(completedRun.providerMetadata.verificationSummary)).not.toContain("forgeos-store-host-secret-12345");
  });

  it("does not complete code-producing operations when runtime verification is skipped", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new UnverifiedCodeRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "unverified-code-output" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "failed");
    const failedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;
    const operation = snapshot.operations.find((candidate) => candidate.id === "op-runtime")!;

    expect(operation).toMatchObject({
      status: "ready",
      workerId: "eng-director",
      routingStage: "lead_triaged",
      escalationRunId: run.id,
      escalationFailureCategory: "verification_failed"
    });
    expect(operation.blockedReason).toBeUndefined();
    expect(failedRun.providerMetadata).toMatchObject({
      finalFailureCategory: "verification_failed",
      verificationSummary: {
        status: "skipped",
        omittedReasons: [expect.stringContaining("package.json")]
      }
    });
  });

  it("runs automatic verification against existing virtual workspace files as well as projected files", async () => {
    const workspaceRoot = await createTempDir();
    process.env.FORGEOS_EXECUTION_WORKSPACE_ROOT = workspaceRoot;
    const baseSnapshot = createDemoSnapshot();
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence({
        ...baseSnapshot,
        files: [
          ...baseSnapshot.files,
          {
            id: "existing-verification-file",
            path: "verify-existing.js",
            content: "require('node:fs').accessSync('docs/project-plan.md'); console.log('existing workspace file ok');",
            status: "generated",
            version: 1,
            divisionId: "engineering",
            workerId: "backend-worker",
            operationId: "op-handoff-eng",
            artifactIds: [],
            updatedAt: new Date().toISOString()
          }
        ]
      }),
      new PackageUsingExistingWorkspaceFileRuntime()
    );

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "workspace-verification-existing-file" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const completedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;

    expect(completedRun.providerMetadata.verificationSummary).toMatchObject({
      source: "runtime",
      status: "passed",
      checks: [
        {
          name: "npm test",
          status: "passed"
        }
      ]
    });
  });

  it("uses acceptance verification for QA and iterates after failed project checks", async () => {
    const workspaceRoot = await createTempDir();
    process.env.FORGEOS_EXECUTION_WORKSPACE_ROOT = workspaceRoot;
    const baseSnapshot = createDemoSnapshot();
    const runtime = new AcceptanceRepairRuntime();
    const implementationOperation = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-runtime")!,
      status: "completed" as const,
      progress: 100,
      outputArtifactIds: ["artifact-implementation"]
    };
    const qaOperation = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-tests")!,
      title: "QA acceptance test the generated project",
      divisionId: "qa",
      workerId: "qa-runner-alpha",
      status: "ready" as const,
      routingStage: "worker_ready" as const,
      blockedReason: undefined
    };
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence({
        ...baseSnapshot,
        divisions: baseSnapshot.divisions.map((division) => (division.id === "qa" ? { ...division, leadWorkerId: "qa-director" } : division)),
        workers: [
          ...baseSnapshot.workers,
          {
            ...baseSnapshot.workers[0],
            id: "qa-director",
            divisionId: "qa",
            name: "QA Director",
            role: "QA division lead",
            kind: "lead" as const,
            managerWorkerId: undefined,
            status: "idle" as const,
            currentTask: undefined
          }
        ],
        operations: baseSnapshot.operations.map((operation) => (operation.id === "op-runtime" ? implementationOperation : operation.id === "op-tests" ? qaOperation : operation)),
        files: [
          ...baseSnapshot.files,
          {
            id: "implementation-file",
            path: "src/app/page.tsx",
            content: "export default function Page() { return null; }",
            status: "generated",
            version: 1,
            divisionId: "engineering",
            workerId: "backend-worker",
            operationId: "op-runtime",
            artifactIds: ["artifact-implementation"],
            updatedAt: new Date().toISOString()
          }
        ]
      }),
      runtime
    );

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-tests", idempotencyKey: "acceptance-verification-repair" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-tests")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const completedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;

    expect(runtime.attempts).toBe(2);
    expect(snapshot.events.some((event) => event.type === "run.retry_requested" && event.payload.failureCategory === "verification_failed")).toBe(true);
    expect(completedRun.providerMetadata.verificationSummary).toMatchObject({
      source: "runtime",
      status: "passed",
      tier: "acceptance",
      checks: [
        { name: "npm test", status: "passed" },
        { name: "npm run build", status: "passed" }
      ]
    });
  });

  it("escalates exhausted QA verification failures to the division lead with check details", async () => {
    const workspaceRoot = await createTempDir();
    process.env.FORGEOS_EXECUTION_WORKSPACE_ROOT = workspaceRoot;
    const baseSnapshot = createDemoSnapshot();
    const runtime = new AcceptanceFailureRuntime();
    const implementationOperation = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-runtime")!,
      status: "completed" as const,
      progress: 100,
      outputArtifactIds: ["artifact-implementation"]
    };
    const qaOperation = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-tests")!,
      title: "QA acceptance test the generated project",
      divisionId: "qa",
      workerId: "qa-runner-alpha",
      status: "ready" as const,
      routingStage: "worker_ready" as const,
      blockedReason: undefined
    };
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence({
        ...baseSnapshot,
        divisions: baseSnapshot.divisions.map((division) => (division.id === "qa" ? { ...division, leadWorkerId: "qa-director" } : division)),
        workers: [
          ...baseSnapshot.workers,
          {
            ...baseSnapshot.workers[0],
            id: "qa-director",
            divisionId: "qa",
            name: "QA Director",
            role: "QA division lead",
            kind: "lead" as const,
            managerWorkerId: undefined,
            status: "idle" as const,
            currentTask: undefined
          }
        ],
        operations: baseSnapshot.operations.map((operation) => (operation.id === "op-runtime" ? implementationOperation : operation.id === "op-tests" ? qaOperation : operation)),
        files: [
          ...baseSnapshot.files,
          {
            id: "implementation-file",
            path: "src/app/page.tsx",
            content: "export default function Page() { return null; }",
            status: "generated",
            version: 1,
            divisionId: "engineering",
            workerId: "backend-worker",
            operationId: "op-runtime",
            artifactIds: ["artifact-implementation"],
            updatedAt: new Date().toISOString()
          }
        ]
      }),
      runtime
    );

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-tests", idempotencyKey: "acceptance-verification-escalation" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-tests")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "failed");
    const failedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;
    const operation = snapshot.operations.find((candidate) => candidate.id === "op-tests")!;

    expect(runtime.attempts).toBe(4);
    expect(operation).toMatchObject({
      status: "ready",
      workerId: "qa-director",
      routingStage: "lead_triaged",
      escalationRunId: run.id,
      escalationFailureCategory: "verification_failed"
    });
    expect(snapshot.operations.some((candidate) => candidate.escalatedFromOperationId === "op-tests")).toBe(false);
    expect(failedRun.providerMetadata).toMatchObject({
      finalFailureCategory: "verification_failed",
      verificationSummary: {
        status: "failed",
        tier: "acceptance",
        checks: [{ name: "npm test", status: "failed" }]
      }
    });
    expect(snapshot.events.some((event) => event.type === "operation.escalated" && event.payload.failureCategory === "verification_failed")).toBe(true);
  });

  it("escalates to Executive instead of assigning lead triage back to the same worker", async () => {
    const workspaceRoot = await createTempDir();
    process.env.FORGEOS_EXECUTION_WORKSPACE_ROOT = workspaceRoot;
    const baseSnapshot = createDemoSnapshot();
    const runtime = new AcceptanceFailureRuntime();
    const qaOperation = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-tests")!,
      divisionId: "qa",
      workerId: "qa-runner-alpha",
      status: "ready" as const,
      routingStage: "worker_ready" as const,
      blockedReason: undefined
    };
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence({
        ...baseSnapshot,
        divisions: baseSnapshot.divisions.map((division) => (division.id === "qa" ? { ...division, leadWorkerId: "qa-runner-alpha" } : division)),
        workers: baseSnapshot.workers.map((worker) => (worker.id === "qa-runner-alpha" ? { ...worker, kind: "lead" as const, managerWorkerId: undefined } : worker)),
        operations: baseSnapshot.operations.map((operation) =>
          operation.id === "op-runtime"
            ? { ...operation, status: "completed" as const, progress: 100, outputArtifactIds: ["artifact-implementation"] }
            : operation.id === "op-tests"
              ? qaOperation
              : operation
        ),
        files: [
          ...baseSnapshot.files,
          {
            id: "implementation-file",
            path: "src/app/page.tsx",
            content: "export default function Page() { return null; }",
            status: "generated",
            version: 1,
            divisionId: "engineering",
            workerId: "backend-worker",
            operationId: "op-runtime",
            artifactIds: ["artifact-implementation"],
            updatedAt: new Date().toISOString()
          }
        ]
      }),
      runtime
    );

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-tests", idempotencyKey: "same-lead-escalation" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-tests")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "failed");

    expect(snapshot.operations.some((operation) => operation.escalatedFromOperationId === "op-tests")).toBe(false);
    expect(snapshot.events.some((event) => event.type === "executive.review_requested" && event.payload.failureCategory === "verification_failed" && typeof event.payload.reviewId === "string")).toBe(true);
  });

  it("preserves existing virtual file artifact provenance when provider updates a path", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new ExistingFileUpdateRuntime());

    const before = await runtimeStore.getSnapshot("demo");
    const existing = before.files.find((file) => file.path === "docs/project-plan.md")!;
    await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "existing-file-update" });
    const snapshot = await waitForOperationStatus(runtimeStore, "demo", "op-runtime", "completed");
    const updated = snapshot.files.find((file) => file.path === "docs/project-plan.md")!;

    expect(updated.id).toBe(existing.id);
    expect(updated.version).toBe(existing.version + 1);
    expect(updated.artifactIds).toEqual(existing.artifactIds);
  });

  it("applies provider file patches when find text matches exactly once", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      new FilePatchRuntime([
        {
          path: "docs/project-plan.md",
          find: "ForgeOS command center, runtime, and release pipeline.",
          replace: "ForgeOS command center, runtime, launcher patching, and release pipeline."
        }
      ])
    );

    const before = await runtimeStore.getSnapshot("demo");
    const existing = before.files.find((file) => file.path === "docs/project-plan.md")!;
    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "file-patch-success" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const patched = snapshot.files.find((file) => file.path === "docs/project-plan.md")!;

    expect(patched.id).toBe(existing.id);
    expect(patched.version).toBe(existing.version + 1);
    expect(patched.content).toContain("launcher patching");
    expect(snapshot.events.find((event) => event.type === "file.updated" && event.targetId === existing.id)?.payload).toMatchObject({
      patched: true,
      path: "docs/project-plan.md"
    });
  });

  it("keeps runtime-owned verification evidence blockers out of Executive approval loops", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      new VerificationEvidenceBlockerPatchRuntime([
        {
          path: "docs/project-plan.md",
          find: "ForgeOS command center, runtime, and release pipeline.",
          replace: "ForgeOS command center, runtime, launcher patching, and release pipeline."
        }
      ])
    );

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "verification-blocker-owned-by-runtime" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const completedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;

    expect(snapshot.operations.find((operation) => operation.id === "op-runtime")).toMatchObject({ status: "completed" });
    expect(snapshot.events.some((event) => event.type === "executive.review_requested" && event.payload.runId === run.id)).toBe(false);
    expect(JSON.stringify(completedRun.providerMetadata.traceSummary)).toContain("runtime-owned verification blocker ignored");
  });

  it("omits provider file patches for missing, zero-match, and multi-match targets", async () => {
    const baseSnapshot = createDemoSnapshot();
    const duplicateFile = {
      ...baseSnapshot.files.find((file) => file.path === "docs/project-plan.md")!,
      id: "duplicate-text-file",
      path: "docs/duplicate.md",
      content: "same same"
    };
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence({ ...baseSnapshot, files: [...baseSnapshot.files, duplicateFile] }),
      new FilePatchRuntime([
        { path: "docs/missing.md", find: "missing", replace: "patched" },
        { path: "docs/project-plan.md", find: "not present", replace: "patched" },
        { path: "docs/duplicate.md", find: "same", replace: "patched" }
      ])
    );

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "file-patch-omissions" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const completedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;

    expect(snapshot.files.find((file) => file.path === "docs/duplicate.md")?.content).toBe("same same");
    expect(snapshot.events.some((event) => event.type === "file.updated" && event.payload.patched === true)).toBe(false);
    expect(completedRun.providerMetadata.traceSummary).toMatchObject({
      outputs: {
        omittedCount: expect.any(Number),
        omissionReasons: expect.arrayContaining([
          "file patch omitted because docs/missing.md does not exist.",
          "file patch omitted because docs/project-plan.md matched 0 times; expected exactly once.",
          "file patch omitted because docs/duplicate.md matched 2 times; expected exactly once."
        ])
      }
    });
  });

  it("projects worker questions for division lead answer and resolution", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new WorkerQuestionRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "worker-question-request" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const question = snapshot.events.find((event) => event.type === "worker.question_requested" && event.payload.runId === run.id)!;
    const workerQuestionId = question.payload.workerQuestionId as string;

    expect(question).toMatchObject({
      actorType: "worker",
      actorId: "backend-worker",
      targetType: "operation",
      targetId: "op-runtime",
      payload: {
        operationId: "op-runtime",
        workerId: "backend-worker",
        leadWorkerId: "eng-director",
        scope: "outside_scope_files"
      }
    });

    const answered = await runtimeStore.dispatch("demo", {
      type: "answer_worker_question",
      workerQuestionId,
      selectedOptionIds: ["approve"],
      notes: "Approved for read-only inspection only.",
      idempotencyKey: "worker-question-answer"
    });

    expect(answered.events.some((event) => event.type === "worker.question_answered" && event.payload.workerQuestionId === workerQuestionId && event.payload.source === "division_lead")).toBe(true);
    await expect(
      runtimeStore.dispatch("demo", {
        type: "answer_worker_question",
        workerQuestionId,
        notes: "second answer",
        idempotencyKey: "worker-question-answer-again"
      })
    ).rejects.toThrow("Worker question is not pending.");
  });

  it("escalates worker questions through Executive controlled mode to operator answer", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new WorkerQuestionRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "worker-question-controlled-request" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const workerQuestionId = snapshot.events.find((event) => event.type === "worker.question_requested" && event.payload.runId === run.id)!.payload.workerQuestionId as string;

    const escalated = await runtimeStore.dispatch("demo", {
      type: "escalate_worker_question",
      workerQuestionId,
      notes: "Lead is unsure.",
      idempotencyKey: "worker-question-escalate"
    });
    const executiveQuestion = escalated.events.find((event) => event.type === "executive.user_input_requested" && event.payload.workerQuestionId === workerQuestionId)!;
    const questionId = executiveQuestion.payload.questionId as string;

    expect(executiveQuestion).toMatchObject({
      targetType: "operation",
      targetId: "op-runtime",
      payload: {
        loopId: "worker-question",
        workerQuestionId,
        leadWorkerId: "eng-director"
      }
    });

    const answered = await runtimeStore.dispatch("demo", {
      type: "answer_executive_question",
      questionId,
      selectedOptionIds: ["approve"],
      notes: "Operator approves this scoped exception.",
      idempotencyKey: "worker-question-operator-answer"
    });

    expect(answered.events.some((event) => event.type === "executive.user_input_answered" && event.payload.questionId === questionId)).toBe(true);
    expect(answered.events.some((event) => event.type === "worker.question_answered" && event.payload.workerQuestionId === workerQuestionId && event.payload.source === "operator")).toBe(true);
  });

  it("lets Executive autopilot answer worker questions marked for escalation", async () => {
    process.env.FORGEOS_EXECUTIVE_AUTOPILOT = "1";
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new WorkerQuestionRuntime(true));

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "worker-question-auto-request" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");

    expect(snapshot.events.some((event) => event.type === "worker.question_requested" && event.payload.runId === run.id)).toBe(true);
    expect(snapshot.events.some((event) => event.type === "worker.question_escalated" && event.payload.runId === run.id)).toBe(true);
    expect(snapshot.events.some((event) => event.type === "worker.question_answered" && event.payload.runId === run.id && event.payload.source === "executive_auto")).toBe(true);
    expect(snapshot.events.some((event) => event.type === "executive.user_input_requested" && event.payload.runId === run.id)).toBe(false);
  });

  it("suppresses worker questions that ask the operator for runtime logs", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new DiagnosticLogQuestionRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "diagnostic-log-question" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");

    expect(snapshot.events.some((event) => event.type === "executive.user_input_requested" && event.payload.runId === run.id)).toBe(false);
    expect(snapshot.events.some((event) => event.type === "worker.question_requested" && event.payload.runId === run.id)).toBe(false);
    expect(snapshot.events.some((event) => event.type === "run.progress" && event.payload.reason === "diagnostic_question_suppressed")).toBe(true);
    const completedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;
    expect(JSON.stringify(completedRun.providerMetadata.traceSummary)).toContain("diagnostic/runtime-log question suppressed");
  });

  it("suppresses worker questions that ask leads for implementation debugging", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new ImplementationHelpQuestionRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "implementation-help-question" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "failed");

    expect(snapshot.events.some((event) => event.type === "worker.question_requested" && event.payload.runId === run.id)).toBe(false);
    expect(snapshot.events.some((event) => event.type === "run.progress" && event.payload.reason === "worker_help_request_suppressed")).toBe(true);
    expect(snapshot.events.some((event) => event.type === "operation.escalated" && event.payload.runId === run.id)).toBe(true);
  });

  it("self-repairs suppressed-only worker help requests before lead escalation", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new SelfRepairingImplementationHelpRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "implementation-help-self-repair" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");

    expect(snapshot.events.some((event) => event.type === "worker.question_requested" && event.payload.runId === run.id)).toBe(false);
    expect(snapshot.events.some((event) => event.type === "operation.escalated" && event.payload.runId === run.id)).toBe(false);
    expect(snapshot.events.some((event) => event.type === "artifact.created" && event.payload.runId === run.id)).toBe(true);
    const completedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;
    expect(JSON.stringify(completedRun.providerMetadata.traceSummary)).toContain("selfRepairAttemptCount");
  });

  it("turns provider dangerous command requests into Executive review events without executing them", async () => {
    const tempDir = await createTempDir();
    const sentinelPath = path.join(tempDir, "provider-shell-ran");
    const command = `${process.execPath} -e "require('node:fs').writeFileSync(${JSON.stringify(sentinelPath)}, 'executed')"`;
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new DangerousActionRuntime(command));

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "dangerous-action-review" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const reviewEvents = snapshot.events.filter((event) => event.type === "executive.review_requested" && event.payload.runId === run.id);

    expect(reviewEvents).toHaveLength(1);
    expect(reviewEvents[0]).toMatchObject({
      actorType: "runtime",
      targetType: "run",
      targetId: run.id,
      severity: "warning",
      payload: {
        operationId: "op-runtime",
        actionCount: 1,
        actions: [
          {
            action: "run shell command",
            reason: "Provider wants to perform a destructive runtime-owned verification step.",
            command
          }
        ],
        providerShellAccess: false
      }
    });
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "executive",
          kind: "executive_summary",
          source: "run_terminal",
          runId: run.id,
          operationId: "op-runtime",
          status: "review_requested",
          content: expect.stringContaining("Runtime blocked 1 dangerous action request")
        })
      ])
    );
    await expect(access(sentinelPath)).rejects.toThrow();
  });

  it("routes worker dependency requests to division lead review and approval patches package.json without install", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      new DependencyRequestRuntime(
        {
          packageName: "zod",
          versionRange: "^3.25.1",
          dependencyType: "dependency",
          reason: "The generated form parser needs schema validation that handwritten checks would duplicate.",
          usedByFiles: ["lib/validation.ts"],
          alternativesConsidered: ["Manual validation would duplicate parsing logic."]
        },
        { name: "generated-app", version: "0.1.0", scripts: { test: "node -e \"console.log('ok')\"" }, dependencies: { react: "^19.0.0" } }
      ),
      undefined,
      undefined,
      createPassingVerificationHook()
    );

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "dependency-request" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const request = snapshot.events.find((event) => event.type === "dependency.requested" && event.payload.runId === run.id)!;
    const dependencyRequestId = request.payload.dependencyRequestId as string;

    expect(request).toMatchObject({
      actorType: "worker",
      targetType: "operation",
      targetId: "op-runtime",
      severity: "info",
      payload: {
        packageName: "zod",
        versionRange: "^3.25.1",
        dependencyType: "dependency",
        requestedRunId: run.id
      }
    });

    const approved = await runtimeStore.dispatch("demo", {
      type: "approve_dependency_request",
      dependencyRequestId,
      notes: "Zod is justified for runtime input validation.",
      idempotencyKey: "dependency-request-approve"
    });
    const packageFile = approved.files.find((file) => file.path === "package.json")!;
    const manifest = JSON.parse(packageFile.content) as { dependencies: Record<string, string> };

    expect(manifest.dependencies).toEqual({ react: "^19.0.0", zod: "^3.25.1" });
    expect(approved.events.some((event) => event.type === "dependency.approved" && event.payload.dependencyRequestId === dependencyRequestId && event.payload.providerShellAccess === false)).toBe(true);
    expect(approved.events.some((event) => event.type === "file.updated" && event.payload.dependencyRequestId === dependencyRequestId && event.payload.installCommandRun === false)).toBe(true);
  });

  it("rejects dependency approval when package.json is missing", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      new DependencyRequestRuntime({
        packageName: "zod",
        versionRange: "^3.25.1",
        dependencyType: "dependency",
        reason: "Schema validation is needed and built-in APIs are insufficient."
      }),
      undefined,
      undefined,
      createPassingVerificationHook()
    );

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "dependency-request-missing-package" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const dependencyRequestId = snapshot.events.find((event) => event.type === "dependency.requested" && event.payload.runId === run.id)!.payload.dependencyRequestId as string;
    const rejected = await runtimeStore.dispatch("demo", { type: "approve_dependency_request", dependencyRequestId, idempotencyKey: "dependency-request-missing-package-approve" });

    expect(rejected.events.some((event) => event.type === "dependency.rejected" && event.payload.dependencyRequestId === dependencyRequestId && String(event.payload.reason).includes("package.json is required"))).toBe(true);
    expect(rejected.events.some((event) => event.type === "file.updated" && event.payload.dependencyRequestId === dependencyRequestId)).toBe(false);
  });

  it("omits malformed dependency requests and install commands from provider output", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      new DependencyRequestRuntime(
        {
          packageName: "git+https://example.com/repo.git",
          versionRange: "file:../local.tgz",
          dependencyType: "dependency",
          reason: "Use a local package."
        },
        { name: "generated-app", scripts: { setup: "npm install zod" } }
      ),
      undefined,
      undefined,
      createPassingVerificationHook()
    );

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "dependency-request-invalid" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const completedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;

    expect(snapshot.events.some((event) => event.type === "dependency.requested" && event.payload.runId === run.id)).toBe(false);
    expect(snapshot.files.some((file) => file.path === "package.json")).toBe(false);
    expect(JSON.stringify(completedRun.providerMetadata.traceSummary)).toContain("dependency request");
    expect(JSON.stringify(completedRun.providerMetadata.traceSummary)).toContain("install commands");
  });

  it("lets operators approve and reject Executive review requests without granting shell access", async () => {
    const tempDir = await createTempDir();
    const sentinelPath = path.join(tempDir, "provider-shell-ran");
    const command = `${process.execPath} -e "require('node:fs').writeFileSync(${JSON.stringify(sentinelPath)}, 'executed')"`;
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new DangerousActionRuntime(command));

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "dangerous-action-resolve" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const review = snapshot.events.find((event) => event.type === "executive.review_requested" && event.payload.runId === run.id)!;
    const reviewId = review.payload.reviewId as string;

    const approved = await runtimeStore.dispatch("demo", { type: "approve_executive_review", reviewId, idempotencyKey: "dangerous-action-approve" });

    expect(approved.events.some((event) => event.type === "executive.review_approved" && event.payload.reviewId === reviewId && event.payload.providerShellAccess === false)).toBe(true);
    expect(approved.messages.some((message) => message.status === "approved" && message.runId === run.id)).toBe(true);
    await expect(access(sentinelPath)).rejects.toThrow();
    await expect(runtimeStore.dispatch("demo", { type: "reject_executive_review", reviewId, idempotencyKey: "dangerous-action-reject-after-approve" })).rejects.toThrow("Executive review request not found or already resolved.");
  });

  it("turns approved prerequisite Executive reviews into actionable repair work", async () => {
    const baseSnapshot = createDemoSnapshot();
    const reviewId = "review-missing-prerequisite-context";
    const blockedOperation = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-tests")!,
      status: "blocked" as const,
      blockedReason: "No executable verification output was supplied in the bounded runtime context.",
      progress: 90
    };
    const snapshot = {
      ...baseSnapshot,
      operations: baseSnapshot.operations.map((operation) => (operation.id === "op-tests" ? blockedOperation : operation)),
      events: [
        ...baseSnapshot.events,
        {
          id: "event-review-missing-prerequisite-context",
          forgeId: baseSnapshot.forge.id,
          sequence: baseSnapshot.lastEventSequence + 1,
          type: "executive.review_requested" as const,
          actorType: "executive" as const,
          targetType: "operation" as const,
          targetId: "op-tests",
          message: "Executive replanning required: QA is blocked because prerequisite work or context is missing.",
          severity: "warning" as const,
          payload: {
            reviewId,
            operationId: "op-tests",
            category: "missing_prerequisite_context"
          },
          createdAt: new Date().toISOString()
        }
      ],
      lastEventSequence: baseSnapshot.lastEventSequence + 1
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new DeferredRuntime());

    const approved = await runtimeStore.dispatch("demo", {
      type: "approve_executive_review",
      reviewId,
      idempotencyKey: "approve-missing-prerequisite-context"
    });
    const prerequisite = approved.operations.find((operation) => operation.title.includes("Produce prerequisite implementation context"));

    expect(prerequisite).toMatchObject({
      status: "ready",
      divisionId: "engineering"
    });
    expect(approved.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "op-tests",
          dependsOnOperationId: prerequisite?.id,
          type: "blocks"
        })
      ])
    );
    expect(approved.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "executive.review_approved", payload: expect.objectContaining({ reviewId }) }),
        expect.objectContaining({ type: "operation.created", payload: expect.objectContaining({ blockedOperationId: "op-tests" }) })
      ])
    );
  });

  it("approves runtime-owned verification reviews by readying the blocked operation for retry", async () => {
    const baseSnapshot = createDemoSnapshot();
    const reviewId = "review-runtime-owned-verification";
    const blockedOperation = {
      ...baseSnapshot.operations.find((operation) => operation.id === "op-runtime")!,
      status: "blocked" as const,
      blockedReason:
        "No executable sandbox verification results were provided in the bounded runtime context, so I cannot truthfully claim rerun evidence; QA must execute npm run typecheck, npm run lint, npm run build, npm run smoke, and npm run acceptance after the config repairs.",
      progress: 90
    };
    const snapshot = {
      ...baseSnapshot,
      operations: baseSnapshot.operations.map((operation) => (operation.id === "op-runtime" ? blockedOperation : operation)),
      events: [
        ...baseSnapshot.events,
        {
          id: "event-review-runtime-owned-verification",
          forgeId: baseSnapshot.forge.id,
          sequence: baseSnapshot.lastEventSequence + 1,
          type: "executive.review_requested" as const,
          actorType: "executive" as const,
          targetType: "operation" as const,
          targetId: "op-runtime",
          message: "Executive replanning required: runtime verification evidence is missing.",
          severity: "warning" as const,
          payload: {
            reviewId,
            operationId: "op-runtime",
            category: "missing_prerequisite_context",
            blockerReason: blockedOperation.blockedReason
          },
          createdAt: new Date().toISOString()
        }
      ],
      lastEventSequence: baseSnapshot.lastEventSequence + 1
    };
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(snapshot), new DeferredRuntime());

    const approved = await runtimeStore.dispatch("demo", {
      type: "approve_executive_review",
      reviewId,
      idempotencyKey: "approve-runtime-owned-verification"
    });

    expect(approved.operations.find((operation) => operation.id === "op-runtime")).toMatchObject({
      status: "ready",
      blockedReason: undefined
    });
    expect(approved.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "executive.review_approved", payload: expect.objectContaining({ reviewId }) }),
        expect.objectContaining({
          type: "operation.ready",
          payload: expect.objectContaining({ reason: "runtime_owned_verification_retry" })
        })
      ])
    );
    expect(approved.events.some((event) => event.type === "operation.created" && event.payload.blockedOperationId === "op-runtime")).toBe(false);
  });

  it("does not allow provider verification metadata to claim shell access", async () => {
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence(createDemoSnapshot()),
      new FileOnlyRuntime(),
      undefined,
      undefined,
      ({ completedAt, projectedArtifactIds, projectedFileIds, projectedHandoffIds, blockerCount }) =>
        ({
          source: "runtime",
          status: "passed",
          checkedAt: completedAt,
          providerShellAccess: true,
          projectedArtifactIds,
          projectedFileIds,
          projectedHandoffIds,
          blockerCount,
          checks: [{ name: "provider claimed shell", status: "passed", message: "provider-set metadata should be sanitized" }]
        }) as unknown as RuntimeVerificationSummary
    );

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "sanitize-verification-shell-access" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const snapshot = await waitForRunStatus(runtimeStore, "demo", run.id, "completed");
    const completedRun = snapshot.runs.find((candidate) => candidate.id === run.id)!;

    expect(completedRun.providerMetadata.verificationSummary).toMatchObject({
      source: "runtime",
      status: "passed",
      providerShellAccess: false,
      projectedArtifactIds: expect.any(Array),
      projectedFileIds: expect.any(Array),
      projectedHandoffIds: expect.any(Array),
      blockerCount: 0
    });
    expect(JSON.stringify(completedRun.providerMetadata.verificationSummary)).not.toContain("providerShellAccess\":true");
  });

  it("rejects duplicate operation execution when an active run is already recorded", async () => {
    const snapshot = createDemoSnapshot();
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence({
        ...snapshot,
        runs: [
          {
            id: "run-active-runtime",
            forgeId: snapshot.forge.id,
            operationId: "op-runtime",
            workerId: "backend-worker",
            provider: "mock",
            status: "running",
            capabilities: {
              streamsEvents: true,
              supportsCancel: true,
              supportsResume: false,
              supportsRetries: true,
              supportsWorkspaceRefs: true,
      supportsWebSearch: false
            },
            queuedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            providerMetadata: {}
          }
        ]
      })
    );

    await expect(
      runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "duplicate-active-run" })
    ).rejects.toMatchObject({
      status: 409,
      message: "Operation already has an active run."
    });
  });

  it("retries provider exceptions before escalating the operation", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new FailingRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "failed-runtime" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const failed = await waitForRunStatus(runtimeStore, "demo", run.id, "failed");

    expect(failed.operations.find((operation) => operation.id === "op-runtime")).toMatchObject({
      status: "ready",
      workerId: "eng-director",
      retryCount: 2,
      routingStage: "lead_triaged",
      escalationRunId: run.id,
      escalationFailureCategory: "runtime_exception"
    });
    expect(failed.operations.find((operation) => operation.id === "op-runtime")?.blockedReason).toBeUndefined();
    expect(failed.workers.find((worker) => worker.id === "backend-worker")).toMatchObject({
      status: "idle",
      currentTask: undefined
    });
    expect(failed.events.map((event) => event.type)).toEqual(expect.arrayContaining(["run.retry_requested", "run.retry_exhausted", "operation.escalated"]));
    expect(failed.runs.find((candidate) => candidate.id === run.id)?.providerMetadata).toMatchObject({
      finalFailureCategory: "runtime_exception"
    });
  });

  it("keeps provider cancellations canceled when the iterator exits normally", async () => {
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), new CancelingRuntime());

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "canceled-runtime" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    const canceled = await waitForRunStatus(runtimeStore, "demo", run.id, "canceled");

    expect(canceled.operations.find((operation) => operation.id === "op-runtime")?.status).toBe("canceled");
    expect(canceled.runs.find((candidate) => candidate.id === run.id)?.providerMetadata).toMatchObject({
      traceId: "cancel-trace",
      traceSummary: {
        context: expect.any(Object),
        lifecycle: {
          provider: "mock",
          status: "canceled"
        }
      }
    });
    expect(canceled.events.filter((event) => event.type === "run.completed" && event.payload.runId === run.id)).toHaveLength(0);
    expect(canceled.events.filter((event) => event.type === "run.canceled" && event.payload.runId === run.id)).toHaveLength(1);
  });

  it("cancels active runs when pausing a forge", async () => {
    const runtime = new DeferredRuntime();
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "pause-active-run" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    await vi.waitFor(() => expect(runtime.startedCount).toBe(1));
    const paused = await runtimeStore.dispatch("demo", { type: "pause_forge", idempotencyKey: "pause-during-run" });
    runtime.releaseNext();

    expect(runtime.canceledCount).toBe(1);
    expect(paused.runs.find((candidate) => candidate.id === run.id)).toMatchObject({
      status: "canceled",
      error: "Run canceled because the Forge was paused."
    });
    expect(paused.events.at(-1)?.payload).toMatchObject({ canceledRunIds: [run.id] });
    const afterProviderExit = await runtimeStore.getSnapshot("demo");
    expect(afterProviderExit.runs.find((candidate) => candidate.id === run.id)?.status).toBe("canceled");
  });

  it("does not revive a queued run canceled while waiting for provider throttle", async () => {
    const originalAutopilot = process.env.FORGEOS_EXECUTIVE_AUTOPILOT;
    process.env.FORGEOS_EXECUTIVE_AUTOPILOT = "0";
    const runtime = new DeferredRuntime();
    const snapshot = createDemoSnapshot();
    const runtimeStore = new RuntimeStore(
      new InMemoryRuntimePersistence({
        ...snapshot,
        operations: snapshot.operations.map((operation) =>
          operation.id === "op-dashboard"
            ? {
                ...operation,
                status: "ready",
                progress: 25,
                routingStage: "worker_ready"
              }
            : operation
        )
      }),
      runtime,
      new ProposalProvider({ summary: "unused", actions: [] }),
      new ProviderThrottle({ globalMaxConcurrentRuns: 1, providerMaxConcurrentRuns: { mock: 1 } })
    );

    try {
      const firstQueued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "throttle-first" });
      const firstRun = firstQueued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
      await vi.waitFor(() => expect(runtime.startedCount).toBe(1));

      const secondQueued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-dashboard", idempotencyKey: "throttle-second" });
      const secondRun = secondQueued.runs.find((candidate) => candidate.operationId === "op-dashboard")!;
      expect(secondQueued.runs.find((candidate) => candidate.id === secondRun.id)?.status).toBe("queued");

      await runtimeStore.dispatch("demo", { type: "pause_forge", idempotencyKey: "pause-while-throttled" });
      runtime.releaseNext();
      await new Promise((resolve) => setTimeout(resolve, 40));
      const snapshot = await runtimeStore.getSnapshot("demo");

      expect(snapshot.runs.find((candidate) => candidate.id === firstRun.id)?.status).toBe("canceled");
      expect(snapshot.runs.find((candidate) => candidate.id === secondRun.id)?.status).toBe("canceled");
      expect(snapshot.events.filter((event) => event.type === "run.started" && event.payload.runId === secondRun.id)).toHaveLength(0);
      expect(runtime.startedCount).toBe(1);
    } finally {
      if (originalAutopilot === undefined) {
        delete process.env.FORGEOS_EXECUTIVE_AUTOPILOT;
      } else {
        process.env.FORGEOS_EXECUTIVE_AUTOPILOT = originalAutopilot;
      }
    }
  });

  it("does not project late provider events after pausing a forge", async () => {
    const runtime = new PostPauseStreamingRuntime();
    const runtimeStore = new RuntimeStore(new InMemoryRuntimePersistence(createDemoSnapshot()), runtime);

    const queued = await runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "pause-late-events" });
    const run = queued.runs.find((candidate) => candidate.operationId === "op-runtime")!;
    await vi.waitFor(async () => {
      const snapshot = await runtimeStore.getSnapshot("demo");
      expect(snapshot.events.some((event) => event.message === "Provider started a stream.")).toBe(true);
    });

    await runtimeStore.dispatch("demo", { type: "pause_forge", idempotencyKey: "pause-before-late-events" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const snapshot = await runtimeStore.getSnapshot("demo");

    expect(snapshot.runs.find((candidate) => candidate.id === run.id)?.status).toBe("canceled");
    expect(snapshot.events.some((event) => event.message === "Late provider progress after pause.")).toBe(false);
    expect(snapshot.artifacts.some((artifact) => artifact.title === "Late")).toBe(false);
  });

  it("projects completed operations into workers, divisions, and forge phase", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-5" });

    const snapshot = await runtimeStore.dispatch("demo", { type: "run_full_flow", idempotencyKey: "complete-flow" });

    expect(snapshot.operations.every((operation) => operation.status === "completed")).toBe(true);
    expect(snapshot.workers.every((worker) => worker.status === "completed")).toBe(true);
    expect(snapshot.divisions.every((division) => division.status === "completed")).toBe(true);
    expect(snapshot.divisions.every((division) => division.progress === 100)).toBe(true);
    expect(snapshot.forge.activePhase).toBe("Deployment Ready");
  });

  it("pauses a forge and marks incomplete work paused", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-6" });

    const snapshot = await runtimeStore.dispatch("demo", { type: "pause_forge", idempotencyKey: "pause-forge" });

    expect(snapshot.forge.status).toBe("paused");
    expect(snapshot.forge.activePhase).toBe("Safe Shutdown");
    expect(snapshot.operations.filter((operation) => operation.status !== "completed").every((operation) => operation.status === "paused")).toBe(true);
    expect(snapshot.workers.filter((worker) => worker.status !== "completed").every((worker) => worker.status === "paused")).toBe(true);
    expect(snapshot.events.at(-1)?.type).toBe("runtime.paused");
  });

  it("keeps shutdown_forge as a safe pause alias", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-7" });

    const snapshot = await runtimeStore.dispatch("demo", { type: "shutdown_forge", idempotencyKey: "shutdown-forge" });

    expect(snapshot.forge.status).toBe("paused");
    expect(snapshot.events.at(-1)?.type).toBe("runtime.paused");
  });

  it("rejects new operation runs while paused", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-8" });
    await runtimeStore.dispatch("demo", { type: "pause_forge", idempotencyKey: "pause-before-run" });

    await expect(
      runtimeStore.dispatch("demo", { type: "run_operation", operationId: "op-runtime", idempotencyKey: "run-after-shutdown" })
    ).rejects.toMatchObject({
      status: 409,
      message: "Forge is paused and is not accepting operation runs."
    });
  });

  it("resumes a paused forge and restores eligible work", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-9" });
    await runtimeStore.dispatch("demo", { type: "pause_forge", idempotencyKey: "pause-before-resume" });

    const snapshot = await runtimeStore.dispatch("demo", { type: "resume_forge", idempotencyKey: "resume-forge" });

    expect(snapshot.forge.status).toBe("active");
    expect(snapshot.forge.activePhase).toBe("Blocked Review");
    expect(snapshot.operations.find((operation) => operation.id === "op-runtime")?.status).toBe("ready");
    expect(snapshot.operations.find((operation) => operation.id === "op-tests")?.status).toBe("blocked");
    expect(snapshot.operations.find((operation) => operation.id === "op-qa")?.status).toBe("planning");
    expect(snapshot.operations.find((operation) => operation.id === "op-release")?.status).toBe("planning");
    expect(snapshot.operations.filter((operation) => operation.status === "blocked").map((operation) => operation.id)).toEqual(["op-tests"]);
    expect(snapshot.events.at(-1)?.type).toBe("runtime.resumed");
  });

  it("connects a GitHub repository from a normalized URL", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-repo-1" });
    const before = await runtimeStore.getSnapshot("demo");

    const snapshot = await runtimeStore.dispatch("demo", {
      type: "connect_repository",
      repositoryUrl: "https://github.com/BottoGrotto/ForgeOS.git",
      defaultBranch: "main",
      workingBranch: "forge/repository-v1",
      idempotencyKey: "connect-repository-url"
    });

    expect(snapshot.repository).toMatchObject({
      provider: "github",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "forge/repository-v1"
    });
    expect(snapshot.repository?.connectedAt).toEqual(expect.any(String));
    expect(snapshot.events.at(-1)?.type).toBe("repository.connected");
    expect(snapshot.events.at(-1)?.targetType).toBe("repository");
    expect(snapshot.files).toEqual(before.files);
  });

  it("connects a GitHub repository from owner and repo metadata", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-repo-metadata" });

    const snapshot = await runtimeStore.dispatch("demo", {
      type: "connect_repository",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "forge/repository-v1",
      installationId: "install-123",
      accountRef: "botto-grotto",
      idempotencyKey: "connect-repository-metadata"
    });

    expect(snapshot.repository).toMatchObject({
      provider: "github",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "forge/repository-v1",
      installationId: "install-123",
      accountRef: "botto-grotto"
    });
  });

  it("updates an existing GitHub repository connection", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-repo-2" });
    await runtimeStore.dispatch("demo", {
      type: "connect_repository",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "forge/old",
      idempotencyKey: "connect-repository-first"
    });

    const snapshot = await runtimeStore.dispatch("demo", {
      type: "connect_repository",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "forge/new",
      idempotencyKey: "connect-repository-second"
    });

    expect(snapshot.repository?.workingBranch).toBe("forge/new");
    expect(snapshot.events.at(-1)?.type).toBe("repository.connected");
  });

  it("rejects malformed GitHub repository input", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-repo-3" });

    await expect(
      runtimeStore.dispatch("demo", {
        type: "connect_repository",
        repositoryUrl: "https://gitlab.com/BottoGrotto/ForgeOS",
        defaultBranch: "main",
        workingBranch: "main",
        idempotencyKey: "connect-invalid-provider"
      })
    ).rejects.toMatchObject({
      status: 400,
      message: "Only GitHub repository URLs are supported."
    });
  });

  it("disconnects a connected GitHub repository", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-repo-4" });
    await runtimeStore.dispatch("demo", {
      type: "connect_repository",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "main",
      idempotencyKey: "connect-before-disconnect"
    });

    const snapshot = await runtimeStore.dispatch("demo", { type: "disconnect_repository", idempotencyKey: "disconnect-repository" });

    expect(snapshot.repository).toBeUndefined();
    expect(snapshot.events.at(-1)?.type).toBe("repository.disconnected");
  });

  it("refreshes repository context without modifying virtual files", async () => {
    const runtimeStore = createTestStore();
    await runtimeStore.dispatch("demo", { type: "reset_demo_state", idempotencyKey: "test-reset-repo-5" });
    const connected = await runtimeStore.dispatch("demo", {
      type: "connect_repository",
      owner: "BottoGrotto",
      repo: "ForgeOS",
      defaultBranch: "main",
      workingBranch: "main",
      idempotencyKey: "connect-before-refresh"
    });

    const snapshot = await runtimeStore.dispatch("demo", { type: "refresh_repository_context", idempotencyKey: "refresh-repository" });

    expect(snapshot.repository?.lastRefreshedAt).toEqual(expect.any(String));
    expect(snapshot.events.at(-1)?.type).toBe("repository.refreshed");
    expect(snapshot.files).toEqual(connected.files);
  });

  it("marks command errors for callers that need status codes", () => {
    const error = new RuntimeCommandError("No operation selected.", 400);

    expect(error.status).toBe(400);
    expect(error.message).toBe("No operation selected.");
  });
});

async function waitForOperationStatus(runtimeStore: RuntimeStore, forgeSlug: string, operationId: string, status: RuntimeStatus) {
  let snapshot = await runtimeStore.getSnapshot(forgeSlug);
  await vi.waitFor(async () => {
    snapshot = await runtimeStore.getSnapshot(forgeSlug);
    expect(snapshot.operations.find((operation) => operation.id === operationId)?.status).toBe(status);
  });
  return snapshot;
}

async function waitForRunStatus(runtimeStore: RuntimeStore, forgeSlug: string, runId: string, status: AgentRunStatus) {
  let snapshot = await runtimeStore.getSnapshot(forgeSlug);
  await vi.waitFor(async () => {
    snapshot = await runtimeStore.getSnapshot(forgeSlug);
    expect(snapshot.runs.find((run) => run.id === runId)?.status).toBe(status);
  });
  return snapshot;
}

async function waitForCycleCompleted(runtimeStore: RuntimeStore, forgeSlug: string, stopReason: string) {
  let snapshot = await runtimeStore.getSnapshot(forgeSlug);
  await vi.waitFor(async () => {
    snapshot = await runtimeStore.getSnapshot(forgeSlug);
    expect(snapshot.events.some((event) => event.type === "cycle.completed" && event.payload.stopReason === stopReason)).toBe(true);
  });
  return snapshot;
}

function createPassingVerificationHook() {
  return (({ completedAt, projectedArtifactIds, projectedFileIds, projectedHandoffIds, blockerCount }) =>
    ({
      source: "runtime",
      status: "passed",
      checkedAt: completedAt,
      providerShellAccess: false,
      projectedArtifactIds,
      projectedFileIds,
      projectedHandoffIds,
      blockerCount
    }) satisfies RuntimeVerificationSummary) satisfies RuntimeVerificationHook;
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

async function createTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forgeos-store-"));
  tempDirs.push(dir);
  return dir;
}
