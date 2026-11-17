/**
 * voc-engineering-issues-config (engineering-issues-config.ts; lambda/engineering/connectors/issues_config.py): only with
 * the engineering agents AND the github_issues plugin; its own role holds exactly the shared secret read and written
 * (that one ARN) and the github_issues schedule rule described and turned on (that one rule), and its log writes; no
 * function URL, no resource policy, no table, no bucket.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';

import { OPTIONAL_FUNCTION_SIZES } from '../sizing/policy';
import { functionStatements, functionUrlAuthTypes } from '../test-support/engineering-template';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

const CONFIG_FUNCTION = 'voc-engineering-issues-config';
const SHARED_SECRET = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:voc';

/** The logical ids of the functions whose physical name holds the function's. */
function configIds(template: Template): string[] {
  return Object.entries(template.findResources('AWS::Lambda::Function'))
    .filter(([, resource]) => JSON.stringify(resource.Properties?.FunctionName ?? '').includes(CONFIG_FUNCTION))
    .map(([id]) => id);
}

describe('the GitHub Issues settings function (VocProcessingStack)', () => {
  const synths = new Map<string, Template>();
  beforeAll(() => {
    synths.set('on', synthProcessingTemplate({ context: { engineeringAgents: true }, enabledSources: ['github_issues'] }));
    synths.set('noPlugin', synthProcessingTemplate({ context: { engineeringAgents: true }, enabledSources: ['webscraper'] }));
    synths.set('noAgents', synthProcessingTemplate({ enabledSources: ['github_issues'] }));
  }, SYNTH_TIMEOUT_MS * 3);
  const template = (key: string): Template => {
    const found = synths.get(key);
    if (found === undefined) throw new Error(`${key} was not synthesized`);
    return found;
  };
  const configId = (synthesized: Template): string => {
    const ids = configIds(synthesized);
    expect(ids).toHaveLength(1);
    return ids[0] ?? '';
  };

  it('exists only with the engineering agents and the github_issues plugin both deployed', () => {
    expect(configIds(template('on'))).toHaveLength(1);
    expect(configIds(template('noPlugin'))).toStrictEqual([]);
    expect(configIds(template('noAgents'))).toStrictEqual([]);
  });

  it('runs issues_config.py with the secret and the rule named, and no function URL or resource policy', () => {
    const on = template('on');
    const properties = on.findResources('AWS::Lambda::Function')[configId(on)]?.Properties;
    expect(properties).toMatchObject({
      Handler: 'engineering/connectors/issues_config.lambda_handler', Runtime: 'python3.14', Architectures: ['arm64'],
      MemorySize: OPTIONAL_FUNCTION_SIZES[CONFIG_FUNCTION], Timeout: 15,
      Environment: { Variables: { ISSUES_SETTINGS_ARN: SHARED_SECRET } },
    });
    expect(JSON.stringify(properties?.Environment?.Variables?.ISSUES_SCHEDULE_RULE)).toMatch(/voc-ingest-github_issues-schedule/);
    expect(functionUrlAuthTypes(on, configId(on))).toStrictEqual([]);
    expect(Object.values(on.findResources('AWS::Lambda::Permission'))
      .filter((permission) => JSON.stringify(permission.Properties).includes(configId(on)))).toStrictEqual([]);
  });

  it('holds its log writes, the one secret read and written and the one rule described and turned on, nothing else', () => {
    const on = template('on');
    const statements = functionStatements(on, configId(on));
    expect(statements.flatMap((statement) => [statement.Action].flat()).sort(byCodeUnit)).toStrictEqual([
      'events:DescribeRule', 'events:EnableRule', 'logs:CreateLogStream', 'logs:PutLogEvents',
      'secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue']);
    const secret = statements.find((statement) => [statement.Action].flat().includes('secretsmanager:PutSecretValue'));
    expect(secret?.Resource).toBe(SHARED_SECRET);
    const rule = JSON.stringify(statements.find((statement) => [statement.Action].flat().includes('events:EnableRule'))?.Resource);
    expect(rule).toMatch(/:rule\/voc-ingest-github_issues-schedule-/);
    expect(rule).not.toContain('*');
  });
});
