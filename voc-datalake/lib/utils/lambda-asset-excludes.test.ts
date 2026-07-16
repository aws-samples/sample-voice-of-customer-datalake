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

/**
 * The full `fromAsset(...)` options argument: from the first `{` after the
 * call start to its balanced closing brace. Exact rather than a fixed-width
 * window, so refactors inside the options object can't slide the assertion
 * off target. The only braces inside these call sites' string literals are
 * balanced `${...}` interpolations, which cancel out in the depth count; an
 * unbalanced brace would end the slice early and fail the containment
 * assertions loudly.
 */
function optionsObject(source: string, callStart: number): string {
  const open = source.indexOf('{', callStart);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function forEachCallSite(needle: string, visit: (file: string, options: string) => void): void {
  for (const { file, source } of stackSources()) {
    let searchFrom = 0;
    for (;;) {
      const at = source.indexOf(needle, searchFrom);
      if (at === -1) break;
      visit(file, optionsObject(source, at + needle.length));
      searchFrom = at + 1;
    }
  }
}

describe('PY_LAMBDA_ASSET_EXCLUDES', () => {
  it('keeps the load-bearing noise patterns', () => {
    for (const pattern of ['layers/**', 'stream/**', 'custom_resources/**', '**/test/**', '**/test_*.py', '**/conftest.py', '**/__pycache__']) {
      expect(PY_LAMBDA_ASSET_EXCLUDES).toContain(pattern);
    }
  });
});

describe('asset staging sites', () => {
  it("every fromAsset('lambda') spreads the shared excludes", () => {
    forEachCallSite("fromAsset('lambda'", (file, options) => {
      expect(options, `${file} stages lambda/ without PY_LAMBDA_ASSET_EXCLUDES`).toContain('...PY_LAMBDA_ASSET_EXCLUDES');
    });
  });

  it("every root-based fromAsset('.') excludes the layer build output and the stream Lambda", () => {
    forEachCallSite("fromAsset('.'", (file, options) => {
      expect(options, `${file} stages the project root without excluding lambda/layers`).toContain('lambda/layers/**');
      expect(options, `${file} stages the project root without excluding lambda/stream`).toContain('lambda/stream/**');
    });
  });
});
