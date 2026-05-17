import type { ProviderCapabilities, RuntimeEventDraft } from "@/lib/runtime/types";

export interface AgentConfig {
  name: string;
  role: string;
  instructions: string;
}

export interface AgentInput {
  operationId: string;
  contextRefs: string[];
}

export interface AgentInstance {
  id: string;
  provider: "nemoclaw";
}

export interface NemoclawAdapter {
  capabilities(): ProviderCapabilities;
  createAgent(config: AgentConfig): Promise<AgentInstance>;
  runAgent(agentId: string, input: AgentInput): AsyncIterable<RuntimeEventDraft>;
  terminateAgent(agentId: string): Promise<void>;
}

export class PlaceholderNemoclawAdapter implements NemoclawAdapter {
  capabilities(): ProviderCapabilities {
    return {
      streamsEvents: true,
      supportsCancel: true,
      supportsResume: true,
      supportsRetries: true,
      supportsWorkspaceRefs: true
    };
  }

  async createAgent(): Promise<AgentInstance> {
    throw new Error("Nemoclaw integration is not configured");
  }

  async *runAgent(): AsyncIterable<RuntimeEventDraft> {
    throw new Error("Nemoclaw integration is not configured");
  }

  async terminateAgent(): Promise<void> {
    throw new Error("Nemoclaw integration is not configured");
  }
}
