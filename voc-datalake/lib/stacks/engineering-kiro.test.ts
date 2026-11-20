/**
 * The Kiro harness's deployment settings (7.53.00, engineering-kiro.ts): `-c engineeringHarness` (native by default),
 * the runtime's and readiness's environment, the key's read granted to exactly the roles on Kiro (its one parameter,
 * decrypted through SSM for it alone), readiness's metadata-only read of it, and no grant on a native deployment.
 */
import * as cdk from 'aws-cdk-lib';
import { Template as TemplateOf } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { buildApiStack, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { globMatches } from '../test-support/iam-statements';
import { functionEnv, policyText, runtimeStack, supervisorEnv } from '../test-support/engineering-runtime-fixture';
import { processingSynths } from '../test-support/engineering-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { engineeringParameterPrefix } from './engineering-broker';
import { engineeringHarness, kiroKeyParameterName } from './engineering-kiro';
import { AGENT_ROLES } from './engineering-runtime';

const KEY = '/voc/engineering-kiro/api-key';
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
    expect(JSON.stringify(template.toJSON())).not.toMatch(/KiroApiKey|engineering-kiro\/api-key/);
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
    expect([/"Action":"ssm:GetParameter".*?parameter\/voc\/engineering-kiro\/api-key"/.test(fixer),
      fixer.includes('"Sid":"KiroApiKeyDecrypt"'), fixer.includes('"kms:ViaService":"ssm.us-east-1.amazonaws.com"'),
      /"kms:EncryptionContext:PARAMETER_ARN":\{?.*?parameter\/voc\/engineering-kiro\/api-key/.test(fixer)])
      .toStrictEqual([true, true, true, true]);
    // No wildcard on the key, no other parameter, no put.
    expect(fixer).not.toMatch(/engineering-kiro\/\*|ssm:PutParameter|ssm:GetParameters"/);
    const others = ['EngineeringAgentHunterRole', 'EngineeringAgentCoordinatorRole', 'EngineeringSupervisorRole',
      'EngineeringDeliveryRole'].filter((role) => /KiroApiKey|engineering-kiro\/api-key/.test(policyText(template, role)));
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
    expect(JSON.stringify(statements(template))).not.toMatch(/engineering-kiro\/api-key/);
    const env = serviceEnvironment(template, 'voc-agents-api');
    expect([env.ENGINEERING_HARNESS, env.ENGINEERING_KIRO_KEY_PARAMETER]).toStrictEqual(['kiro', KEY]);
  });
});

/** A synthesized ARN with its `Fn::Join` flattened and the partition named (`{Ref: AWS::Partition}` as `aws`). */
function flatArn(resource: unknown): string {
  const text = JSON.stringify(resource);
  const joined = /^\{"Fn::Join":\["",(\[.*\])\]\}$/.exec(text)?.[1];
  if (joined === undefined) return typeof resource === 'string' ? resource : text;
  const parts: unknown = JSON.parse(joined);
  return (Array.isArray(parts) ? parts : []).map((part: unknown) => (typeof part === 'string' ? part : 'aws')).join('');
}

describe('the key\'s own path (7.58.00)', { timeout: SYNTH_TIMEOUT_MS }, () => {
  const processing = processingSynths({ kiro: { engineeringAgents: true, engineeringHarness: 'kiro' } });

  it('is beside the connections\' path, never under it, unprefixed and prefixed', () => {
    expect([kiroKeyParameterName('/voc/engineering/'), kiroKeyParameterName('/b-voc/engineering/')])
      .toStrictEqual(['/voc/engineering-kiro/api-key', '/b-voc/engineering-kiro/api-key']);
    expect(() => kiroKeyParameterName('/voc/other/')).toThrow(/the connections' path ends in \/engineering\//);
    for (const prefix of [undefined, 'b']) {
      const connections = `${engineeringParameterPrefix(prefix)}*`;   // (every grant on a connection's parameter)
      expect([globMatches(connections, kiroKeyParameterName(engineeringParameterPrefix(prefix))),
        globMatches(connections, `${engineeringParameterPrefix(prefix)}conn-1`)]).toStrictEqual([false, true]);
    }
  });

  it('is reached by none of the connections\' readers or writers: the broker, the cache writer, the Agents API', () => {
    const ssm = (statement: { Action?: unknown; Resource?: unknown }) => [statement.Action].flat()
      .some((action) => String(action).startsWith('ssm:'));
    const reaching = (parameter: string) => Object.entries(processing('kiro').findResources('AWS::IAM::Policy'))
      .filter(([, policy]) => !/EngineeringAgent[A-Za-z]+Role/.test(JSON.stringify(policy.Properties?.Roles)))
      .flatMap(([id, policy]) => (policy.Properties?.PolicyDocument?.Statement ?? [])
        .filter(ssm).filter((statement: { Resource?: unknown }) => [statement.Resource].flat()
          .some((resource) => /:parameter\//.test(flatArn(resource))
            && globMatches(flatArn(resource).replace(/^arn:aws:ssm:[^:]*:[^:]*:/, ''), `parameter${parameter}`)))
        .map(() => id));
    // (the control: the broker's and the cache writer's reads of every connection's parameter reach the old place)
    expect([reaching('/voc/engineering/conn-1').length >= 2, reaching('/voc/engineering/_kiro/api-key').length >= 2])
      .toStrictEqual([true, true]);
    expect(reaching(KEY)).toStrictEqual([]);
    const api = TemplateOf.fromStack(buildApiStack({ engineeringAgents: true, engineeringHarness: 'kiro' }));
    const writes = policyStatementsOf(api, 'AgentsLambdaRole').filter((statement) => statement.actions
      .some((action) => /^ssm:(Put|Delete|Get)Parameter/.test(action)));
    expect(writes.length).toBeGreaterThan(0);   // (its connections' puts and deletes: under /voc/engineering/* only)
    expect(writes.filter((statement) => /engineering-kiro|parameter\/voc\/\*|parameter\/\*/.test(statement.resource)))
      .toStrictEqual([]);
  });
});
