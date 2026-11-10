/**
 * knip's production run: the knip.jsonc of the directory knip runs from, with ignoreExportsUsedInFile
 * turned back on, so an export that its own file uses and a spec imports is a testing seam, not dead.
 * Usage (from the package directory): npx knip --config <path-to>/scripts/knip-production.mjs --production --strict
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

// The package's own typescript reads the JSONC (comments allowed).
const ts = createRequire(path.join(process.cwd(), 'package.json'))('typescript');
const file = path.join(process.cwd(), 'knip.jsonc');
const { config, error } = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
// A malformed knip.jsonc must fail the run: spreading `undefined` would silently analyse knip's defaults.
// TypeScript reports a non-object root ([], null, 1, "x") as a diagnostic too, and an empty file reads as {}.
if (error) {
  throw new Error(`knip-production: cannot read ${file}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
}

export default { ...config, ignoreExportsUsedInFile: true };
