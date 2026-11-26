/**
 * The Agents API's check of a PRD's project (api-engineering-prd-check.ts, 7.80.00): nothing by default; with
 * -c engineeringAgents=true one GetItem on voc-projects, held to the deployment's `PROJECT#*` partitions and to the
 * attributes the check projects, and the table named to the Lambda. No workspace partition, claim, write or Query.
 */
import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { Template as TemplateOf } from 'aws-cdk-lib/assertions';

import { apiTemplate, buildApiStack, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { PRD_PROJECT_ATTRIBUTES, PRD_PROJECT_PARTITIONS } from './api-engineering-prd-check';

let cached: Template | undefined;
const on = (): Template => {
  cached ??= TemplateOf.fromStack(buildApiStack({ engineeringAgents: true }));
  return cached;
};
const projectStatements = (template: Template) =>
  policyStatementsOf(template, 'AgentsLambdaRole').filter((statement) => /Projects/.test(statement.resource));

describe('the PRD check\'s grant on the agents API', { timeout: SYNTH_TIMEOUT_MS }, () => {
  it('is off by default: no statement on voc-projects and no PROJECTS_TABLE', () => {
    expect(projectStatements(apiTemplate())).toStrictEqual([]);
    expect(serviceEnvironment(apiTemplate(), 'voc-agents-api').PROJECTS_TABLE).toBeUndefined();
  });

  it('reads the deployment\'s project META only, projected, with the engineering module on', () => {
    expect(projectStatements(on()).map((statement) => [statement.actions, statement.condition])).toStrictEqual([[
      ['dynamodb:GetItem'], {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [...PRD_PROJECT_PARTITIONS] },
        Null: { 'dynamodb:LeadingKeys': 'false', 'dynamodb:Attributes': 'false' },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': [...PRD_PROJECT_ATTRIBUTES] },
        StringEqualsIfExists: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
      }]]);
    expect(PRD_PROJECT_PARTITIONS).toStrictEqual(['PROJECT#*']);
    expect(JSON.stringify(serviceEnvironment(on(), 'voc-agents-api').PROJECTS_TABLE)).toMatch(/Projects/);
  });

  it('holds the attributes the check projects', () => {
    // (shared/project_writes.py deployment_project_live, which agents_handler.py _require_deployment_prd calls)
    const writes = fs.readFileSync(path.join(__dirname, '../../lambda/shared/project_writes.py'), 'utf8');
    expect(writes).toMatch(/^LIVE_PROJECTION: Final = 'pk, sk, #status, #deleting'$/m);
    expect(writes).toContain("ExpressionAttributeNames={'#status': 'status', '#deleting': PROJECT_DELETION_ATTRIBUTE}");
    expect(writes).toMatch(/^PROJECT_DELETION_ATTRIBUTE = 'deletion_started_at'$/m);
    expect([...PRD_PROJECT_ATTRIBUTES]).toStrictEqual(['deletion_started_at', 'pk', 'sk', 'status']);
  });
});
