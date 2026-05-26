import { describe, expect, it, vi } from "vitest";
import { createEmptyForgeSnapshot } from "@/lib/mock/seed";
import type { ForgeSnapshot } from "@/lib/runtime/types";

const storeMocks = vi.hoisted(() => ({
  listForges: vi.fn(),
  getSnapshot: vi.fn()
}));

vi.mock("@/lib/runtime/store", () => ({
  runtimeStore: storeMocks
}));

import { GET } from "./route";

describe("GET /api/usage", () => {
  it("summarizes local run usage when OpenAI admin costs are not configured", async () => {
    const originalAdminKey = process.env.FORGEOS_OPENAI_ADMIN_KEY;
    const originalOpenAIAdminKey = process.env.OPENAI_ADMIN_KEY;
    delete process.env.FORGEOS_OPENAI_ADMIN_KEY;
    delete process.env.OPENAI_ADMIN_KEY;
    const fetchMock = vi.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchMock;

    const snapshot = withRuns(
      createEmptyForgeSnapshot({
        id: "forge-usage",
        slug: "usage-forge",
        name: "Usage Forge"
      })
    );

    storeMocks.listForges.mockResolvedValue([{ slug: "usage-forge" }]);
    storeMocks.getSnapshot.mockResolvedValue(snapshot);

    try {
      const response = await GET();
      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          local: {
            totals: {
              totalRuns: number;
              completedRuns: number;
              activeRuns: number;
              requestCount: number;
              inputTokens: number;
              outputTokens: number;
              cachedInputTokens: number;
              costMicros: number;
              webEnabledRuns: number;
              webSourceCount: number;
              omittedContextCount: number;
              truncatedContextCount: number;
            };
            openai: {
              trackedCostMicros: number;
              runs: number;
              runsWithEstimatedCost: number;
              runsWithoutEstimatedCost: number;
            };
            byProvider: Array<{ key: string; runs: number; costMicros: number }>;
            byForge: Array<{
              key: string;
              openaiSpendMicros: number;
              openaiSpendLimitMicros?: number;
              openaiSpendRemainingMicros?: number;
              openaiSpendLimitReached: boolean;
            }>;
            recentRuns: Array<{ id: string; forgeSlug: string; web: { enabled: boolean; used: boolean; sourceCount: number } }>;
          };
          openai: { configured: boolean; status: string; totalUsd: null; buckets: unknown[] };
        };
      };

      expect(response.status).toBe(200);
      expect(payload.success).toBe(true);
      expect(payload.data?.local.totals).toMatchObject({
        totalRuns: 2,
        completedRuns: 1,
        activeRuns: 1,
        requestCount: 3,
        inputTokens: 120,
        outputTokens: 45,
        cachedInputTokens: 20,
        costMicros: 2500,
        webEnabledRuns: 1,
        webSourceCount: 4,
        omittedContextCount: 2,
        truncatedContextCount: 3
      });
      expect(payload.data?.local.byProvider).toContainEqual(expect.objectContaining({ key: "codex", runs: 1, costMicros: 2500 }));
      expect(payload.data?.local.byProvider).toContainEqual(expect.objectContaining({ key: "mock", runs: 1, costMicros: 0 }));
      expect(payload.data?.local.openai).toMatchObject({
        trackedCostMicros: 2500,
        runs: 1,
        runsWithEstimatedCost: 1,
        runsWithoutEstimatedCost: 0
      });
      expect(payload.data?.local.byForge).toEqual([
        expect.objectContaining({
          key: "usage-forge",
          openaiSpendMicros: 2500,
          openaiSpendLimitMicros: 3000,
          openaiSpendRemainingMicros: 500,
          openaiSpendLimitReached: false
        })
      ]);
      expect(payload.data?.local.recentRuns[0]).toEqual(
        expect.objectContaining({
          id: "run-active",
          forgeSlug: "usage-forge",
          web: { enabled: false, used: false, sourceCount: 0 }
        })
      );
      expect(payload.data?.openai).toEqual({
        configured: false,
        status: "missing_admin_key",
        totalUsd: null,
        buckets: []
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv("FORGEOS_OPENAI_ADMIN_KEY", originalAdminKey);
      restoreEnv("OPENAI_ADMIN_KEY", originalOpenAIAdminKey);
      global.fetch = originalFetch;
      vi.clearAllMocks();
    }
  });

  it("returns OpenAI billed cost totals and the local tracking gap when admin costs are configured", async () => {
    const originalAdminKey = process.env.FORGEOS_OPENAI_ADMIN_KEY;
    const originalOpenAIAdminKey = process.env.OPENAI_ADMIN_KEY;
    process.env.FORGEOS_OPENAI_ADMIN_KEY = "admin-test-key";
    delete process.env.OPENAI_ADMIN_KEY;
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            start_time: 1779750000,
            end_time: 1779836400,
            results: [
              { amount: { value: 7.25, currency: "usd" }, line_item: "Responses API", project_id: "proj_forgeos" },
              { amount: { value: 0.5, currency: "usd" }, line_item: "Web search", project_id: "proj_forgeos" }
            ]
          }
        ]
      })
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const snapshot = withRuns(
      createEmptyForgeSnapshot({
        id: "forge-usage",
        slug: "usage-forge",
        name: "Usage Forge"
      })
    );
    storeMocks.listForges.mockResolvedValue([{ slug: "usage-forge" }]);
    storeMocks.getSnapshot.mockResolvedValue(snapshot);

    try {
      const response = await GET();
      const payload = (await response.json()) as {
        data?: {
          local: { openai: { trackedCostMicros: number } };
          openai: {
            totalUsd: number | null;
            totalMicros?: number;
            byLineItem?: Array<{ key: string; amountMicros: number }>;
            byProject?: Array<{ key: string; amountMicros: number }>;
          };
        };
      };

      expect(payload.data?.local.openai.trackedCostMicros).toBe(2500);
      expect(payload.data?.openai.totalUsd).toBe(7.75);
      expect(payload.data?.openai.totalMicros).toBe(7_750_000);
      expect(payload.data?.openai.byLineItem).toEqual([
        { key: "Responses API", amountUsd: 7.25, amountMicros: 7_250_000 },
        { key: "Web search", amountUsd: 0.5, amountMicros: 500_000 }
      ]);
      expect(payload.data?.openai.byProject).toEqual([{ key: "proj_forgeos", amountUsd: 7.75, amountMicros: 7_750_000 }]);
      expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer admin-test-key" })
      }));
    } finally {
      restoreEnv("FORGEOS_OPENAI_ADMIN_KEY", originalAdminKey);
      restoreEnv("OPENAI_ADMIN_KEY", originalOpenAIAdminKey);
      global.fetch = originalFetch;
      vi.clearAllMocks();
    }
  });
});

