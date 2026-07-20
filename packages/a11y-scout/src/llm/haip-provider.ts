/**
 * HAIP (Hyland AI Platform) LLM provider.
 *
 * Talks to the HAIP Model Gateway via the OpenAI-compatible LiteLLM API.
 * Real calls only — when no API key is present the factory returns a
 * MockProvider instead, so this provider never runs in mock mode.
 */

import OpenAI from "openai";
import { BaseLlmProvider } from "./base-provider.js";
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmDescribe,
} from "./provider.js";
import { VERSION } from "../version.js";

// Default to PUBLIC ALB endpoints so a developer laptop can hit HAIP without
// being on the shared VPC. Override with HAIP_BASE_URL for private/VPC use
// (e.g. CI runners deployed inside the shared VPC).
const HAIP_ENDPOINTS: Record<string, string> = {
  dev: "https://ai-platform-public.api.ai.dev.app.hyland.com",
  "dev-private": "https://ai-platform.api.ai.dev.app.hyland.com",
  staging: "https://ai-platform.api.ai.staging.app.hyland.com",
  prod: "https://ai-platform.api.ai.app.hyland.com",
  "prod-eu": "https://ai-platform.api.ai.app.hyland.eu",
  "prod-au": "https://ai-platform.api.ai.app.au.hyland.com",
};

export interface HaipProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  environmentId?: string;
  userId?: string;
  env?: string;
  appKey?: string;
  reasonerModel?: string;
  cheapModel?: string;
  maxCostUsd?: number;
}

export class HaipProvider extends BaseLlmProvider {
  readonly isMock = false;
  readonly env: string;
  readonly endpoint: string;
  readonly appKey: string;

  private readonly client: OpenAI;
  private readonly environmentId: string;
  private readonly userId: string;

  constructor(opts: HaipProviderOptions = {}) {
    // Defaults are chosen from HAIP "default_models" (the broadly-available
    // allowlist for unprivileged dev keys). gpt-oss-120b/20b are OpenAI's
    // open-source models, support JSON / function calling, and are the
    // cheapest route to good reasoning without per-team Claude access.
    // Override via HAIP_MODEL_REASONER / HAIP_MODEL_CHEAP if your team has
    // Claude / Sonnet 4 entitlements.
    super(
      opts.reasonerModel ??
        process.env.HAIP_MODEL_REASONER ??
        "openai.gpt-oss-120b-1:0",
      opts.cheapModel ?? process.env.HAIP_MODEL_CHEAP ?? "openai.gpt-oss-20b-1:0",
      opts.maxCostUsd,
    );

    const apiKey = opts.apiKey ?? process.env.HAIP_API_KEY ?? "";
    if (apiKey.length === 0) {
      throw new Error(
        "HaipProvider requires an API key. Set HAIP_API_KEY (the factory " +
          "returns a MockProvider when no key is present).",
      );
    }

    this.env = (opts.env ?? process.env.HAIP_ENV ?? "dev").toLowerCase();
    // Resolution order: explicit opts -> HAIP_BASE_URL env -> per-env default.
    this.endpoint =
      opts.baseUrl ??
      process.env.HAIP_BASE_URL ??
      HAIP_ENDPOINTS[this.env] ??
      HAIP_ENDPOINTS.dev!;
    // Empty string means "do not send environment_id" (some HAIP envs accept this).
    this.environmentId =
      opts.environmentId ?? process.env.HAIP_ENVIRONMENT_ID ?? "";
    this.userId =
      opts.userId ?? process.env.HAIP_USER_ID ?? "a11y-scout-service";
    this.appKey = opts.appKey ?? process.env.HAIP_APP_KEY ?? "a11y-scout";

    this.client = new OpenAI({
      apiKey,
      baseURL: `${this.endpoint}/v1`,
      defaultHeaders: {
        "User-Agent": `a11y-scout/${VERSION} (${process.platform} ${process.arch}) openai-node`,
      },
    });
  }

  describe(): LlmDescribe {
    return {
      provider: "haip",
      lines: [
        { label: "Environment", value: this.env },
        { label: "Endpoint", value: this.endpoint },
        { label: "Mode", value: "READY", hint: "ok" },
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

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (req.systemPrompt) {
      messages.push({ role: "system", content: req.systemPrompt });
    }
    messages.push({ role: "user", content: req.prompt });

    // Build HAIP metadata. environment_id is optional — only included when set,
    // matching how nuxeo-ai-package operates against HAIP dev today.
    const metadata: Record<string, string> = {
      user_id: this.userId,
      app_key: this.appKey,
    };
    if (this.environmentId) {
      metadata.environment_id = this.environmentId;
    }

    const response = await this.client.chat.completions.create(
      {
        model,
        messages,
        temperature: req.temperature ?? 0.0,
        max_tokens: req.maxTokens ?? 1024,
        ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
        // Cast through unknown because the OpenAI SDK does not type custom
        // body fields, but LiteLLM forwards them.
        metadata,
      } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      {
        headers: { "x-correlation-id": correlationId },
      },
    );

    const content = response.choices[0]?.message?.content ?? "";
    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;

    return this.recordAndBuildResponse({
      model,
      content,
      inputTokens,
      outputTokens,
      correlationId,
    });
  }
}
