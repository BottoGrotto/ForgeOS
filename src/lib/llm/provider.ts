export interface LLMInput {
  forgeId: string;
  message: string;
}

export interface LLMOutput {
  content: string;
  provider: "mock" | "nemoclaw";
}

export interface LLMProvider {
  sendMessage(input: LLMInput): Promise<LLMOutput>;
}

export class MockLLMProvider implements LLMProvider {
  async sendMessage(input: LLMInput): Promise<LLMOutput> {
    return {
      provider: "mock",
      content: `Executive AI acknowledged: ${input.message}`
    };
  }
}
