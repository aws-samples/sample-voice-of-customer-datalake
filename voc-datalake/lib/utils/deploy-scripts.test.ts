/**
 * Guards package.json `deploy:*` scripts against stack renames.
 *
 * The stack consolidation (VocStorage + VocAuth + VocFrontendInfra -> VocCoreStack,
 * VocAnalytics + VocFrontend -> VocApiStack) left FIVE deploy scripts pointing at
 * stacks that no longer existed. Nothing caught it because a wrong stack name is
 * only discovered when someone runs the script and reads a confusing CDK error.
 *
 * The same rot independently broke frontend/scripts/update-env.sh, so this is a
 * recurring class rather than a one-off — hence a permanent check.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = join(__dirname, '..', '..');
const UPDATE_ENV_SH = join(PROJECT_ROOT, 'frontend', 'scripts', 'update-env.sh');
const RUNTIME_CONFIG_TS = join(PROJECT_ROOT, 'frontend', 'src', 'runtimeConfig.ts');

/** Stack ids the CDK app actually constructs: `new XStack(app, 'Id', ...)`. */
function declaredStackIds(): Set<string> {
  const source = readFileSync(join(PROJECT_ROOT, 'bin', 'voc-datalake.ts'), 'utf8');
  const ids = [...source.matchAll(/new\s+\w+\s*\(\s*app\s*,\s*'([^']+)'/g)].map((m) => m[1]);
  return new Set(ids);
}

/** `deploy:*` scripts whose command is a bare `cdk deploy <SingleStack>`. */
function stackTargetedScripts(): Array<{ name: string; stack: string }> {
  const pkg = JSON.parse(
    readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };
  const out: Array<{ name: string; stack: string }> = [];
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (!name.startsWith('deploy')) continue;
    const match = /^(?:npx\s+)?cdk\s+deploy\s+(\w+Stack)\s*$/.exec(command.trim());
    if (match) out.push({ name, stack: match[1] });
  }
  return out;
}

describe('package.json deploy scripts', () => {
  it('names only stacks the CDK app declares', () => {
    const declared = declaredStackIds();
    const dead = stackTargetedScripts().filter((s) => !declared.has(s.stack));
    expect(
      dead,
      `deploy script(s) target non-existent stacks: ${dead
        .map((d) => `${d.name} -> ${d.stack}`)
        .join(', ')}. Known stacks: ${[...declared].sort().join(', ')}`,
    ).toEqual([]);
  });

  it('finds stacks to check, so the guard cannot silently pass on a parse failure', () => {
    // If either regex stops matching (file reformatted, syntax changed), both
    // sets go empty and the assertion above would trivially hold.
    expect(declaredStackIds().size).toBeGreaterThan(0);
    expect(stackTargetedScripts().length).toBeGreaterThan(0);
  });
});

describe('frontend/scripts/update-env.sh', () => {
  const source = () => readFileSync(UPDATE_ENV_SH, 'utf8');

  it('defaults its stack names to stacks the CDK app declares', () => {
    // Same rot class as the deploy scripts above, and it bit harder here: the
    // script queried two stacks the merge had removed, so it wrote an empty
    // env file and local dev looked broken for reasons nothing pointed at.
    const declared = declaredStackIds();
    const defaults = [...source().matchAll(/^\w*STACK="\$\{\w+:-(\w+Stack)\}"/gm)].map((m) => m[1]);
    expect(defaults.length, 'expected STACK="${OVERRIDE:-Default}" declarations').toBeGreaterThan(0);
    const dead = defaults.filter((stack) => !declared.has(stack));
    expect(
      dead,
      `update-env.sh defaults to non-existent stack(s): ${dead.join(', ')}. ` +
        `Known stacks: ${[...declared].sort().join(', ')}`,
    ).toEqual([]);
  });

  it('writes every VITE_ var that runtimeConfig.ts requires', () => {
    // RuntimeConfigSchema rejects an empty identityPoolId, and getEnvConfig's
    // failure branch then BLANKS all four cognito values — so omitting one var
    // makes the login screen claim "Cognito not configured" even when the user
    // pool and client id resolved fine. Any var read there must be written here.
    const required = [...readFileSync(RUNTIME_CONFIG_TS, 'utf8')
      .matchAll(/getEnvString\('(VITE_[A-Z_]+)'/g)]
      .map((m) => m[1])
      // Local-only escape hatches have no CloudFormation output to read from.
      .filter((name) => name !== 'VITE_ENABLE_WEB_SEARCH');
    expect(required.length, 'expected runtimeConfig.ts to read VITE_ vars').toBeGreaterThan(0);

    const written = new Set(
      [...source().matchAll(/^(VITE_[A-Z_]+)=/gm)].map((m) => m[1]),
    );
    const missing = required.filter((name) => !written.has(name));
    expect(missing, `update-env.sh never writes: ${missing.join(', ')}`).toEqual([]);
  });

  it('writes .env, which the vite dev server actually reads', () => {
    // .env.production is ignored by `vite dev`, so the previous version of this
    // script could not fix local development no matter what it put in the file.
    expect(source()).toMatch(/^cat > \.env <</m);
    expect(source()).not.toMatch(/^cat > \.env\.production <</m);
  });
});