function withRuns(snapshot: ForgeSnapshot): ForgeSnapshot {
  return {
    ...snapshot,
    forge: {
      ...snapshot.forge,
      openaiSpendLimitMicros: 3000
    },
    runs: [
      {
        id: "run-completed",
        forgeId: snapshot.forge.id,
        operationId: "operation-1",
        workerId: "worker-1",
        provider: "codex",
        status: "completed",
        capabilities: runtimeCapabilities({ streamsEvents: true, supportsWebSearch: true }),
        queuedAt: "2026-05-25T16:00:00.000Z",
        startedAt: "2026-05-25T16:01:00.000Z",
        completedAt: "2026-05-25T16:02:00.000Z",
        usage: {
          requestCount: 2,
          inputTokens: 120,
          outputTokens: 45,
          cachedInputTokens: 20,
          costMicros: 2500
        },
        providerMetadata: {
          webEnabled: true,
          webUsed: true,
          webSourceCount: 4,
          traceSummary: {
            context: {
              omittedReasons: ["secret", "too-large"],
              sections: [{ truncatedItems: 1 }, { truncatedItems: 2 }]
            }
          }
        }
      },
      {
        id: "run-active",
        forgeId: snapshot.forge.id,
        operationId: "operation-2",
        provider: "mock",
        status: "running",
        capabilities: runtimeCapabilities(),
        queuedAt: "2026-05-25T16:03:00.000Z",
        startedAt: "2026-05-25T16:04:00.000Z",
        usage: { requestCount: 1 },
        providerMetadata: {}
      }
    ]
  };
}

function runtimeCapabilities(overrides: Partial<ForgeSnapshot["runs"][number]["capabilities"]> = {}): ForgeSnapshot["runs"][number]["capabilities"] {
  return {
    streamsEvents: false,
    supportsCancel: false,
    supportsResume: false,
    supportsRetries: true,
    supportsWorkspaceRefs: true,
    supportsWebSearch: false,
    ...overrides
  };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
