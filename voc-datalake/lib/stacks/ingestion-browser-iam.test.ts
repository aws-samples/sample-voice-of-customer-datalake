/**
 * The web_reviews ingestor's AgentCore browser grants (`infrastructure.ingestor.browser`).
 *
 * Start/Stop are scoped to the AWS-managed `aws.browser.v1` of the deployment's
 * region; ConnectBrowserAutomationStream has no resource type in the service
 * authorization reference, so it is the only action granted on `*`. No other
 * ingestor role carries any bedrock-agentcore action.
 */
import type { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { type NormalizedStatement, roleStatements } from '../test-support/iam-statements';
import { SYNTH_REGION } from '../test-support/synth-app';
import { BROWSER_SESSION_ACTIONS, BROWSER_STREAM_ACTION } from './ingestion-roles';

const AGENTCORE = 'bedrock-agentcore:';

function agentcoreStatements(statements: NormalizedStatement[]): NormalizedStatement[] {
  return statements.filter((s) => s.actions.some((action) => action.startsWith(AGENTCORE)));
}

describe('VocIngestionStack AgentCore browser grants', () => {
  let template: Template;
  beforeAll(() => {
    template = synthIngestionTemplate(['web_reviews', 'webscraper', 'app_reviews_ios']);
  });

  const webReviews = () => roleStatements(template, 'IngestorRoleWebReviewsDefaultPolicy', { byIdPrefix: true });

  it('scopes session start/stop to the AWS-managed browser of the region', () => {
    const scoped = agentcoreStatements(webReviews()).filter((s) => s.resource !== '"*"');
    expect(scoped.map((s) => s.actions)).toStrictEqual([[...BROWSER_SESSION_ACTIONS]]);
    expect(scoped.map((s) => s.resource)).toStrictEqual([
      JSON.stringify(`arn:aws:bedrock-agentcore:${SYNTH_REGION}:aws:browser/aws.browser.v1`),
    ]);
  });

  it('grants only the stream connect on "*"', () => {
    const wildcard = agentcoreStatements(webReviews()).filter((s) => s.resource === '"*"');
    expect(wildcard.map((s) => s.actions)).toStrictEqual([[BROWSER_STREAM_ACTION]]);
  });

  it('keeps the Bedrock model grant the bedrock capability gives', () => {
    expect(webReviews().some((s) => s.actions.includes('bedrock:InvokeModel'))).toBe(true);
  });

  it('gives no other ingestor role any AgentCore action', () => {
    const others = ['IngestorRoleWebscraperDefaultPolicy', 'IngestorRoleAppReviewsIosDefaultPolicy']
      .flatMap((prefix) => agentcoreStatements(roleStatements(template, prefix, { byIdPrefix: true })));
    expect(others).toStrictEqual([]);
  });
});
