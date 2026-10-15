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

/**
 * Every `.ts` file under `dir`, at any depth.
 *
 * Hand-rolled rather than `readdirSync(dir, { recursive: true })` because
 * package.json declares `"node": ">=18.0.0"`, and on Node 18 that option is
 * simply IGNORED — no error, just a flat listing. So the sturdier-looking
 * one-liner fails open on a supported runtime, which is the same failure
 * direction as the guard it is here to power. `Dirent.parentPath` needs 20.12
 * for the same reason. Five lines, no version floor.
 */
function typeScriptFilesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return typeScriptFilesIn(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * Every stack and construct file that could name a physical resource.
 *
 * Recursive: a flat listing would drop a stack moved into a subdirectory out of
 * this list silently, leaving the assertions below looping over the remaining
 * files and still passing.
 */
const STACK_FILES = typeScriptFilesIn(STACKS_DIR).sort();

/**
 * A name assembled from the account/region pair OUTSIDE the helper.
 *
 * Both spellings, because every stack file here imports CDK as `import * as cdk`
 * and writes `cdk.Aws.ACCOUNT_ID` (api-stack.ts, ingestion-stack.ts) — a guard
 * matching only the bare `Aws.` form would catch the one spelling this repo
 * never uses. `this.account`/`this.region` is the third way to write it, and on
 * a Stack subclass it is the most convenient one.
 *
 * Deliberately NOT `/g`: these are used with `.test()`, and a global regex
 * carries `lastIndex` from one call to the next, so the second file (or the
 * second assertion) would be tested from an offset instead of the start.
 */
const HAND_ROLLED_NAME_PATTERNS = [
  /\$\{(?:cdk\.)?Aws\.ACCOUNT_ID\}-\$\{(?:cdk\.)?Aws\.REGION\}/,
  /\$\{this\.account\}-\$\{this\.region\}/,
];

/**
 * A named import from the naming module, in either quote style. Single quotes
 * are this repo's convention, but a double-quoted import would sail past a
 * pattern that only knows about `'`.
 */
const NAMING_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/utils\/naming['"]/;

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
      const imported = (NAMING_IMPORT.exec(read(file))?.[1] ?? '')
        .split(',').map((name) => name.trim()).filter(Boolean);
      expect(imported, relative(file)).not.toContain('uniqueName');
      expect(imported, relative(file)).not.toContain('uniqueDnsName');
    }
  });

  it('is not bypassed by a hand-rolled account/region suffix, in any of its three spellings', () => {
    // The shape the helper exists to own. `this.region`/`this.account` in an ARN
    // is fine and common — what must not recur is a NAME assembled from the
    // account/region pair outside the helper, because that is the exact string
    // the prefix has to interpose on.
    for (const file of STACK_FILES) {
      const source = read(file);
      for (const pattern of HAND_ROLLED_NAME_PATTERNS) {
        expect(
          pattern.test(source),
          `${relative(file)} builds a name outside DeploymentNaming (${pattern.source})`,
        ).toBe(false);
      }
    }
  });

  it('descends into subdirectories, so a stack moved into one cannot slip out', () => {
    // Aimed at lib/, not lib/stacks/, deliberately. lib/stacks/ is flat, so a
    // non-recursive walk passes every other assertion in this file — the reason
    // an earlier version of this guard could lose its recursion without a single
    // test going red. lib/ has three subdirectories, so descent is observable.
    const found = typeScriptFilesIn(join(PROJECT_ROOT, 'lib')).map(relative);
    expect(found).toContain('lib/plugin-loader.ts'); // top level
    expect(found).toContain('lib/stacks/core-stack.ts'); // one level down
    expect(found).toContain('lib/utils/naming.ts'); // a sibling subdirectory
    expect(found).not.toContain('lib/utils/naming.test.ts'); // and still skips tests
  });

  it('matches each shape it claims to catch', () => {
    // The guard on the guard. Every assertion above is a pattern asserted to
    // find NOTHING, which is exactly what a pattern that matches nothing at all
    // also reports — and that is not hypothetical here: the original
    // `${Aws.ACCOUNT_ID}-${Aws.REGION}` pattern was the one spelling no file in
    // this repo uses, while `cdk.Aws.ACCOUNT_ID` (the spelling two stacks DO
    // write) went straight through.
    const [awsPseudoParams, stackProperties] = HAND_ROLLED_NAME_PATTERNS;
    expect('`${Aws.ACCOUNT_ID}-${Aws.REGION}`').toMatch(awsPseudoParams);
    expect('`${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`').toMatch(awsPseudoParams);
    expect('`${this.account}-${this.region}`').toMatch(stackProperties);
    // ...and does not fire on an ARN, which legitimately interpolates both.
    expect('`arn:aws:lambda:${this.region}:${this.account}:function:x`').not.toMatch(stackProperties);

    expect("import { DeploymentNaming } from '../utils/naming';").toMatch(NAMING_IMPORT);
    expect('import { DeploymentNaming } from "../utils/naming";').toMatch(NAMING_IMPORT);
  });

  it('routes every physical name through the prefix-aware helpers', () => {
    // At least one stack must actually use them — otherwise the two negative
    // assertions above would pass on a tree where naming had been ripped out
    // entirely.
    //
    // A superset assertion, not an equality: a SIXTH stack that names a resource
    // is a normal addition and must not fail a test whose name reads as "naming
    // was ripped out", while a stack DROPPING the helpers still fails here.
    const users = STACK_FILES.filter((file) => /this\.unique(Dns)?Name\(/.test(read(file))).map(relative);
    expect(users).toEqual(expect.arrayContaining([
      'lib/stacks/api-stack.ts',
      'lib/stacks/core-stack.ts',
      'lib/stacks/ingestion-stack.ts',
      'lib/stacks/processing-stack-consolidated.ts',
      'lib/stacks/web-search-stack.ts',
    ]));
  });
});
