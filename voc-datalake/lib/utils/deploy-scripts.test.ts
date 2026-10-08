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
import { z } from 'zod';
import { byCodeUnit } from './compare';
import { itemAt } from '../test-support/guards';

const PROJECT_ROOT = join(__dirname, '..', '..');
const UPDATE_ENV_SH = join(PROJECT_ROOT, 'frontend', 'scripts', 'update-env.sh');
const DEPLOY_SH = join(PROJECT_ROOT, 'frontend', 'scripts', 'deploy.sh');
const RUNTIME_CONFIG_TS = join(PROJECT_ROOT, 'frontend', 'src', 'runtimeConfig.ts');
const REFRESH_API_STAGE_SH = join(PROJECT_ROOT, 'scripts', 'refresh-api-stage.sh');
const CDK_DEPLOY_SH = join(PROJECT_ROOT, 'scripts', 'cdk-deploy.sh');

/**
 * Stack ids the CDK app actually constructs. Two accepted shapes:
 *
 *   new XStack(app, 'Id', ...)           — a bare literal
 *   new XStack(app, stackId('Id'), ...)  — namespaced by deploymentPrefix
 *
 * The second exists because a deployment prefix has to reach the stack id too:
 * without it, a second deploy into the same account and region UPDATES the
 * first deployment's stacks instead of creating new ones. The BASE id is what
 * this guard cares about — that is what `cdk deploy <Stack>` and update-env.sh
 * name for the default (unprefixed) deployment, and a prefixed deployment
 * passes `-c deploymentPrefix=...` to both.
 */
