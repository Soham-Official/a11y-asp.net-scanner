import { describe, it, expect } from "vitest";
import { runContentQuality } from "../agents/content-quality.js";
import type { LlmChatRequest, LlmChatResponse, LlmProvider } from "../llm/provider.js";
import type { CostEntry, PageEvidence } from "../types.js";

/**
 * Stub provider that always replies with a canned JSON payload. Used to drive
 * the content-quality agent deterministically without touching a real LLM.
 */
class StubProvider implements LlmProvider {
  readonly isMock = false; // important: agent skips itself when isMock=true
  readonly maxCostUsd = 1;
  private readonly entries: CostEntry[] = [];
  totalCost = 0;
  callCount = 0;
  lastPrompt = "";
  lastSystemPrompt = "";
  constructor(private readonly content: string) {}

  get costLog(): CostEntry[] {
    return [...this.entries];
  }

  resolveModel(): string {
    return "stub-model";
  }

  describe() {
    return { provider: "mock" as const, lines: [] };
  }

  async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
    this.callCount += 1;
    this.lastPrompt = req.prompt;
    this.lastSystemPrompt = req.systemPrompt ?? "";
    const cost = 0.001;
    this.totalCost += cost;
    this.entries.push({
      model: "stub-model",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: cost,
      ts: new Date().toISOString(),
    });
    return {
      content: this.content,
      model: "stub-model",
      costUsd: cost,
      inputTokens: 100,
      outputTokens: 50,
      isMock: false,
      correlationId: "test",
    };
  }
}

const SCs = [
  "1.1.1",
  "1.3.3",
  "2.4.2",
  "2.4.4",
  "2.5.3",
  "3.3.1",
  "3.3.2",
  "1.3.5",
  "2.4.6",
  "3.1.2",
  "3.3.3",
] as const;

const SC_LEVEL: Record<(typeof SCs)[number], "A" | "AA"> = {
  "1.1.1": "A",
  "1.3.3": "A",
  "2.4.2": "A",
  "2.4.4": "A",
  "2.5.3": "A",
  "3.3.1": "A",
  "3.3.2": "A",
  "1.3.5": "AA",
  "2.4.6": "AA",
  "3.1.2": "AA",
  "3.3.3": "AA",
};

function buildPayloadForAllScs(): string {
  const findings = SCs.map((sc) => ({
    sc,
    title: `Stub finding for ${sc}`,
    description: `Synthetic violation of ${sc}.`,
    evidence: `<el data-sc="${sc}">`,
    confidence: "medium",
    remediation: `Fix the ${sc} issue.`,
  }));
  return JSON.stringify({ findings });
}

function syntheticEvidence(): PageEvidence {
  return {
    url: "http://test.local/",
    title: "Untitled",
    htmlLang: "en",
    textSample: "Sample text. Click here for more.",
    links: [
      { href: "http://test.local/a", text: "click here" },
      { href: "http://test.local/b", text: "Read more" },
    ],
    headings: [{ level: 1, text: "Section 1" }],
    images: [
      { alt: "image", src: "http://test.local/x.png", hasAlt: true },
      { alt: "", src: "http://test.local/y.png", hasAlt: false },
    ],
    formFields: [
      {
        tag: "input",
        type: "email",
        id: "email",
        name: "email",
        labelText: undefined,
        accessibleName: undefined,
        placeholder: "you@example.com",
      },
    ],
    errorMessages: [
      { text: "Invalid input", role: "alert", nearFieldName: "email" },
    ],
    langParts: [{ lang: "fr", text: "Bonjour" }],
    instructions: ["All fields required."],
  };
}

