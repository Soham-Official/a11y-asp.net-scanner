import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FindingSchema } from "../types.js";
import { detectStack, scanRepoStatic } from "../scanners/static.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures/aspnet-app");

describe("static scanner - ASP.NET", () => {
  it("detectStack should identify ASP.NET without package.json", async () => {
    const result = await detectStack(fixtureDir);
    expect(result.framework).toBe("aspnet");
    expect(result.rationale).toContain("ASP.NET marker");
  });

  it("scanRepoStatic should return findings for ASP.NET server controls", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });
    expect(result.detected.framework).toBe("aspnet");

    const ruleIds = result.findings.map((f) => f.ruleId);
    expect(ruleIds).toContain("aspnet/alt-text");
    expect(ruleIds).toContain("aspnet/alt-text-meaningless");
    expect(ruleIds).toContain("aspnet/html-has-lang");
    expect(ruleIds).toContain("aspnet/title-non-descriptive");
    expect(ruleIds).toContain("aspnet/anchor-has-content");
    expect(ruleIds).toContain("aspnet/anchor-as-button");
    expect(ruleIds).toContain("aspnet/button-has-content");
    expect(ruleIds).toContain("aspnet/hyperlink-has-content");
    expect(ruleIds).toContain("aspnet/linkbutton-has-content");
    expect(ruleIds).toContain("aspnet/checkbox-has-label");
    expect(ruleIds).toContain("aspnet/radiobutton-has-label");
    expect(ruleIds).toContain("aspnet/textbox-has-label");
    expect(ruleIds).toContain("aspnet/svg-focusable-false-no-aria-hidden");
    expect(ruleIds).toContain("aspnet/disabled-on-non-form-element");
    expect(ruleIds).toContain("aspnet/aria-hidden-focusable");
    expect(ruleIds).toContain("aspnet/label-used-as-heading");
    expect(ruleIds).toContain("aspnet/panel-onclick-without-keyboard");
    expect(ruleIds).toContain("aspnet/dialog-semantics");
    expect(ruleIds).toContain("aspnet/multiple-h1");
    expect(ruleIds).toContain("aspnet/missing-landmarks");
    expect(ruleIds).toContain("aspnet/td-headers-missing-target");
    expect(ruleIds).toContain("aspnet/caption-not-first-child");
    expect(ruleIds).toContain("aspnet/object-embed-missing-fallback");
    expect(ruleIds).toContain("aspnet/svg-role-img-missing-name");
    expect(ruleIds).toContain("aspnet/label-for-missing-target");
    expect(ruleIds).toContain("aspnet/label-empty");
    expect(ruleIds).toContain("aspnet/label-orphan");
    expect(ruleIds).toContain("aspnet/fieldset-missing-legend");
    expect(ruleIds).toContain("aspnet/optgroup-missing-label");
    expect(ruleIds).toContain("aspnet/aria-reference-missing-target");
    expect(ruleIds).toContain("aspnet/aria-attribute-misspelled");
    expect(ruleIds).toContain("aspnet/aria-enum-invalid");
    expect(ruleIds).toContain("aspnet/role-invalid");
    expect(ruleIds).toContain("aspnet/role-heading-missing-level");
    expect(ruleIds).toContain("aspnet/tab-outside-tablist");
    expect(ruleIds).toContain("aspnet/radiogroup-missing-radio");
    expect(ruleIds).toContain("aspnet/role-checkbox-missing-checked");
    expect(ruleIds).toContain("aspnet/role-slider-missing-value");
    expect(ruleIds).toContain("aspnet/presentation-role-on-interactive");
    expect(ruleIds).toContain("aspnet/disabled-aria-disabled-contradiction");
    expect(ruleIds).toContain("aspnet/aria-label-conflict");
    expect(ruleIds).toContain("aspnet/heading-level-skip");
    expect(ruleIds).toContain("aspnet/empty-heading");
    expect(ruleIds).toContain("aspnet/tabindex-noninteractive-no-role");
    expect(ruleIds).toContain("aspnet/input-autocomplete-missing");
    expect(ruleIds).toContain("aspnet/textbox-autocomplete-missing");
    expect(ruleIds).toContain("aspnet/placeholder-only-label");
    expect(ruleIds).toContain("aspnet/input-pattern-missing-title");
    expect(ruleIds).toContain("aspnet/iframe-title-empty");
    expect(ruleIds).toContain("aspnet/link-text-non-descriptive");
    expect(ruleIds).toContain("aspnet/duplicate-link-text-different-target");
    expect(ruleIds).toContain("aspnet/validator-missing-errormessage");
    expect(ruleIds).toContain("aspnet/validation-summary-missing-live");
    expect(ruleIds).toContain("aspnet/updateprogress-missing-live");
    expect(ruleIds).toContain("aspnet/auto-moving-content");
    expect(ruleIds).toContain("aspnet/css-infinite-animation");
    expect(ruleIds).toContain("aspnet/js-single-char-shortcut-global");
    expect(ruleIds).toContain("aspnet/css-focus-color-only");
    expect(ruleIds).toContain("aspnet/css-hover-only-reveal");
    expect(ruleIds).not.toContain("aspnet/css-low-contrast-same-rule");
    expect(ruleIds).toContain("aspnet/css-font-size-zero");
    expect(ruleIds).toContain("aspnet/css-base-font-px");
    expect(ruleIds).toContain("aspnet/css-font-size-px-important");
    expect(ruleIds).toContain("aspnet/css-line-height-important-low");
    expect(ruleIds).toContain("aspnet/css-spacing-important");
    expect(ruleIds).toContain("aspnet/css-min-width-large");
    expect(ruleIds).toContain("aspnet/css-target-size-too-small");
    expect(ruleIds).toContain("aspnet/viewport-zoom-restricted");
    expect(ruleIds).toContain("aspnet/inline-min-width-large");
    expect(ruleIds).toContain("aspnet/js-hover-without-focus-parity");
    expect(ruleIds).toContain("aspnet/js-focus-context-change");
    expect(ruleIds).toContain("aspnet/onchange-navigation");
    expect(ruleIds).toContain("aspnet/js-pointer-only-interaction");
    expect(ruleIds).toContain("aspnet/js-timed-context-change");
    expect(ruleIds).toContain("aspnet/cs-refresh-header");
    expect(ruleIds).toContain("aspnet/grid-useaccessibleheader-false");
    expect(ruleIds).toContain("aspnet/menu-renderingmode-not-list");
    expect(ruleIds).toContain("aspnet/auth-paste-blocked");
    expect(ruleIds).toContain("aspnet/auth-autocomplete-missing");
    expect(ruleIds).toContain("aspnet/dropdown-autopostback-navigation");
    expect(ruleIds).toContain("html-lint/page-has-title");
    expect(ruleIds).toContain("html-lint/empty-heading");
    expect(ruleIds).toContain("html-lint/input-has-label");
    expect(ruleIds).toContain("html-lint/hidden-focusable");
    expect(ruleIds).toContain("html-lint/alt-text");
    expect(ruleIds).toContain("html-lint/th-missing-scope");
    expect(ruleIds).toContain("aspnet/no-accesskey");
    expect(ruleIds).toContain("aspnet/no-autofocus");
    expect(ruleIds).toContain("aspnet/js-pointermove-only");
    expect(ruleIds).toContain("aspnet/js-drag-without-keyboard-fallback");
    expect(ruleIds).toContain("aspnet/required-without-indicator");
    expect(ruleIds).toContain("aspnet/readonly-with-js-mutation");
    expect(ruleIds).toContain("aspnet/form-without-submit");
    expect(ruleIds).toContain("aspnet/input-type-date-time-lacks-label");
    expect(ruleIds).toContain("aspnet/form-multiple-submits-same-name");
    expect(ruleIds).toContain("aspnet/missing-skip-links");
    expect(ruleIds).toContain("aspnet/color-only-indicator");
    expect(ruleIds).toContain("aspnet/error-message-not-announced");
    expect(ruleIds).toContain("aspnet/asterisk-required-inconsistent");
  });

  it("should only run html lint on plain markup candidates", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });
    const htmlLintFindings = result.findings.filter(
      (f) => f.ruleId.startsWith("html-lint/"),
    );

    expect(htmlLintFindings.length).toBeGreaterThan(0);
    for (const finding of htmlLintFindings) {
      expect(finding.source).toBe("html-lint");
      expect(finding.tags).toContain("html-lint");
      expect(finding.filePath).toBe("plain-markup.html");
    }
  });

  it("labelled TextBox should not fire aspnet/textbox-has-label", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });
    const txtFindings = result.findings.filter(
      (f) => f.ruleId === "aspnet/textbox-has-label",
    );
    // TxtEmail is labelled via asp:Label AssociatedControlID — only TxtName should fire
    expect(txtFindings).toHaveLength(1);
    expect(txtFindings[0]?.htmlSnippet).toContain("TxtName");
  });

  it("should detect JS/jQuery DOM injection accessibility issues", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });
    const ruleIds = result.findings.map((f) => f.ruleId);

    expect(ruleIds).toContain("aspnet/js-img-missing-alt");
    expect(ruleIds).toContain("aspnet/js-button-missing-label");
    expect(ruleIds).toContain("aspnet/js-anchor-missing-label");
    expect(ruleIds).toContain("aspnet/js-input-missing-label");
    expect(ruleIds).toContain("aspnet/js-aria-hidden-focusable");
    expect(ruleIds).toContain("aspnet/js-tabindex-positive");
    expect(ruleIds).toContain("aspnet/js-confirm-alert");
    expect(ruleIds).toContain("aspnet/js-focus-stealing");
    expect(ruleIds).toContain("aspnet/js-tab-key-suppression");
  });

  it("should detect code-behind control and script include heuristics", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });
    const ruleIds = result.findings.map((f) => f.ruleId);

    expect(ruleIds).toContain("aspnet/cs-image-missing-alt");
    expect(ruleIds).toContain("aspnet/cs-button-missing-text");
    expect(ruleIds).toContain("aspnet/cs-hyperlink-missing-text");
    expect(ruleIds).toContain("aspnet/cs-textbox-missing-label-hint");
    expect(ruleIds).toContain("aspnet/cs-script-include");
  });

  it("JS findings should be marked requiresHumanReview and severity review", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });
    const jsFindings = result.findings.filter(
      (f) => f.ruleId.startsWith("aspnet/js-"),
    );

    expect(jsFindings.length).toBeGreaterThan(0);
    for (const f of jsFindings) {
      expect(f.requiresHumanReview).toBe(true);
      expect(f.severity).toBe("review");
      expect(f.tags).toContain("dom-injection");
    }
  });

  it("code-behind findings should be marked requiresHumanReview and severity review", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });
    const codeBehindFindings = result.findings.filter((f) =>
      f.ruleId.startsWith("aspnet/cs-"),
    );

    expect(codeBehindFindings.length).toBeGreaterThan(0);
    for (const f of codeBehindFindings) {
      expect(f.requiresHumanReview).toBe(true);
      expect(f.severity).toBe("review");
      expect(f.tags).toContain("code-behind");
    }
  });

  it("clean JS patterns should not fire false positives", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });

    // Img with alt= should not fire js-img-missing-alt for the logo
    const jsImgFindings = result.findings.filter(
      (f) => f.ruleId === "aspnet/js-img-missing-alt",
    );
    // The spinner createElement and the jQuery html('<img src="...">') fire,
    // but the logo with alt="Company logo" should NOT fire
    const logoFires = jsImgFindings.some((f) =>
      (f.htmlSnippet ?? "").includes("Company logo"),
    );
    expect(logoFires).toBe(false);
  });

  it("clean code-behind image with AlternateText should not fire cs-image-missing-alt", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });
    const csImgFindings = result.findings.filter(
      (f) => f.ruleId === "aspnet/cs-image-missing-alt",
    );
    const logoFires = csImgFindings.some((f) =>
      (f.htmlSnippet ?? "").includes("AlternateText = \"Company logo\""),
    );
    expect(logoFires).toBe(false);
  });

  it("Roslyn pass should respect later code-behind assignments", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });

    const deferredImageFires = result.findings.some(
      (f) =>
        f.ruleId === "aspnet/cs-image-missing-alt" &&
        (f.htmlSnippet ?? "").includes("deferredLogo"),
    );
    const deferredTextboxFires = result.findings.some(
      (f) =>
        f.ruleId === "aspnet/cs-textbox-missing-label-hint" &&
        (f.htmlSnippet ?? "").includes("deferredInput"),
    );

    expect(deferredImageFires).toBe(false);
    expect(deferredTextboxFires).toBe(false);
  });

  it("img with server-expression alt should not fire aspnet/alt-text", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });
    const htmlImgFindings = result.findings.filter(
      (f) => f.ruleId === "aspnet/alt-text",
    );
    const serverAltFires = htmlImgFindings.some((f) =>
      (f.htmlSnippet ?? "").includes("GetAltTextForLogo()"),
    );
    expect(serverAltFires).toBe(false);
  });

  it("anchors and buttons with server-expression text should not fire empty-content rules", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });

    const anchorServerExprFires = result.findings.some(
      (f) =>
        f.ruleId === "aspnet/anchor-has-content" &&
        (f.htmlSnippet ?? "").includes("GetLinkText"),
    );
    const buttonServerExprFires = result.findings.some(
      (f) =>
        f.ruleId === "aspnet/button-has-content" &&
        (f.htmlSnippet ?? "").includes("GetButtonText"),
    );

    expect(anchorServerExprFires).toBe(false);
    expect(buttonServerExprFires).toBe(false);
  });

  it("should skip generated artifact folders during static scans", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });
    const artifactFindings = result.findings.filter((f) =>
      (f.filePath ?? "").includes("artifacts/"),
    );

    expect(artifactFindings).toHaveLength(0);
  });

  it("all findings should validate against FindingSchema", async () => {
    const result = await scanRepoStatic({ repoPath: fixtureDir });
    for (const finding of result.findings) {
      expect(() => FindingSchema.parse(finding)).not.toThrow();
    }
  });
});
