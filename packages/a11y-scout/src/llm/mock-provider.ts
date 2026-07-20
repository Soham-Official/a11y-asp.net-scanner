/**
 * Mock LLM provider for testing and offline development.
 *
 * The single mock code path: the factory routes here whenever no real
 * credentials are available (or A11Y_HAIP_MOCK=1 / A11Y_LLM_PROVIDER=mock).
 */

import { BaseLlmProvider } from "./base-provider.js";
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmDescribe,
} from "./provider.js";

export class MockProvider extends BaseLlmProvider {
  readonly isMock = true;

  constructor() {
    super("mock-llm-v1", "mock-llm-v1", 0);
  }

  describe(): LlmDescribe {
    const reason =
      process.env.A11Y_HAIP_MOCK === "1"
        ? "A11Y_HAIP_MOCK=1"
        : process.env.A11Y_LLM_PROVIDER === "mock"
          ? "A11Y_LLM_PROVIDER=mock"
          : "no credentials detected";
    return {
      provider: "mock",
      lines: [
        { label: "Mode", value: "mock — no real LLM calls", hint: "warn" },
        { label: "Selected because", value: reason },
        {
          label: "AAA-level findings",
          value: "will be stubs (axe-based A/AA scans still work)",
          hint: "info",
        },
      ],
    };
  }

  async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
    return this.buildMockResponse(req);
  }
}
