/**
 * Static catalog of WCAG 2.2 success criteria a manual tester must audit
 * because they cannot be (or are only partially) automated by a11y-scout.
 *
 * Source of truth: the "All WCAG Checks" Notion page. Each entry mirrors a row
 * marked Manual / Partial / LLM (review) in the Auto? column there.
 *
 * This module is intentionally static — every report carries the same
 * checklist regardless of the scan's findings. It is the human counterpart to
 * the tool's automated coverage.
 */

import type { WcagLevel } from "../types.js";

export interface ManualAudit {
  /** WCAG SC id, e.g. "1.4.11" */
  sc: string;
  /** Conformance level. */
  level: WcagLevel;
  /** Title from W3C. */
  title: string;
  /**
   * Why this can't (yet) be fully automated.
   * - "manual"  — content / behavioral / device-sensor / live judgment
   * - "partial" — tools detect obvious cases; nuance needs a human
   * - "llm"     — LLM can flag candidates but must be human-reviewed
   */
  category: "manual" | "partial" | "llm";
  /**
   * Step-by-step instructions a tester follows to evaluate this SC manually.
   * Written so a non-expert can execute them with a real browser, screen
   * reader, and the page in front of them.
   */
  howToTest: string[];
  /**
   * Optional tags for filtering. Use to mark items that should appear in
   * specific report sections. Tags:
   * - "Manual Only" — shown in the "Required Manual Audit" tab
   * - other tags can be added as needed for future filtering
   */
  tags?: string[];
}

/**
 * Stable display order: A → AA → AAA, then ascending SC within each level.
 * The catalog itself is authored in this order so consumers don't need to sort.
 */
