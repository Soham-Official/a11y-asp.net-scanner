/**
 * Single source of truth for the a11y-scout package version.
 *
 * Read at runtime from the package's own package.json so the version is never
 * duplicated in code — bumping package.json is all it takes. Resolves correctly
 * under tsx (src/), the compiled build (dist/), and published tarballs (npm
 * always ships package.json).
 *
 * Used for the CLI `--version` flag, the `User-Agent` header sent to HAIP,
 * and the `version` field stamped into scan reports.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const VERSION: string = pkg.version;
