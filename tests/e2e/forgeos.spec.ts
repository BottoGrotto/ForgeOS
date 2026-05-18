import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/forges");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Operator Password").fill("e2e-password");
  await page.getByRole("button", { name: "Enter ForgeOS" }).click();
  await expect(page).toHaveURL(/\/forges$/);
}

test("operator can run the ForgeOS demo flow", async ({ page }) => {
  const waitForRuntimeCommand = async () => {
    const response = await page.waitForResponse((candidate) => /\/api\/forges\/[^/]+\/commands/.test(candidate.url()));
    expect(response.status()).toBe(200);
    return response;
  };
  const forgeName = `E2E Forge ${Date.now()}`;
  const forgeSlug = forgeName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  await login(page);
  await page.getByPlaceholder("New Forge name").fill(forgeName);
  await page.getByRole("button", { name: "Create Forge" }).click();
  await expect(page).toHaveURL(new RegExp(`/forge/${forgeSlug}$`));

  await expect(page.getByRole("heading", { name: forgeName })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project Completeness Board" })).toBeVisible();
  await expect(page.getByText("These are operations that currently prevent downstream work")).toBeVisible();
  await expect(page.getByText("Why blocked")).toBeVisible();
  await expect(page.getByText("Next action")).toBeVisible();
  await expect(page.getByText("Complete").first()).toBeVisible();
  await expect(page.getByText("In Progress").first()).toBeVisible();
  await expect(page.getByText("Not Started").first()).toBeVisible();
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: /Shutdown/ }).click()]);
  await expect(page.getByText("Safe Shutdown").first()).toBeVisible();
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: /Resume/ }).click()]);
  await expect(page.getByRole("button", { name: /Shutdown/ })).toBeVisible();
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: /Reset/ }).click()]);
  await expect(page.getByText("Autonomous Development").first()).toBeVisible();

  await page.getByRole("link", { name: "Operations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Operations Board" })).toBeVisible();
  await expect(page.getByText("Implement runtime contracts").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Run Selected Operation" })).toBeEnabled();
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: "Run Selected Operation" }).click()]);
  await expect(page.getByRole("button", { name: "Select a Ready Operation" })).toBeDisabled();
  await expect(page.getByText("Operations can run only when the Forge is active and the selected operation is ready.")).toBeVisible();
  await expect(page.getByText("Verify runtime and UI").first()).toBeVisible();

  await page.getByRole("button", { name: /Verify runtime and UI/ }).first().click();
  await expect(page).toHaveURL(/operation=.*op-tests/);
  await expect(page.getByRole("heading", { name: "Operations Board" })).toBeVisible();
  await expect(page.getByText("Cover event ordering, dependency readiness, APIs, and golden flow.").first()).toBeVisible();
  await page.goto(`/forge/${forgeSlug}`);
  await expect(page.getByRole("button", { name: /Run Flow/ })).toBeEnabled();
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: /Run Flow/ }).click()]);
  await expect(page.getByText("Deployment Ready").first()).toBeVisible();
  await page.getByRole("link", { name: /Logs/ }).click();
  await expect(page.getByText("Full autonomous flow completed").first()).toBeVisible();

  await page.getByRole("link", { name: /Organization/ }).click();
  await expect(page.getByRole("heading", { name: "Agent Organization Map" })).toBeVisible();
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

test("operator can return to the Forge index and switch Forge instances", async ({ page }) => {
  const waitForRuntimeCommand = async () => {
    const response = await page.waitForResponse((candidate) => /\/api\/forges\/[^/]+\/commands/.test(candidate.url()));
    expect(response.status()).toBe(200);
    return response;
  };
  const firstName = `Switcher First ${Date.now()}`;
  const secondName = `Switcher Second ${Date.now()}`;
  const firstSlug = firstName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  await login(page);
  await page.getByPlaceholder("New Forge name").fill(firstName);
  await page.getByRole("button", { name: "Create Forge" }).click();
  await expect(page).toHaveURL(new RegExp(`/forge/${firstSlug}$`));
  await expect(page.getByRole("heading", { name: firstName })).toBeVisible();

  await page.getByRole("link", { name: "Forges" }).click();
  await expect(page).toHaveURL(/\/forges$/);
  await page.getByRole("link", { name: new RegExp(firstName) }).click();

  const response = await page.request.post("/api/forges", { data: { name: secondName } });
  expect(response.status()).toBe(201);
  const payload = (await response.json()) as { data: { forge: { slug: string } } };

  await page.getByRole("button", { name: "Switch Forge" }).click();
  await expect(page.getByRole("dialog", { name: "Switch Forge" })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(firstName) })).toBeVisible();
  await page.getByRole("link", { name: new RegExp(secondName) }).click();
  await expect(page).toHaveURL(new RegExp(`/forge/${payload.data.forge.slug}$`));
  await expect(page.getByRole("heading", { name: secondName })).toBeVisible();
  await Promise.all([waitForRuntimeCommand(), page.getByRole("button", { name: /Run Flow/ }).click()]);
  await expect(page.getByText("Deployment Ready").first()).toBeVisible();
});

test("operator can clear file-backed local Forge state in development", async ({ page }) => {
  const forgeName = `Clear Local ${Date.now()}`;

  await login(page);
  await page.getByPlaceholder("New Forge name").fill(forgeName);
  await page.getByRole("button", { name: "Create Forge" }).click();
  await page.getByRole("link", { name: "Forges" }).click();
  await expect(page.getByRole("link", { name: new RegExp(forgeName) })).toBeVisible();
  await expect(page.getByText("File-backed local runtime")).toBeVisible();

  await page.getByRole("button", { name: "Clear Local State" }).click();
  const dialog = page.getByRole("dialog", { name: "Clear Local Forge State" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Clear Local State" }).click();

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/forges$/);
  await expect(page.getByText("No Forge instances exist yet.")).toBeVisible();
});
