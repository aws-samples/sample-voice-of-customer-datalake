/**
 * The integrations API's EventBridge grant: the enable/disable routes and
 * GET /sources/status reach exactly the schedule rules VocIngestionStack
 * creates, by name, never a `rule/...-*` wildcard that would also reach a
 * disabled plugin's rule or another deployment's.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { apiTemplate, apiTemplateAllPlugins, discoverPluginIds } from '../test-support/api-stack-template';
import { roleStatements } from '../test-support/iam-statements';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { itemAt } from '../test-support/guards';

const EVENTS_ACTIONS = ['events:DescribeRule', 'events:DisableRule', 'events:EnableRule'];

function integrationsRoleId(template: Template): string {
  const ids = Object.keys(template.findResources('AWS::IAM::Role'))
    .filter((id) => id.startsWith('IntegrationsLambdaRole'));
  expect(ids, 'expected exactly one IntegrationsLambdaRole').toHaveLength(1);
  return itemAt(ids, 0);
}

const JoinSchema = z.object({ 'Fn::Join': z.tuple([z.literal(''), z.array(z.unknown())]) });

/** The EventBridge statements of the integrations role (one per synth). */
function eventsStatements(template: Template): { actions: string[]; resource: string }[] {
  return roleStatements(template, integrationsRoleId(template))
    .filter((s) => s.actions.some((action) => action.startsWith('events:')));
}

/**
 * A rule name as its synthesized `Fn::Join` parts, serialized. Names carry
 * `{Ref: AWS::AccountId}`/`{Ref: AWS::Region}` tokens, so comparing the parts
 * pins the literal stem AND the suffix tokens.
 */
function nameKey(name: unknown): string {
  return JSON.stringify(JoinSchema.parse(name)['Fn::Join'][1]);
}

/** The same key for a rule ARN: its join parts from the text after `rule/`. */
function arnNameKey(arn: unknown): string {
  const parts = JoinSchema.parse(arn)['Fn::Join'][1];
  const at = parts.findIndex((part) => typeof part === 'string' && part.includes(':rule/'));
  const head = parts[at];
  expect(typeof head, `no rule/ segment in ${JSON.stringify(arn)}`).toBe('string');
  return JSON.stringify([String(head).split(':rule/')[1], ...parts.slice(at + 1)]);
}

describe('integrations role: EventBridge schedule-rule grant', () => {
  let allPlugins: Template;
  let ingestionRuleKeys: string[];
  beforeAll(() => {
    allPlugins = apiTemplateAllPlugins();
    ingestionRuleKeys = Object.values(synthIngestionTemplate(discoverPluginIds()).findResources('AWS::Events::Rule'))
      .map((rule) => nameKey(z.object({ Properties: z.object({ Name: z.unknown() }) }).parse(rule).Properties.Name))
      .filter((key) => key.includes('-schedule-'))
      .sort(byCodeUnit);
  }, SYNTH_TIMEOUT_MS);

  it('grants enable, disable and describe in one statement naming no wildcard', () => {
    const statements = eventsStatements(allPlugins);
    expect(statements).toHaveLength(1);
    const statement = itemAt(statements, 0);
    expect([...statement.actions].sort(byCodeUnit)).toStrictEqual(EVENTS_ACTIONS);
    expect(statement.resource).not.toContain('*');
  });

  it('grants exactly the schedule rules the ingestion stack creates', () => {
    expect(ingestionRuleKeys.length, 'the ingestion stack created no schedule rule').toBeGreaterThan(0);
    const granted = z.array(z.unknown()).parse(JSON.parse(itemAt(eventsStatements(allPlugins), 0).resource));
    expect(granted.map(arnNameKey).sort(byCodeUnit)).toStrictEqual(ingestionRuleKeys);
  });

  it('grants no EventBridge action when no scheduled plugin is enabled', () => {
    expect(eventsStatements(apiTemplate())).toStrictEqual([]);
  });
});
