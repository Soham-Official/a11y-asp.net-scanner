/**
 * LLM provider abstraction layer.
 *
 * Provides a unified interface for switching between AWS Bedrock (development)
 * and HAIP (production) with zero code changes.
 */

export { createLlmProvider, getActiveProvider } from "./factory.js";
export type { CreateProviderOptions } from "./factory.js";
export {
  detectProvider,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmDescribe,
  type LlmDescribeLine,
  type LlmProvider,
  type LlmProviderType,
} from "./provider.js";
export { BaseLlmProvider } from "./base-provider.js";
export type { BaseProviderOptions } from "./base-provider.js";
export { BedrockProvider } from "./bedrock-provider.js";
export type { BedrockProviderOptions } from "./bedrock-provider.js";
export { HaipProvider } from "./haip-provider.js";
export type { HaipProviderOptions } from "./haip-provider.js";
export { MockProvider } from "./mock-provider.js";
export { CostMeter, BudgetExceededError, MODEL_PRICING } from "./cost-meter.js";
