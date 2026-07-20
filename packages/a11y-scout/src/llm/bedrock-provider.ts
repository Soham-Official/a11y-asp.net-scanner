/**
 * AWS Bedrock LLM provider.
 *
 * Uses AWS Bedrock Runtime API with Converse API for Claude models.
 * Credentials come from AWS SDK (AWS_PROFILE, AWS SSO, IAM roles, etc).
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import { BaseLlmProvider } from "./base-provider.js";
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmDescribe,
} from "./provider.js";

export interface BedrockProviderOptions {
  region?: string;
  reasonerModel?: string;
  cheapModel?: string;
  maxCostUsd?: number;
}

/**
 * Default model mapping for Bedrock.
 * Uses Claude Sonnet 4.5 (matching Claude Code's config from settings.json).
 */
const DEFAULT_REASONER = "global.anthropic.claude-sonnet-4-5-20250929-v1:0";
const DEFAULT_CHEAP = "anthropic.claude-3-5-haiku-20241022-v1:0";

export class BedrockProvider extends BaseLlmProvider {
  readonly isMock = false;
  private readonly client: BedrockRuntimeClient;
  private readonly region: string;

  constructor(opts: BedrockProviderOptions = {}) {
    super(
      opts.reasonerModel ?? DEFAULT_REASONER,
      opts.cheapModel ?? DEFAULT_CHEAP,
      opts.maxCostUsd,
    );
    this.region = opts.region ?? process.env.AWS_REGION ?? "us-east-1";
    this.client = new BedrockRuntimeClient({ region: this.region });
  }

  describe(): LlmDescribe {
    const profile = process.env.AWS_PROFILE ?? "(default credential chain)";
    return {
      provider: "bedrock",
      lines: [
        { label: "AWS profile", value: profile },
        { label: "AWS region", value: this.region },
        { label: "Reasoner model", value: this.reasonerModel },
        { label: "Cheap model", value: this.cheapModel },
        {
          label: "Max cost USD",
          value: `$${this.maxCostUsd.toFixed(2)}`,
        },
      ],
    };
  }

  async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
    const model = this.resolveModel(req.model);
    const correlationId = this.newCorrelationId();

    this.checkBudgetOrThrow();

    // Build messages for Converse API
    const messages: Message[] = [
      {
        role: "user",
        content: [{ text: req.prompt }],
      },
    ];

    // Converse API takes system prompts separately
    const systemPrompts = req.systemPrompt
      ? [{ text: req.systemPrompt }]
      : undefined;

    try {
      const command = new ConverseCommand({
        modelId: model,
        messages,
        system: systemPrompts,
        inferenceConfig: {
          temperature: req.temperature ?? 0.0,
          maxTokens: req.maxTokens ?? 1024,
        },
        // Note: Bedrock Converse API doesn't support response_format for JSON mode
        // directly. We'll rely on prompt engineering for JSON responses.
      });

      const response = await this.client.send(command);

      // Extract content from response
      const outputMessage = response.output?.message;
      const contentBlocks = outputMessage?.content ?? [];
      const content = contentBlocks
        .map((block: ContentBlock) => {
          if ("text" in block) return block.text;
          return "";
        })
        .join("");

      // Extract token usage
      const inputTokens = response.usage?.inputTokens ?? 0;
      const outputTokens = response.usage?.outputTokens ?? 0;

      return this.recordAndBuildResponse({
        model,
        content,
        inputTokens,
        outputTokens,
        correlationId,
      });
    } catch (error) {
      // Re-throw with context
      throw new Error(
        `Bedrock API error for model ${model}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
