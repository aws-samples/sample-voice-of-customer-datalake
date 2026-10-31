/**
 * scripts/build-layers.sh skips a layer whose build inputs did not change (H7).
 *
 * The script runs for real against a temp LAYERS_DIR, with CONTAINER_CMD pointed at a fake
 * container runtime that records each build and writes a python/ dir, so no Docker is needed.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { byCodeUnit } from './compare';
import { LAYER_BUILD_STAMP } from './python-layer-bundling';

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'build-layers.sh');

// `<cmd> run --rm --platform P -v <dir>:/var/task IMAGE sh -c ...`: log <dir>, create <dir>/python.
const FAKE_CONTAINER = `#!/bin/bash
while [ $# -gt 0 ]; do
  if [ "$1" = "-v" ]; then dir="\${2%%:*}"; fi
  shift
done
echo "$dir" >> "$FAKE_LOG"
mkdir -p "$dir/python" && touch "$dir/python/installed"
`;

let root: string;
let layers: string;
let log: string;
let fake: string;

function run(extraEnv: Record<string, string> = {}, args: string[] = []): string {
  return execFileSync('/bin/bash', [SCRIPT, ...args], {
    env: { ...process.env, LAYERS_DIR: layers, CONTAINER_CMD: fake, FAKE_LOG: log, FORCE_LAYER_BUILD: '', ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Layer names built since the last call (and the log reset). */
function builds(): string[] {
  if (!existsSync(log)) return [];
  const names = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((dir) => dir.split('/').pop() ?? '');
  rmSync(log);
  return names.sort(byCodeUnit);
}

/** Back-date a layer's build stamp by `days`. */
function ageStamp(name: string, days: number): void {
  const when = Date.now() / 1000 - days * 24 * 60 * 60;
  utimesSync(join(layers, name, LAYER_BUILD_STAMP), when, when);
}

function addLayer(name: string, requirements: string): void {
  mkdirSync(join(layers, name), { recursive: true });
  writeFileSync(join(layers, name, 'requirements.txt'), requirements);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'build-layers-'));
  layers = join(root, 'layers');
  log = join(root, 'builds.log');
  fake = join(root, 'fake-container');
  writeFileSync(fake, FAKE_CONTAINER);
  chmodSync(fake, 0o755);
  addLayer('alpha-deps', 'requests==2.32.0\n');
  addLayer('beta-deps', 'pydantic==2.11.0\n');
  mkdirSync(join(layers, 'no-requirements'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scripts/build-layers.sh skip-unchanged', () => {
  it('builds every layer with a requirements.txt once, then skips them all', () => {
    run();
    expect(builds()).toStrictEqual(['alpha-deps', 'beta-deps']);
    expect(existsSync(join(layers, 'alpha-deps', LAYER_BUILD_STAMP))).toBe(true);

    const second = run();
    expect(builds()).toStrictEqual([]);
    expect(second).toMatch(/alpha-deps layer unchanged \(build hash [0-9a-f]{12}\), skipped/);
  });

  it('rebuilds only the layer whose requirements changed', () => {
    run();
    builds();
    writeFileSync(join(layers, 'beta-deps', 'requirements.txt'), 'pydantic==2.12.0\n');
    run();
    expect(builds()).toStrictEqual(['beta-deps']);
  });

  it('counts any requirements*.txt of the layer', () => {
    run();
    builds();
    writeFileSync(join(layers, 'alpha-deps', 'requirements-extra.txt'), 'lxml==6.0.0\n');
    run();
    expect(builds()).toStrictEqual(['alpha-deps']);
  });

  it('rebuilds everything with FORCE_LAYER_BUILD=1 or --force', () => {
    run();
    builds();
    run({ FORCE_LAYER_BUILD: '1' });
    expect(builds()).toStrictEqual(['alpha-deps', 'beta-deps']);
    run({}, ['--force']);
    expect(builds()).toStrictEqual(['alpha-deps', 'beta-deps']);
  });

  it('rebuilds when the stamp is missing or corrupt, or the python/ output is gone', () => {
    run();
    builds();
    rmSync(join(layers, 'alpha-deps', LAYER_BUILD_STAMP));
    writeFileSync(join(layers, 'beta-deps', LAYER_BUILD_STAMP), 'not-a-hash\n');
    run();
    expect(builds()).toStrictEqual(['alpha-deps', 'beta-deps']);

    rmSync(join(layers, 'alpha-deps', 'python'), { recursive: true });
    run();
    expect(builds()).toStrictEqual(['alpha-deps']);
  });

  it('rebuilds a layer whose stamp is older than 7 days (unpinned deps are re-resolved)', () => {
    run();
    builds();
    ageStamp('alpha-deps', 8);
    ageStamp('beta-deps', 6);
    expect(run()).toMatch(/alpha-deps layer stamp is older than 7 days, rebuilding/);
    expect(builds()).toStrictEqual(['alpha-deps']);
    run();
    expect(builds()).toStrictEqual([]); // the rebuild wrote a fresh stamp
  });

  it('takes the stamp age limit from LAYER_STAMP_MAX_AGE_DAYS, a whole number of days', () => {
    run();
    builds();
    ageStamp('beta-deps', 2);
    run({ LAYER_STAMP_MAX_AGE_DAYS: '1' });
    expect(builds()).toStrictEqual(['beta-deps']);
    expect(() => run({ LAYER_STAMP_MAX_AGE_DAYS: 'week' })).toThrow(/whole number of days/);
  });

  it('leaves no stamp when the build fails, so the next run retries', () => {
    writeFileSync(fake, '#!/bin/bash\nexit 1\n');
    expect(() => run()).toThrow(/Command failed/);
    expect(existsSync(join(layers, 'alpha-deps', LAYER_BUILD_STAMP))).toBe(false);
  });

  it('refuses an unknown argument instead of ignoring it', () => {
    expect(() => run({}, ['--frce'])).toThrow(/Unknown argument: --frce/);
    expect(builds()).toStrictEqual([]);
  });
});
