# ASP.NET Static Scanner — Capabilities Reference

Applies to: `scan-repo` command on ASP.NET codebases containing `.aspx`, `.ascx`, `.master`, `.cshtml`, `.cs`, `.vb`, `.js`, `.ts`, `.css`, `.less`, `.scss` files.

---

## ✅ What the scanner CAN find

### ASPX / ASCX / Master / CSHTML / HTML markup

| Issue | Rule ID | WCAG SC | Severity |
|---|---|---|---|
| `<img>` missing `alt` attribute | `aspnet/alt-text` | 1.1.1 (A) | Blocker |
| `<html>` missing `lang` attribute | `aspnet/html-has-lang` | 3.1.1 (A) | Severe |
| Empty `<a>` link (no text, aria-label, or title) | `aspnet/anchor-has-content` | 2.4.4 (A) | Severe |
| Empty `<button>` (no text or aria-label) | `aspnet/button-has-content` | 4.1.2 (A) | Blocker |
| `<input>` with no associated `<label>` or aria-label | `aspnet/input-has-label` | 3.3.2 (AA) | Major |
| `<select>` with no associated label | `aspnet/select-has-label` | 3.3.2 (AA) | Major |
| `<textarea>` with no associated label | `aspnet/textarea-has-label` | 3.3.2 (AA) | Major |
| `<iframe>` missing `title` attribute | `aspnet/iframe-has-title` | 2.4.1 (A) | Severe |
| `<table>` without `<caption>` or aria-label | `aspnet/table-missing-caption` | 1.3.1 (A) | Severe |
| `<th>` without `scope` attribute | `aspnet/th-missing-scope` | 1.3.1 (A) | Severe |
| Missing or empty `<title>` element on full pages | `aspnet/page-has-title` | 2.4.2 (A) | Major |
| `tabindex` set to a positive value in markup | `aspnet/tabindex-positive` | 2.4.3 (A) | Major |
| `<meta http-equiv="refresh">` automatic page refresh | `aspnet/no-meta-refresh` | 2.2.1 (A) | Major |
| `<video>` / `<audio>` missing `<track kind="captions">` | `aspnet/media-missing-captions` | 1.2.2 (A) | Severe |
| `onclick` on `<div>`/`<span>` etc. with no role or keyboard handler | `aspnet/onclick-non-interactive` | 2.1.1 (A) | Blocker |

### ASP.NET server controls

| Issue | Rule ID | WCAG SC | Severity |
|---|---|---|---|
| `asp:Image` missing `AlternateText` | `aspnet/alt-text` | 1.1.1 (A) | Blocker |
| `asp:ImageButton` missing `AlternateText` | `aspnet/alt-text` | 1.1.1 (A) | Blocker |
| `asp:ImageMap` missing `AlternateText` | `aspnet/alt-text` | 1.1.1 (A) | Blocker |
| `asp:Button` missing `Text` attribute | `aspnet/button-has-content` | 4.1.2 (A) | Blocker |
| `asp:LinkButton` missing `Text` attribute | `aspnet/linkbutton-has-content` | 2.4.4 (A) | Severe |
| `asp:HyperLink` missing `Text` attribute | `aspnet/hyperlink-has-content` | 2.4.4 (A) | Severe |
| `asp:CheckBox` missing `Text` attribute | `aspnet/checkbox-has-label` | 1.3.1 (A) | Severe |
| `asp:RadioButton` missing `Text` attribute | `aspnet/radiobutton-has-label` | 1.3.1 (A) | Severe |
| `asp:TextBox` with no `asp:Label AssociatedControlID` or aria-label | `aspnet/textbox-has-label` | 3.3.2 (AA) | Major |
| `asp:DropDownList` with no associated label | `aspnet/dropdownlist-has-label` | 3.3.2 (AA) | Major |
| `asp:ListBox` with no associated label | `aspnet/listbox-has-label` | 3.3.2 (AA) | Major |
| `asp:FileUpload` with no associated label | `aspnet/fileupload-has-label` | 3.3.2 (AA) | Major |
| `asp:GridView` / `asp:DetailsView` without `Caption` | `aspnet/grid-missing-caption` | 1.3.1 (A) | Severe |

### JavaScript / TypeScript / jQuery (heuristic — all flagged as "requires human review")

These checks scan string literals and DOM API calls for patterns that commonly
produce inaccessible markup when injected into the page. Because static analysis
cannot see runtime variable values, every JS finding is marked `requiresHumanReview: true`
with `severity: review`. Confirm or dismiss with `scan-url` on the live app.