describe("runContentQuality", () => {
  it("emits one Finding per SC with the required AI-flagged shape", async () => {
    const llm = new StubProvider(buildPayloadForAllScs());
    const result = await runContentQuality({
      evidence: [syntheticEvidence()],
      llm,
    });

    expect(llm.callCount).toBe(1);
    expect(result.findings).toHaveLength(SCs.length);

    for (const f of result.findings) {
      expect(f.source).toBe("content-quality");
      expect(f.severity).toBe("review");
      expect(f.aiGenerated).toBe(true);
      expect(f.requiresHumanReview).toBe(true);
      expect(f.confidence).toBe("medium");
      expect(f.ruleId).toBe(`content-quality-${f.wcagSc}`);
      expect(f.tags).toContain("content-quality");
      expect(f.tags).toContain("ai-flagged");
      expect(f.helpUrl).toMatch(/^https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\//);
      // Mock tag must NOT be present — provider reports isMock=false
      expect(f.tags).not.toContain("__mock__");
    }

    // Each finding's wcagLevel matches the static SC→level table.
    for (const f of result.findings) {
      const expected = SC_LEVEL[f.wcagSc as (typeof SCs)[number]];
      expect(f.wcagLevel).toBe(expected);
      expect(f.tags).toContain(expected === "A" ? "wcag-a" : "wcag-aa");
    }

    // Cost is propagated from the provider.
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("drops findings that report a SC outside the advertised set", async () => {
    const llm = new StubProvider(
      JSON.stringify({
        findings: [
          {
            sc: "1.1.1",
            title: "ok",
            description: "in scope",
            confidence: "low",
          },
          {
            sc: "9.9.9",
            title: "bogus",
            description: "out of scope — should be dropped",
            confidence: "high",
          },
        ],
      }),
    );
    const result = await runContentQuality({
      evidence: [syntheticEvidence()],
      llm,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.wcagSc).toBe("1.1.1");
  });

  it("recovers from minor JSON malformations (extractJson/parseJsonLenient)", async () => {
    const messy =
      "Here is the JSON you asked for:\n```json\n" +
      JSON.stringify({
        findings: [
          {
            sc: "2.4.2",
            title: "Generic title",
            description: "Page title is 'Untitled'.",
            confidence: "high",
          },
        ],
      }) +
      "\n```\n(Hope this helps!)";
    const llm = new StubProvider(messy);
    const result = await runContentQuality({
      evidence: [syntheticEvidence()],
      llm,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.wcagSc).toBe("2.4.2");
  });

  it("returns no findings for empty evidence and never calls the LLM", async () => {
    const llm = new StubProvider("{}");
    const result = await runContentQuality({ evidence: [], llm });
    expect(result.findings).toHaveLength(0);
    expect(result.costUsd).toBe(0);
    expect(llm.callCount).toBe(0);
  });

  it("respects maxCostUsd by short-circuiting once 95% of the ceiling is spent", async () => {
    // Provider reports a high per-call cost so the budget is exhausted after one call.
    class ExpensiveProvider extends StubProvider {
      override async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
        const resp = await super.chat(req);
        // Force the provider's view of total cost above the 95% ceiling.
        this.totalCost = 1.0;
        return { ...resp, costUsd: 1.0 };
      }
    }
    const llm = new ExpensiveProvider(buildPayloadForAllScs());
    const ev1 = { ...syntheticEvidence(), url: "http://test.local/p1" };
    const ev2 = { ...syntheticEvidence(), url: "http://test.local/p2" };
    const result = await runContentQuality({
      evidence: [ev1, ev2],
      llm,
      maxCostUsd: 1.0,
    });

    // First page runs (ceiling not yet hit at start), second is skipped.
    expect(llm.callCount).toBe(1);
    expect(result.findings.length).toBe(SCs.length);
  });

  it("caps findings per page at 20", async () => {
    // Build a payload with 25 findings for the same SC (1.1.1) and ensure cap.
    const findings = Array.from({ length: 25 }, (_, i) => ({
      sc: "1.1.1",
      title: `Issue ${i}`,
      description: "Synthetic alt-quality issue.",
      confidence: "low",
    }));
    const llm = new StubProvider(JSON.stringify({ findings }));
    const result = await runContentQuality({
      evidence: [syntheticEvidence()],
      llm,
    });
    expect(result.findings.length).toBe(20);
  });

  it("includes the new evidence sections in the prompt", async () => {
    const llm = new StubProvider(JSON.stringify({ findings: [] }));
    await runContentQuality({
      evidence: [syntheticEvidence()],
      llm,
    });
    expect(llm.lastPrompt).toContain("IMAGES");
    expect(llm.lastPrompt).toContain("FORM FIELDS");
    expect(llm.lastPrompt).toContain("ERROR MESSAGES");
    expect(llm.lastPrompt).toContain("INSTRUCTIONS NEAR FORMS");
    expect(llm.lastPrompt).toContain("LANGUAGE-OF-PARTS SAMPLES");
    expect(llm.lastPrompt).toContain("HTML lang: en");
    // Includes the actual SC reminders
    expect(llm.lastPrompt).toMatch(/1\.1\.1/);
    expect(llm.lastPrompt).toMatch(/3\.3\.3/);
  });
});
