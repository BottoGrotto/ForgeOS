import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "@/lib/mock/seed";
import { OpenAIExecutiveIntentProvider } from "./provider";

describe("OpenAIExecutiveIntentProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends bounded recent Executive conversation history with secret-like values redacted", async () => {
    const snapshot = {
      ...createDemoSnapshot(),
      messages: Array.from({ length: 10 }, (_, index) => ({
        id: `msg-${index}`,
        role: index % 2 === 0 ? ("operator" as const) : ("executive" as const),
        kind: index % 2 === 0 ? ("operator_prompt" as const) : ("executive_reply" as const),
        source: "manual" as const,
        content: index === 9 ? "Use the previous source-link prompt with sk-proj-example-secret-value" : `Conversation turn ${index}`,
        createdAt: `2026-05-25T12:${String(index).padStart(2, "0")}:00.000Z`
      }))
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ output_text: JSON.stringify({ summary: "Prepared from history.", actions: [] }) })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIExecutiveIntentProvider("test-key", "gpt-test");
    await provider.proposeOperationChanges({
      forgeId: snapshot.forge.id,
      message: "Do that again with four agents.",
      snapshot
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const userPayload = JSON.parse(body.input.find((item: { role: string }) => item.role === "user").content);

    expect(body.text.format).toMatchObject({
      type: "json_schema",
      strict: true
    });
    expectStrictObjectSchemasRequireEveryProperty(body.text.format.schema);
    expect(userPayload.operatorMessage).toBe("Do that again with four agents.");
    expect(userPayload.recentConversation).toHaveLength(8);
    expect(userPayload.recentConversation.map((item: { id: string }) => item.id)).not.toContain("msg-0");
    expect(userPayload.recentConversation.at(-1)).toMatchObject({
      id: "msg-9",
      role: "executive",
      kind: "executive_reply"
    });
    expect(JSON.stringify(userPayload.recentConversation)).not.toContain("sk-proj-example-secret-value");
    expect(JSON.stringify(userPayload.recentConversation)).toContain("[redacted-secret]");
  });

  it("sends pending proposals so follow-up prompts can revise existing plans", async () => {
    const snapshot = {
      ...createDemoSnapshot(),
      proposals: [
        {
          id: "proposal-original",
          status: "pending" as const,
          sourceMessageId: "msg-original",
          provider: "openai" as const,
          model: "gpt-test",
          summary: "Build an inventory search website.",
          actions: [
            {
              type: "create_operation" as const,
              title: "Build menu search",
              description: "Build a searchable inventory interface.",
              divisionId: "engineering",
              workerId: "frontend-worker",
              priority: "high" as const,
              status: "ready" as const
            }
          ],
          createdAt: "2026-05-25T12:00:00.000Z"
        }
      ]
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          summary: "Revised to use the supplied source link.",
          supersedesProposalIds: ["proposal-original"],
          actions: []
        })
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIExecutiveIntentProvider("test-key", "gpt-test");
    await provider.proposeOperationChanges({
      forgeId: snapshot.forge.id,
      message: "Use https://example.com/source-feed as the source.",
      snapshot
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const userPayload = JSON.parse(body.input.find((item: { role: string }) => item.role === "user").content);

    expect(userPayload.pendingProposals).toEqual([
      expect.objectContaining({
        id: "proposal-original",
        summary: "Build an inventory search website."
      })
    ]);
  });

  it("sends explicit delegation guidance for research versus engineering work", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ output_text: JSON.stringify({ summary: "Prepared routing plan.", actions: [] }) })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIExecutiveIntentProvider("test-key", "gpt-test");
    await provider.proposeOperationChanges({
      forgeId: "demo-forge",
      message: "Research the provided source page and build the website.",
      snapshot: createDemoSnapshot()
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const developerPrompt = body.input.find((item: { role: string }) => item.role === "developer").content;
    const userPayload = JSON.parse(body.input.find((item: { role: string }) => item.role === "user").content);

    expect(developerPrompt).toContain("Broad product, user, market, source-discovery, scope, requirements, acceptance-criteria, and authoritative-link research belongs in Strategy");
    expect(developerPrompt).toContain("Engineering may perform implementation research");
    expect(developerPrompt).toContain("Create prerequisite scaffold/setup operations before app implementation");
    expect(developerPrompt).toContain("QA, validation, review, release, deployment, and packaging operations may be proposed early");
    expect(developerPrompt).toContain("complete with actual virtual files or file patches");
    expect(developerPrompt).toContain("Treat the configured parallel run target as a utilization goal");
    expect(developerPrompt).toContain("Prefer several focused ready operations for different workers over one broad serial operation");
    expect(developerPrompt).toContain("A create_operation workerId must belong to the same divisionId");
    expect(developerPrompt).toContain("never a worker from another division");
    expect(userPayload.delegationGuidance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          division: "strategy",
          owns: expect.arrayContaining(["product/user/source-discovery research"])
        }),
        expect.objectContaining({
          division: "engineering",
          owns: expect.arrayContaining(["technical feasibility research"])
        }),
        expect.objectContaining({
          division: "qa",
          avoid: expect.arrayContaining(["workers from another division for QA-owned work"])
        }),
        expect.objectContaining({
          division: "release",
          avoid: expect.arrayContaining(["workers from another division for Release-owned work"])
        })
      ])
    );
  });

  it("sends recent runtime diagnostics and tells Executive not to ask operators for logs", async () => {
    const baseSnapshot = createDemoSnapshot();
    const run = {
      ...baseSnapshot.runs[0],
      id: "run-verification-failed",
      operationId: "op-tests",
      status: "failed" as const,
      providerMetadata: {
        verificationSummary: {
          source: "runtime",
          status: "failed",
          tier: "acceptance",
          checkedAt: "2026-05-26T10:00:00.000Z",
          providerShellAccess: false,
          projectedArtifactIds: [],
          projectedFileIds: ["file-app"],
          projectedHandoffIds: [],
          blockerCount: 0,
          checks: [
            {
              name: "npm run build",
              status: "failed",
              message: "Verification command failed with exit code 1.",
              exitCode: 1,
              outputTail: "src/App.tsx:12:7 - error TS2322: Type 'string' is not assignable."
            }
          ]
        }
      }
    };
    const snapshot = {
      ...baseSnapshot,
      runs: [...baseSnapshot.runs, run],
      events: [
        ...baseSnapshot.events,
        {
          id: "event-launcher-check",
          sequence: baseSnapshot.lastEventSequence + 1,
          forgeId: baseSnapshot.forge.id,
          type: "launcher.check_completed" as const,
          actorType: "runtime" as const,
          targetType: "forge" as const,
          targetId: baseSnapshot.forge.id,
          message: "Project launcher check failed.",
          severity: "error" as const,
          payload: { launcherId: "launcher-one", status: "failed", command: "npm run build", exitCode: 1, timedOut: false },
          createdAt: "2026-05-26T10:00:00.000Z"
        },
        {
          id: "event-launcher-log",
          sequence: baseSnapshot.lastEventSequence + 2,
          forgeId: baseSnapshot.forge.id,
          type: "launcher.log" as const,
          actorType: "runtime" as const,
          targetType: "forge" as const,
          targetId: baseSnapshot.forge.id,
          message: "Launcher log tail captured.",
          severity: "info" as const,
          payload: { launcherId: "launcher-one", output: "Chrome extension runtime check failed with exit code 1\nbackground.ts missing manifest permission" },
          createdAt: "2026-05-26T10:00:01.000Z"
        }
      ],
      lastEventSequence: baseSnapshot.lastEventSequence + 2
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ output_text: JSON.stringify({ summary: "Prepared repair work.", actions: [] }) })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIExecutiveIntentProvider("test-key", "gpt-test");
    await provider.proposeOperationChanges({
      forgeId: snapshot.forge.id,
      message: "Fix the failed launcher check.",
      snapshot
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const developerPrompt = body.input.find((item: { role: string }) => item.role === "developer").content;
    const userPayload = JSON.parse(body.input.find((item: { role: string }) => item.role === "user").content);

    expect(developerPrompt).toContain("Do not ask the operator for runtime logs, launcher output, verification output, stack traces, or error codes");
    expect(JSON.stringify(userPayload.recentRuntimeFindings)).toContain("Chrome extension runtime check failed with exit code 1");
    expect(JSON.stringify(userPayload.recentRuntimeFindings)).toContain("TS2322");
    expect(JSON.stringify(userPayload.recentRuntimeFindings)).toContain("exitCode");
  });

  it("normalizes strict-schema null placeholders before returning proposal actions", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          summary: "Prepared strict proposal.",
          supersedesProposalIds: [],
          actions: [
            {
              type: "create_operation",
              title: "Build UI",
              description: "Build the main interface.",
              divisionId: "engineering",
              workerId: null,
              priority: "high",
              status: "ready"
            },
            {
              type: "create_handoff",
              fromDivisionId: "strategy",
              toDivisionId: "engineering",
              targetOperationId: null,
              summary: "Use the scoped requirements.",
              deliverables: [],
              blockers: [],
              requiredContext: [],
              confidence: 80
            }
          ]
        })
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIExecutiveIntentProvider("test-key", "gpt-test");
    const proposal = await provider.proposeOperationChanges({
      forgeId: "demo-forge",
      message: "Build the UI.",
      snapshot: createDemoSnapshot()
    });

    expect(proposal).toEqual({
      summary: "Prepared strict proposal.",
      supersedesProposalIds: [],
      actions: [
        {
          type: "create_operation",
          title: "Build UI",
          description: "Build the main interface.",
          divisionId: "engineering",
          priority: "high",
          status: "ready",
          dependsOnOperationIds: [],
          dependsOnOperationKeys: []
        },
        {
          type: "create_handoff",
          fromDivisionId: "strategy",
          toDivisionId: "engineering",
          summary: "Use the scoped requirements.",
          deliverables: [],
          blockers: [],
          requiredContext: [],
          confidence: 80
        }
      ]
    });
  });

  it("normalizes dependency-gated operation proposals", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          summary: "Build first, then validate.",
          supersedesProposalIds: [],
          userQuestion: null,
          actions: [
            {
              type: "create_operation",
              operationKey: "build_app",
              title: "Build menu search app",
              description: "Create concrete app files for menu search.",
              divisionId: "engineering",
              workerId: "frontend-worker",
              workerName: null,
              priority: "critical",
              status: "ready",
              dependsOnOperationIds: [],
              dependsOnOperationKeys: []
            },
            {
              type: "create_operation",
              operationKey: "qa_app",
              title: "QA validate menu search app",
              description: "Validate the generated app only after implementation files exist.",
              divisionId: "qa",
              workerId: "qa-runner-alpha",
              workerName: null,
              priority: "high",
              status: "blocked",
              dependsOnOperationIds: [],
              dependsOnOperationKeys: ["build_app"]
            }
          ]
        })
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIExecutiveIntentProvider("test-key", "gpt-test");
    const proposal = await provider.proposeOperationChanges({
      forgeId: "demo-forge",
      message: "Build the app and validate it.",
      snapshot: createDemoSnapshot()
    });

    expect(proposal.actions).toEqual([
      expect.objectContaining({
        type: "create_operation",
        operationKey: "build_app",
        dependsOnOperationIds: [],
        dependsOnOperationKeys: []
      }),
      expect.objectContaining({
        type: "create_operation",
        operationKey: "qa_app",
        status: "blocked",
        dependsOnOperationKeys: ["build_app"]
      })
    ]);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const createOperationSchema = body.text.format.schema.properties.actions.items.anyOf.find(
      (item: { properties?: { type?: { enum?: string[] } } }) => item.properties?.type?.enum?.includes("create_operation")
    );
    expect(createOperationSchema.required).toEqual(
      expect.arrayContaining(["operationKey", "dependsOnOperationIds", "dependsOnOperationKeys"])
    );
  });

  it("bounds generated Executive Manager phase objectives", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ output_text: JSON.stringify({ summary: "Prepared long goal plan.", actions: [] }) })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIExecutiveIntentProvider("test-key", "gpt-test");
    const decision = await provider.decideNextExecutiveAction({
      forgeId: "demo-forge",
      message: "Build ".repeat(140),
      snapshot: createDemoSnapshot()
    });

    expect(decision.planPatch?.phases?.[0]?.objective.length).toBeLessThanOrEqual(500);
    expect(decision.planPatch?.phases?.[0]?.objective).toContain("[truncated]");
  });

  it("adds answered Executive questions to manager context", async () => {
    const snapshot = {
      ...createDemoSnapshot(),
      messages: [
        {
          id: "msg-answer",
          role: "operator" as const,
          kind: "operator_prompt" as const,
          source: "executive_loop" as const,
          content: "Answered Executive question: Who is this for?\nSelected: Startup founders\nNotes: Keep it practical.",
          createdAt: "2026-05-25T12:00:00.000Z"
        }
      ],
      events: [
        {
          id: "event-question",
          forgeId: "demo-forge",
          sequence: 1,
          type: "executive.user_input_requested" as const,
          actorType: "executive" as const,
          targetType: "forge" as const,
          targetId: "demo-forge",
          message: "Who is this for?",
          severity: "info" as const,
          payload: { questionId: "question-one", question: "Who is this for?" },
          createdAt: "2026-05-25T11:59:00.000Z"
        },
        {
          id: "event-answer",
          forgeId: "demo-forge",
          sequence: 2,
          type: "executive.user_input_answered" as const,
          actorType: "operator" as const,
          targetType: "forge" as const,
          targetId: "demo-forge",
          message: "Operator answered an Executive question.",
          severity: "info" as const,
          payload: { questionId: "question-one", selectedOptionIds: ["founders"], notes: "Keep it practical." },
          createdAt: "2026-05-25T12:00:00.000Z"
        }
      ]
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ output_text: JSON.stringify({ summary: "Prepared from answer.", actions: [] }) })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIExecutiveIntentProvider("test-key", "gpt-test");
    await provider.decideNextExecutiveAction({
      forgeId: "demo-forge",
      message: "Build the project.",
      snapshot
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const developerPrompt = body.input.find((item: { role: string }) => item.role === "developer").content;
    const userPayload = JSON.parse(body.input.find((item: { role: string }) => item.role === "user").content);

    expect(developerPrompt).toContain("Ask a structured operator question only when the answer materially changes");
    expect(userPayload.recentExecutiveQuestions).toEqual([
      expect.objectContaining({
        questionId: "question-one",
        question: "Who is this for?",
        answered: true,
        notes: "Keep it practical."
      })
    ]);
    expect(JSON.stringify(userPayload.recentConversation)).toContain("Keep it practical");
  });

  it("accepts structured manager question decisions from the provider", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          summary: "Need operator audience choice.",
          supersedesProposalIds: [],
          userQuestion: {
            reason: "Audience changes the product tone.",
            question: "Who is the primary audience?",
            options: [
              { id: "founders", label: "Startup founders", description: "Fast, launch-focused positioning." },
              { id: "enterprise", label: "Enterprise teams", description: "Trust and governance first." }
            ],
            allowNotes: true
          },
          actions: []
        })
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIExecutiveIntentProvider("test-key", "gpt-test");
    const decision = await provider.decideNextExecutiveAction({
      forgeId: "demo-forge",
      message: "Build a project.",
      snapshot: createDemoSnapshot()
    });

    expect(decision.userQuestion).toEqual({
      reason: "Audience changes the product tone.",
      question: "Who is the primary audience?",
      options: [
        { id: "founders", label: "Startup founders", description: "Fast, launch-focused positioning." },
        { id: "enterprise", label: "Enterprise teams", description: "Trust and governance first." }
      ],
      allowNotes: true
    });
  });

  it("bounds oversized Executive proposal text before runtime validation", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          summary: "Summary ".repeat(120),
          supersedesProposalIds: [],
          actions: [
            {
              type: "create_operation",
              title: "Build ".repeat(60),
              description: "Description ".repeat(160),
              divisionId: "engineering",
              workerId: null,
              priority: "high",
              status: "ready"
            },
            {
              type: "create_blocker",
              operationId: "op-tests",
              reason: "Reason ".repeat(120),
              severity: "warning"
            },
            {
              type: "delete_operation",
              operationId: "op-duplicate",
              reason: "Duplicate ".repeat(120)
            }
          ]
        })
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIExecutiveIntentProvider("test-key", "gpt-test");
    const proposal = await provider.proposeOperationChanges({
      forgeId: "demo-forge",
      message: "Build the UI.",
      snapshot: createDemoSnapshot()
    });

    expect(proposal.summary.length).toBeLessThanOrEqual(500);
    expect(proposal.actions[0]).toMatchObject({ type: "create_operation" });
    if (proposal.actions[0].type === "create_operation") {
      expect(proposal.actions[0].title.length).toBeLessThanOrEqual(160);
      expect(proposal.actions[0].description.length).toBeLessThanOrEqual(1000);
    }
    expect(proposal.actions[1]).toMatchObject({ type: "create_blocker" });
    if (proposal.actions[1].type === "create_blocker") {
      expect(proposal.actions[1].reason.length).toBeLessThanOrEqual(500);
    }
    expect(proposal.actions[2]).toMatchObject({ type: "delete_operation", operationId: "op-duplicate" });
    if (proposal.actions[2].type === "delete_operation") {
      expect(proposal.actions[2].reason.length).toBeLessThanOrEqual(500);
    }
  });
});

function expectStrictObjectSchemasRequireEveryProperty(schema: unknown) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return;
  }

  const candidate = schema as { type?: unknown; properties?: unknown; required?: unknown; anyOf?: unknown; items?: unknown };
  if (candidate.type === "object") {
    const properties = candidate.properties && typeof candidate.properties === "object" && !Array.isArray(candidate.properties) ? Object.keys(candidate.properties) : [];
    expect(candidate.required).toEqual(expect.arrayContaining(properties));
    expect(Array.isArray(candidate.required) ? candidate.required.slice().sort() : candidate.required).toEqual(properties.slice().sort());
  }

  if (candidate.properties && typeof candidate.properties === "object" && !Array.isArray(candidate.properties)) {
    for (const propertySchema of Object.values(candidate.properties)) {
      expectStrictObjectSchemasRequireEveryProperty(propertySchema);
    }
  }
  if (Array.isArray(candidate.anyOf)) {
    for (const option of candidate.anyOf) {
      expectStrictObjectSchemasRequireEveryProperty(option);
    }
  }
  if (candidate.items) {
    expectStrictObjectSchemasRequireEveryProperty(candidate.items);
  }
}
