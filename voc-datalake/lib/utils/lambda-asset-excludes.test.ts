/**
 * Guard for the Lambda asset-staging excludes (issue #194 follow-up).
 *
 * Staged-but-never-copied files still feed CDK asset hashes: before these
 * excludes, local layer build output, lambda/stream/node_modules (141MB),
 * tests and caches were hashed into every Python function asset, so every
 * deploy rolled ~25 functions with byte-identical code. These tests fail if
 * a staging site stops excluding the noise.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PY_LAMBDA_ASSET_EXCLUDES } from './lambda-asset-excludes';

const stacksDir = path.join(process.cwd(), 'lib', 'stacks');

function stackSources(): Array<{ file: string; source: string }> {
  return fs.readdirSync(stacksDir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ file, source: fs.readFileSync(path.join(stacksDir, file), 'utf8') }));
}

describe('PY_LAMBDA_ASSET_EXCLUDES', () => {
  it('keeps the load-bearing noise patterns', () => {
    for (const pattern of ['layers/**', 'stream/**', '**/test/**', '**/conftest.py', '**/__pycache__']) {
      expect(PY_LAMBDA_ASSET_EXCLUDES).toContain(pattern);
    }
  });
});

describe('asset staging sites', () => {
  it("every fromAsset('lambda') spreads the shared excludes", () => {
    for (const { file, source } of stackSources()) {
      let searchFrom = 0;
      for (;;) {
        const at = source.indexOf("fromAsset('lambda'", searchFrom);
        if (at === -1) break;
        // The exclude must appear within the option object that follows.
        const window = source.slice(at, at + 400);
        expect(window, `${file} stages lambda/ without PY_LAMBDA_ASSET_EXCLUDES`).toContain('...PY_LAMBDA_ASSET_EXCLUDES');
        searchFrom = at + 1;
      }
    }
  });

  it("every root-based fromAsset('.') excludes the layer build output and the stream Lambda", () => {
    for (const { file, source } of stackSources()) {
      let searchFrom = 0;
      for (;;) {
        const at = source.indexOf("fromAsset('.'", searchFrom);
        if (at === -1) break;
        const window = source.slice(at, at + 900);
        expect(window, `${file} stages the project root without excluding lambda/layers`).toContain('lambda/layers/**');
        expect(window, `${file} stages the project root without excluding lambda/stream`).toContain('lambda/stream/**');
        searchFrom = at + 1;
      }
    }
  });
});
