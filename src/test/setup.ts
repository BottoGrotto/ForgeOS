import "@testing-library/jest-dom/vitest";

delete process.env.DATABASE_URL;
process.env.FORGEOS_AGENT_PROVIDER = "mock";
delete process.env.FORGEOS_EXECUTIVE_AUTOPILOT;
