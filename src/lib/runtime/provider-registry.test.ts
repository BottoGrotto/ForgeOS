import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeForProvider, readProviderName } from "./provider-registry";

const originalProvider = process.env.FORGEOS_AGENT_PROVIDER;

describe("runtime provider registry", () => {
  afterEach(() => {
    if (originalProvider) {
      process.env.FORGEOS_AGENT_PROVIDER = originalProvider;
    } else {
      delete process.env.FORGEOS_AGENT_PROVIDER;
    }
  });

  it("defaults unknown provider configuration to mock", () => {
    expect(readProviderName(undefined)).toBe("mock");
    expect(readProviderName("github")).toBe("mock");
  });

  it("creates explicit runtime providers by stable provider identity", () => {
    expect(createRuntimeForProvider("mock").provider()).toBe("mock");
    expect(createRuntimeForProvider("codex").provider()).toBe("codex");
    expect(createRuntimeForProvider("openclaw").provider()).toBe("openclaw");
    expect(createRuntimeForProvider("nemoclaw").provider()).toBe("nemoclaw");
  });
});