export const MANUAL_AUDIT_CATALOG: ManualAudit[] = [
  // ===== Level A =====
  {
    sc: "1.1.1",
    level: "A",
    title: "Non-text Content",
    category: "partial",
    howToTest: [
      "For every image, icon, chart, button-as-image, and SVG, read its alt / aria-label out loud.",
      "Ask: does the text convey the same purpose as the visual? An <img> of a magnifying glass labelled 'magnifying glass' fails — it should be 'Search'.",
      "Confirm decorative images use alt=\"\" (and not alt=\"decorative image\").",
      "Run a screen reader (NVDA / VoiceOver) over each image and confirm the announced text matches intent.",
    ],
  },
  {
    sc: "1.2.1",
    level: "A",
    title: "Audio-only and Video-only (Prerecorded)",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "Locate every <audio> or video-only <video> element on the page.",
      "For audio-only: confirm a transcript is linked or rendered nearby and that it contains every spoken word.",
      "For video-only: confirm either a transcript or an audio track describes the visual content.",
      "Read the transcript while the media plays and verify they match.",
    ],
  },
  {
    sc: "1.2.2",
    level: "A",
    title: "Captions (Prerecorded)",
    category: "partial",
    howToTest: [
      "Open every prerecorded <video> with audio. Enable captions in the player (CC button or default state).",
      "Watch with the audio muted — confirm captions exist for every spoken word AND for non-speech audio (e.g., '[door slams]', '[music swells]').",
      "Check captions are synchronized to within ~200 ms of the spoken audio.",
      "Verify caption text is accurate (no mistakes, no missing dialogue).",
    ],
  },
  {
    sc: "1.2.3",
    level: "A",
    title: "Audio Description or Media Alternative (Prerecorded)",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "For each prerecorded video with meaningful visuals, look for an audio-description track or a separate text alternative.",
      "Listen to the audio-described version: confirm narration fills in important visual information that's not in the dialogue.",
      "If a text alternative is provided instead, read it and confirm it equivalently describes the visual content.",
    ],
  },
  {
    sc: "1.3.1",
    level: "A",
    title: "Info and Relationships",
    category: "partial",
    howToTest: [
      "Inspect the page with the developer tools accessibility tree (Chrome DevTools → Accessibility panel).",
      "Confirm visual headings are real <h1>–<h6> (not styled <div>s); lists are <ul>/<ol>; data tables have <th> with scope.",
      "Tab through forms with a screen reader and confirm each field reads its label, not just its placeholder.",
      "For each visual grouping (cards, sections, panels), confirm there's a landmark or heading that the screen reader announces.",
    ],
  },
  {
    sc: "1.3.2",
    level: "A",
    title: "Meaningful Sequence",
    category: "partial",
    howToTest: [
      "Disable CSS (Firefox: View → Page Style → No Style; or DevTools 'disable styles').",
      "Read the page top-to-bottom in source order; confirm the meaning still holds.",
      "If sequence matters (instructions, multi-step flows), make sure the DOM order matches the intended reading order.",
    ],
  },
  {
    sc: "1.3.3",
    level: "A",
    title: "Sensory Characteristics",
    category: "llm",
    howToTest: [
      "Read every instruction on the page (tooltips, error messages, help text, form hints).",
      "Flag any that rely solely on shape ('the round button'), color ('the red link'), location ('on the right'), size ('the large icon'), or sound ('listen for the chime').",
      "Confirm the instruction also has a non-sensory cue — a label, an icon name, or a programmatic identifier.",
    ],
  },
  {
    sc: "1.4.1",
    level: "A",
    title: "Use of Color",
    category: "partial",
    howToTest: [
      "Take a screenshot and convert it to grayscale (browser extension or screenshot tool).",
      "Check that every state, error, link, required field, and chart legend is still distinguishable without color.",
      "Common fails: required-field asterisks shown only in red; chart series differentiated only by hue; links indicated by color alone with no underline.",
    ],
  },
  {
    sc: "1.4.2",
    level: "A",
    title: "Audio Control",
    category: "partial",
    howToTest: [
      "Reload the page with sound on. If any audio plays automatically for more than 3 seconds, confirm there's a pause/stop or independent volume control.",
      "Confirm the control is keyboard-operable and clearly labelled.",
    ],
  },
  {
    sc: "2.1.1",
    level: "A",
    title: "Keyboard",
    category: "partial",
    howToTest: [
      "Unplug the mouse. Tab through every interactive element on the page.",
      "For each control, confirm Enter / Space / arrow keys / Esc behave as documented for that ARIA pattern (button = Enter+Space; combobox = Down opens; tablist = Left/Right cycles).",
      "Hover-only menus, drag-and-drop, and color-pickers are common fail points — confirm a keyboard alternative exists for each.",
      "For custom widgets, follow the W3C ARIA Authoring Practices keyboard expectations.",
    ],
  },
  {
    sc: "2.1.4",
    level: "A",
    title: "Character Key Shortcuts",
    category: "partial",
    howToTest: [
      "Identify any single-character keyboard shortcuts (e.g., 'press / to search', 'press j/k to navigate').",
      "Confirm at least one of: shortcut can be turned off; shortcut can be remapped to include a non-printable modifier (Ctrl/Alt); shortcut is only active while the relevant component has focus.",
    ],
  },
  {
    sc: "2.2.1",
    level: "A",
    title: "Timing Adjustable",
    category: "partial",
    howToTest: [
      "Identify any time limit on the page (session timeout, form auto-submit, slideshow advance).",
      "Confirm the user can turn off, adjust to ≥ 10× the default, or extend the limit before it expires.",
      "Common fail: bank session timeouts that log the user out without warning.",
    ],
  },
  {
    sc: "2.2.2",
    level: "A",
    title: "Pause, Stop, Hide",
    category: "partial",
    howToTest: [
      "Find every moving / blinking / scrolling / auto-updating element on the page (carousels, tickers, animated banners).",
      "If it lasts more than 5 seconds, confirm a pause / stop / hide control exists, is keyboard-operable, and labelled.",
    ],
  },
  {
    sc: "2.3.1",
    level: "A",
    title: "Three Flashes or Below Threshold",
    category: "partial",
    howToTest: [
      "Watch any flashing or strobing content. If it flashes more than 3 times per second, that's a fail.",
      "For borderline cases use the Trace Center's PEAT (Photosensitive Epilepsy Analysis Tool) — record the page and run the analysis.",
      "Common fails: animated GIFs / video content showing strobe effects.",
    ],
  },
  {
    sc: "2.4.1",
    level: "A",
    title: "Bypass Blocks",
    category: "partial",
    howToTest: [
      "Reload the page and press Tab once. The first focusable element should be a 'Skip to main content' link, OR there should be at least one <main> / <nav> landmark.",
      "Activate the skip link with Enter; confirm focus moves into the main content area.",
      "Confirm a screen reader's landmark navigation (NVDA: D; VoiceOver: VO+U) lists distinct landmarks.",
    ],
  },
  {
    sc: "2.4.2",
    level: "A",
    title: "Page Titled",
    category: "partial",
    howToTest: [
      "Read the browser tab / window title. Does it describe the page's purpose?",
      "Compare titles across multiple pages: each should be unique and meaningful (not 'Untitled' or just the brand name).",
    ],
  },
  {
    sc: "2.4.3",
    level: "A",
    title: "Focus Order",
    category: "partial",
    howToTest: [
      "Tab through the entire page once. Does the focus order match the visual order top-to-bottom, left-to-right (or right-to-left for RTL languages)?",
      "Open every modal / popover; confirm focus enters the dialog and moves through it logically.",
      "Confirm closing a dialog returns focus to the element that opened it.",
    ],
  },
  {
    sc: "2.4.4",
    level: "A",
    title: "Link Purpose (In Context)",
    category: "partial",
    howToTest: [
      "Read every link's text together with its surrounding sentence / paragraph / heading / list-item / table-cell.",
      "Confirm a user could understand where the link goes from that context.",
      "Common fails: identical 'Read more' links scattered across a list of articles, where context only resolves them visually (next to the article title).",
    ],
  },
  {
    sc: "2.5.1",
    level: "A",
    title: "Pointer Gestures",
    category: "partial",
    howToTest: [
      "Identify any multi-point gestures (pinch-zoom, two-finger rotate) or path-based gestures (swipe, drag-along-a-track).",
      "For each, confirm there's a single-point alternative — usually a button (zoom in / zoom out, prev / next).",
    ],
  },
  {
    sc: "2.5.2",
    level: "A",
    title: "Pointer Cancellation",
    category: "partial",
    howToTest: [
      "Press down on each button / interactive element. Drag away before releasing.",
      "Confirm the action does NOT trigger on the down-event — it should trigger on up-event over the original target only.",
      "Drag-to-delete and other irreversible down-event actions are common fails.",
    ],
  },
  {
    sc: "2.5.3",
    level: "A",
    title: "Label in Name",
    category: "partial",
    howToTest: [
      "For each control with a visible text label, run a screen reader over it.",
      "Confirm the announced accessible name CONTAINS the visible label text. ('Search' icon labelled aria-label='Magnifier' fails — voice users say 'click Search'.)",
    ],
  },
  {
    sc: "2.5.4",
    level: "A",
    title: "Motion Actuation",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "Test on a real device. If any function is triggered by shaking the device, tilting it, or moving it (e.g., shake to undo), confirm:",
      "  - There's a non-motion alternative (a button on screen).",
      "  - The motion trigger can be disabled in settings.",
    ],
  },
  {
    sc: "3.1.1",
    level: "A",
    title: "Language of Page",
    category: "partial",
    howToTest: [
      "View page source; confirm <html lang=\"…\"> matches the page's primary language and uses a valid BCP-47 tag (e.g., 'en', 'en-US', 'fr-CA').",
    ],
  },
  {
    sc: "3.2.1",
    level: "A",
    title: "On Focus",
    category: "partial",
    howToTest: [
      "Tab to every interactive element. Confirm focusing it does NOT trigger a change of context: navigation, form submit, popup, modal opening, page reload.",
      "Common fail: a select element that auto-submits on focus.",
    ],
  },
  {
    sc: "3.2.2",
    level: "A",
    title: "On Input",
    category: "partial",
    howToTest: [
      "Change each form value (type, select, check). Confirm no unexpected change of context happens — unless the user was warned beforehand.",
      "Common fail: changing a country dropdown auto-submits the form and reloads.",
    ],
  },
  {
    sc: "3.2.6",
    level: "A",
    title: "Consistent Help",
    category: "partial",
    howToTest: [
      "Visit several pages of the same site. Locate help / contact / FAQ / chat link on each.",
      "Confirm the help mechanism appears in the same relative location across pages (e.g., always in the footer; always top-right).",
    ],
  },
  {
    sc: "3.3.1",
    level: "A",
    title: "Error Identification",
    category: "partial",
    howToTest: [
      "Submit each form with deliberately invalid input.",
      "Confirm the error message identifies which field is wrong AND describes the error in text — not just a red border.",
      "Confirm a screen reader announces the error (live region or focus shift).",
    ],
  },
  {
    sc: "3.3.2",
    level: "A",
    title: "Labels or Instructions",
    category: "partial",
    howToTest: [
      "For every form field, confirm there's a visible label or instructions explaining what to enter.",
      "Placeholder text alone is NOT a label — it disappears when the user starts typing.",
      "Required fields should be marked (text or aria-required), not just colored differently.",
    ],
  },
  {
    sc: "3.3.7",
    level: "A",
    title: "Redundant Entry",
    category: "partial",
    howToTest: [
      "Walk through any multi-step form (checkout, signup, application).",
      "Confirm previously-entered information is auto-filled or made selectable on later steps — the user shouldn't have to retype name, address, email.",
    ],
  },
  {
    sc: "4.1.2",
    level: "A",
    title: "Name, Role, Value",
    category: "partial",
    howToTest: [
      "For every custom widget (custom dropdown, tabs, accordion, dialog, tree, slider), use a screen reader to inspect what's announced.",
      "Confirm the widget's name (label), role (button / dialog / tab), and current state (expanded / pressed / selected) are announced — and that state updates are announced as the user interacts.",
      "Tools: Chrome DevTools Accessibility panel; NVDA + Firefox; VoiceOver + Safari.",
    ],
  },

  // ===== Level AA =====
  {
    sc: "1.2.4",
    level: "AA",
    title: "Captions (Live)",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "Watch any live audio content (webinar, livestream, video call). Confirm real-time captions are displayed.",
      "Confirm captions cover every speaker and any non-speech audio relevant to the content.",
    ],
  },
  {
    sc: "1.2.5",
    level: "AA",
    title: "Audio Description (Prerecorded)",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "For every prerecorded <video> with audio, confirm an audio-description track is provided (additional narration describing important visual information).",
      "Listen to the described version with the screen off — confirm the narration fills in important visuals.",
    ],
  },
  {
    sc: "1.3.4",
    level: "AA",
    title: "Orientation",
    category: "partial",
    howToTest: [
      "Rotate device or browser viewport between portrait and landscape.",
      "Confirm content reflows / rotates and remains usable in both orientations.",
      "Acceptable to lock orientation only when essential (e.g., a piano-keyboard app).",
    ],
  },
  {
    sc: "1.4.3",
    level: "AA",
    title: "Contrast (Minimum)",
    category: "partial",
    howToTest: [
      "For text rendered over a gradient, image, or video background — automated tools cannot measure contrast reliably.",
      "Sample 5–10 spots along the text; measure foreground vs the actual underlying pixels with TPGi Colour Contrast Analyser.",
      "Confirm 4.5:1 for normal text, 3:1 for large text (≥ 18pt or ≥ 14pt bold).",
    ],
  },
  {
    sc: "1.4.4",
    level: "AA",
    title: "Resize Text",
    category: "partial",
    howToTest: [
      "Increase browser zoom to 200% (Ctrl/Cmd + repeatedly, or Ctrl/Cmd +).",
      "Confirm no text is clipped, no buttons disappear, no horizontal scroll appears at desktop widths, no functionality is lost.",
    ],
  },
  {
    sc: "1.4.5",
    level: "AA",
    title: "Images of Text",
    category: "llm",
    howToTest: [
      "Inspect each image on the page. If it contains text (other than logo, brand mark, or stylized art), it's a violation.",
      "Real text in CSS is preferred. Hero banners with text baked into PNGs are common fails.",
    ],
  },
  {
    sc: "1.4.10",
    level: "AA",
    title: "Reflow",
    category: "partial",
    howToTest: [
      "Resize browser window to 320 CSS pixels wide (DevTools device toolbar → 320×480).",
      "Confirm content reflows: no two-dimensional scrolling (no horizontal scroll for vertical content).",
      "Confirm no critical functionality is lost.",
      "Acceptable exceptions: data tables, complex graphs, maps, where a horizontal scroll is essential.",
    ],
  },
  {
    sc: "1.4.11",
    level: "AA",
    title: "Non-text Contrast",
    category: "partial",
    howToTest: [
      "For every UI component (buttons, inputs, checkboxes, focus rings) confirm visual boundary contrast vs surroundings is at least 3:1.",
      "Same for component states (focused, checked, selected, disabled): the state-indicating pixels must contrast 3:1 against adjacent colors.",
      "Same for meaningful graphics (chart bars, icons that aren't decorative).",
      "Hard cases: icons over gradients, focus indicators on non-solid backgrounds, anti-aliased thin strokes — measure with a contrast analyser pixel-picker.",
    ],
  },
  {
    sc: "1.4.12",
    level: "AA",
    title: "Text Spacing",
    category: "partial",
    howToTest: [
      "In DevTools, apply this CSS to every text element: line-height: 1.5em; letter-spacing: 0.12em; word-spacing: 0.16em; paragraph-spacing: 2em.",
      "Confirm no text is clipped, no buttons collapse, no overlap occurs.",
      "Bookmarklets like 'WCAG Text Spacing' apply this in one click.",
    ],
  },
  {
    sc: "1.4.13",
    level: "AA",
    title: "Content on Hover or Focus",
    category: "partial",
    howToTest: [
      "Hover any element that triggers a tooltip / popover / submenu.",
      "Confirm: (1) the popover stays visible while hovered; (2) the user can move the pointer onto the popover content without it disappearing; (3) Esc dismisses it; (4) the popover doesn't obscure the trigger.",
    ],
  },
  {
    sc: "2.4.5",
    level: "AA",
    title: "Multiple Ways",
    category: "llm",
    howToTest: [
      "Confirm the site provides at least two of: navigation menu, search box, sitemap, table of contents, A-Z index, or breadcrumbs.",
      "Single-page apps that aren't part of a process are exempt.",
    ],
  },
  {
    sc: "2.4.6",
    level: "AA",
    title: "Headings and Labels",
    category: "partial",
    howToTest: [
      "Read every heading and every form label out loud.",
      "Confirm each is descriptive of the section / control it labels — no 'Section 1' or 'Field' generics.",
      "Browse the heading outline (HeadingsMap extension, NVDA H key) and confirm it reads like a useful table of contents.",
    ],
  },
  {
    sc: "2.4.7",
    level: "AA",
    title: "Focus Visible",
    category: "partial",
    howToTest: [
      "Tab through every focusable element. Confirm a clearly visible focus indicator appears on each.",
      "Test on different backgrounds — a 1px dotted outline on a busy page may not be visible enough.",
      "If the page suppresses outlines via `outline: none`, the developer must provide a replacement.",
    ],
  },
  {
    sc: "2.4.11",
    level: "AA",
    title: "Focus Not Obscured (Minimum)",
    category: "partial",
    howToTest: [
      "Tab through every focusable element on the page.",
      "Confirm sticky / fixed elements (cookie banners, sticky headers, chat widgets) do NOT entirely cover the focused element.",
      "Common fail: a sticky bottom cookie banner covering form fields as the user tabs down.",
    ],
  },
  {
    sc: "2.5.7",
    level: "AA",
    title: "Dragging Movements",
    category: "partial",
    howToTest: [
      "Identify every drag interaction (drag-to-reorder, drag-and-drop file upload, slider drag, kanban board).",
      "Confirm each has a single-pointer alternative — buttons to move up/down, an input field for numeric values, etc.",
    ],
  },
  {
    sc: "2.5.8",
    level: "AA",
    title: "Target Size (Minimum)",
    category: "partial",
    howToTest: [
      "Measure each interactive target's CSS pixel size — must be at least 24×24 CSS px.",
      "Exceptions: inline links in body text, user-agent-default targets, essential targets (e.g., real-world map markers).",
      "Browser DevTools → click element → check computed size.",
    ],
  },
  {
    sc: "3.1.2",
    level: "AA",
    title: "Language of Parts",
    category: "llm",
    howToTest: [
      "Identify any phrase or passage on the page in a different language than the page primary language.",
      "Confirm it's wrapped in an element with `lang=\"…\"` — e.g., <span lang=\"fr\">savoir-faire</span>.",
      "Idioms / proper names that have entered the primary language don't need lang.",
    ],
  },
  {
    sc: "3.2.3",
    level: "AA",
    title: "Consistent Navigation",
    category: "partial",
    howToTest: [
      "Visit several pages of the site. Confirm the same navigation menu appears in the same order and same location on each page.",
      "Items can be added or hidden contextually but the relative order should not change unpredictably.",
    ],
  },
  {
    sc: "3.2.4",
    level: "AA",
    title: "Consistent Identification",
    category: "partial",
    howToTest: [
      "Find icons / controls that recur across pages (search icon, profile button, cart, save button).",
      "Confirm the same icon / role has the same accessible name everywhere — search labelled 'Search' on one page and 'Find' on another is a fail.",
    ],
  },
  {
    sc: "3.3.3",
    level: "AA",
    title: "Error Suggestion",
    category: "llm",
    howToTest: [
      "Submit forms with bad input. Read each error message.",
      "Confirm the message suggests how to correct the error — 'Email must contain @' beats 'Invalid email'.",
      "If suggestion would compromise security (e.g., 'wrong password' → don't say which character was wrong), exempt.",
    ],
  },
  {
    sc: "3.3.4",
    level: "AA",
    title: "Error Prevention (Legal, Financial, Data)",
    category: "llm",
    howToTest: [
      "For every form that creates a legal commitment, takes payment, modifies data, or submits test answers:",
      "Confirm at least one of: submission is reversible; data is checked and the user is given a chance to correct errors; a final 'review and confirm' step exists.",
    ],
  },
  {
    sc: "3.3.8",
    level: "AA",
    title: "Accessible Authentication (Minimum)",
    category: "partial",
    howToTest: [
      "Walk the login flow. Confirm at least one path doesn't require a cognitive function test (puzzle, math, character recall, image identification).",
      "Confirm password fields support paste and password-manager autofill (try Ctrl+V; try the browser's saved-password autofill).",
      "Acceptable: object recognition CAPTCHAs (select all images with a bus); recognising user-supplied content.",
    ],
  },
  {
    sc: "4.1.3",
    level: "AA",
    title: "Status Messages",
    category: "partial",
    howToTest: [
      "Trigger every status update on the page that DOESN'T receive focus: form-submit success toast, cart-item-added confirmation, search-results-loaded notification, error banner.",
      "Confirm a screen reader announces it (the developer must use role=\"status\" / aria-live=\"polite\" / role=\"alert\").",
      "Test in NVDA, VoiceOver, or JAWS — automated tools see the markup but cannot prove the announcement happened at the right moment.",
    ],
  },

  // ===== Level AAA =====
  {
    sc: "1.2.6",
    level: "AAA",
    title: "Sign Language (Prerecorded)",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "For each prerecorded <video> with audio, confirm a sign-language interpretation is provided (typically a picture-in-picture interpreter video).",
      "Confirm the interpreter is in the user's primary signed language and large enough to read.",
    ],
  },
  {
    sc: "1.2.7",
    level: "AAA",
    title: "Extended Audio Description (Prerecorded)",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "If a video's natural pauses don't leave enough time to describe visuals, confirm an extended audio-description track exists that pauses the video to insert narration.",
    ],
  },
  {
    sc: "1.2.8",
    level: "AAA",
    title: "Media Alternative (Prerecorded)",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "Confirm a full text alternative for every prerecorded synchronized media element exists — covering both speech and visual information.",
      "Read it end-to-end and confirm equivalence to the source video.",
    ],
  },
  {
    sc: "1.2.9",
    level: "AAA",
    title: "Audio-only (Live)",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "Watch any live audio-only stream. Confirm a real-time text alternative (live captions / live transcript) is available.",
    ],
  },
  {
    sc: "1.3.6",
    level: "AAA",
    title: "Identify Purpose",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "Confirm UI components, icons, and regions can be programmatically identified using ARIA / metadata so adaptive technology (symbol replacement, simplified UI) can substitute them.",
      "This is rarely fully achievable today; flag any obvious omissions.",
    ],
  },
  {
    sc: "1.4.6",
    level: "AAA",
    title: "Contrast (Enhanced)",
    category: "partial",
    howToTest: [
      "Same as 1.4.3 but at the higher AAA threshold: 7:1 for normal text, 4.5:1 for large text.",
      "Use a contrast analyser; pay extra attention to text over gradients and images.",
    ],
  },
  {
    sc: "1.4.7",
    level: "AAA",
    title: "Low or No Background Audio",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "For prerecorded speech audio, confirm: no background sounds, OR background can be turned off, OR background is at least 20 dB lower than foreground speech.",
    ],
  },
  {
    sc: "1.4.8",
    level: "AAA",
    title: "Visual Presentation",
    category: "partial",
    howToTest: [
      "Confirm the user can: select foreground & background colors; have line width ≤ 80 characters; turn off justification; set line-spacing ≥ 1.5×; resize text to 200% without horizontal scroll at full-screen width.",
    ],
  },
  {
    sc: "1.4.9",
    level: "AAA",
    title: "Images of Text (No Exception)",
    category: "llm",
    howToTest: [
      "Even logos with stylized type — at AAA confirm they're presented as real text wherever the visual style allows.",
      "Decorative images of text are exempt.",
    ],
  },
  {
    sc: "2.1.3",
    level: "AAA",
    title: "Keyboard (No Exception)",
    category: "partial",
    howToTest: [
      "All functionality must be operable via keyboard with no exceptions — even handwriting / drawing apps must offer a keyboard mode.",
    ],
  },
  {
    sc: "2.2.3",
    level: "AAA",
    title: "No Timing",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "Confirm no timing is essential to any activity, except for non-interactive synchronized media events (e.g., live auctions).",
    ],
  },
  {
    sc: "2.2.4",
    level: "AAA",
    title: "Interruptions",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "Identify every notification / alert / popup that interrupts the user.",
      "Confirm the user can postpone or suppress them, except for emergencies.",
    ],
  },
  {
    sc: "2.2.5",
    level: "AAA",
    title: "Re-authenticating",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "Let a session expire while you're partway through a task. Re-authenticate.",
      "Confirm you return to where you were and didn't lose data (form drafts, cart contents, partially-filled fields).",
    ],
  },
  {
    sc: "2.2.6",
    level: "AAA",
    title: "Timeouts",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "Identify any inactivity timeout that could cause data loss.",
      "Confirm the user is warned about the duration of the timeout at the start of the activity.",
    ],
  },
  {
    sc: "2.3.2",
    level: "AAA",
    title: "Three Flashes",
    category: "partial",
    howToTest: [
      "At AAA, NO content is allowed to flash more than 3 times per second — even below the general flash threshold.",
      "Use PEAT or visual inspection.",
    ],
  },
  {
    sc: "2.3.3",
    level: "AAA",
    title: "Animation from Interactions",
    category: "partial",
    howToTest: [
      "Enable 'Reduce Motion' in OS / browser settings (macOS: System Settings → Accessibility → Display; iOS: Settings → Accessibility → Motion).",
      "Confirm interaction-triggered motion animation (parallax scroll, scroll-tied effects, slide transitions) is reduced or eliminated.",
      "Tools: Chrome DevTools → Rendering → Emulate CSS prefers-reduced-motion: reduce.",
    ],
  },
  {
    sc: "2.4.8",
    level: "AAA",
    title: "Location",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "Confirm users can determine their location within the site — breadcrumbs, current-page indicator in nav, current-step indicator in a multi-step process.",
    ],
  },
  {
    sc: "2.4.9",
    level: "AAA",
    title: "Link Purpose (Link Only)",
    category: "llm",
    howToTest: [
      "Read every link's text in isolation (no surrounding context).",
      "Confirm purpose is clear from the link text alone — 'click here', 'read more', 'this' are fails.",
      "Acceptable when ambiguous links are exempt by author judgment (e.g., 'Read more' inside a list of articles where each article has its own heading nearby — but stricter at AAA).",
    ],
  },
  {
    sc: "2.4.10",
    level: "AAA",
    title: "Section Headings",
    category: "llm",
    howToTest: [
      "Read every section of the page. Confirm each meaningfully-distinct section has a heading appropriate to its content.",
      "Long blocks of prose without subheadings are common fails.",
    ],
  },
  {
    sc: "2.4.12",
    level: "AAA",
    title: "Focus Not Obscured (Enhanced)",
    category: "partial",
    howToTest: [
      "Stricter than 2.4.11: the focused element must NEVER be obscured even partially by author-created sticky / fixed content.",
      "Tab through the entire page; check no overlay clips any portion of the focus indicator.",
    ],
  },
  {
    sc: "2.4.13",
    level: "AAA",
    title: "Focus Appearance",
    category: "partial",
    howToTest: [
      "Tab to a focusable element. Measure the focus indicator: its area must be at least the equivalent of a 2 CSS-pixel-thick perimeter around the element.",
      "Measure contrast between the focused-state and unfocused-state pixels — must be at least 3:1.",
      "Use a screenshot tool + contrast analyser.",
    ],
  },
  {
    sc: "2.5.5",
    level: "AAA",
    title: "Target Size (Enhanced)",
    category: "partial",
    howToTest: [
      "Same as 2.5.8 but at the higher AAA threshold: every pointer target must be at least 44×44 CSS px.",
    ],
  },
  {
    sc: "2.5.6",
    level: "AAA",
    title: "Concurrent Input Mechanisms",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "Try operating the site with mouse, then keyboard, then touch, then any combination — at any time.",
      "Confirm the site does not restrict you to one input method.",
    ],
  },
  {
    sc: "3.1.3",
    level: "AAA",
    title: "Unusual Words",
    category: "llm",
    howToTest: [
      "Read the page. Note any jargon, idioms, technical terms, foreign phrases, or domain-specific vocabulary.",
      "Confirm a definition is provided — inline (first use), in a glossary linked from the page, or via <abbr title=\"…\">.",
    ],
  },
  {
    sc: "3.1.4",
    level: "AAA",
    title: "Abbreviations",
    category: "llm",
    howToTest: [
      "Find every abbreviation / acronym / initialism on the page.",
      "Confirm an expansion or definition is available — e.g., wrapped in <abbr title=\"World Wide Web\">WWW</abbr>, or expanded inline at first use.",
    ],
  },
  {
    sc: "3.1.5",
    level: "AAA",
    title: "Reading Level",
    category: "llm",
    howToTest: [
      "Read the page text. Estimate or measure (Flesch-Kincaid, Hemingway) the reading level.",
      "If above lower-secondary education (~14 years), confirm a simpler version exists, OR illustrations / supplementary content are provided to aid comprehension.",
    ],
  },
  {
    sc: "3.1.6",
    level: "AAA",
    title: "Pronunciation",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "Find words whose meaning depends on pronunciation (homographs in context, foreign names).",
      "Confirm pronunciation is provided — typically via ruby annotations (Asian languages) or audio.",
    ],
  },
  {
    sc: "3.2.5",
    level: "AAA",
    title: "Change on Request",
    category: "manual",
    tags: ["Manual Only"],
    howToTest: [
      "Confirm changes of context (navigation, popup, focus shift) only happen on direct user request.",
      "Auto-redirects, auto-refreshes, and auto-popups are common fails.",
    ],
  },
  {
    sc: "3.3.5",
    level: "AAA",
    title: "Help",
    category: "llm",
    howToTest: [
      "For every form, especially complex ones (financial, legal, account-creation), confirm contextual help is available — inline tooltips, help icons next to fields, a help link nearby.",
    ],
  },
  {
    sc: "3.3.6",
    level: "AAA",
    title: "Error Prevention (All)",
    category: "llm",
    howToTest: [
      "At AAA, EVERY form that submits user data must offer reversal, review-and-confirm, or input checking — not just legal/financial/data forms.",
    ],
  },
  {
    sc: "3.3.9",
    level: "AAA",
    title: "Accessible Authentication (Enhanced)",
    category: "partial",
    howToTest: [
      "Stricter than 3.3.8: even object-recognition CAPTCHAs and personal-content recall are NOT acceptable.",
      "Acceptable: passkeys, biometric auth, password managers with paste support, email magic links.",
    ],
  },
];