| Issue | Rule ID | WCAG SC |
|---|---|---|
| String literal `<img>` without `alt` (e.g. `$.html('<img src="...">')`) | `aspnet/js-img-missing-alt` | 1.1.1 |
| `document.createElement('img')` with no `.alt =` assignment nearby | `aspnet/js-img-missing-alt` | 1.1.1 |
| String-injected `<button>` with no visible text or aria-label | `aspnet/js-button-missing-label` | 4.1.2 |
| String-injected `<a>` with no visible text or aria-label | `aspnet/js-anchor-missing-label` | 2.4.4 |
| String-injected `<input>` with no aria-label or title | `aspnet/js-input-missing-label` | 3.3.2 |
| `.setAttribute('aria-hidden','true')` or jQuery `.attr('aria-hidden','true')` | `aspnet/js-aria-hidden-focusable` | 1.3.1 |
| Positive `tabIndex` set via JS (`el.tabIndex = 5`) | `aspnet/js-tabindex-positive` | 2.4.3 |

### ASP.NET code-behind (`.cs` / `.vb`) heuristics (all flagged as "requires human review")

These checks inspect dynamic control creation and script registration in
code-behind files. They are intentionally conservative and always require
runtime confirmation with `scan-url`.

| Issue | Rule ID | WCAG SC |
|---|---|---|
| `new Image { ... }` without `AlternateText =` in initializer | `aspnet/cs-image-missing-alt` | 1.1.1 |
| `new ImageButton { ... }` without `AlternateText =` in initializer | `aspnet/cs-imagebutton-missing-alt` | 1.1.1 |
| `new ImageMap { ... }` without `AlternateText =` in initializer | `aspnet/cs-imagemap-missing-alt` | 1.1.1 |
| `new Button { ... }` without `Text =` in initializer | `aspnet/cs-button-missing-text` | 4.1.2 |
| `new LinkButton { ... }` without `Text =` in initializer | `aspnet/cs-linkbutton-missing-text` | 2.4.4 |
| `new HyperLink { ... }` without `Text =` in initializer | `aspnet/cs-hyperlink-missing-text` | 2.4.4 |
| `new CheckBox { ... }` without `Text =` in initializer | `aspnet/cs-checkbox-missing-text` | 1.3.1 |
| `new RadioButton { ... }` without `Text =` in initializer | `aspnet/cs-radiobutton-missing-text` | 1.3.1 |
| `new TextBox { ... }` with no inline labeling hint (`aria-label`, `aria-labelledby`, `ToolTip`) | `aspnet/cs-textbox-missing-label-hint` | 3.3.2 |
| `ClientScript` / `ScriptManager` script-include registration found in code-behind | `aspnet/cs-script-include` | 4.1.2 |

### CSS / LESS / SCSS

| Issue | Rule ID | WCAG SC | Severity |
|---|---|---|---|
| `outline: none` or `outline: 0` (removes browser focus ring) | `aspnet/css-outline-none` | 2.4.7 (AA) | Major |

---

## ❌ What is IMPOSSIBLE for a static scanner (requires a live browser — use `scan-url`)

These categories fundamentally require a rendered, interactive browser session. No static
analysis tool can evaluate them from source files alone.

| Issue | WCAG SC | Why static analysis cannot help |
|---|---|---|
| **Color contrast** — text, UI components, focus indicators | 1.4.3, 1.4.6, 1.4.11 | Needs rendered pixels with real fonts, sizes, opacity, and overlapping CSS applied |
| **Focus indicator visibility** — is there a visible ring? | 2.4.7, 2.4.11 | Needs browser to compute the focused visual state |
| **Keyboard traps** — can the user Tab out of a region? | 2.1.2 | Needs a real browser with Tab / Shift+Tab / Escape simulation |
| **Focus order** — does keyboard order match visual order? | 2.4.3 | Needs layout coordinates from a fully rendered DOM |
| **Reflow at 320px viewport** | 1.4.10 | Needs browser viewport resize |
| **AJAX / fetch-loaded content** | Any | Content does not exist in source files at scan time |
| **Runtime ARIA states** (`aria-expanded`, `aria-selected`, `aria-live` announcements, etc.) | 4.1.3 | States are set by JavaScript at interaction time |
| **Code-behind values assigned outside object initializers / across methods** | 1.1.1, 3.3.2, 4.1.2 | Static pass is heuristic and does not do full inter-procedural data-flow tracking |
| **`display:none` / `visibility:hidden` applied by CSS to focusable elements** | 2.4.3 | Requires computed style from a rendered DOM |
| **Animations and flashing** | 2.3.1, 2.3.3 | Requires runtime rendering and timing |
| **Touch target size** (pointer targets ≥ 24×24 px) | 2.5.8 | Requires rendered layout measurements |
| **Sensory-characteristic instructions** ("click the red button") | 1.3.3 | Requires semantic understanding of rendered text |
| **Session timeout warnings** | 2.2.1 | Requires runtime timer observation |

---

## Recommended workflow

```
scan-repo  →  Catches all source-level issues above (fast, no browser needed)
scan-url   →  Catches runtime issues: contrast, keyboard, focus, ARIA states, AJAX content
```

Run both for the most complete WCAG AA coverage on an ASP.NET application.

```bash
# Static repo scan
npm run cli -- scan-repo "C:\path\to\your\webapp" --level AA

# Live URL scan (requires the app to be running)
npm run cli -- scan-url https://your-app-url --level AA
```
