import { z } from "zod";

export const IncompleteGuidanceSchema = z.object({
  label: z.string(),
  reason: z.string(),
  verificationSteps: z.array(z.string()),
  wcagRef: z.string().optional(),
});

export type IncompleteGuidance = z.infer<typeof IncompleteGuidanceSchema>;

const GUIDANCE_TABLE: Record<string, IncompleteGuidance> = {
  // Color contrast - gradient/image backgrounds
  "color-contrast::color-contrast": {
    label: "Color Contrast on Complex Background",
    reason:
      "a11y-scout cannot compute contrast ratios when text appears over CSS gradients, background images, or semi-transparent overlays.",
    verificationSteps: [
      "Take a screenshot of the element in its rendered state",
      "Use a color picker tool (e.g., browser DevTools, Colour Contrast Analyser) to sample the foreground text color",
      "Sample the background color at multiple points behind the text (gradients may vary)",
      "Calculate the contrast ratio using the darkest/lightest combination",
      "Verify the ratio meets WCAG requirements: 4.5:1 for normal text (AA), 3:1 for large text (AA), or 7:1 for normal text (AAA)",
      "If the background is an image, verify contrast across all areas where text appears",
    ],
    wcagRef: "1.4.3",
  },

  // Color contrast - fallback for all color-contrast checks
  "color-contrast::*": {
    label: "Color Contrast Verification",
    reason:
      "a11y-scout could not automatically determine the effective background color for this element.",
    verificationSteps: [
      "Inspect the element using browser DevTools",
      "Identify the computed foreground and background colors",
      "Use a contrast checker tool to verify the ratio meets WCAG requirements",
      "Check contrast in different viewport sizes and zoom levels",
    ],
    wcagRef: "1.4.3",
  },

  // Link in text block
  "link-in-text-block::color-contrast": {
    label: "Link Color Contrast in Text",
    reason:
      "a11y-scout could not determine if the link color provides sufficient contrast against surrounding text or background.",
    verificationSteps: [
      "Verify the link has 3:1 contrast ratio against surrounding body text (if no underline or other non-color distinguisher)",
      "Verify the link has 4.5:1 contrast ratio against the background (for normal text)",
      "Check that focus and hover states also maintain sufficient contrast",
      "Ensure links are distinguishable without relying solely on color (underline, icon, bold, etc.)",
    ],
    wcagRef: "1.4.1",
  },

  // Hidden content
  "hidden-content::*": {
    label: "Hidden Content Accessibility",
    reason:
      "a11y-scout detected hidden content that may contain accessibility issues but cannot fully evaluate it while hidden.",
    verificationSteps: [
      "Identify the mechanism that reveals this content (button, tab, toggle, etc.)",
      "Verify the trigger element is keyboard accessible and has appropriate ARIA attributes",
      "Test that the content becomes visible and focusable when activated",
      "Ensure screen readers announce the state change appropriately",
      "Run accessibility checks again with the content visible",
    ],
    wcagRef: "4.1.2",
  },

  // ARIA attributes
  "aria-allowed-attr::aria-allowed-attr": {
    label: "ARIA Attribute Validation",
    reason:
      "a11y-scout detected an ARIA attribute that may not be allowed on this element role.",
    verificationSteps: [
      "Check the element's computed role (either implicit from the tag or explicit via role attribute)",
      "Consult the ARIA specification to verify which attributes are allowed for this role",
      "Remove any disallowed attributes or change the element's role",
      "Test with a screen reader to ensure the element behaves as expected",
    ],
    wcagRef: "4.1.2",
  },

  // ARIA required children
  "aria-required-children::aria-required-children": {
    label: "ARIA Required Children",
    reason:
      "This element's role requires specific child roles, but a11y-scout could not verify their presence.",
    verificationSteps: [
      "Identify the parent element's ARIA role (e.g., list, menu, tablist)",
      "Check the ARIA specification for required child roles (e.g., listitem, menuitem, tab)",
      "Verify all direct children have the appropriate roles",
      "Ensure no non-role elements interrupt the expected structure",
      "Test with a screen reader to verify the structure is announced correctly",
    ],
    wcagRef: "1.3.1",
  },

  // Label verification
  "label::*": {
    label: "Form Label Association",
    reason:
      "a11y-scout could not definitively determine if this form control has an accessible label.",
    verificationSteps: [
      "Check for a <label> element with a matching 'for' attribute",
      "Check for an aria-label or aria-labelledby attribute",
      "Verify the label text is meaningful and describes the control's purpose",
      "Test with a screen reader to ensure the label is announced when the control receives focus",
    ],
    wcagRef: "3.3.2",
  },

  // Image alt text
  "image-alt::*": {
    label: "Image Alternative Text",
    reason:
      "a11y-scout detected an image but could not verify if the alternative text is appropriate for its context.",
    verificationSteps: [
      "Determine if the image is decorative or informative",
      "For decorative images, use alt='' (empty string)",
      "For informative images, ensure alt text conveys the same information as the image",
      "For complex images (charts, diagrams), consider providing a longer description via aria-describedby or a caption",
      "Verify that the alt text makes sense when read in the flow of surrounding content",
    ],
    wcagRef: "1.1.1",
  },

  // Focus order
  "focus-order-semantics::*": {
    label: "Focus Order and Semantics",
    reason:
      "a11y-scout could not determine if the focus order matches the visual and semantic reading order.",
    verificationSteps: [
      "Tab through the page using only the keyboard",
      "Verify focus moves in a logical order (top-to-bottom, left-to-right in most Western layouts)",
      "Check that tabindex values do not create a confusing order (avoid positive tabindex)",
      "Ensure no focusable elements are skipped",
      "Test with a screen reader to verify the reading order matches the visual layout",
    ],
    wcagRef: "2.4.3",
  },

  // Duplicate IDs
  "duplicate-id::*": {
    label: "Duplicate ID Attribute",
    reason:
      "Multiple elements share the same ID, which may break ARIA relationships and form label associations.",
    verificationSteps: [
      "Search the page source for all instances of the duplicate ID",
      "Ensure each ID is unique across the entire page",
      "Check if any aria-labelledby, aria-describedby, or for attributes reference this ID",
      "If the ID is used for fragment navigation (#anchor), ensure only one element has it",
      "Re-test form controls to verify label associations still work",
    ],
    wcagRef: "4.1.1",
  },

  // Heading order
  "heading-order::*": {
    label: "Heading Hierarchy",
    reason:
      "a11y-scout detected potential issues with heading level order (e.g., h1 → h3 skipping h2).",
    verificationSteps: [
      "Review the heading structure in DevTools or with a heading bookmarklet",
      "Verify headings form a logical hierarchy without skipping levels",
      "Ensure the page has exactly one h1 (typically the main page title)",
      "Check that heading levels reflect the document structure, not just font sizes",
      "Test with a screen reader's heading navigation feature",
    ],
    wcagRef: "1.3.1",
  },

  // Landmark uniqueness
  "landmark-unique::*": {
    label: "Landmark Region Labels",
    reason:
      "Multiple landmarks of the same type exist, but a11y-scout could not verify they have unique labels.",
    verificationSteps: [
      "Identify all landmarks of the same type (e.g., multiple <nav> elements)",
      "Ensure each has a unique accessible name via aria-label or aria-labelledby",
      "Verify the labels clearly distinguish each landmark's purpose",
      "Test with a screen reader's landmark navigation feature",
    ],
    wcagRef: "1.3.1",
  },

  // Table headers
  "table-fake-caption::*": {
    label: "Table Caption or Summary",
    reason:
      "a11y-scout detected a potential table caption implemented incorrectly (e.g., as a regular paragraph).",
    verificationSteps: [
      "Check if the table has a <caption> element",
      "If the caption exists, verify it accurately describes the table's purpose",
      "If using aria-label or aria-labelledby instead, ensure the text is meaningful",
      "Avoid fake captions (e.g., bold text in a cell above the table)",
      "Test with a screen reader to verify the caption is announced when the table receives focus",
    ],
    wcagRef: "1.3.1",
  },

  // Scrollable region
  "scrollable-region-focusable::*": {
    label: "Scrollable Region Keyboard Access",
    reason:
      "a11y-scout detected a scrollable region that may not be keyboard accessible.",
    verificationSteps: [
      "Verify the scrollable element can receive keyboard focus (tabindex='0' if necessary)",
      "Test that arrow keys scroll the content",
      "Ensure any interactive content inside the scrollable region is reachable via Tab",
      "Check that focus is visible when the scrollable container has focus",
      "Test with screen readers to ensure the scrollable nature is announced",
    ],
    wcagRef: "2.1.1",
  },

  // Nested interactive elements
  "nested-interactive::*": {
    label: "Nested Interactive Elements",
    reason:
      "a11y-scout detected interactive elements nested inside other interactive elements (e.g., button inside link).",
    verificationSteps: [
      "Identify the nested interactive elements (buttons, links, form controls)",
      "Restructure the HTML to avoid nesting (e.g., move button outside the link)",
      "If nesting is unavoidable, use ARIA to override the outer element's role",
      "Test keyboard navigation to ensure both elements are reachable",
      "Test with a screen reader to verify both elements are announced correctly",
    ],
    wcagRef: "4.1.2",
  },
};

const DEFAULT_GUIDANCE: IncompleteGuidance = {
  label: "Manual Verification Required",
  reason:
    "a11y-scout could not automatically determine compliance for this element.",
  verificationSteps: [
    "Inspect the element in browser DevTools",
    "Check the element against the relevant WCAG success criterion",
    "Verify that the element is accessible using assistive technology",
  ],
};

export function getIncompleteGuidance(
  ruleId: string,
  checkId: string
): IncompleteGuidance {
  // Lookup logic:
  // 1. Try exact: `${ruleId}::${checkId}`
  // 2. Try wildcard: `${ruleId}::*`
  // 3. Fall back to DEFAULT_GUIDANCE
  const exactKey = `${ruleId}::${checkId}`;
  const wildcardKey = `${ruleId}::*`;

  return (
    GUIDANCE_TABLE[exactKey] ?? GUIDANCE_TABLE[wildcardKey] ?? DEFAULT_GUIDANCE
  );
}
