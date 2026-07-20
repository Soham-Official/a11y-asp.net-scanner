/**
 * LLM Provider abstraction layer.
 *
 * Allows switching between AWS Bedrock (dev/demo) and HAIP (production)
 * via environment variables with zero code changes.
 */

import type { CostEntry } from "../types.js";

export interface LlmChatRequest {
  prompt: string;
  systemPrompt?: string;
  model?: "reasoner" | "cheap" | string;
  responseFormat?: { type: "json_object" } | { type: "text" };
  temperature?: number;
  maxTokens?: number;
}

export interface LlmChatResponse {
  content: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  isMock: boolean;
  correlationId: string;
}

/**
 * One row of provider diagnostic output, e.g. {label: "AWS region",
 * value: "us-east-1"}. `hint` lets callers style ready/warn states.
 */
export interface LlmDescribeLine {
  label: string;
  value: string;
  hint?: "ok" | "warn" | "info";
}

export interface LlmDescribe {
  provider: LlmProviderType;
  /** Lines specific to the provider (region, env, models, max cost, etc). */
  lines: LlmDescribeLine[];
}

export interface LlmProvider {
  readonly isMock: boolean;
  readonly totalCost: number;
  readonly costLog: CostEntry[];
  readonly maxCostUsd: number;

  chat(req: LlmChatRequest): Promise<LlmChatResponse>;
  resolveModel(modelHint: LlmChatRequest["model"]): string;
  /**
   * Self-describe for `doctor`. Each provider returns only the lines that
   * are actually relevant — Bedrock prints AWS region/profile/models, HAIP
   * prints env/endpoint/mock-state, mock prints why mock was selected.
   */
  describe(): LlmDescribe;
}

export type LlmProviderType = "bedrock" | "haip" | "mock";

/**
 * Detect which LLM provider to use based on environment variables.
 * Priority:
 * 1. Explicit A11Y_LLM_PROVIDER env var
 * 2. If CLAUDE_CODE_USE_BEDROCK=1 OR AWS_PROFILE is set → bedrock
 * 3. If HAIP_API_KEY is set → haip
 * 4. If A11Y_HAIP_MOCK=1 → mock
 * 5. Default: haip (will run in mock mode if no key)
 */
export function detectProvider(): LlmProviderType {
  const explicit = process.env.A11Y_LLM_PROVIDER?.toLowerCase();
  if (explicit === "bedrock" || explicit === "haip" || explicit === "mock") {
    return explicit;
  }

  // Auto-detect Bedrock from Claude Code environment
  if (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    (process.env.AWS_PROFILE && !process.env.HAIP_API_KEY)
  ) {
    return "bedrock";
  }

  // Force mock mode
  if (process.env.A11Y_HAIP_MOCK === "1") {
    return "mock";
  }

  // Default to HAIP (will auto-mock if no key)
  return "haip";
}
