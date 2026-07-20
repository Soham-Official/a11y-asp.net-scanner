/**
 * Centralized cost tracking for all LLM providers.
 */

import type { CostEntry } from "../types.js";

interface ModelPricing {
  inputPer1k: number;
  outputPer1k: number;
}

/**
 * Unified pricing table for all supported models across HAIP and AWS Bedrock.
 * Prices are per 1000 tokens in USD.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude models (HAIP)
  "anthropic.claude-3-5-sonnet-20241022-v2:0": {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
  },
  "anthropic.claude-3-5-sonnet-20240620-v1:0": {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
  },
  "anthropic.claude-3-7-sonnet-20250219-v1:0": {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
  },
  "us.anthropic.claude-3-7-sonnet-20250219-v1:0": {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
  },
  "us.anthropic.claude-3-5-sonnet-20241022-v2:0": {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
  },
  "bedrock-claude-sonnet-4-20250514-v1:0": {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
  },
  "anthropic.claude-sonnet-4-20250514-v1:0": {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
  },
  "anthropic.claude-3-5-haiku-20241022-v1:0": {
    inputPer1k: 0.0008,
    outputPer1k: 0.004,
  },

  // AWS Bedrock Claude models (Sonnet 4.5 - matching Claude Code config)
  "global.anthropic.claude-sonnet-4-5-20250929-v1:0": {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
  },
  "us.anthropic.claude-opus-4-6-v1": {
    inputPer1k: 0.015,
    outputPer1k: 0.075,
  },
  "anthropic.claude-3-opus-20240229-v1:0": {
    inputPer1k: 0.015,
    outputPer1k: 0.075,
  },

  // AWS Nova models
  "amazon.nova-micro-v1:0": { inputPer1k: 0.000035, outputPer1k: 0.00014 },
  "amazon.nova-lite-v1:0": { inputPer1k: 0.00006, outputPer1k: 0.00024 },
  "amazon.nova-pro-v1:0": { inputPer1k: 0.0008, outputPer1k: 0.0032 },

  // Other HAIP models
  "meta.llama3-8b-instruct-v1:0": { inputPer1k: 0.0003, outputPer1k: 0.0006 },
  "openai.gpt-oss-20b-1:0": { inputPer1k: 0.00007, outputPer1k: 0.0003 },
  "openai.gpt-oss-120b-1:0": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "qwen.qwen3-next-80b-a3b": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "qwen.qwen3-vl-235b-a22b": { inputPer1k: 0.0006, outputPer1k: 0.0024 },
  "mistral.ministral-3-14b-instruct": {
    inputPer1k: 0.0001,
    outputPer1k: 0.0004,
  },
  "mistral.ministral-3-8b-instruct": {
    inputPer1k: 0.00007,
    outputPer1k: 0.0003,
  },
  "google.gemma-3-27b-it": { inputPer1k: 0.0002, outputPer1k: 0.0008 },
  "zai.glm-4.7": { inputPer1k: 0.0006, outputPer1k: 0.0022 },
  "moonshotai.kimi-k2.5": { inputPer1k: 0.0006, outputPer1k: 0.0025 },

  // Mock
  "mock-llm-v1": { inputPer1k: 0, outputPer1k: 0 },
};

export class CostMeter {
  private totalCostUsd = 0;
  private readonly costEntries: CostEntry[] = [];
  private readonly maxCostUsd: number;

  constructor(maxCostUsd = 1.0) {
    this.maxCostUsd = maxCostUsd;
  }

  get totalCost(): number {
    return this.totalCostUsd;
  }

  get costLog(): CostEntry[] {
    return [...this.costEntries];
  }

  get maxCost(): number {
    return this.maxCostUsd;
  }

  calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) {
      // Unknown model - assume zero cost rather than erroring
      return 0;
    }
    return (
      (inputTokens / 1000) * pricing.inputPer1k +
      (outputTokens / 1000) * pricing.outputPer1k
    );
  }

  record(entry: CostEntry): void {
    this.totalCostUsd += entry.costUsd;
    this.costEntries.push(entry);
  }

  isOverBudget(): boolean {
    return this.totalCostUsd >= this.maxCostUsd;
  }
}

export class BudgetExceededError extends Error {
  constructor(used: number, cap: number) {
    super(
      `LLM budget exceeded: $${used.toFixed(4)} of $${cap.toFixed(2)} cap. ` +
        `Set A11Y_MAX_COST_USD higher in your .env or environment.`,
    );
    this.name = "BudgetExceededError";
  }
}
