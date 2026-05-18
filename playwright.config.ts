import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  webServer: {
    command: "rm -f .forgeos/e2e-runtime-store.json && FORGEOS_RUNTIME_STORE_PATH=.forgeos/e2e-runtime-store.json FORGEOS_OPERATOR_PASSWORD=e2e-password FORGEOS_SESSION_SECRET=e2e-session-secret npm run dev -- -H 127.0.0.1 --port 8130",
    url: "http://localhost:8130",
    reuseExistingServer: true,
    timeout: 120_000
  },
  use: {
    baseURL: "http://localhost:8130",
    trace: "on-first-retry"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ]
});
