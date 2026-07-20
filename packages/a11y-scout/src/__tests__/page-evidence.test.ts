import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPageEvidence } from "../scanners/runtime.js";
import { createPlaywrightPageDriver } from "../driver/playwright/index.js";
import type { PageEvidence } from "../types.js";

/**
 * Verifies that collectPageEvidence pulls the new content-quality fields
 * (htmlLang, images, formFields, errorMessages, langParts, instructions)
 * from a real Playwright page so the LLM agent has the data it needs to
 * judge A/AA semantic SCs.
 */
describe("collectPageEvidence — content-quality fields", () => {
  let browser: Browser;
  let evidence: PageEvidence;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const fixturePath = resolve(
      fileURLToPath(import.meta.url),
      "../../__tests__/fixtures/content-quality/evidence.html",
    );
    const url = `file://${fixturePath}`;
    await page.goto(url);
    evidence = await collectPageEvidence(createPlaywrightPageDriver(page), url);
    await page.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("captures the page's html lang attribute", () => {
    expect(evidence.htmlLang).toBe("en");
  });

  it("captures images with alt text and presence flag", () => {
    const cat = evidence.images.find((i) => i.src.endsWith("/cat.png"));
    const dog = evidence.images.find((i) => i.src.endsWith("/dog.png"));
    const bird = evidence.images.find((i) => i.src.endsWith("/bird.png"));

    expect(cat).toBeDefined();
    expect(cat?.alt).toBe("image");
    expect(cat?.hasAlt).toBe(true);

    expect(dog).toBeDefined();
    expect(dog?.alt).toBe("");
    expect(dog?.hasAlt).toBe(true);

    expect(bird).toBeDefined();
    expect(bird?.alt).toBe("");
    expect(bird?.hasAlt).toBe(false);
  });

  it("captures form fields with computed accessible name and described-by text", () => {
    const email = evidence.formFields.find((f) => f.id === "signup_email");
    const name = evidence.formFields.find((f) => f.id === "signup_name");

    expect(email).toBeDefined();
    expect(email?.type).toBe("email");
    expect(email?.required).toBe(true);
    // No <label for> nor aria-label, so accessibleName falls through to placeholder.
    expect(email?.labelText).toBeFalsy();
    expect(email?.accessibleName).toBe("you@example.com");
    expect(email?.placeholder).toBe("you@example.com");
    // Personal-data input missing autocomplete — surface this for the 1.3.5 prompt.
    expect(email?.autocomplete).toBeFalsy();

    expect(name).toBeDefined();
    expect(name?.labelText).toBe("Full name");
    expect(name?.accessibleName).toBe("Full name");
    expect(name?.describedByText).toContain("As shown on your ID.");
  });

  it("never reads the .value of inputs (PII safety)", () => {
    // The fixture has no `value=` attributes, but we still want a structural
    // guarantee that nothing leaked under unrelated keys. Spot-check by
    // serialising the captured fields and asserting no obviously-PII shapes.
    const serialised = JSON.stringify(evidence.formFields);
    expect(serialised).not.toMatch(/"value"\s*:/);
  });

  it("captures error/alert regions and associates to nearest form field", () => {
    expect(evidence.errorMessages.length).toBeGreaterThan(0);
    const alert = evidence.errorMessages.find((e) => e.role === "alert");
    expect(alert).toBeDefined();
    expect(alert?.text).toContain("Invalid input");
  });

  it("captures language-of-parts samples that differ from html lang", () => {
    const fr = evidence.langParts.find((p) => p.lang === "fr");
    expect(fr).toBeDefined();
    expect(fr?.text.toLowerCase()).toContain("bonjour");
    // The <html lang="en"> root must NOT appear as a langPart.
    expect(evidence.langParts.find((p) => p.lang === "en")).toBeUndefined();
  });

  it("captures instructional text near forms", () => {
    expect(evidence.instructions.length).toBeGreaterThan(0);
    const joined = evidence.instructions.join(" | ");
    // The <p> sibling immediately preceding the form OR the in-form <p>.
    expect(joined).toMatch(/required|complete every section/i);
  });
});
