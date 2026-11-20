/**
 * The GitHub App connect flow's infrastructure (7.45.00, engineering-app-tokens.ts; docs/autonomous-engineering.md "A
 * GitHub App in two clicks"): the token function and its exact grants, who may invoke it (the Agents API and the
 * github_issues ingestor, each only with the engineering agents on), the webhook role's read of the Apps' webhook
 * secrets (only with that webhook AND the agents), the SPA's `form-action` widened to github.com alone, and voc-agents'
 * TTL for the flow's setup states.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';

import { OPTIONAL_FUNCTION_SIZES } from '../sizing/policy';
import { policyStatementsOf, serviceEnvironment, synthApiTemplate } from '../test-support/api-stack-template';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import {
  functionIds, functionStatements, functionUrlAuthTypes, permissionsNaming, processingSynths,
} from '../test-support/engineering-template';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { githubAppParameterPrefix } from './engineering-app-tokens';

const ARN = (resource: string) => ({
  'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:ssm:us-east-1:111111111111:parameter/${resource}`]],
});
const KEYS = ARN('voc/engineering/_github-app/*/key');
const WEBHOOK_SECRETS = ARN('voc/engineering/_github-app/*/webhook');
const TOKEN_FUNCTION = 'voc-engineering-app-tokens';

/** The logical id of the one function whose environment says it is `source`'s (SOURCE_PLATFORM). */
function sourceFunctionId(template: Template, source: string): string {
  const ids = Object.entries(template.findResources('AWS::Lambda::Function'))
    .filter(([, resource]) => resource.Properties?.Environment?.Variables?.SOURCE_PLATFORM === source).map(([id]) => id);
  expect(ids).toHaveLength(1);
  return ids[0] ?? '';
}

/** Every `lambda:InvokeFunction` resource of `statements`, serialized. */
const invokes = (statements: readonly { actions: string[]; resource: string }[]) => statements
  .filter((statement) => statement.actions.includes('lambda:InvokeFunction')).map((statement) => statement.resource);

describe('the token function (VocProcessingStack)', () => {
  const template = processingSynths({ off: {}, on: { engineeringAgents: true } });
  const tokensId = (synthesized: Template): string => {
    const ids = functionIds(synthesized, TOKEN_FUNCTION);
    expect(ids).toHaveLength(1);
    return ids[0] ?? '';
  };

  it('is absent without the engineering agents', () => {
    expect(functionIds(template('off'), TOKEN_FUNCTION)).toStrictEqual([]);
  });

  it('runs the broker\'s code at its own entry, with the broker\'s signing layer, and no function URL', () => {
    const on = template('on');
    const properties = on.findResources('AWS::Lambda::Function')[tokensId(on)]?.Properties;
    expect(properties).toMatchObject({
      Handler: 'engineering/connectors/app_tokens.lambda_handler', Runtime: 'python3.14', Architectures: ['arm64'],
      MemorySize: OPTIONAL_FUNCTION_SIZES[TOKEN_FUNCTION], Timeout: 20,
      Environment: { Variables: { ENGINEERING_PARAMETER_PREFIX: '/voc/engineering/' } },
    });
    expect(JSON.stringify(properties?.Layers)).toContain('EngineeringBrokerSigningDepsLayer');
    expect(functionUrlAuthTypes(on, tokensId(on))).toStrictEqual([]);
  });

  it('grants nobody a way in by resource policy: only roles an IAM policy names may invoke it', () => {
    const on = template('on');
    expect(permissionsNaming(on, tokensId(on))).toStrictEqual([]);
  });

  it('holds its log writes, the Apps\' keys and their decrypt through SSM for them alone, and nothing else', () => {
    const on = template('on');
    const statements = functionStatements(on, tokensId(on));
    expect(statements.flatMap((statement) => [statement.Action].flat()).sort(byCodeUnit)).toStrictEqual([
      'kms:Decrypt', 'logs:CreateLogStream', 'logs:PutLogEvents', 'ssm:GetParameter']);
    expect(statements.find((statement) => statement.Action === 'ssm:GetParameter')).toMatchObject({ Resource: KEYS });
    expect(statements.find((statement) => statement.Action === 'kms:Decrypt')).toMatchObject({
      Condition: {
        StringEquals: { 'kms:ViaService': 'ssm.us-east-1.amazonaws.com' },
        StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': KEYS },
      },
    });
  });

  it('names the Apps\' parameters under the connections\' path, the deployment prefix on its voc segment', () => {
    expect(githubAppParameterPrefix(undefined)).toBe('/voc/engineering/_github-app/');
    expect(githubAppParameterPrefix('qa')).toBe('/qa-voc/engineering/_github-app/');
  });
});

