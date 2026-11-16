/**
 * The web_reviews ingestor's AgentCore browser grants (`infrastructure.ingestor.browser`).
 *
 * By default Start/Stop (and SaveBrowserSessionProfile) are scoped to the deployment's own Web Bot Auth browser,
 * and Start and the save to its browser profile (lib/stacks/ingestion-browser.ts), never to aws.browser.v1; with
 * `-c webReviewsBotAuth=false` Start/Stop are on the AWS-managed aws.browser.v1 of the deployment's region, as before
 * 7.41.00. ConnectBrowserAutomationStream has no resource type in the service authorization reference, so it is the
 * only action granted on `*`. No other ingestor role carries any bedrock-agentcore action. (AgentCore Web Search's
 * `InvokeWebSearch`, the `auto` method's last step, is the web search capability's: ingestion-web-search.test.ts.)
 */
import type { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { byCodeUnit } from '../utils/compare';
import { type NormalizedStatement, roleStatements } from '../test-support/iam-statements';
import { SYNTH_REGION } from '../test-support/synth-app';
import { claudeRoleGrantOf, missingModelGrants } from '../test-support/bedrock-grants';
import { ALLOWED_MODEL_IDS } from '../utils/model-allowlist';
import {
  AGENTCORE_WEB_SEARCH_ACTION, BROWSER_PROFILE_SAVE_ACTION, BROWSER_SESSION_ACTIONS, BROWSER_STREAM_ACTION,
  MANAGED_BROWSER_ID,
} from './ingestion-roles';

const AGENTCORE = 'bedrock-agentcore:';
const MANAGED_BROWSER_ARN = JSON.stringify(`arn:aws:bedrock-agentcore:${SYNTH_REGION}:aws:browser/${MANAGED_BROWSER_ID}`);
const CUSTOM_BROWSER_ARN = JSON.stringify({ 'Fn::GetAtt': ['WebReviewsBrowser', 'BrowserArn'] });
const PROFILE_ARN = JSON.stringify({ 'Fn::GetAtt': ['WebReviewsBrowserProfile', 'ProfileArn'] });

/** The browser's AgentCore statements (AgentCore Web Search's is the web search capability's, pinned apart). */
function agentcoreStatements(statements: NormalizedStatement[]): NormalizedStatement[] {
  return statements.filter((s) => s.actions.some((action) => action.startsWith(AGENTCORE))
    && !s.actions.includes(AGENTCORE_WEB_SEARCH_ACTION));
}

/** `[actions, resource]` of every scoped (not `*`) AgentCore statement, actions sorted. */
function scoped(statements: NormalizedStatement[]): [string[], string][] {
  return agentcoreStatements(statements).filter((s) => s.resource !== '"*"')
    .map((s): [string[], string] => [[...s.actions].sort(byCodeUnit), s.resource]);
}

const webReviews = (template: Template) => roleStatements(template, 'IngestorRoleWebReviewsDefaultPolicy', { byIdPrefix: true });

describe('VocIngestionStack AgentCore browser grants (Web Bot Auth and a profile, the default)', () => {
  let template: Template;
  beforeAll(() => {
    template = synthIngestionTemplate(['web_reviews', 'webscraper', 'app_reviews_ios']);
  });

  it('scopes sessions to the deployment\'s own browser and its profile, never aws.browser.v1', () => {
    expect(scoped(webReviews(template))).toStrictEqual([
      [[BROWSER_PROFILE_SAVE_ACTION, ...BROWSER_SESSION_ACTIONS].sort(byCodeUnit), CUSTOM_BROWSER_ARN],
      [[BROWSER_PROFILE_SAVE_ACTION, 'bedrock-agentcore:StartBrowserSession'].sort(byCodeUnit), PROFILE_ARN],
    ]);
    expect(JSON.stringify(webReviews(template))).not.toContain(MANAGED_BROWSER_ID);
  });

  it('grants only the stream connect on "*"', () => {
    const wildcard = agentcoreStatements(webReviews(template)).filter((s) => s.resource === '"*"');
    expect(wildcard.map((s) => s.actions)).toStrictEqual([[BROWSER_STREAM_ACTION]]);
  });

  it('keeps the Bedrock model grant the bedrock capability gives', () => {
    const grant = claudeRoleGrantOf('Ingestion', template.toJSON(), 'IngestorRoleWebReviews');
    expect(missingModelGrants([grant], ALLOWED_MODEL_IDS, 'global')).toStrictEqual([]);
  });

  it('gives no other ingestor role any AgentCore action', () => {
    const others = ['IngestorRoleWebscraperDefaultPolicy', 'IngestorRoleAppReviewsIosDefaultPolicy']
      .flatMap((prefix) => agentcoreStatements(roleStatements(template, prefix, { byIdPrefix: true })));
    expect(others).toStrictEqual([]);
  });
});

describe('VocIngestionStack AgentCore browser grants, opted out', () => {
  it('scopes session start/stop to the AWS-managed browser of the region with -c webReviewsBotAuth=false', () => {
    const template = synthIngestionTemplate(['web_reviews'],
      { webReviewsBotAuth: false, webReviewsBrowserProfile: false });
    expect(scoped(webReviews(template))).toStrictEqual([[[...BROWSER_SESSION_ACTIONS].sort(byCodeUnit), MANAGED_BROWSER_ARN]]);
  });

  it('saves the profile through aws.browser.v1 when only the signing is off', () => {
    const template = synthIngestionTemplate(['web_reviews'], { webReviewsBotAuth: false });
    expect(scoped(webReviews(template))).toStrictEqual([
      [[BROWSER_PROFILE_SAVE_ACTION, ...BROWSER_SESSION_ACTIONS].sort(byCodeUnit), MANAGED_BROWSER_ARN],
      [[BROWSER_PROFILE_SAVE_ACTION, 'bedrock-agentcore:StartBrowserSession'].sort(byCodeUnit), PROFILE_ARN],
    ]);
  });

  it('starts sessions on the custom browser without a profile action when only the profile is off', () => {
    const template = synthIngestionTemplate(['web_reviews'], { webReviewsBrowserProfile: false });
    expect(scoped(webReviews(template))).toStrictEqual([[[...BROWSER_SESSION_ACTIONS].sort(byCodeUnit), CUSTOM_BROWSER_ARN]]);
  });
});
