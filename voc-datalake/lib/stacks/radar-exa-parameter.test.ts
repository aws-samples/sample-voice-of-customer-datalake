/**
 * The Radar Exa key (docs/radar.md → "Exa"): an SSM SecureString the Radar API writes at runtime.
 * Both Radar Lambdas are told its name and hold exactly the actions they need on exactly its ARN;
 * no Secrets Manager secret (a fixed monthly cost) and no SSM parameter is created by the stacks.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';

import { apiTemplate, apiTemplatePrefixed, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { roleStatements } from '../test-support/iam-statements';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { findWorkerFunction } from '../test-support/worker-function';
import { radarExaParameterName } from '../utils/radar-exa-parameter';

const PARAMETER_ARN = /arn:.*:ssm:.*:parameter\/voc\/radar\/exa-api-key"/;

let processing: Template;
beforeAll(() => { processing = synthProcessingTemplate({ withIndexes: true }); }, SYNTH_TIMEOUT_MS);

const ssmStatements = (statements: readonly { actions: string[]; resource: string }[]) =>
  statements.filter((s) => s.actions.some((action) => action.startsWith('ssm:')));

describe('the parameter name', () => {
  it('is per deployment, the prefix on the voc segment', () => {
    expect([radarExaParameterName(undefined), radarExaParameterName('b')])
      .toStrictEqual(['/voc/radar/exa-api-key', '/b-voc/radar/exa-api-key']);
  });
});

describe('voc-radar-api', () => {
  it('is told the parameter name', () => {
    expect(serviceEnvironment(apiTemplate(), 'voc-radar-api').RADAR_EXA_PARAMETER).toBe('/voc/radar/exa-api-key');
    expect(serviceEnvironment(apiTemplatePrefixed(), 'voc-radar-api').RADAR_EXA_PARAMETER).toBe('/b-voc/radar/exa-api-key');
  });

  it('may put, delete and read exactly that parameter, and no other SSM action or resource', () => {
    const statements = ssmStatements(policyStatementsOf(apiTemplate(), 'RadarLambdaRole'));
    expect(statements.map((s) => [...s.actions].sort((a, b) => a.localeCompare(b)))).toStrictEqual([
      ['ssm:DeleteParameter', 'ssm:GetParameter', 'ssm:PutParameter']]);
    expect(statements[0]?.resource).toMatch(PARAMETER_ARN);
  });

  it('is the only API-stack policy that names the parameter', () => {
    const policies = Object.entries(apiTemplate().findResources('AWS::IAM::Policy'))
      .filter(([, policy]) => JSON.stringify(policy).includes('voc/radar/exa-api-key'))
      .map(([id]) => id);
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatch(/^RadarLambdaRole/);
  });
});

describe('voc-radar-scan', () => {
  const scanner = () => findWorkerFunction(processing, 'voc-radar-scan-');

  it('is told the parameter name', () => {
    expect(scanner().Environment.Variables.RADAR_EXA_PARAMETER).toBe('/voc/radar/exa-api-key');
  });

  it('may only read exactly that parameter', () => {
    const statements = ssmStatements(roleStatements(processing, scanner().Role['Fn::GetAtt'][0]));
    expect(statements.map((s) => s.actions)).toStrictEqual([['ssm:GetParameter']]);
    expect(statements[0]?.resource).toMatch(PARAMETER_ARN);
  });
});

describe('pay per use', () => {
  it.each([['api', () => apiTemplate()], ['processing', () => processing]])(
    'the %s stack creates no Secrets Manager secret and no SSM parameter for it', (_name, template) => {
      expect(Object.keys(template().findResources('AWS::SSM::Parameter'))).toStrictEqual([]);
      expect(Object.keys(template().findResources('AWS::SecretsManager::Secret')).filter((id) => /radar|exa/i.test(id)))
        .toStrictEqual([]);
    },
  );
});
