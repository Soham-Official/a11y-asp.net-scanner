import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FindingSchema } from "../types.js";
import { detectStack, scanRepoStatic } from "../scanners/static.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures/angular-app");

describe("static scanner - Angular", () => {
  it("detectStack should identify Angular", async () => {
    const result = await detectStack(fixtureDir);
    expect(result.framework).toBe("angular");
    expect(result.rationale).toContain("@angular/core");
  });

  it("scanRepoStatic should return Angular template findings", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });
    expect(result.findings.length).toBeGreaterThanOrEqual(4);
  });

  it("all findings should have correct source and properties", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });

    for (const finding of result.findings) {
      expect(finding.source).toBe("eslint-angular-template");
      expect(finding.ruleId).toMatch(/^@angular-eslint\/template\//);
      expect(finding.aiGenerated).toBe(false);
      expect(finding.requiresHumanReview).toBe(false);
      expect(finding.wcagSc).not.toBe("n/a");
      expect(finding.wcagSc.length).toBeGreaterThan(0);
      expect(finding.tags).toContain("static");
      expect(finding.tags).toContain("angular");
    }
  });

  it("should find violations in both external HTML and inline templates", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });

    const htmlFindings = result.findings.filter((f) =>
      f.filePath?.endsWith(".html"),
    );
    const tsFindings = result.findings.filter((f) =>
      f.filePath?.endsWith(".component.ts"),
    );

    expect(htmlFindings.length).toBeGreaterThan(0);
    expect(tsFindings.length).toBeGreaterThan(0);
  });

  it("inline template findings should have correct line numbers", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });

    const inlineFinding = result.findings.find(
      (f) =>
        f.filePath?.endsWith("inline.component.ts") &&
        f.ruleId === "@angular-eslint/template/label-has-associated-control",
    );

    expect(inlineFinding).toBeDefined();
    // The template is on line 6, so line number should point to the actual TS file
    expect(inlineFinding?.line).toBeGreaterThan(0);
  });

  it("all findings should validate against FindingSchema", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });

    for (const finding of result.findings) {
      expect(() => FindingSchema.parse(finding)).not.toThrow();
    }
  });
});
