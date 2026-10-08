/**
 * Frugal API Gateway invoke permissions. VocApiStack sits at CloudFormation's
 * 500-resource ceiling: with every plugin enabled the real synth reached 502 and
 * failed until MetricsApi (22 per-method permissions) and the plugin webhook
 * receivers moved to ONE permission each, scoped to this RestApi. These cases
 * keep that headroom from being given back silently, and pin that the wider
 * permission is still bounded to this API and to API Gateway as the caller.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Template } from 'aws-cdk-lib/assertions';

import { apiTemplateAllPlugins, functionIdForHandler } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

beforeAll(() => {
  apiTemplateAllPlugins();
}, SYNTH_TIMEOUT_MS);

const PermissionSchema = z.object({
  Properties: z.object({
    Action: z.string(),
    Principal: z.string(),
    FunctionName: z.unknown(),
    SourceArn: z.unknown(),
  }),
});

/** Invoke permissions whose FunctionName is `Fn::GetAtt [functionId, Arn]`. */
function permissionsFor(template: Template, functionId: string) {
  const target = JSON.stringify({ 'Fn::GetAtt': [functionId, 'Arn'] });
  return Object.values(template.findResources('AWS::Lambda::Permission'))
    .map((resource) => PermissionSchema.parse(resource).Properties)
    .filter((permission) => JSON.stringify(permission.FunctionName) === target);
}

/** Logical id of the one Lambda whose id starts with `prefix`. */
function functionIdWithPrefix(template: Template, prefix: string): string {
  const ids = Object.keys(template.findResources('AWS::Lambda::Function')).filter((id) => id.startsWith(prefix));
  expect(ids, `expected exactly one function whose logical id starts with ${prefix}`).toHaveLength(1);
  return ids[0] ?? '';
}

const FRUGAL_FUNCTIONS: [string, (template: Template) => string][] = [
  ['the metrics API', (template) => functionIdForHandler(template, 'metrics_handler.py')],
  ['the feedback edit API', (template) => functionIdForHandler(template, 'feedback_edit_handler.py')],
  ['the github_issues webhook receiver', (template) => functionIdWithPrefix(template, 'GithubIssuesWebhook')],
];

describe.each(FRUGAL_FUNCTIONS)('%s', (_label, functionIdOf) => {
  const permissions = () => {
    const template = apiTemplateAllPlugins();
    return permissionsFor(template, functionIdOf(template));
  };

  it('has exactly one invoke permission, granted to API Gateway', () => {
    expect(permissions()).toStrictEqual([
      expect.objectContaining({ Action: 'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com' }),
    ]);
  });

  it('scopes that permission to this RestApi, for any stage, method and path', () => {
    const template = apiTemplateAllPlugins();
    const [restApiId, ...others] = Object.keys(template.findResources('AWS::ApiGateway::RestApi'));
    expect(others, 'expected exactly one RestApi').toStrictEqual([]);

    expect(permissions()[0]?.SourceArn).toStrictEqual({
      'Fn::Join': ['', [
        'arn:', { Ref: 'AWS::Partition' }, ':execute-api:us-east-1:111111111111:', { Ref: restApiId }, '/*/*/*',
      ]],
    });
  });
});
