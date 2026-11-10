/**
 * `generateIntegrityHashes` against a real plugin folder on disk.
 *
 * The function used to guard each read with `existsSync` (a check-then-read gap
 * CodeQL reports as a file-system race); it now reads once and treats ENOENT as
 * absence. These pin the behaviour that refactor had to keep: a missing manifest
 * is the same error, a component the plugin does not ship gets NO integrity
 * entry (an empty-directory hash would wrongly look like a verified component),
 * and a shipped component gets a sha256 over its .py files only.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateIntegrityHashes } from './plugin-loader';

const PLUGIN = 'demo_plugin';
const SHA256_HEX = /^sha256-[0-9a-f]{64}$/;

function readIntegrity(pluginsDir: string): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(join(pluginsDir, PLUGIN, 'manifest.json'), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('integrity' in parsed)) return {};
  const { integrity } = parsed;
  return typeof integrity === 'object' && integrity !== null ? { ...integrity } : {};
}

describe('generateIntegrityHashes', () => {
  const pluginsDir = { current: '' };

  beforeEach(() => {
    pluginsDir.current = mkdtempSync(join(tmpdir(), 'voc-integrity-'));
    mkdirSync(join(pluginsDir.current, PLUGIN));
    writeFileSync(join(pluginsDir.current, PLUGIN, 'manifest.json'), JSON.stringify({ id: PLUGIN }));
  });

  afterEach(() => {
    rmSync(pluginsDir.current, { recursive: true, force: true });
  });

  it('raises the same "Manifest not found" error for a plugin folder without one', () => {
    rmSync(join(pluginsDir.current, PLUGIN, 'manifest.json'));
    expect(() => generateIntegrityHashes(PLUGIN, pluginsDir.current)).toThrow(/^Manifest not found: /);
  });

  it('writes no integrity entry for a component the plugin does not ship', () => {
    mkdirSync(join(pluginsDir.current, PLUGIN, 'ingestor'));
    writeFileSync(join(pluginsDir.current, PLUGIN, 'ingestor', 'handler.py'), 'print(1)\n');

    generateIntegrityHashes(PLUGIN, pluginsDir.current);

    const integrity = readIntegrity(pluginsDir.current);
    expect(Object.keys(integrity)).toStrictEqual(['ingestor']);
    expect(integrity.ingestor).toMatch(SHA256_HEX);
  });

  it('hashes both components when both are present, over their .py files only', () => {
    for (const component of ['ingestor', 'webhook']) {
      mkdirSync(join(pluginsDir.current, PLUGIN, component));
      writeFileSync(join(pluginsDir.current, PLUGIN, component, 'handler.py'), `# ${component}\n`);
    }
    writeFileSync(join(pluginsDir.current, PLUGIN, 'webhook', 'notes.md'), 'ignored by the hash\n');
    generateIntegrityHashes(PLUGIN, pluginsDir.current);
    const first = readIntegrity(pluginsDir.current);

    // A non-.py file changing must not move the hash; a .py file changing must.
    writeFileSync(join(pluginsDir.current, PLUGIN, 'webhook', 'notes.md'), 'edited\n');
    generateIntegrityHashes(PLUGIN, pluginsDir.current);
    expect(readIntegrity(pluginsDir.current)).toStrictEqual(first);

    writeFileSync(join(pluginsDir.current, PLUGIN, 'webhook', 'handler.py'), '# changed\n');
    generateIntegrityHashes(PLUGIN, pluginsDir.current);
    const changed = readIntegrity(pluginsDir.current);
    expect(changed.ingestor).toBe(first.ingestor);
    expect(changed.webhook).not.toBe(first.webhook);
  });

  it('treats a component path that is a file, not a directory, as absent', () => {
    writeFileSync(join(pluginsDir.current, PLUGIN, 'webhook'), 'not a directory');
    generateIntegrityHashes(PLUGIN, pluginsDir.current);
    expect(readIntegrity(pluginsDir.current)).toStrictEqual({});
  });
});