function declaredStackIds(): Set<string> {
  const source = readFileSync(join(PROJECT_ROOT, 'bin', 'voc-datalake.ts'), 'utf8');
  const ids = [
    ...source.matchAll(/new\s+\w+\s*\(\s*app\s*,\s*(?:stackId\(\s*)?'([^']+)'/g),
  ].map((m) => itemAt(m, 1));
  return new Set(ids);
}

/**
 * A stack name written into a shell script as a literal rather than a variable.
 *
 * `[\w-]` rather than `\w`, and either quote style, because the likeliest wrong
 * edit here is not `VocCoreStack` — it is pasting the OTHER deployment's
 * `b-VocCoreStack`, which a `\w+` pattern reads as no match at all.
 *
 * Declared WITHOUT `/g`, with the global copy made at the `matchAll` call site:
 * `expect().toMatch()` runs `regex.test()` under the hood, and `test()` on a
 * global regex advances `lastIndex`, so a shared `/g` pattern would examine the
 * second and subsequent strings from an offset — quietly turning the self-test
 * below into nonsense.
 */
const LITERAL_STACK_NAME = /--stack-name\s+['"]?([\w-]*Stack)\b/;

/** The one part of package.json this suite reads. */
const PackageScriptsSchema = z.object({ scripts: z.record(z.string(), z.string()).optional() });

/** `deploy:*` scripts whose command is a bare `cdk deploy <SingleStack>`. */
function stackTargetedScripts(): Array<{ name: string; stack: string }> {
  const pkg = PackageScriptsSchema.parse(
    JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')),
  );
  const out: Array<{ name: string; stack: string }> = [];
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (!name.startsWith('deploy')) continue;
    const match = /^(?:(?:npx\s+)?cdk\s+deploy|bash\s+scripts\/cdk-deploy\.sh)\s+(\w+Stack)\s*$/.exec(command.trim());
    if (match) out.push({ name, stack: itemAt(match, 1) });
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
        .join(', ')}. Known stacks: ${[...declared].sort(byCodeUnit).join(', ')}`,
    ).toStrictEqual([]);
  });

  it('finds stacks to check, so the guard cannot silently pass on a parse failure', () => {
    // If either regex stops matching (file reformatted, syntax changed), both
    // sets go empty and the assertion above would trivially hold.
    expect(declaredStackIds().size).toBeGreaterThan(0);
    expect(stackTargetedScripts().length).toBeGreaterThan(0);
  });
});

// Both shell scripts that resolve CloudFormation outputs, held to the same two
// rules. deploy.sh is here because it had neither: it queried VocCoreStack and
// VocApiStack as literals, so `npm run deploy:frontend` for a deployment created
// with `-c deploymentPrefix=<p>` resolved the UNPREFIXED deployment's bucket and
// CloudFront distribution and synced this build over that site — silently,
// because every output resolved successfully.
describe.each([
  ['frontend/scripts/update-env.sh', UPDATE_ENV_SH],
  ['frontend/scripts/deploy.sh', DEPLOY_SH],
  ['scripts/refresh-api-stage.sh', REFRESH_API_STAGE_SH],
])('%s', (label, path) => {
  const source = () => readFileSync(path, 'utf8');

  it('defaults its stack names to stacks the CDK app declares', () => {
    // Same rot class as the deploy scripts above, and it bit harder in
    // update-env.sh: the script queried two stacks the merge had removed, so it
    // wrote an empty env file and local dev looked broken for reasons nothing
    // pointed at.
    const declared = declaredStackIds();
    const defaults = [...source().matchAll(/^\w*STACK="\$\{\w+:-(\w+Stack)\}"/gm)].map((m) => itemAt(m, 1));
    expect(defaults.length, 'expected STACK="${OVERRIDE:-Default}" declarations').toBeGreaterThan(0);
    const dead = defaults.filter((stack) => !declared.has(stack));
    expect(
      dead,
      `${label} defaults to non-existent stack(s): ${dead.join(', ')}. ` +
        `Known stacks: ${[...declared].sort(byCodeUnit).join(', ')}`,
    ).toStrictEqual([]);
  });

  it('names no stack literally, so a prefixed deployment can redirect it', () => {
    // The complement of the case above, and the one that catches the real
    // defect: the hazard is not a WRONG default, it is a hardcoded name with no
    // seam at all. `bin/voc-datalake.ts` reads the prefix from CDK context,
    // which a shell script cannot see, so an environment variable is the only
    // way to point these at the right deployment — and a literal here silently
    // points them at the wrong one.
    const literals = [...source().matchAll(new RegExp(LITERAL_STACK_NAME, 'g'))].map((m) => m[1]);
    expect(
      literals,
      `${label} hardcodes stack name(s): ${literals.join(', ')}. Use "$CORE_STACK"/"$API_STACK".`,
    ).toStrictEqual([]);
    // ...and it really does query CloudFormation, so the assertion above cannot
    // pass merely because the script stopped resolving stacks altogether. This
    // also pins that the variable is QUOTED — an unquoted $CORE_STACK would word-
    // split, which is a different bug with the same symptom (wrong stack).
    expect(source(), `${label} no longer queries CloudFormation`).toMatch(/--stack-name\s+"\$/);
  });
});

describe('the literal-stack-name pattern', () => {
  it('catches the shapes a prefixed-deployment mistake actually takes', () => {
    // Every use of this pattern asserts it finds NOTHING, which is what a pattern
    // that matches nothing at all also reports. Its first version was narrower
    // than the mistake: `\w` excludes `-`, so the most likely wrong edit of all —
    // pasting the OTHER deployment's prefixed stack name — went uncaught, and so
    // did a single-quoted literal.
    for (const hardcoded of [
      '  --stack-name VocCoreStack \\',
      '  --stack-name "VocApiStack" \\',
      "  --stack-name 'VocCoreStack' \\",
      '  --stack-name b-VocCoreStack \\', // the other deployment's stack
    ]) {
      expect(hardcoded, hardcoded).toMatch(LITERAL_STACK_NAME);
    }

    // ...and does not fire on the overridable forms both scripts use.
    for (const parameterised of ['  --stack-name "$CORE_STACK" \\', '  --stack-name "$1" \\']) {
      expect(parameterised, parameterised).not.toMatch(LITERAL_STACK_NAME);
    }
  });
});

describe('frontend/scripts/update-env.sh', () => {
  const source = () => readFileSync(UPDATE_ENV_SH, 'utf8');

  it('writes every VITE_ var that runtimeConfig.ts requires', () => {
    // RuntimeConfigSchema rejects an empty identityPoolId, and getEnvConfig's
    // failure branch then BLANKS all four cognito values — so omitting one var
    // makes the login screen claim "Cognito not configured" even when the user
    // pool and client id resolved fine. Any var read there must be written here.
    const runtimeConfig = readFileSync(RUNTIME_CONFIG_TS, 'utf8');
    // Two patterns, deliberately: today every var goes through the getEnvString
    // helper, but a future direct `import.meta.env.VITE_X` read would otherwise
    // be silently exempt from this guard — the check would still pass while the
    // var went unwritten, which is the exact failure it exists to prevent.
    const required = [
      ...[...runtimeConfig.matchAll(/getEnvString\('(VITE_[A-Z_]+)'/g)].map((m) => m[1]),
      ...[...runtimeConfig.matchAll(/import\.meta\.env\.(VITE_[A-Z_]+)/g)].map((m) => m[1]),
    ]
      // Local-only escape hatches have no CloudFormation output to read from.
      .filter((name) => name !== 'VITE_ENABLE_WEB_SEARCH');
    expect(required.length, 'expected runtimeConfig.ts to read VITE_ vars').toBeGreaterThan(0);

    const written = new Set(
      [...source().matchAll(/^(VITE_[A-Z_]+)=/gm)].map((m) => m[1]),
    );
    const missing = required.filter((name) => !written.has(name));
    expect(missing, `update-env.sh never writes: ${missing.join(', ')}`).toStrictEqual([]);
  });

  it('writes .env, which the vite dev server actually reads', () => {
    // .env.production is ignored by `vite dev`, so the previous version of this
    // script could not fix local development no matter what it put in the file.
    expect(source()).toMatch(/^cat > \.env <</m);
    expect(source()).not.toMatch(/^cat > \.env\.production <</m);
  });
});

/** Every `deploy*` script of the repo root and voc-datalake package.json files. */
function allDeployScripts(): Array<{ file: string; name: string; command: string }> {
  return [join(PROJECT_ROOT, '..', 'package.json'), join(PROJECT_ROOT, 'package.json')].flatMap((file) => {
    const pkg = PackageScriptsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    return Object.entries(pkg.scripts ?? {})
      .filter(([name]) => name.startsWith('deploy'))
      .map(([name, command]) => ({ file, name, command }));
  });
}

// 3.00.00 R1: a removed route stayed live on the stage, because CloudFormation
// snapshots the new Deployment BEFORE its cleanup phase deletes the removed
// methods (scripts/refresh-api-stage.sh explains). The fix is a stage refresh
// after the deploy, so every deploy command that can update the API must run it.
describe('API stage refresh after deploy (R1)', () => {
  it('every deploy script that can update VocApiStack goes through scripts/cdk-deploy.sh', () => {
    const scripts = allDeployScripts();
    const updatesApi = scripts.filter(({ command }) => /cdk(?:-deploy\.sh|\s+deploy|\s+--\s+deploy)/.test(command)
      && (/--all\b/.test(command) || /VocApiStack/.test(command)));
    expect(updatesApi.map((s) => s.name), 'expected deploy:infra, deploy and deploy:api').toStrictEqual(
      expect.arrayContaining(['deploy:infra', 'deploy', 'deploy:api']),
    );
    const bypassing = updatesApi.filter(({ command }) => !command.includes('scripts/cdk-deploy.sh'));
    expect(bypassing.map((s) => `${s.name}: ${s.command}`)).toStrictEqual([]);
  });

  it('cdk-deploy.sh refreshes the stage only after cdk deploy succeeded', () => {
    const source = readFileSync(CDK_DEPLOY_SH, 'utf8');
    expect(source).toMatch(/^set -euo pipefail$/m);
    const deployAt = source.indexOf('npx cdk deploy "$@"');
    const refreshAt = source.indexOf('bash scripts/refresh-api-stage.sh');
    expect(deployAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(deployAt);
  });

  it('refresh-api-stage.sh creates a fresh deployment OF THE STAGE and nothing else', () => {
    const source = readFileSync(REFRESH_API_STAGE_SH, 'utf8');
    expect(source).toMatch(/^set -euo pipefail$/m);
    expect(source).toMatch(/aws apigateway create-deployment\s*\\\n\s*--rest-api-id "\$API_ID"\s*\\\n\s*--stage-name "\$STAGE"/);
    // Read-only apart from that one call: no other mutating AWS verb.
    // Every `aws <service> <verb>` the script runs (single spaces, as written there).
    const verbs = [...source.matchAll(/\baws ([a-z0-9-]+) ([a-z0-9-]+)/g)].map((m) => itemAt(m, 2));
    expect([...verbs].sort(byCodeUnit)).toStrictEqual(['create-deployment', 'describe-stacks']);
  });

  it('reads the outputs the API stack actually declares', () => {
    const stack = readFileSync(join(PROJECT_ROOT, 'lib', 'stacks', 'api-stack.ts'), 'utf8');
    for (const key of ['ApiId', 'ApiEndpoint']) {
      expect(stack, `VocApiStack lost its ${key} output`).toMatch(new RegExp(`new cdk\\.CfnOutput\\(this, '${key}'`));
      expect(readFileSync(REFRESH_API_STAGE_SH, 'utf8')).toContain(`output ${key}`);
    }
  });
});
