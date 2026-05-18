import type { ForgeSnapshot } from "@/lib/runtime/types";

const now = new Date("2026-05-17T20:00:00.000Z").toISOString();

export interface CreateForgeSnapshotInput {
  id: string;
  slug: string;
  name: string;
  tagline?: string;
  prefixEntityIds?: boolean;
}

export function createDemoSnapshot(): ForgeSnapshot {
  return createForgeSnapshot({
    id: "demo-forge",
    slug: "demo",
    name: "ForgeOS Demo Forge",
    tagline: "An operating system for autonomous AI organizations."
  });
}

export function createForgeSnapshot(input: CreateForgeSnapshotInput): ForgeSnapshot {
  const tagline = input.tagline ?? "An operating system for autonomous AI organizations.";
  const idFor = input.prefixEntityIds ? (id: string) => `${input.slug}-${id}` : (id: string) => id;

  const divisions = [
    { id: idFor("strategy"), name: "Strategy Division", objective: "Shape the project direction and hackathon strategy.", status: "completed", progress: 100, order: 1 },
    { id: idFor("operations"), name: "Operations Division", objective: "Coordinate handoffs, blockers, and organizational alignment.", status: "running", progress: 72, order: 2 },
    { id: idFor("engineering"), name: "Engineering Division", objective: "Build the product through dependency-aware operations.", status: "running", progress: 61, order: 3 },
    { id: idFor("presentation"), name: "Presentation Division", objective: "Create pitch narrative, demo flow, and judge positioning.", status: "reviewing", progress: 54, order: 4 },
    { id: idFor("qa"), name: "QA Division", objective: "Review implementation, pitch, and organizational consistency.", status: "planning", progress: 22, order: 5 },
    { id: idFor("release"), name: "Release Division", objective: "Finalize launch readiness, documentation, and demo path.", status: "idle", progress: 8, order: 6 }
  ] as ForgeSnapshot["divisions"];

  const workers = [
    worker(idFor("executive-ai"), idFor("operations"), "Executive AI", "Runtime coordinator", "running", "Coordinating Forge status"),
    worker(idFor("strategy-director"), idFor("strategy"), "Strategy Director", "Project strategy owner", "completed", "Finalized Forge plan"),
    worker(idFor("research-analyst"), idFor("strategy"), "Research Analyst", "Competitive and sponsor research", "completed", "Delivered market scan"),
    worker(idFor("ops-coordinator"), idFor("operations"), "Engineering Coordinator", "Cross-division operations router", "running", "Routing engineering handoff"),
    worker(idFor("eng-director"), idFor("engineering"), "Engineering Director", "Technical execution owner", "running", "Sequencing implementation graph"),
    worker(idFor("frontend-worker"), idFor("engineering"), "Frontend Worker", "Command center UI specialist", "running", "Building dashboard shell"),
    worker(idFor("backend-worker"), idFor("engineering"), "Backend Worker", "Runtime and API specialist", "ready", "Waiting for schema lock"),
    worker(idFor("testing-worker"), idFor("engineering"), "Testing Worker", "Verification specialist", "blocked", "Waiting for UI contracts"),
    worker(idFor("story-strategist"), idFor("presentation"), "Story Strategist", "Pitch narrative owner", "reviewing", "Reviewing judge story"),
    worker(idFor("qa-runner-alpha"), idFor("qa"), "QA Runner Alpha", "Autonomous review runner", "planning", "Preparing validation plan"),
    worker(idFor("release-director"), idFor("release"), "Release Director", "Submission readiness owner", "idle", "Waiting for QA pass")
  ] as ForgeSnapshot["workers"];

  const operations = [
    op(idFor("op-strategy-plan"), idFor("strategy"), idFor("strategy-director"), "Finalize Forge strategy", "Define scope, judge angle, risks, and execution roadmap.", "completed", 100, []),
    op(idFor("op-research"), idFor("strategy"), idFor("research-analyst"), "Research sponsor alignment", "Identify competitive framing and sponsor-friendly capabilities.", "completed", 100, []),
    op(idFor("op-handoff-eng"), idFor("operations"), idFor("ops-coordinator"), "Prepare engineering handoff", "Convert strategy into build-ready operations and constraints.", "completed", 100, [idFor("artifact-strategy")]),
    op(idFor("op-runtime"), idFor("engineering"), idFor("backend-worker"), "Implement runtime contracts", "Create RuntimeStore, event stream, scheduler, and mock adapter.", "ready", 25, []),
    op(idFor("op-dashboard"), idFor("engineering"), idFor("frontend-worker"), "Build Forge Command Center", "Render cockpit, org map, operations board, inspector, and console.", "running", 58, []),
    op(idFor("op-tests"), idFor("engineering"), idFor("testing-worker"), "Verify runtime and UI", "Cover event ordering, dependency readiness, APIs, and golden flow.", "blocked", 10, [], "Waiting for runtime contracts"),
    op(idFor("op-pitch"), idFor("presentation"), idFor("story-strategist"), "Draft demo narrative", "Create pitch outline and demo script aligned to ForgeOS value.", "reviewing", 61, [idFor("artifact-pitch")]),
    op(idFor("op-qa"), idFor("qa"), idFor("qa-runner-alpha"), "Run organizational review", "Inspect output quality, security risks, and release readiness.", "planning", 15, []),
    op(idFor("op-release"), idFor("release"), idFor("release-director"), "Prepare release pass", "Finalize README, checklist, and submission readiness.", "planning", 5, [])
  ] as ForgeSnapshot["operations"];

  const dependencies = [
    dep(idFor("dep-runtime-handoff"), idFor("op-runtime"), idFor("op-handoff-eng")),
    dep(idFor("dep-dashboard-runtime"), idFor("op-dashboard"), idFor("op-runtime"), "informs"),
    dep(idFor("dep-tests-runtime"), idFor("op-tests"), idFor("op-runtime")),
    dep(idFor("dep-qa-dashboard"), idFor("op-qa"), idFor("op-dashboard")),
    dep(idFor("dep-qa-pitch"), idFor("op-qa"), idFor("op-pitch")),
    dep(idFor("dep-release-qa"), idFor("op-release"), idFor("op-qa"))
  ] as ForgeSnapshot["dependencies"];

  const artifacts = [
    artifact(idFor("artifact-strategy"), "ForgeOS Project Plan", "project_plan", idFor("strategy"), idFor("strategy-director"), idFor("op-strategy-plan"), "A serious AI organization runtime for hackathon execution with visible hierarchy, artifacts, handoffs, and release pass.", "finalized", ["strategy", "scope"]),
    artifact(idFor("artifact-architecture"), "Runtime Architecture Proposal", "architecture_plan", idFor("engineering"), idFor("eng-director"), idFor("op-runtime"), "Server-authoritative snapshot plus append-only events, strict runtime adapters, and virtual workspace boundaries.", "generated", ["runtime", "events"]),
    artifact(idFor("artifact-pitch"), "Presentation Outline", "pitch_outline", idFor("presentation"), idFor("story-strategist"), idFor("op-pitch"), "Position ForgeOS as Kubernetes for autonomous AI organizations, focused on command visibility and execution confidence.", "generated", ["pitch", "judges"]),
    artifact(idFor("artifact-qa"), "QA Risk Register", "review_report", idFor("qa"), idFor("qa-runner-alpha"), idFor("op-qa"), "Open risks: endpoint hardening, event ordering, XSS in rendered generated content, and real-agent adapter contract drift.", "draft", ["qa", "security"])
  ] as ForgeSnapshot["artifacts"];

  const files = [
    file(idFor("file-readme"), "README.md", "# ForgeOS\n\nAn operating system for autonomous AI organizations.\n", "generated", idFor("strategy"), idFor("strategy-director"), idFor("op-strategy-plan"), [idFor("artifact-strategy")]),
    file(idFor("file-page"), "src/app/page.tsx", "export default function Page() {\n  return <ForgeCommandCenter />\n}\n", "draft", idFor("engineering"), idFor("frontend-worker"), idFor("op-dashboard"), [idFor("artifact-architecture")]),
    file(idFor("file-plan"), "docs/project-plan.md", "# Project Plan\n\nForgeOS command center, runtime, and release pipeline.\n", "finalized", idFor("strategy"), idFor("strategy-director"), idFor("op-strategy-plan"), [idFor("artifact-strategy")]),
    file(idFor("file-pitch"), "pitch/presentation-outline.md", "# Pitch Outline\n\nProblem, autonomous organization runtime, demo flow, and release pass.\n", "generated", idFor("presentation"), idFor("story-strategist"), idFor("op-pitch"), [idFor("artifact-pitch")]),
    file(idFor("file-qa"), "review/qa-report.md", "# QA Report\n\nRuntime state and command APIs require focused validation.\n", "draft", idFor("qa"), idFor("qa-runner-alpha"), idFor("op-qa"), [idFor("artifact-qa")])
  ];

  const handoffs = [
    {
      id: idFor("handoff-strategy-ops"),
      fromDivisionId: idFor("strategy"),
      toDivisionId: idFor("operations"),
      summary: "Strategy has locked the product identity, core scope, and MVP operating model.",
      deliverables: ["Project plan", "Competitive positioning", "Scope constraints"],
      blockers: [],
      requiredContext: ["Build dashboard first", "Keep mock-to-real adapters strict"],
      confidence: 92,
      createdAt: now
    },
    {
      id: idFor("handoff-ops-eng"),
      fromDivisionId: idFor("operations"),
      toDivisionId: idFor("engineering"),
      summary: "Engineering can proceed with runtime contracts and command center shell.",
      deliverables: ["Operation graph", "Runtime boundaries", "UI panel priorities"],
      blockers: ["Testing waits for runtime event contract"],
      requiredContext: ["Virtual files only", "No raw provider internals"],
      confidence: 84,
      createdAt: now
    }
  ];

  const messages = [
    { id: idFor("msg-1"), role: "executive", content: "Forge initialized. Strategy is complete, engineering is active, and QA is preparing the release review.", createdAt: now },
    { id: idFor("msg-2"), role: "operator", content: "Surface the current blockers.", createdAt: now },
    { id: idFor("msg-3"), role: "executive", content: "Primary blocker: testing worker is waiting for runtime contracts. Recommendation: lock RuntimeEvent and ForgeSnapshot before broad UI expansion.", createdAt: now }
  ] as ForgeSnapshot["messages"];

  const events = [
    event(input.id, idFor, 1, "forge.initialized", "runtime", "forge", input.id, "Forge initialized with seeded autonomous organization.", "success"),
    event(input.id, idFor, 2, "operation.completed", "worker", "operation", idFor("op-strategy-plan"), "Strategy plan finalized.", "success"),
    event(input.id, idFor, 3, "handoff.created", "division", "handoff", idFor("handoff-strategy-ops"), "Strategy handed execution context to Operations.", "info"),
    event(input.id, idFor, 4, "operation.started", "worker", "operation", idFor("op-dashboard"), "Frontend Worker started the command center.", "info"),
    event(input.id, idFor, 5, "operation.blocked", "worker", "operation", idFor("op-tests"), "Testing is blocked on runtime contract completion.", "warning")
  ];

  return {
    forge: {
      id: input.id,
      slug: input.slug,
      name: input.name,
      tagline,
      activePhase: "Autonomous Development",
      status: "active"
    },
    lastEventSequence: events.length,
    schemaVersion: 2,
    divisions,
    workers,
    operations,
    dependencies,
    artifacts,
    files,
    handoffs,
    messages,
    events
  };
}

