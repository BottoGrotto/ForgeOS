import { expect, test } from "@playwright/test";

test("operator can run the ForgeOS demo flow", async ({ page }) => {
  await page.goto("/forge/demo");

  await expect(page.getByRole("heading", { name: "ForgeOS Demo Forge" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project Completeness Board" })).toBeVisible();
  await expect(page.getByText("These are operations that currently prevent downstream work")).toBeVisible();
  await expect(page.getByText("Why blocked")).toBeVisible();
  await expect(page.getByText("Next action")).toBeVisible();
  await expect(page.getByText("Complete").first()).toBeVisible();
  await expect(page.getByText("In Progress").first()).toBeVisible();
  await expect(page.getByText("Not Started").first()).toBeVisible();
  await page.getByRole("button", { name: /Shutdown/ }).click();
  await expect(page.getByText("Safe Shutdown").first()).toBeVisible();
  await page.getByRole("button", { name: /Resume/ }).click();
  await expect(page.getByRole("button", { name: /Shutdown/ })).toBeVisible();
  await page.getByRole("button", { name: /Reset/ }).click();
  await expect(page.getByText("Autonomous Development").first()).toBeVisible();

  await page.getByRole("link", { name: /Verify runtime and UI/ }).first().click();
  await expect(page).toHaveURL(/operation=op-tests/);
  await expect(page.getByRole("heading", { name: "Operations Board" })).toBeVisible();
  await expect(page.getByText("Cover event ordering, dependency readiness, APIs, and golden flow.").first()).toBeVisible();
  await page.getByRole("link", { name: /Overview/ }).click();
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/runtime/commands") && response.status() === 200),
    page.getByRole("button", { name: /Run Flow/ }).click()
  ]);
  await expect(page.getByText("Deployment Ready").first()).toBeVisible();

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
  await expect(page.getByRole("button", { name: "README.md" })).toBeVisible();
  await page.getByRole("button", { name: "README.md" }).click();
  await expect(page.getByText("An operating system for autonomous AI organizations.").first()).toBeVisible();

  await page.getByRole("link", { name: /Logs/ }).click();
  await expect(page.getByText("Full autonomous flow completed").first()).toBeVisible();
});
