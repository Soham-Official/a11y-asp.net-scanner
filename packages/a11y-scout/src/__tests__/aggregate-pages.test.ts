import { describe, expect, it } from "vitest";
import { aggregatePages, type PerPageSlice } from "../agents/aggregate-pages.js";
import type {
  Finding,
  InapplicableRule,
  PageEvidence,
  PassedRule,
} from "../types.js";

function evidence(url: string): PageEvidence {
  return {
    url,
    title: `Title for ${url}`,
    links: [],
    headings: [],
    images: [],
    formFields: [],
    errorMessages: [],
    langParts: [],
    instructions: [],
  };
}

function pass(
  ruleId: string,
  url: string,
  overrides: Partial<PassedRule> = {},
): PassedRule {
  return {
    ruleId,
    description: `desc for ${ruleId}`,
    helpUrl: `https://example.test/${ruleId}`,
    wcagSc: "1.1.1",
    wcagLevel: "A",
    tags: [],
    nodeCount: 1,
    sampleSelectors: [`.${ruleId}`],
    pageUrls: [url],
    ...overrides,
  };
}

function inapplicable(
  ruleId: string,
  url: string,
): InapplicableRule {
  return {
    ruleId,
    description: `desc for ${ruleId}`,
    helpUrl: `https://example.test/${ruleId}`,
    wcagSc: "1.1.1",
    wcagLevel: "A",
    tags: [],
    pageUrls: [url],
  };
}

function finding(
  url: string,
  ruleId: string,
  selector: string,
  id = `${url}-${ruleId}-${selector}`,
): Finding {
  return {
    id,
    wcagSc: "1.1.1",
    wcagLevel: "A",
    severity: "major",
    source: "axe",
    ruleId,
    title: ruleId,
    description: "",
    helpUrl: "",
    selector,
    htmlSnippet: `<div class="${selector.slice(1)}">x</div>`,
    remediation: "",
    aiGenerated: false,
    requiresHumanReview: false,
    tags: [],
    relatedRuleIds: [],
    relatedNodes: [],
    pageUrl: url,
  };
}

describe("aggregatePages", () => {
  it("merges passes by ruleId, sums node counts, dedups selectors, extends pageUrls", () => {
    const urlA = "https://example.test/a";
    const urlB = "https://example.test/b";

    const slices: PerPageSlice[] = [
      {
        url: urlA,
        findings: [],
        evidence: evidence(urlA),
        passes: [
          pass("image-alt", urlA, {
            nodeCount: 3,
            sampleSelectors: ["img.one", "img.two", "img.three"],
          }),
        ],
        inapplicable: [],
      },
      {
        url: urlB,
        findings: [],
        evidence: evidence(urlB),
        passes: [
          pass("image-alt", urlB, {
            nodeCount: 4,
            // .two overlaps with page A; together we still cap at 5
            sampleSelectors: ["img.two", "img.four", "img.five", "img.six"],
          }),
        ],
        inapplicable: [],
      },
    ];

    const out = aggregatePages(slices);
    expect(out.passes).toHaveLength(1);
    const merged = out.passes[0]!;
    expect(merged.ruleId).toBe("image-alt");
    expect(merged.nodeCount).toBe(7);
    expect(merged.pageUrls).toEqual([urlA, urlB]);
    expect(merged.sampleSelectors).toHaveLength(5);
    expect(new Set(merged.sampleSelectors).size).toBe(5);
    expect(merged.sampleSelectors).toContain("img.one");
    expect(merged.sampleSelectors).toContain("img.two");
  });

  it("keeps only inapplicable rules present on every page; extends pageUrls", () => {
    const urlA = "https://example.test/a";
    const urlB = "https://example.test/b";

    const slices: PerPageSlice[] = [
      {
        url: urlA,
        findings: [],
        evidence: evidence(urlA),
        passes: [],
        inapplicable: [inapplicable("shared", urlA), inapplicable("only-a", urlA)],
      },
      {
        url: urlB,
        findings: [],
        evidence: evidence(urlB),
        passes: [],
        inapplicable: [inapplicable("shared", urlB), inapplicable("only-b", urlB)],
      },
    ];

    const out = aggregatePages(slices);
    expect(out.inapplicable).toHaveLength(1);
    const survivor = out.inapplicable[0]!;
    expect(survivor.ruleId).toBe("shared");
    expect(survivor.pageUrls).toEqual([urlA, urlB]);
  });

  it("concatenates findings then dedupes via validate()", () => {
    const urlA = "https://example.test/a";
    const urlB = "https://example.test/b";

    // Same selector on two different pages — different `pageUrl`, so validate()
    // keeps them as distinct findings (key includes selector but not pageUrl —
    // however the equivalence group keys also include filePath/line which are
    // empty here, so two findings on the same selector with the same rule
    // collapse. Use different selectors to assert both survive.)
    const slices: PerPageSlice[] = [
      {
        url: urlA,
        findings: [finding(urlA, "image-alt", "img.a")],
        evidence: evidence(urlA),
        passes: [],
        inapplicable: [],
      },
      {
        url: urlB,
        findings: [finding(urlB, "image-alt", "img.b")],
        evidence: evidence(urlB),
        passes: [],
        inapplicable: [],
      },
    ];

    const out = aggregatePages(slices);
    expect(out.findings).toHaveLength(2);
    const pageUrls = out.findings.map((f) => f.pageUrl).sort();
    expect(pageUrls).toEqual([urlA, urlB]);
    expect(out.evidence).toHaveLength(2);
    expect(out.pagesScanned).toEqual([urlA, urlB]);
  });

  it("preserves pagesScanned ordering matching input slices", () => {
    const urls = ["https://example.test/c", "https://example.test/a", "https://example.test/b"];
    const slices: PerPageSlice[] = urls.map((u) => ({
      url: u,
      findings: [],
      evidence: evidence(u),
      passes: [],
      inapplicable: [],
    }));
    expect(aggregatePages(slices).pagesScanned).toEqual(urls);
  });

  it("handles an empty input", () => {
    const out = aggregatePages([]);
    expect(out.findings).toEqual([]);
    expect(out.passes).toEqual([]);
    expect(out.inapplicable).toEqual([]);
    expect(out.evidence).toEqual([]);
    expect(out.pagesScanned).toEqual([]);
  });
});