function worker(id: string, divisionId: string, name: string, role: string, status: ForgeSnapshot["workers"][number]["status"], currentTask: string) {
  return {
    id,
    divisionId,
    name,
    role,
    status,
    currentTask,
    contextManifest: {
      objective: currentTask,
      instructionSources: ["ForgeOS role charter", "Current operation brief"],
      virtualFileRefs: ["docs/project-plan.md"],
      artifactRefs: ["artifact-strategy"],
      memorySnippets: ["Prioritize hierarchy, handoffs, and operational visibility."],
      recentEventSummary: ["Received latest runtime event projection."],
      redactions: ["Provider raw prompts and hidden instructions are not displayed."]
    }
  };
}

function op(
  id: string,
  divisionId: string,
  workerId: string,
  title: string,
  description: string,
  status: ForgeSnapshot["operations"][number]["status"],
  progress: number,
  outputArtifactIds: string[],
  blockedReason?: string
) {
  return { id, divisionId, workerId, title, description, status, priority: "high", progress, blockedReason, retryCount: 0, outputArtifactIds };
}

function dep(id: string, operationId: string, dependsOnOperationId: string, type: ForgeSnapshot["dependencies"][number]["type"] = "blocks") {
  return { id, operationId, dependsOnOperationId, type };
}

function artifact(
  id: string,
  title: string,
  type: string,
  divisionId: string,
  workerId: string,
  operationId: string,
  content: string,
  status: ForgeSnapshot["artifacts"][number]["status"],
  tags: string[]
) {
  return { id, title, type, divisionId, workerId, operationId, content, status, version: 1, tags, fileIds: [], createdAt: now, updatedAt: now };
}

function file(
  id: string,
  path: string,
  content: string,
  status: ForgeSnapshot["files"][number]["status"],
  divisionId: string,
  workerId: string,
  operationId: string,
  artifactIds: string[]
) {
  return { id, path, content, status, version: 1, divisionId, workerId, operationId, artifactIds, updatedAt: now };
}

function event(
  forgeId: string,
  idFor: (id: string) => string,
  sequence: number,
  type: ForgeSnapshot["events"][number]["type"],
  actorType: ForgeSnapshot["events"][number]["actorType"],
  targetType: ForgeSnapshot["events"][number]["targetType"],
  targetId: string,
  message: string,
  severity: ForgeSnapshot["events"][number]["severity"]
) {
  return {
    id: idFor(`event-${sequence}`),
    forgeId,
    sequence,
    type,
    actorType,
    targetType,
    targetId,
    message,
    severity,
    payload: {},
    createdAt: now
  };
}
