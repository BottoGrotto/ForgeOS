import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/forges");
  await expect(page).toHaveURL(/\/login/);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.getByLabel("Operator Password").fill("e2e-password");
    const responsePromise = page.waitForResponse((candidate) => candidate.url().endsWith("/api/auth/login"));
    await page.getByRole("button", { name: "Enter ForgeOS" }).click();
    const response = await responsePromise;
    if (response.ok()) {
      await expect(page).toHaveURL(/\/forges$/);
      return;
    }
  }
  await expect(page).toHaveURL(/\/forges$/);
}

test("operator can run the ForgeOS demo flow", async ({ page }) => {
  const waitForRuntimeCommand = async () => {
    const response = await page.waitForResponse((candidate) => /\/api\/forges\/[^/]+\/commands/.test(candidate.url()));
    expect(response.status()).toBe(200);
    return response;
  };
  const injectTraceSummary = (payload: {
    data?: {
      runs?: Array<{
        operationId: string;
        providerMetadata: Record<string, unknown>;
      }>;
    };
  }) => ({
    ...payload,
    data: payload.data
      ? {
          ...payload.data,
          runs: payload.data.runs?.map((run) =>
            run.operationId.endsWith("op-runtime")
              ? {
                  ...run,
                  providerMetadata: {
                    ...run.providerMetadata,
                    traceSummary: {
                      context: {
                        estimatedTokens: 1200,
                        budgetTokens: 24000,
                        sections: [{ section: "files", allocatedTokens: 800, usedTokens: 400, selectedItems: 2, omittedItems: 0, truncatedItems: 0 }],
                        omittedReasons: []
                      },
                      outputs: {
                        artifactCount: 1,
                        fileCount: 2,
                        handoffCount: 1,
                        blockerCount: 0,
                        omittedCount: 0,
                        omissionReasons: []
                      },
                      lifecycle: {
                        provider: "mock",
                        status: "completed"
                      }
                    }
                  }
                }
              : run
          )
        }
      : payload.data
  });
  const forgeName = `E2E Forge ${Date.now()}`;
  const forgeSlug = forgeName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  await login(page);
  await page.getByPlaceholder("Project name").fill(forgeName);
  await page.getByRole("button", { name: "Start Project" }).click();
  await expect(page).toHaveURL(new RegExp(`/forge/${forgeSlug}$`));

  await expect(page.getByRole("heading", { name: forgeName })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Executive AI" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project Health" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs Attention" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Team Health" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project Completeness Board" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run Ready Team" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Show Next Work" })).toHaveAttribute("href", /\/operations/);
  await expect(page.getByRole("link", { name: "Review Blockers" })).toHaveAttribute("href", /status=blockers/);
  await expect(page.getByText("Progress").first()).toBeVisible();
  await expect(page.getByText("Active Runs").first()).toBeVisible();
  await expect(page.getByText("Blockers").first()).toBeVisible();
  await expect(page.getByText("Next Work").first()).toBeVisible();
  await expect(page.getByText("Command the Forge from here")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss Executive AI tip" }).click();
  await expect(page.getByText("Command the Forge from here")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Command the Forge from here")).toHaveCount(0);
  await expect(page.getByText("Conversation", { exact: true })).toBeVisible();
  await page.getByPlaceholder("Ask Executive AI").fill("What is blocked?");
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: "Send" }).click()]);
  await expect(page.getByText("Operator").first()).toBeVisible();
  await expect(page.getByText("Executive AI").first()).toBeVisible();
  await expect(page.locator("time").first()).toBeVisible();
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: /Pause/ }).click()]);
  await expect(page.getByText("Safe Shutdown").first()).toBeVisible();
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: /Resume/ }).click()]);
  await expect(page.getByRole("button", { name: /Pause/ })).toBeVisible();
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: /Reset/ }).click()]);
  await expect(page.getByText("Autonomous Development").first()).toBeVisible();

  await page.getByRole("link", { name: "Operations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Operations Board" })).toBeVisible();
  await expect(page.getByText("Implement runtime contracts").first()).toBeVisible();
  await expect(page.getByText("No operation selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Implement runtime contracts/ }).first().click();
  await expect(page.getByRole("button", { name: "Run Selected Operation" })).toBeEnabled();
  await page.route(/\/api\/forges\/[^/]+\/commands$/, async (route) => {
    const response = await route.fetch();
    const command = route.request().postDataJSON() as { type?: string; operationId?: string };
    if (!response.ok() || command.type !== "run_operation" || !command.operationId?.endsWith("op-runtime")) {
      await route.fulfill({ response });
      return;
    }

    const payload = (await response.json()) as {
      success: boolean;
      data?: {
        runs?: Array<{
          operationId: string;
          providerMetadata: Record<string, unknown>;
        }>;
      };
    };

    await route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify(injectTraceSummary(payload))
    });
  });
  await page.route(/\/api\/forges\/[^/]+\/snapshot$/, async (route) => {
    const response = await route.fetch();
    if (!response.ok()) {
      await route.fulfill({ response });
      return;
    }

    const payload = (await response.json()) as {
      success: boolean;
      data?: {
        runs?: Array<{
          operationId: string;
          providerMetadata: Record<string, unknown>;
        }>;
      };
    };

    await route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify(injectTraceSummary(payload))
    });
  });
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: "Run Selected Operation" }).click()]);
  await expect(page.getByText("Active Run", { exact: true })).toBeVisible();
  await expect(page.getByText("Trace Summary")).toBeVisible();
  await expect(page.getByText("Context")).toBeVisible();
  await expect(page.getByText(/\/24000 tokens/)).toBeVisible();
  await expect(page.getByText("hidden prompt")).toHaveCount(0);
  await expect(page.getByText("Run History")).toBeVisible();
  await expect(page.getByText("Lifecycle Timeline")).toBeVisible();
  await expect(page.getByText("run.progress")).toBeVisible();
  await expect(page.getByRole("button", { name: "Operation Run Active" })).toBeDisabled();
  await expect(page.getByText("Verify runtime and UI").first()).toBeVisible();

  await page.getByRole("button", { name: /Verify runtime and UI/ }).first().click();
  await expect(page).toHaveURL(/operation=.*op-tests/);
  await expect(page.getByRole("heading", { name: "Operations Board" })).toBeVisible();
  await expect(page.getByText("Cover event ordering, dependency readiness, APIs, and golden flow.").first()).toBeVisible();
  await page.goto(`/forge/${forgeSlug}`);
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: /Reset/ }).click()]);
  await expect(page.getByText("Autonomous Development").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Demo Flow/ })).toBeDisabled();
  await page.getByRole("link", { name: /Logs/ }).click();
  await expect(page.getByText("Forge state reset").first()).toBeVisible();
  await expect(page.getByText("No event selected", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: /Organization/ }).click();
  await expect(page.getByRole("heading", { name: "Agent Organization Map" })).toBeVisible();
  await expect(page.getByText("No card selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Frontend Worker/ }).click();
  await expect(page.getByText("Command center UI specialist")).toBeVisible();

  await page.getByRole("link", { name: /Operations/ }).click();
  await page.getByPlaceholder("Search title, worker, division, status, blocker").fill("runtime");
  await expect(page.getByRole("button", { name: /Implement runtime contracts/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Draft demo narrative/ })).toHaveCount(0);
  await page.getByLabel("Group By").selectOption("division");
  await expect(page.getByRole("heading", { name: "Engineering Division" })).toBeVisible();
  await page.getByPlaceholder("Search title, worker, division, status, blocker").fill("");

  await page.getByRole("link", { name: /Workspace/ }).click();
  await expect(page.getByRole("heading", { name: "GitHub Repository" })).toBeVisible();
  await page.getByPlaceholder("octo-org").fill("BottoGrotto");
  await page.getByPlaceholder("forgeos").fill("ForgeOS");
  await page.getByLabel("Working Branch").fill("forge/repository-v1");
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: "Connect", exact: true }).click()]);
  await expect(page.getByText("BottoGrotto/ForgeOS").first()).toBeVisible();
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: "Refresh" }).click()]);
  await expect(page.getByText("Refreshed")).toBeVisible();
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: "Disconnect" }).click()]);
  await expect(page.getByText("No GitHub repository metadata is connected.")).toBeVisible();
  await expect(page.getByText("No file selected", { exact: true })).toBeVisible();
  await expect(page.getByText("No file metadata selected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "README.md" })).toBeVisible();
  await page.getByRole("button", { name: "README.md" }).click();
  await expect(page.getByText("An operating system for autonomous AI organizations.").first()).toBeVisible();

  await page.getByRole("link", { name: /Logs/ }).click();
  await expect(page.getByText("GitHub repository disconnected").first()).toBeVisible();
});