/**
 * Verify the static catalog is consistent at module-load time. Failing fast
 * here is preferable to silently rendering a broken report.
 */
function validateCatalog(): void {
  const seen = new Set<string>();
  for (const entry of MANUAL_AUDIT_CATALOG) {
    if (seen.has(entry.sc)) {
      throw new Error(`manual-audits: duplicate SC ${entry.sc}`);
    }
    seen.add(entry.sc);
    if (entry.howToTest.length === 0) {
      throw new Error(`manual-audits: SC ${entry.sc} has no howToTest steps`);
    }
  }
}
validateCatalog();

const LEVEL_ORDER: Record<WcagLevel, number> = { A: 0, AA: 1, AAA: 2 };

/**
 * Filter catalog by tag. If tag is provided, returns only entries that have
 * that tag in their tags array. If no tag provided, returns all entries.
 */
function filterByTag(tag?: string): ManualAudit[] {
  if (!tag) return MANUAL_AUDIT_CATALOG;
  return MANUAL_AUDIT_CATALOG.filter((entry) =>
    entry.tags?.includes(tag)
  );
}

/**
 * Catalog grouped by level, in display order. Used by both report renderers.
 * @param tag - Optional tag to filter by (e.g., "Manual Only")
 */
export function manualAuditsByLevel(tag?: string): Record<WcagLevel, ManualAudit[]> {
  const filtered = filterByTag(tag);
  const out: Record<WcagLevel, ManualAudit[]> = { A: [], AA: [], AAA: [] };
  for (const entry of filtered) {
    out[entry.level].push(entry);
  }
  for (const level of ["A", "AA", "AAA"] as const) {
    out[level].sort((a, b) => compareSc(a.sc, b.sc));
  }
  return out;
}

/**
 * Total count for tab badges.
 * @param tag - Optional tag to filter by (e.g., "Manual Only")
 */
export function manualAuditsCount(tag?: string): number {
  return filterByTag(tag).length;
}

/** Numeric comparison of SC ids ("1.4.10" > "1.4.3"). */
function compareSc(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** Useful when consumers want to render in canonical level order with no grouping. */
export function compareManualAudits(a: ManualAudit, b: ManualAudit): number {
  const lvl = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
  if (lvl !== 0) return lvl;
  return compareSc(a.sc, b.sc);
}
