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
