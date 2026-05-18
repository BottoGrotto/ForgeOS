import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  webServer: {
    command: "rm -f .forgeos/e2e-runtime-store.json && FORGEOS_RUNTIME_STORE_PATH=.forgeos/e2e-runtime-store.json npm run dev -- -H 127.0.0.1 --port 8130",
    url: "http://127.0.0.1:8130",
    reuseExistingServer: true,
    timeout: 120_000
  },
  use: {
    baseURL: "http://127.0.0.1:8130",
    trace: "on-first-retry"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ]
});
