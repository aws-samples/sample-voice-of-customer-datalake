/**
 * scripts/knip-production.mjs (repo root) reads the knip.jsonc of the directory knip runs from. It
 * runs in a child process here because it reads process.cwd() at import time. The scratch package
 * sits inside this one so the script's createRequire resolves this package's typescript.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT_URL = pathToFileURL(path.resolve(__dirname, '../../scripts/knip-production.mjs')).href;

function loadConfigIn(cwd: string): string {
  return execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(SCRIPT_URL)}); process.stdout.write(JSON.stringify(m.default));`],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(__dirname, '.knip-production-'));
  writeFileSync(path.join(dir, 'package.json'), '{}');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('knip-production.mjs', () => {
  it('returns the package knip.jsonc (comments allowed) with ignoreExportsUsedInFile turned on', () => {
    writeFileSync(path.join(dir, 'knip.jsonc'), '{\n  // a comment\n  "entry": ["src/a.ts"],\n  "ignoreExportsUsedInFile": false\n}\n');

    expect(JSON.parse(loadConfigIn(dir))).toStrictEqual({ entry: ['src/a.ts'], ignoreExportsUsedInFile: true });
  });

  it('fails instead of analysing knip defaults when knip.jsonc is malformed', () => {
    writeFileSync(path.join(dir, 'knip.jsonc'), '{ "entry": [ \n');

    expect(() => loadConfigIn(dir)).toThrow(/knip-production: cannot read .*knip\.jsonc/);
  });

  it('fails when knip.jsonc is valid JSON but not an object', () => {
    writeFileSync(path.join(dir, 'knip.jsonc'), '[]');

    expect(() => loadConfigIn(dir)).toThrow(/knip-production: cannot read .*must be an object/);
  });
});