test("/forge/demo is not a compatibility route", async ({ page }) => {
  await login(page);
  const response = await page.goto("/forge/demo");
  expect(response?.status()).toBe(404);
});

test("operator sees the default overview dashboard layout", async ({ page }) => {
  const forgeName = `Default Layout ${Date.now()}`;
  const forgeSlug = forgeName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  await login(page);
  await page.getByPlaceholder("Project name").fill(forgeName);
  await page.getByRole("button", { name: "Start Project" }).click();
  await expect(page).toHaveURL(new RegExp(`/forge/${forgeSlug}$`));

  await expect(page.getByRole("heading", { name: "Executive AI" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project Health" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs Attention" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Team Health" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Theme selector: Default Theme/ })).toBeVisible();
  await page.getByRole("button", { name: /Theme selector: Default Theme/ }).click();
  await expect(page.getByRole("button", { name: /Theme selector: Color Theme/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /Theme selector: Color Theme/ }).click();
  await expect(page.getByRole("button", { name: /Theme selector: Hacker Theme/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /Theme selector: Hacker Theme/ }).click();
  await expect(page.getByRole("button", { name: /Theme selector: Top Secret Mode/ })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: /Theme selector: Top Secret Mode/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Customize" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Move/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Review Blockers" }).click();
  await expect(page).toHaveURL(/\/operations\?.*status=blockers/);
  await expect(page.getByLabel("Status Filter")).toHaveValue("blockers");
  await expect(page.getByText("No operations match the current search and filters.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Implement runtime contracts/ })).toHaveCount(0);
});

test("operator can set an OpenAI spend budget from usage", async ({ page }) => {
  const forgeName = `Budget Forge ${Date.now()}`;
  const forgeSlug = forgeName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  await login(page);
  await page.getByPlaceholder("Project name").fill(forgeName);
  await page.getByRole("button", { name: "Start Project" }).click();
  await expect(page).toHaveURL(new RegExp(`/forge/${forgeSlug}$`));

  await page.goto("/usage");
  await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "OpenAI Budget By Forge" })).toBeVisible();
  await expect(page.getByRole("link", { name: forgeName }).first()).toBeVisible();

  const budgetInput = page.getByLabel(`OpenAI spend limit for ${forgeName}`);
  await expect(budgetInput).toBeVisible();
  await budgetInput.fill("25");
  await budgetInput.press("Enter");
  await expect(page.getByText("Budget saved.")).toBeVisible();
  await expect(page.getByText("$25.0000").first()).toBeVisible();
});

test("operator can return to the Forge index and switch Forge instances", async ({ page }) => {
  const firstName = `Switcher First ${Date.now()}`;
  const secondName = `Switcher Second ${Date.now()}`;
  const firstSlug = firstName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  await login(page);
  await page.getByPlaceholder("Project name").fill(firstName);
  await page.getByRole("button", { name: "Start Project" }).click();
  await expect(page).toHaveURL(new RegExp(`/forge/${firstSlug}$`));
  await expect(page.getByRole("heading", { name: firstName })).toBeVisible();

  await page.getByRole("link", { name: "Forges" }).click();
  await expect(page).toHaveURL(/\/forges$/);
  await page.getByRole("link", { name: new RegExp(firstName) }).click();

  const response = await page.request.post("/api/forges", {
    data: { name: secondName },
    headers: { origin: new URL(page.url()).origin }
  });
  expect(response.status()).toBe(201);
  const payload = (await response.json()) as { data: { forge: { slug: string } } };

  await page.getByRole("button", { name: "Switch Forge" }).click();
  await expect(page.getByRole("dialog", { name: "Switch Forge" })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(firstName) })).toBeVisible();
  await page.getByRole("link", { name: new RegExp(secondName) }).click();
  await expect(page).toHaveURL(new RegExp(`/forge/${payload.data.forge.slug}$`));
  await expect(page.getByRole("heading", { name: secondName })).toBeVisible();
  await expect(page.getByText("Command the Forge from here")).toBeVisible();
});

test("operator can clear file-backed local Forge state in development", async ({ page }) => {
  const forgeName = `Clear Local ${Date.now()}`;

  await login(page);
  await page.getByPlaceholder("Project name").fill(forgeName);
  await page.getByRole("button", { name: "Start Project" }).click();
  await page.getByRole("link", { name: "Forges" }).click();
  await expect(page.getByRole("link", { name: new RegExp(forgeName) })).toBeVisible();

  await page.getByRole("button", { name: "Manage" }).click();
  await expect(page.getByText(/runtime$/)).toBeVisible();
  const clearButton = page.getByRole("button", { name: "Clear Development State" });
  test.skip(await clearButton.isDisabled(), "File-backed local Forge reset is unavailable in the current storage mode.");
  await clearButton.click();
  const dialog = page.getByRole("dialog", { name: "Clear Development Forge State" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Clear Development State" }).click();

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/forges$/);
  await expect(page.getByText("No projects yet. Enter a project name above to create the first command deck.")).toBeVisible();
});
