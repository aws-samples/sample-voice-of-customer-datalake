/**
 * The Cognito `e2e` group (lib/stacks/core-auth.ts, 5.63.00): the production e2e test users, whose
 * model calls resolve to Haiku 5.5 on every surface. Pinned here, together with the two runtime
 * copies of its name and model (lambda/shared/model_profile.py + model_config.py, and
 * lambda/stream/src/bedrock/model-profile.ts), so a rename in one place fails the CDK suite.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { ALLOWED_MODEL_IDS } from '../utils/model-allowlist';
import { byCodeUnit } from '../utils/compare';

const LAMBDA = join(__dirname, '..', '..', 'lambda');
const HAIKU55 = 'global.anthropic.claude-haiku-5-5';

/** The string literal assigned to `name` at the start of a line (Python `NAME: Final = '…'`, TS `export const NAME = '…'`). */
function literal(file: string, name: string): string {
  const source = readFileSync(join(LAMBDA, file), 'utf8');
  const match = new RegExp(`^(?:export\\s+)?(?:const\\s+)?${name}(?::\\s*Final)?\\s*=\\s*'([^']+)'`, 'm').exec(source);
  if (!match?.[1]) throw new Error(`could not read ${name} from ${file}`);
  return match[1];
}

describe('the e2e Cognito group', () => {
  const template = synthCoreTemplate();

  it('exists next to admins and users, and grants nothing by itself', () => {
    const groups = Object.values(template.findResources('AWS::Cognito::UserPoolGroup'));
    const names = groups.map((group) => String(group.Properties?.GroupName)).sort(byCodeUnit);
    expect(names).toStrictEqual(['admins', 'e2e', 'users']);
    const e2e = groups.find((group) => group.Properties?.GroupName === 'e2e');
    // No IAM role and no precedence: membership changes the model profile, never a permission.
    expect(e2e?.Properties?.RoleArn).toBeUndefined();
    expect(e2e?.Properties?.Precedence).toBeUndefined();
  });

  it('is the group both runtimes read', () => {
    expect(literal('shared/model_profile.py', 'E2E_GROUP')).toBe('e2e');
    expect(literal('stream/src/bedrock/model-profile.ts', 'E2E_GROUP')).toBe('e2e');
  });

  it('resolves, in both runtimes, to the allowlisted Haiku 5.5', () => {
    expect(readFileSync(join(LAMBDA, 'shared', 'model_config.py'), 'utf8')).toMatch(/^PROFILE_MODELS = \{E2E_PROFILE: _HAIKU55\}$/m);
    expect(literal('stream/src/bedrock/model-profile.ts', 'HAIKU55')).toBe(HAIKU55);
    expect(ALLOWED_MODEL_IDS).toContain(HAIKU55);
  });
});
