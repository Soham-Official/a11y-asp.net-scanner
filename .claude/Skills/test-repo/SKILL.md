---
name: test-repo
description: Execute comprehensive end-to-end testing for the a11y-scout distribution, CLI commands, Playwright/WebdriverIO integrations, and React/Angular repository scanning + auto-fixing across multiple test projects. Use before releasing a new version to validate the full distribution pipeline.
---

# test-repo

Execute comprehensive end-to-end testing for a11y-scout distribution, CLI commands, and integrations across multiple test projects.

## When to use

Invoke this skill when you need to validate the complete a11y-scout distribution pipeline, including:
- Distribution package creation
- CLI functionality (scan-url with various configurations)
- Playwright test fixture integration
- WebdriverIO integration
- React repository scanning and auto-fixing
- Angular repository scanning and auto-fixing

This is a full end-to-end test suite that should be run before releasing new versions.

## Instructions

You are testing the a11y-scout distribution and all its integrations. Execute the following test phases sequentially and report any failures immediately.

### Phase 1: Build Distribution

**Working directory:** `/Users/pradeep.ganesh/Documents/Work/Accessibility Checker/a11y-scanner`

1. Run `npm run dist` to build the distribution packages
2. Verify the `distribution/` folder is created
3. Confirm exactly 3 packages are present in the distribution folder:
   - `a11y-scout-<version>.tgz`
   - `a11y-scout-playwright-<version>.tgz`
   - `a11y-scout-webdriverio-<version>.tgz`
4. **Exit early if distribution build fails or packages are missing**

### Phase 2: Integration Tests

**Working directory:** `/Users/pradeep.ganesh/Documents/Work/Accessibility Checker/a11y-scanner`

1. Run the integration test suite (specify the exact command if available, or check `package.json` scripts)
2. Report test results and any failures

### Phase 3: CLI Testing

**Working directory:** `/Users/pradeep.ganesh/Documents/Work/Accessibility Checker/a11y-scanner`

Test the CLI with multiple scan configurations:

1. **Multi-page crawl test:**
   ```bash
   npm run cli -- scan-url https://www.hyland.com/en --level AAA --crawl --max-pages 2 --max-depth 2
   ```
   - Verify command completes successfully
   - Check that reports are generated in `/Users/pradeep.ganesh/Documents/Work/Accessibility Checker/a11y-scanner/packages/a11y-scout/a11y-reports/latest`

2. **Single-page AA scan (headed):**
   ```bash
   npm run cli -- scan-url https://www.hyland.com/en --level AA --headed
   ```
   - Verify command completes successfully
   - Check that reports are generated in `/Users/pradeep.ganesh/Documents/Work/Accessibility Checker/a11y-scanner/packages/a11y-scout/a11y-reports/latest`
   - **Save the report path** for comparison in Phase 4
   - **Note:** `--headed` is required so this baseline matches the Playwright integration run in Phase 4. The `test-project` Playwright config runs with `headless: false`, and hyland.com renders differently in headed vs. headless Chromium (extra video/carousel and modal-overlay content appears headed). A headless baseline here produces ~60 findings vs. ~104 headed — an apples-to-oranges comparison. Running both headed makes the Phase 4 comparison meaningful.

### Phase 4: Playwright Integration Testing

**Working directory:** `/Users/pradeep.ganesh/Documents/Work/Accessibility Checker/test-project`

1. Uninstall existing a11y-scout packages:
   ```bash
   npm uninstall a11y-scout @a11y-scout/playwright
   ```

2. Delete previous reports if present:
   ```bash
   rm -rf a11y-reports/
   ```

3. Install packages from the distribution folder:
   ```bash
   npm install ../a11y-scanner/distribution/a11y-scout-*.tgz ../a11y-scanner/distribution/a11y-scout-playwright-*.tgz
   ```

4. **Run Playwright test suite (hyland.com single-page):**
   ```bash
   npx playwright test tests/example.spec.ts
   ```
   - Verify test executes successfully
   - Check that reports are generated in `/Users/pradeep.ganesh/Documents/Work/Accessibility Checker/test-project/a11y-reports/latest`
   - **Save the report path** for comparison with Phase 3

5. **Run Playwright test suite (Perceptive multi-page):**
   ```bash
   npx playwright test tests/perceptive.spec.js
   ```
   - Verify test executes successfully
   - Check that reports are generated in `/Users/pradeep.ganesh/Documents/Work/Accessibility Checker/test-project/a11y-reports/latest`
   - **Verify findings are present across 2 pages:**
     - Page 1: "Home"
     - Page 2: "Capture and Indexing"
   - Confirm multi-page report structure is correct

6. **Compare reports:** Verify that the single-page scan-url report from Phase 3 (run with `--headed`) and the Playwright integration report (from step 4) have only minimal differences:
   - Same accessibility findings (allow for timestamp/metadata differences)
   - Same WCAG violations detected
   - Similar issue counts
   - **Both runs must be headed** for an apples-to-apples comparison (Phase 3b uses `--headed`; the Playwright config uses `headless: false`). The deterministic axe/keyboard rules should match rule-for-rule. Small ±1 variations in the non-deterministic LLM `content-quality-*` findings (and color-contrast counts that depend on them) are expected noise, not defects.
   - **Report any significant discrepancies** in the deterministic findings.

### Phase 5: WebdriverIO Integration Testing

**Working directory:** `/Users/pradeep.ganesh/Documents/Work/Accessibility Checker/a11y-scanner/examples/webdriverio-demo`

**Note:** The webdriverio-demo uses the built packages from the workspace, not the distribution packages. The demo is already configured and ready to run.

