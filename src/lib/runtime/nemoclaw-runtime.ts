import type { AgentRuntime, ProviderCapabilities, RunOperationInput, RuntimeEventDraft } from "./types";

export class NemoclawRuntime implements AgentRuntime {
  provider() {
    return "nemoclaw" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: true,
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
      message: "Nemoclaw provider is not configured.",
      severity: "error",
      payload: { operationId: input.operationId }
    };
  }

  async cancelOperation() {
    return Promise.resolve();
  }
}