describe('the Agents API and the webhook (VocApiStack)', () => {
  const synths = new Map<string, Template>();
  beforeAll(() => {
    synths.set('off', synthApiTemplate({}, ['github_issues']));
    synths.set('on', synthApiTemplate({ engineeringAgents: true }, ['github_issues']));
    synths.set('onWithoutWebhook', synthApiTemplate({ engineeringAgents: true }));
  }, SYNTH_TIMEOUT_MS * 3);
  const template = (key: string): Template => synths.get(key) ?? synthApiTemplate();

  it('lets the Agents API invoke the token function by its name, and names it and the app\'s address', () => {
    const on = template('on');
    expect(invokes(policyStatementsOf(on, 'AgentsLambdaRole')).filter((resource) => resource.includes(TOKEN_FUNCTION)))
      .toStrictEqual([expect.stringMatching(/:function:voc-engineering-app-tokens-",{"Ref":"AWS::AccountId"}/)]);
    const env = serviceEnvironment(on, 'voc-agents-api');
    expect(JSON.stringify(env.ENGINEERING_APP_TOKENS_FUNCTION)).toContain(`"${TOKEN_FUNCTION}-"`);
    expect(JSON.stringify(env.FRONTEND_URL)).toContain('https://');
  });

  it('gives the Agents API no read of any parameter (it writes the Apps\' keys and never reads them back)', () => {
    const statements = policyStatementsOf(template('on'), 'AgentsLambdaRole');
    expect(statements.filter((statement) => statement.actions.some((action) => /^ssm:Get/.test(action))))
      .toStrictEqual([]);
    expect(JSON.stringify(policyStatementsOf(template('off'), 'AgentsLambdaRole'))).not.toContain(TOKEN_FUNCTION);
  });

  it('lets the webhook role read the Apps\' webhook secrets alone, only with the agents and the webhook', () => {
    const reads = (key: string) => policyStatementsOf(template(key), 'WebhookLambdaRole')
      .filter((statement) => statement.actions.includes('ssm:GetParameter') && statement.resource.includes('_github-app'));
    expect(reads('on').map((statement) => statement.resource)).toStrictEqual([JSON.stringify(WEBHOOK_SECRETS)]);
    expect(reads('off')).toStrictEqual([]);
    expect(JSON.stringify(reads('on'))).not.toContain('/key');
  });

  it('names the secrets\' path to the github_issues webhook and the hook\'s address to the Agents API, only then', () => {
    const on = template('on');
    const variables = on.findResources('AWS::Lambda::Function')[sourceFunctionId(on, 'github_issues')]?.Properties
      ?.Environment?.Variables;
    expect(variables?.GITHUB_APP_PARAMETER_PREFIX).toBe('/voc/engineering/_github-app/');
    expect(JSON.stringify(serviceEnvironment(on, 'voc-agents-api').GITHUB_APP_WEBHOOK_URL)).toMatch(
      /execute-api.*\/v1\/webhooks\/github_issues/);
    expect(serviceEnvironment(template('onWithoutWebhook'), 'voc-agents-api').GITHUB_APP_WEBHOOK_URL).toBeUndefined();
  });
});

describe('the github_issues ingestor (VocIngestionStack)', () => {
  const synths = new Map<string, Template>();
  beforeAll(() => {
    synths.set('off', synthIngestionTemplate(['github_issues']));
    synths.set('on', synthIngestionTemplate(['github_issues'], { engineeringAgents: true }));
  }, SYNTH_TIMEOUT_MS * 2);
  const template = (key: string): Template => synths.get(key) ?? synthIngestionTemplate();
  const ingestorStatements = (key: string) => {
    const synthesized = template(key);
    return functionStatements(synthesized, sourceFunctionId(synthesized, 'github_issues')).map((statement) => ({
      actions: [statement.Action].flat(), resource: JSON.stringify(statement.Resource) }));
  };

  it('may invoke the token function by its name only with the engineering agents on', () => {
    expect(invokes(ingestorStatements('on')).filter((resource) => resource.includes(TOKEN_FUNCTION)))
      .toStrictEqual([expect.stringMatching(/:function:voc-engineering-app-tokens-",{"Ref":"AWS::AccountId"}/)]);
    expect(JSON.stringify(ingestorStatements('off'))).not.toContain(TOKEN_FUNCTION);
  });

  it('learns the token function\'s name only then', () => {
    const variables = (key: string) => template(key).findResources('AWS::Lambda::Function')[
      sourceFunctionId(template(key), 'github_issues')]?.Properties?.Environment?.Variables;
    expect(JSON.stringify(variables('on')?.ENGINEERING_APP_TOKENS_FUNCTION)).toContain(`"${TOKEN_FUNCTION}-"`);
    expect(variables('off')?.ENGINEERING_APP_TOKENS_FUNCTION).toBeUndefined();
  });
});

describe('the SPA\'s form-action and voc-agents\' TTL (VocCoreStack)', () => {
  const synths = new Map<string, Template>();
  beforeAll(() => {
    synths.set('off', synthCoreTemplate());
    synths.set('on', synthCoreTemplate({ engineeringAgents: true }));
  }, SYNTH_TIMEOUT_MS * 2);
  const template = (key: string): Template => synths.get(key) ?? synthCoreTemplate();
  /** The SPA's CSP (core-cdn.ts's SecurityHeadersPolicy, found by its logical id), its form-action directive. */
  const formAction = (key: string): string => {
    const [, policy] = Object.entries(template(key).findResources('AWS::CloudFront::ResponseHeadersPolicy'))
      .find(([logicalId]) => logicalId.startsWith('SecurityHeadersPolicy')) ?? [];
    return /form-action ([^;]*);/u.exec(JSON.stringify(policy ?? {}))?.[1] ?? '';
  };

  it('lets the SPA\'s forms post to github.com alone besides itself, only with the engineering agents on', () => {
    expect(formAction('on')).toBe("'self' https://github.com");
    expect(formAction('off')).toBe("'self'");
  });

  it('turns voc-agents\' TTL on, on the `ttl` attribute', () => {
    const agents = Object.values(template('off').findResources('AWS::DynamoDB::Table'))
      .filter((table) => JSON.stringify(table.Properties?.TableName).includes('voc-agents'));
    expect(agents.map((table) => table.Properties?.TimeToLiveSpecification)).toStrictEqual([
      { AttributeName: 'ttl', Enabled: true }]);
  });
});
