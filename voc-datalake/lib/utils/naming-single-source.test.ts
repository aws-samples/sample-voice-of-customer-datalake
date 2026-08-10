/**
 * Physical names must have exactly ONE route: `this.uniqueName()` /
 * `this.uniqueDnsName()` on VocStack, which honour `deploymentPrefix`.
 *
 * This is a source-level guard rather than a behavioural one because the failure
 * it prevents is invisible in a passing synth. A resource whose name is built
 * from `${base}-${Aws.ACCOUNT_ID}-${Aws.REGION}` directly synthesizes cleanly,
 * matches the no-prefix baseline exactly, and only misbehaves on a PREFIXED
 * deployment — where it silently resolves to the same string in both copies, so
 * two deployments that believe they are isolated share one table, bucket or
 * function. The exhaustive mapping in lib/app-deployment-prefix.test.ts catches
 * that for the names it can see, but only for resources that a synth of the
 * committed context actually creates: a name behind a disabled plugin or an
 * unset feature flag would slip past it.
 *
 * A prefix-blind `uniqueName()` helper was exported from naming.ts until it was
 * removed for exactly this reason. This is the guard that keeps it from coming
 * back — as a re-export, as a local copy in a stack, or as a hand-rolled
 * template literal.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = join(__dirname, '..', '..');
const STACKS_DIR = join(PROJECT_ROOT, 'lib', 'stacks');

/** Every stack and construct file that could name a physical resource. */
const STACK_FILES = readdirSync(STACKS_DIR)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => join(STACKS_DIR, name))
  .sort();

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

function relative(file: string): string {
  return file.slice(PROJECT_ROOT.length + 1);
}

describe('the single source of physical names', () => {
  it('finds the stack files to check, so this cannot silently pass on a bad path', () => {
    // Without this, a moved directory turns every assertion below into a loop
    // over nothing — the same failure mode that made the zero-warnings guard
    // vacuous.
    expect(STACK_FILES.length).toBeGreaterThanOrEqual(5);
    expect(STACK_FILES.map(relative)).toContain('lib/stacks/core-stack.ts');
  });

  it('is not bypassed by a prefix-blind uniqueName() import', () => {
    // naming.ts deliberately exports no bare `uniqueName`. Re-adding one and
    // importing it would compile, synth clean, match the baseline, and quietly
    // share that resource between two deployments.
    for (const file of STACK_FILES) {
      const source = read(file);
      const importsNaming = /import\s*\{([^}]*)\}\s*from\s*'\.\.\/utils\/naming'/.exec(source);
      const imported = (importsNaming?.[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean);
      expect(imported, relative(file)).not.toContain('uniqueName');
      expect(imported, relative(file)).not.toContain('uniqueDnsName');
    }
  });

  it('is not bypassed by a hand-rolled ${Aws.ACCOUNT_ID}-${Aws.REGION} suffix', () => {
    // The shape the helper exists to own. `this.region`/`this.account` in an ARN
    // is fine and common — what must not recur is a NAME assembled from the
    // account/region pair outside the helper, because that is the exact string
    // the prefix has to interpose on.
    for (const file of STACK_FILES) {
      const source = read(file);
      const handRolled = source.match(/\$\{Aws\.ACCOUNT_ID\}-\$\{Aws\.REGION\}/g) ?? [];
      expect(handRolled, `${relative(file)} builds a name outside DeploymentNaming`).toEqual([]);
    }
  });

  it('routes every physical name through the prefix-aware helpers', () => {
    // At least one stack must actually use them — otherwise the two negative
    // assertions above would pass on a tree where naming had been ripped out
    // entirely.
    const users = STACK_FILES.filter((file) => /this\.unique(Dns)?Name\(/.test(read(file)));
    expect(users.map(relative).sort()).toEqual([
      'lib/stacks/api-stack.ts',
      'lib/stacks/core-stack.ts',
      'lib/stacks/ingestion-stack.ts',
      'lib/stacks/processing-stack-consolidated.ts',
      'lib/stacks/web-search-stack.ts',
    ]);
  });
});
