import type { ForgeSnapshot } from "@/lib/runtime/types";

const now = new Date("2026-05-17T20:00:00.000Z").toISOString();

export function createDemoSnapshot(): ForgeSnapshot {
  const divisions = [
    { id: "strategy", name: "Strategy Division", objective: "Shape the project direction and hackathon strategy.", status: "completed", progress: 100, order: 1 },
    { id: "operations", name: "Operations Division", objective: "Coordinate handoffs, blockers, and organizational alignment.", status: "running", progress: 72, order: 2 },
    { id: "engineering", name: "Engineering Division", objective: "Build the product through dependency-aware operations.", status: "running", progress: 61, order: 3 },
    { id: "presentation", name: "Presentation Division", objective: "Create pitch narrative, demo flow, and judge positioning.", status: "reviewing", progress: 54, order: 4 },
    { id: "qa", name: "QA Division", objective: "Review implementation, pitch, and organizational consistency.", status: "planning", progress: 22, order: 5 },
    { id: "release", name: "Release Division", objective: "Finalize launch readiness, documentation, and demo path.", status: "idle", progress: 8, order: 6 }
  ] as ForgeSnapshot["divisions"];

  const workers = [
    worker("executive-ai", "operations", "Executive AI", "Runtime coordinator", "running", "Coordinating Forge status"),
    worker("strategy-director", "strategy", "Strategy Director", "Project strategy owner", "completed", "Finalized Forge plan"),
    worker("research-analyst", "strategy", "Research Analyst", "Competitive and sponsor research", "completed", "Delivered market scan"),
    worker("ops-coordinator", "operations", "Engineering Coordinator", "Cross-division operations router", "running", "Routing engineering handoff"),
    worker("eng-director", "engineering", "Engineering Director", "Technical execution owner", "running", "Sequencing implementation graph"),
    worker("frontend-worker", "engineering", "Frontend Worker", "Command center UI specialist", "running", "Building dashboard shell"),
    worker("backend-worker", "engineering", "Backend Worker", "Runtime and API specialist", "ready", "Waiting for schema lock"),
    worker("testing-worker", "engineering", "Testing Worker", "Verification specialist", "blocked", "Waiting for UI contracts"),
    worker("story-strategist", "presentation", "Story Strategist", "Pitch narrative owner", "reviewing", "Reviewing judge story"),
    worker("qa-runner-alpha", "qa", "QA Runner Alpha", "Autonomous review runner", "planning", "Preparing validation plan"),
    worker("release-director", "release", "Release Director", "Submission readiness owner", "idle", "Waiting for QA pass")
  ] as ForgeSnapshot["workers"];

  const operations = [
    op("op-strategy-plan", "strategy", "strategy-director", "Finalize Forge strategy", "Define scope, judge angle, risks, and execution roadmap.", "completed", 100, []),
    op("op-research", "strategy", "research-analyst", "Research sponsor alignment", "Identify competitive framing and sponsor-friendly capabilities.", "completed", 100, []),
    op("op-handoff-eng", "operations", "ops-coordinator", "Prepare engineering handoff", "Convert strategy into build-ready operations and constraints.", "completed", 100, ["artifact-strategy"]),
    op("op-runtime", "engineering", "backend-worker", "Implement runtime contracts", "Create RuntimeStore, event stream, scheduler, and mock adapter.", "ready", 25, []),
    op("op-dashboard", "engineering", "frontend-worker", "Build Forge Command Center", "Render cockpit, org map, operations board, inspector, and console.", "running", 58, []),
    op("op-tests", "engineering", "testing-worker", "Verify runtime and UI", "Cover event ordering, dependency readiness, APIs, and golden flow.", "blocked", 10, [], "Waiting for runtime contracts"),
    op("op-pitch", "presentation", "story-strategist", "Draft demo narrative", "Create pitch outline and demo script aligned to ForgeOS value.", "reviewing", 61, ["artifact-pitch"]),
    op("op-qa", "qa", "qa-runner-alpha", "Run organizational review", "Inspect output quality, security risks, and release readiness.", "planning", 15, []),
    op("op-release", "release", "release-director", "Prepare release pass", "Finalize README, checklist, and submission readiness.", "planning", 5, [])
  ] as ForgeSnapshot["operations"];

  const dependencies = [
    dep("dep-runtime-handoff", "op-runtime", "op-handoff-eng"),
    dep("dep-dashboard-runtime", "op-dashboard", "op-runtime", "informs"),
    dep("dep-tests-runtime", "op-tests", "op-runtime"),
    dep("dep-qa-dashboard", "op-qa", "op-dashboard"),
    dep("dep-qa-pitch", "op-qa", "op-pitch"),
    dep("dep-release-qa", "op-release", "op-qa")
  ] as ForgeSnapshot["dependencies"];

  const artifacts = [
    artifact("artifact-strategy", "ForgeOS Project Plan", "project_plan", "strategy", "strategy-director", "op-strategy-plan", "A serious AI organization runtime for hackathon execution with visible hierarchy, artifacts, handoffs, and release pass.", "finalized", ["strategy", "scope"]),
    artifact("artifact-architecture", "Runtime Architecture Proposal", "architecture_plan", "engineering", "eng-director", "op-runtime", "Server-authoritative snapshot plus append-only events, strict runtime adapters, and virtual workspace boundaries.", "generated", ["runtime", "events"]),
    artifact("artifact-pitch", "Presentation Outline", "pitch_outline", "presentation", "story-strategist", "op-pitch", "Position ForgeOS as Kubernetes for autonomous AI organizations, focused on command visibility and execution confidence.", "generated", ["pitch", "judges"]),
    artifact("artifact-qa", "QA Risk Register", "review_report", "qa", "qa-runner-alpha", "op-qa", "Open risks: endpoint hardening, event ordering, XSS in rendered generated content, and real-agent adapter contract drift.", "draft", ["qa", "security"])
  ] as ForgeSnapshot["artifacts"];

  const files = [
    file("file-readme", "README.md", "# ForgeOS\n\nAn operating system for autonomous AI organizations.\n", "generated", "strategy", "strategy-director", "op-strategy-plan", ["artifact-strategy"]),
    file("file-page", "src/app/page.tsx", "export default function Page() {\n  return <ForgeCommandCenter />\n}\n", "draft", "engineering", "frontend-worker", "op-dashboard", ["artifact-architecture"]),
    file("file-plan", "docs/project-plan.md", "# Project Plan\n\nForgeOS command center, runtime, and release pipeline.\n", "finalized", "strategy", "strategy-director", "op-strategy-plan", ["artifact-strategy"]),
    file("file-pitch", "pitch/presentation-outline.md", "# Pitch Outline\n\nProblem, autonomous organization runtime, demo flow, and release pass.\n", "generated", "presentation", "story-strategist", "op-pitch", ["artifact-pitch"]),
    file("file-qa", "review/qa-report.md", "# QA Report\n\nRuntime state and command APIs require focused validation.\n", "draft", "qa", "qa-runner-alpha", "op-qa", ["artifact-qa"])
  ];

  const handoffs = [
    {
      id: "handoff-strategy-ops",
      fromDivisionId: "strategy",
      toDivisionId: "operations",
      summary: "Strategy has locked the product identity, core scope, and MVP operating model.",
      deliverables: ["Project plan", "Competitive positioning", "Scope constraints"],
      blockers: [],
      requiredContext: ["Build dashboard first", "Keep mock-to-real adapters strict"],
      confidence: 92,
      createdAt: now
    },
    {
      id: "handoff-ops-eng",
      fromDivisionId: "operations",
      toDivisionId: "engineering",
      summary: "Engineering can proceed with runtime contracts and command center shell.",
      deliverables: ["Operation graph", "Runtime boundaries", "UI panel priorities"],
      blockers: ["Testing waits for runtime event contract"],
      requiredContext: ["Virtual files only", "No raw provider internals"],
      confidence: 84,
      createdAt: now
    }
  ];

  const messages = [
    { id: "msg-1", role: "executive", content: "Forge initialized. Strategy is complete, engineering is active, and QA is preparing the release review.", createdAt: now },
    { id: "msg-2", role: "operator", content: "Surface the current blockers.", createdAt: now },
    { id: "msg-3", role: "executive", content: "Primary blocker: testing worker is waiting for runtime contracts. Recommendation: lock RuntimeEvent and ForgeSnapshot before broad UI expansion.", createdAt: now }
  ] as ForgeSnapshot["messages"];

  const events = [
    event(1, "forge.initialized", "runtime", "forge", "demo-forge", "Forge initialized with seeded autonomous organization.", "success"),
    event(2, "operation.completed", "worker", "operation", "op-strategy-plan", "Strategy plan finalized.", "success"),
    event(3, "handoff.created", "division", "handoff", "handoff-strategy-ops", "Strategy handed execution context to Operations.", "info"),
    event(4, "operation.started", "worker", "operation", "op-dashboard", "Frontend Worker started the command center.", "info"),
    event(5, "operation.blocked", "worker", "operation", "op-tests", "Testing is blocked on runtime contract completion.", "warning")
  ];

  return {
    forge: {
      id: "demo-forge",
      slug: "demo",
      name: "ForgeOS Demo Forge",
      tagline: "An operating system for autonomous AI organizations.",
      activePhase: "Autonomous Development",
      status: "active"
    },
    lastEventSequence: events.length,
    schemaVersion: 1,
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
  sequence: number,
  type: ForgeSnapshot["events"][number]["type"],
  actorType: ForgeSnapshot["events"][number]["actorType"],
  targetType: ForgeSnapshot["events"][number]["targetType"],
  targetId: string,
  message: string,
  severity: ForgeSnapshot["events"][number]["severity"]
) {
  return {
    id: `event-${sequence}`,
    forgeId: "demo-forge",
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
