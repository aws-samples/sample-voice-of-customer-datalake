/**
 * The Agents API's side of the GitHub Issues source's follow (api-engineering-issues-sync.ts; lambda/engineering/
 * connectors/issues_sync.py): nothing by default or without the github_issues plugin; with both, exactly
 * `lambda:InvokeFunction` on voc-engineering-issues-config by its name, and never a grant on the shared secret or the
 * schedule rule (engineering-issues-config.ts holds those, on the function's own role).
 */
import { describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { Template as TemplateOf } from 'aws-cdk-lib/assertions';

import { apiTemplate, buildApiStack, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { ISSUES_CONFIG_FUNCTION_ENV } from './engineering-issues-config';

const CONFIG_FUNCTION = 'voc-engineering-issues-config';
const cached = new Map<string, Template>();
const synth = (sources: string[]): Template => {
  const key = sources.join(',');
  const found = cached.get(key) ?? TemplateOf.fromStack(buildApiStack({ engineeringAgents: true }, sources));
  cached.set(key, found);
  return found;
};
const statements = (template: Template) => policyStatementsOf(template, 'AgentsLambdaRole');
const actions = (template: Template) => statements(template).flatMap((statement) => statement.actions);
const configInvokes = (template: Template) => statements(template)
  .filter((statement) => statement.actions.includes('lambda:InvokeFunction') && statement.resource.includes(CONFIG_FUNCTION))
  .map((statement) => statement.resource);

describe('the Agents API and the GitHub Issues settings function', { timeout: SYNTH_TIMEOUT_MS }, () => {
  it('is nothing by default and without the github_issues plugin: no invoke, no environment', () => {
    expect(configInvokes(synth(['webscraper']))).toStrictEqual([]);
    expect(serviceEnvironment(synth(['webscraper']), 'voc-agents-api')[ISSUES_CONFIG_FUNCTION_ENV]).toBeUndefined();
    expect(JSON.stringify(statements(apiTemplate()))).not.toContain(CONFIG_FUNCTION);
  });

  it('invokes the function by its name and names it to the follow', () => {
    const on = synth(['github_issues']);
    expect(configInvokes(on)).toStrictEqual([expect.stringMatching(/:function:voc-engineering-issues-config-",\{"Ref":"AWS::AccountId"\}/)]);
    expect(JSON.stringify(serviceEnvironment(on, 'voc-agents-api')[ISSUES_CONFIG_FUNCTION_ENV])).toMatch(/voc-engineering-issues-config/);
  });

  it('holds no secretsmanager action and never turns a schedule rule on (the function\'s own role does)', () => {
    for (const sources of [['github_issues'], ['webscraper']]) {
      expect(actions(synth(sources)).filter((action) => action.startsWith('secretsmanager:'))).toStrictEqual([]);
      expect(actions(synth(sources)).filter((action) => /^events:(EnableRule|DisableRule|PutRule)$/.test(action)))
        .toStrictEqual([]);
    }
  });
});
