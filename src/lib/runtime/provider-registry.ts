import { CodexRuntime } from "./codex-runtime";
import { MockRuntime } from "./mock-runtime";
import { NemoclawRuntime } from "./nemoclaw-runtime";
import { OpenClawRuntime } from "./openclaw-runtime";
import { ProviderThrottle } from "./provider-throttle";
import type { AgentProviderName, AgentRuntime } from "./types";

export type RuntimeProviderMap = Map<AgentProviderName, AgentRuntime>;

export function createAgentRuntimeFromEnv() {
  return createRuntimeForProvider(readProviderName(process.env.FORGEOS_AGENT_PROVIDER));
}

export function createRuntimeForProvider(provider: AgentProviderName): AgentRuntime {
  if (provider === "codex") {
    return new CodexRuntime();
  }
  if (provider === "openclaw") {
    return new OpenClawRuntime();
  }
  if (provider === "nemoclaw") {
    return new NemoclawRuntime();
  }
  return new MockRuntime();
}

export function createRuntimeProviderMap(primary: AgentRuntime): RuntimeProviderMap {
  return new Map<AgentProviderName, AgentRuntime>([
    ["mock", primary.provider() === "mock" ? primary : new MockRuntime()],
    ["codex", primary.provider() === "codex" ? primary : new CodexRuntime()],
    ["openclaw", primary.provider() === "openclaw" ? primary : new OpenClawRuntime()],
    ["nemoclaw", primary.provider() === "nemoclaw" ? primary : new NemoclawRuntime()]
  ]);
}

export function createProviderThrottleFromEnv() {
  return new ProviderThrottle({
    globalMaxConcurrentRuns: readPositiveInteger(process.env.FORGEOS_AGENT_MAX_CONCURRENT_RUNS, 4),
    providerMaxConcurrentRuns: {
      mock: readPositiveInteger(process.env.FORGEOS_MOCK_MAX_CONCURRENT_RUNS, 4),
      codex: readPositiveInteger(process.env.FORGEOS_CODEX_MAX_CONCURRENT_RUNS, 1),
      openclaw: readPositiveInteger(process.env.FORGEOS_OPENCLAW_MAX_CONCURRENT_RUNS, 1),
      nemoclaw: readPositiveInteger(process.env.FORGEOS_NEMOCLAW_MAX_CONCURRENT_RUNS, 1)
    }
  });
}

export function readProviderName(value: string | undefined): AgentProviderName {
  return value === "openclaw" || value === "codex" || value === "nemoclaw" || value === "mock" ? value : "mock";
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
