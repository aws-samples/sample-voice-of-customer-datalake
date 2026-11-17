/**
 * The Kiro harness's deployment settings (7.53.00, engineering-kiro.ts): `-c engineeringHarness` (native by default),
 * the runtime's and readiness's environment, the key's read granted to exactly the roles on Kiro (its one parameter,
 * decrypted through SSM for it alone), readiness's metadata-only read of it, and no grant on a native deployment.
 */
import * as cdk from 'aws-cdk-lib';
import { Template as TemplateOf } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { buildApiStack, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { functionEnv, policyText, runtimeStack, supervisorEnv } from '../test-support/engineering-runtime-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { engineeringHarness } from './engineering-kiro';
import { AGENT_ROLES } from './engineering-runtime';

const KEY = '/voc/engineering/_kiro/api-key';
const scope = (value: unknown): cdk.App => new cdk.App({ context: value === undefined ? {} : { engineeringHarness: value } });

describe('-c engineeringHarness', () => {
  it('is native by default and when named', () => {
    expect([engineeringHarness(scope(undefined), AGENT_ROLES), engineeringHarness(scope('native'), AGENT_ROLES)])
      .toStrictEqual([{ value: 'native', kiroRoles: [] }, { value: 'native', kiroRoles: [] }]);
  });

  it('is every launchable role for kiro, never the coach', () => {
    const all = engineeringHarness(scope('kiro'), AGENT_ROLES);
    expect({ value: all.value, count: all.kiroRoles.length, coach: all.kiroRoles.includes('coach') })
      .toStrictEqual({ value: 'kiro', count: 12, coach: false });
  });

  it('is the named roles, sorted, for kiro:<roles>', () => {
    expect(engineeringHarness(scope('kiro:gate-runner, fixer'), AGENT_ROLES))
      .toStrictEqual({ value: 'kiro:fixer,gate-runner', kiroRoles: ['fixer', 'gate-runner'] });
  });

  it.each(['Kiro', 'kiro:', 'kiro:coach', 'kiro:nobody', 'claude', 'fixer'])('refuses %s at synth', (value) => {
    expect(() => engineeringHarness(scope(value), AGENT_ROLES)).toThrow(/engineeringHarness is not a harness setting/);
  });
});

describe('the runtime on Kiro', { timeout: SYNTH_TIMEOUT_MS }, () => {
  it('names native and no key parameter, and grants no role the key, by default', () => {
    const { template } = runtimeStack({ engineeringAgents: 'true' });
    const env = supervisorEnv(template);
    expect([env.ENGINEERING_HARNESS, 'ENGINEERING_KIRO_KEY_PARAMETER' in env]).toStrictEqual(['native', false]);
    expect(JSON.stringify(template.toJSON())).not.toMatch(/KiroApiKey|_kiro\/api-key/);
  });

  it('names the switch and the key parameter to the runtime, never to the delivery', () => {
    const { template } = runtimeStack({ engineeringAgents: 'true', engineeringHarness: 'kiro:fixer' });
    const env = supervisorEnv(template);
    const delivery = functionEnv(template, 'voc-engineering-delivery');
    expect([env.ENGINEERING_HARNESS, env.ENGINEERING_KIRO_KEY_PARAMETER, 'ENGINEERING_HARNESS' in delivery,
      'ENGINEERING_KIRO_KEY_PARAMETER' in delivery]).toStrictEqual(['kiro:fixer', KEY, false, false]);
  });

  it('grants exactly the roles on Kiro the key, its one parameter, decrypted through SSM for it alone', () => {
    const { template } = runtimeStack({ engineeringAgents: 'true', engineeringHarness: 'kiro:fixer' });
    const fixer = policyText(template, 'EngineeringAgentFixerRole');
    expect([/"Action":"ssm:GetParameter".*?parameter\/voc\/engineering\/_kiro\/api-key"/.test(fixer),
      fixer.includes('"Sid":"KiroApiKeyDecrypt"'), fixer.includes('"kms:ViaService":"ssm.us-east-1.amazonaws.com"'),
      /"kms:EncryptionContext:PARAMETER_ARN":\{?.*?parameter\/voc\/engineering\/_kiro\/api-key/.test(fixer)])
      .toStrictEqual([true, true, true, true]);
    // No wildcard on the key, no other parameter, no put.
    expect(fixer).not.toMatch(/_kiro\/\*|ssm:PutParameter|ssm:GetParameters"/);
    const others = ['EngineeringAgentHunterRole', 'EngineeringAgentCoordinatorRole', 'EngineeringSupervisorRole',
      'EngineeringDeliveryRole'].filter((role) => /KiroApiKey|_kiro\/api-key/.test(policyText(template, role)));
    expect(others).toStrictEqual([]);
  });
});

describe('readiness on Kiro', { timeout: SYNTH_TIMEOUT_MS }, () => {
  const statements = (template: TemplateOf) => policyStatementsOf(template, 'AgentsLambdaRole');

  it('reads nothing of SSM for the key on a native deployment', () => {
    const template = TemplateOf.fromStack(buildApiStack({ engineeringAgents: true }));
    expect(JSON.stringify(statements(template))).not.toMatch(/ssm:DescribeParameters/);
    expect(serviceEnvironment(template, 'voc-agents-api').ENGINEERING_HARNESS).toBe('native');
  });

  it('describes the key\'s parameter (its type, never its value) where a role runs on Kiro', () => {
    const template = TemplateOf.fromStack(buildApiStack({ engineeringAgents: true, engineeringHarness: 'kiro' }));
    const kiro = statements(template).filter((statement) => statement.actions.some((action) => action.startsWith('ssm:Describe')));
    expect(kiro.map((statement) => [statement.actions, statement.resource])).toStrictEqual(
      [[['ssm:DescribeParameters'], '"*"']]);
    expect(JSON.stringify(statements(template))).not.toMatch(/_kiro\/api-key/);
    const env = serviceEnvironment(template, 'voc-agents-api');
    expect([env.ENGINEERING_HARNESS, env.ENGINEERING_KIRO_KEY_PARAMETER]).toStrictEqual(['kiro', KEY]);
  });
});
