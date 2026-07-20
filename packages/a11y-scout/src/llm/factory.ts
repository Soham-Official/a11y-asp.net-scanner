/**
 * Factory for creating LLM providers based on environment configuration.
 */

import { BedrockProvider } from "./bedrock-provider.js";
import { HaipProvider } from "./haip-provider.js";
import { MockProvider } from "./mock-provider.js";
import {
  detectProvider,
  type LlmProvider,
  type LlmProviderType,
} from "./provider.js";

export interface CreateProviderOptions {
  provider?: LlmProviderType;
  maxCostUsd?: number;
}

/**
 * Create an LLM provider based on environment configuration.
 *
 * Provider selection (in priority order):
 * 1. Explicit `provider` option
 * 2. A11Y_LLM_PROVIDER env var
 * 3. Auto-detect from CLAUDE_CODE_USE_BEDROCK / AWS_PROFILE / HAIP_API_KEY
 *
 * Examples:
 * ```
 * // Auto-detect (uses Claude Code Bedrock if CLAUDE_CODE_USE_BEDROCK=1)
 * const llm = createLlmProvider();
 *
 * // Explicit provider
 * const llm = createLlmProvider({ provider: 'haip' });
 *
 * // With cost limit
 * const llm = createLlmProvider({ maxCostUsd: 5.0 });
 * ```
 */
export function createLlmProvider(
  opts: CreateProviderOptions = {},
): LlmProvider {
  const providerType = opts.provider ?? detectProvider();
  const maxCostUsd = opts.maxCostUsd ?? undefined;

  switch (providerType) {
    case "bedrock":
      return new BedrockProvider({ maxCostUsd });

    case "haip": {
      // HAIP requires a key to make real calls. Without one (or when mock is
      // forced) fall back to the single MockProvider path rather than letting
      // HaipProvider construct with no key.
      const hasKey = (process.env.HAIP_API_KEY ?? "").length > 0;
      if (!hasKey || process.env.A11Y_HAIP_MOCK === "1") {
        return new MockProvider();
      }
      return new HaipProvider({ maxCostUsd });
    }

    case "mock":
      return new MockProvider();

    default:
      throw new Error(`Unknown LLM provider: ${providerType}`);
  }
}

/**
 * Get the active provider type for logging/diagnostics.
 */
export function getActiveProvider(): LlmProviderType {
  return detectProvider();
}
