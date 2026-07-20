/**
 * Abstract base for all LLM providers.
 *
 * Owns everything common across HAIP, Bedrock, and Mock: cost metering,
 * budget enforcement, model-hint resolution, and mock-JSON generation.
 * Concrete providers implement only the transport (`chat`) and `describe`.
 */

import { v4 as uuidv4 } from "uuid";
import type { CostEntry } from "../types.js";
import { BudgetExceededError, CostMeter } from "./cost-meter.js";
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmDescribe,
  LlmProvider,
} from "./provider.js";

export interface BaseProviderOptions {
  reasonerModel?: string;
  cheapModel?: string;
  maxCostUsd?: number;
}

export abstract class BaseLlmProvider implements LlmProvider {
  abstract readonly isMock: boolean;

  protected readonly costMeter: CostMeter;
  protected readonly reasonerModel: string;
  protected readonly cheapModel: string;

  protected constructor(
    reasonerModel: string,
    cheapModel: string,
    maxCostUsd?: number,
  ) {
    this.reasonerModel = reasonerModel;
    this.cheapModel = cheapModel;
    const maxCost =
      maxCostUsd ?? Number.parseFloat(process.env.A11Y_MAX_COST_USD ?? "1.0");
    this.costMeter = new CostMeter(maxCost);
  }

  get totalCost(): number {
    return this.costMeter.totalCost;
  }

  get costLog(): CostEntry[] {
    return this.costMeter.costLog;
  }

  get maxCostUsd(): number {
    return this.costMeter.maxCost;
  }

  resolveModel(modelHint: LlmChatRequest["model"]): string {
    if (!modelHint || modelHint === "reasoner") return this.reasonerModel;
    if (modelHint === "cheap") return this.cheapModel;
    return modelHint;
  }

  abstract chat(req: LlmChatRequest): Promise<LlmChatResponse>;
  abstract describe(): LlmDescribe;

  /** Generate a fresh correlation id for a single request. */
  protected newCorrelationId(): string {
    return uuidv4();
  }

  /** Throw if the cumulative spend has reached the configured cap. */
  protected checkBudgetOrThrow(): void {
    if (this.costMeter.isOverBudget()) {
      throw new BudgetExceededError(
        this.costMeter.totalCost,
        this.costMeter.maxCost,
      );
    }
  }

  /**
   * Compute + record cost for a completed call and return the fully-formed
   * response. Used by every real provider so cost plumbing lives in one place.
   */
  protected recordAndBuildResponse(args: {
    model: string;
    content: string;
    inputTokens: number;
    outputTokens: number;
    correlationId: string;
  }): LlmChatResponse {
    const { model, content, inputTokens, outputTokens, correlationId } = args;
    const costUsd = this.costMeter.calculateCost(
      model,
      inputTokens,
      outputTokens,
    );
    this.costMeter.record({
      model,
      inputTokens,
      outputTokens,
      costUsd,
      ts: new Date().toISOString(),
    });
    return {
      content,
      model,
      costUsd,
      inputTokens,
      outputTokens,
      isMock: false,
      correlationId,
    };
  }

  /**
   * The single mock response shape, shared so providers can never diverge.
   * Records a zero-cost entry and returns either JSON or text per the request.
   */
  protected buildMockResponse(req: LlmChatRequest): LlmChatResponse {
    const model = this.resolveModel(req.model);
    const correlationId = this.newCorrelationId();
    const promptHash = req.prompt.length.toString(16).slice(0, 4);
    const isJson = req.responseFormat?.type === "json_object";

    const content = isJson
      ? JSON.stringify({
          __mock__: true,
          findings: [],
          fixes: [],
          notes:
            "Mock mode active. Set AWS credentials or HAIP_API_KEY to enable real LLM calls.",
        })
      : `__MOCK__: Mock mode active. prompt=${promptHash}`;

    this.costMeter.record({
      model: `${model} (mock)`,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      ts: new Date().toISOString(),
    });

    return {
      content,
      model,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      isMock: true,
      correlationId,
    };
  }
}
