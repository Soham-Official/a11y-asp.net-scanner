import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FindingSchema } from "../types.js";
import { detectStack, scanRepoStatic } from "../scanners/static.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures/react-app");

describe("static scanner - React (flat config)", () => {
  it("detectStack should identify React", async () => {
    const result = await detectStack(fixtureDir);
    expect(result.framework).toBe("react");
    expect(result.rationale).toContain("react");
  });

  it("scanRepoStatic should return jsx-a11y findings under ESLint 9", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });
    expect(result.findings.length).toBeGreaterThanOrEqual(3);
  });

  it("all findings should have correct source and properties", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });

    for (const finding of result.findings) {
      expect(finding.source).toBe("eslint-jsx-a11y");
      expect(finding.ruleId).toMatch(/^jsx-a11y\//);
      expect(finding.aiGenerated).toBe(false);
      expect(finding.requiresHumanReview).toBe(false);
      expect(finding.wcagSc).not.toBe("n/a");
      expect(finding.wcagSc.length).toBeGreaterThan(0);
      expect(finding.tags).toContain("static");
      expect(finding.tags).toContain("react");
      // Enrichment stamps the W3C helpUrl; the GitHub rule-docs link is kept
      // as the secondary docUrl.
      expect(finding.helpUrl).toMatch(
        /^https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\//,
      );
      expect(finding.docUrl).toMatch(/github\.com/);
    }
  });

  it("should detect missing alt text", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });

    const altFinding = result.findings.find(
      (f) => f.ruleId === "jsx-a11y/alt-text",
    );
    expect(altFinding).toBeDefined();
    expect(altFinding?.wcagSc).toBe("1.1.1");
  });

  it("all findings should validate against FindingSchema", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });

    for (const finding of result.findings) {
      expect(() => FindingSchema.parse(finding)).not.toThrow();
    }
  });
});
