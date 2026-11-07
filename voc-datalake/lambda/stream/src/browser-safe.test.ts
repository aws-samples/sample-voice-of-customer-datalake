/**
 * The SPA imports some stream modules itself, through `@stream` (frontend/streamSource.ts), so they run in the
 * browser bundle. The `browser-safe` block of eslint.config.js lints exactly those modules and every stream file
 * they import (no Node built-in, no @aws-sdk / @smithy at runtime). This spec fails when the SPA starts
 * importing a stream module the block does not cover, when a covered module imports an uncovered stream file,
 * or when the block lists a file nothing in the browser reaches: add or drop it in BROWSER_SAFE_FILES.
 */
import { join, posix } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const RULE = '@typescript-eslint/no-restricted-imports';
const PACKAGE_ROOT = join(__dirname, '..');

/** Every SPA source file, as text (vitest reads them at transform time). */
const SPA_SOURCES = import.meta.glob<string>('../../../frontend/src/**/*.{ts,tsx}', { eager: true, query: '?raw', import: 'default' });
/** Every stream source file, as text, keyed `./<path under src>`. */
const STREAM_SOURCES = import.meta.glob<string>('./**/*.ts', { eager: true, query: '?raw', import: 'default' });

const STREAM_IMPORT = /['"]@stream\/([^'"]+)['"]/g;
const RELATIVE_IMPORT = /\bfrom\s+'(\.{1,2}\/[^']+)\.js'/g;

/** `src/<module>.ts` of each `@stream/<module>` the SPA names. */
function spaImports(): string[] {
  const modules = Object.values(SPA_SOURCES).flatMap((text) => [...text.matchAll(STREAM_IMPORT)].map((match) => match[1] ?? ''));
  return [...new Set(modules)].map((module) => `src/${module}.ts`);
}

function sourceOf(file: string): string {
  const text = STREAM_SOURCES[`./${file.slice('src/'.length)}`];
  if (text === undefined) throw new Error(`${file} is not a stream source file`);
  return text;
}

/** The stream files `file` imports by relative path, as `src/...ts`. */
function relativeImports(file: string): string[] {
  return [...sourceOf(file).matchAll(RELATIVE_IMPORT)].map((match) => posix.join(posix.dirname(file), `${match[1] ?? ''}.ts`));
}

/** `roots` and every stream file they reach through relative imports. */
function closure(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop() ?? '';
    if (!seen.has(file)) {
      seen.add(file);
      pending.push(...relativeImports(file));
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

const PRODUCTION_FILES = Object.keys(STREAM_SOURCES)
  .filter((key) => !key.endsWith('.test.ts'))
  .map((key) => `src/${key.slice('./'.length)}`);

async function browserSafeFiles(): Promise<string[]> {
  const eslint = new ESLint({ cwd: PACKAGE_ROOT });
  const covered = await Promise.all(PRODUCTION_FILES.map(async (file) => {
    const config: unknown = await eslint.calculateConfigForFile(join(PACKAGE_ROOT, file));
    return hasRule(config) ? [file] : [];
  }));
  return covered.flat().sort((a, b) => a.localeCompare(b));
}

function hasRule(config: unknown): boolean {
  if (typeof config !== 'object' || config === null || !('rules' in config)) return false;
  const rules: unknown = config.rules;
  return typeof rules === 'object' && rules !== null && RULE in rules;
}

describe('browser-safe stream modules', () => {
  it('finds the SPA’s @stream imports (positive control)', () => {
    expect(spaImports()).toContain('src/assistant/contract.ts');
  });

  it('the browser-safe block covers exactly what the SPA imports and what that imports', async () => {
    expect(await browserSafeFiles()).toStrictEqual(closure(spaImports()));
  }, 60_000);
});
