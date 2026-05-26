import type { AgentProviderName } from "./types";

export interface ProviderThrottleOptions {
  globalMaxConcurrentRuns?: number;
  providerMaxConcurrentRuns?: Partial<Record<AgentProviderName, number>>;
}

export interface ProviderThrottleClaim {
  provider: AgentProviderName;
  waitedMs: number;
  release(): void;
}

interface QueueEntry {
  resolve: (claim: ProviderThrottleClaim) => void;
  requestedAt: number;
}

export class ProviderThrottle {
  private globalActiveRuns = 0;
  private readonly providerActiveRuns = new Map<AgentProviderName, number>();
  private readonly queues = new Map<AgentProviderName, QueueEntry[]>();

  constructor(private readonly options: ProviderThrottleOptions = {}) {}

  async claim(provider: AgentProviderName): Promise<ProviderThrottleClaim> {
    const requestedAt = Date.now();
    if (this.canStart(provider)) {
      return this.start(provider, requestedAt);
    }

    return new Promise((resolve) => {
      const queue = this.queues.get(provider) ?? [];
      this.queues.set(provider, [...queue, { resolve, requestedAt }]);
    });
  }

  private canStart(provider: AgentProviderName) {
    return this.globalActiveRuns < this.globalLimit && this.providerCount(provider) < this.providerLimit(provider);
  }

  private start(provider: AgentProviderName, requestedAt: number): ProviderThrottleClaim {
    this.globalActiveRuns += 1;
    this.providerActiveRuns.set(provider, this.providerCount(provider) + 1);
    let released = false;
    return {
      provider,
      waitedMs: Date.now() - requestedAt,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.globalActiveRuns = Math.max(0, this.globalActiveRuns - 1);
        this.providerActiveRuns.set(provider, Math.max(0, this.providerCount(provider) - 1));
        this.drain();
      }
    };
  }

  private drain() {
    for (const [provider, queue] of Array.from(this.queues.entries())) {
      if (queue.length === 0 || !this.canStart(provider)) {
        continue;
      }

      const [next, ...rest] = queue;
      this.queues.set(provider, rest);
      next.resolve(this.start(provider, next.requestedAt));
    }
  }

  private providerCount(provider: AgentProviderName) {
    return this.providerActiveRuns.get(provider) ?? 0;
  }

  private providerLimit(provider: AgentProviderName) {
    return Math.max(1, this.options.providerMaxConcurrentRuns?.[provider] ?? 1);
  }

  private get globalLimit() {
    return Math.max(1, this.options.globalMaxConcurrentRuns ?? 4);
  }
}

export function parseRetryAfter(value: string | null | undefined, now = Date.now()) {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }

  return Math.max(0, dateMs - now);
}