1. Delete previous reports if present:
   ```bash
   rm -rf a11y-reports/
   ```

2. **Run WebdriverIO test suite:**
   ```bash
   npm test
   ```
   - Verify test executes successfully
   - Check that reports are generated in `/Users/pradeep.ganesh/Documents/Work/Accessibility Checker/a11y-scanner/examples/webdriverio-demo/a11y-reports/latest`
   - Verify findings are present (google.co.in single-page scan)

**Note:** Multi-page WebdriverIO test does not exist yet. The single-page test validates the WebdriverIO integration is working correctly.

### Phase 6: React Repository Testing

**Working directory:** `/Users/pradeep.ganesh/Documents/Work/Accessibility Checker/react-frontend`

1. Uninstall existing a11y-scout:
   ```bash
   npm uninstall a11y-scout
   ```

2. Delete previous reports if present:
   ```bash
   rm -rf a11y-reports/
   ```

3. Revert all staged changes (safety check):
   ```bash
   git restore --staged .
   git restore .
   ```

4. Install a11y-scout from distribution:
   ```bash
   npm install ../a11y-scanner/distribution/a11y-scout-*.tgz
   ```

5. Run repository scan:
   ```bash
   npx a11y-scout scan-repo
   ```
   - Verify command completes successfully
   - Check that reports are generated in `/Users/pradeep.ganesh/Documents/Work/Accessibility Checker/react-frontend/a11y-reports/latest`
   - Confirm findings are present for React/JSX files

6. Run auto-fixer:
   ```bash
   npx a11y-scout fix-repo
   ```
   - Verify command completes successfully
   - Check that files have been modified (use `git status`)
   - Confirm changes are staged for commit
   - Verify fixes are appropriate (review a sample of changes)

7. Clean up staged changes:
   ```bash
   git restore --staged .
   git restore .
   ```

### Phase 7: Angular Repository Testing

**Working directory:** `/Users/pradeep.ganesh/Documents/Work/Accessibility Checker/angular-frontend`

1. Uninstall existing a11y-scout:
   ```bash
   npm uninstall a11y-scout
   ```

2. Delete previous reports if present:
   ```bash
   rm -rf a11y-reports/
   ```

3. Revert all staged changes (safety check):
   ```bash
   git restore --staged .
   git restore .
   ```

4. Install a11y-scout from distribution:
   ```bash
   npm install ../a11y-scanner/distribution/a11y-scout-*.tgz
   ```

5. Run repository scan:
   ```bash
   npx a11y-scout scan-repo
   ```
   - Verify command completes successfully
   - Check that reports are generated in `/Users/pradeep.ganesh/Documents/Work/Accessibility Checker/angular-frontend/a11y-reports/latest`
   - Confirm findings are present for Angular component files

6. Run auto-fixer:
   ```bash
   npx a11y-scout fix-repo
   ```
   - Verify command completes successfully
   - Check that files have been modified (use `git status`)
   - Confirm changes are staged for commit
   - Verify fixes are appropriate (review a sample of changes)

7. Clean up staged changes:
   ```bash
   git restore --staged .
   git restore .
   ```

## Success Criteria

All phases must complete successfully:
- ✅ Distribution builds with 3 packages (core + playwright + webdriverio)
- ✅ Integration tests pass (smoke test already runs in Phase 2)
- ✅ CLI commands execute without errors
- ✅ Playwright integration (hyland-accessibility.spec.js) works with installed distribution packages
- ✅ Playwright integration (perceptive.spec.js) works and generates multi-page reports (requires VPN/internal network)
- ✅ Perceptive test reports include findings for both "Home" and "Capture and Indexing" pages
- ✅ Single-page and Playwright reports match (minimal differences only) - **Note:** Currently hyland-accessibility.spec.js scans innominds.com instead of hyland.com
- ✅ WebdriverIO integration (example.spec.ts) works with workspace packages
- ✅ React scan-repo and fix-repo both work correctly
- ✅ Angular scan-repo and fix-repo both work correctly
- ✅ All repositories cleaned up (unstaged changes reverted)

## Reporting

For each phase:
1. State what you're testing
2. Show command outputs for verification
3. Report success/failure immediately
4. If any phase fails, stop and report the failure details before proceeding

At the end, provide a summary table:

```
Phase                          Status    Notes
────────────────────────────────────────────────────────
Distribution Build             ✅/❌     
Integration Tests              ✅/❌     
CLI Multi-page Crawl           ✅/❌     
CLI Single-page AA             ✅/❌     
Playwright (hyland.spec.js)    ✅/❌     
Playwright (perceptive.spec)   ✅/❌     
Report Comparison              ✅/❌     
WebdriverIO (example.spec.ts)  ✅/❌     
React scan-repo                ✅/❌     
React fix-repo                 ✅/❌     
Angular scan-repo              ✅/❌     
Angular fix-repo               ✅/❌     
```

## Notes

- All test projects use the same distribution packages built in Phase 1
- WebdriverIO demo uses workspace packages (not distribution) since it's in the examples/ folder
- Report comparisons allow for metadata differences (timestamps, execution environment)
- Git cleanup ensures test projects remain in clean state
- Any command failure should be reported immediately with full error details

## Known Issues

1. **Playwright test URL mismatch:** `test-project/tests/hyland-accessibility.spec.js` scans `innominds.com/partners` instead of `hyland.com/en`, making the Phase 4 report comparison invalid. Update the test URL to match the CLI baseline.

2. **Perceptive test requires internal network:** `test-project/tests/perceptive.spec.js` accesses `project-titan.pc.k8s.hyland.io` which requires VPN or internal Hyland network access.
