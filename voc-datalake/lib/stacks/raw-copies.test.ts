/**
 * Every ingested source keeps a raw copy (wave B, decision 3): the writers that were not plugins get
 * a write-once put on their OWN raw prefix (put only: never a read, never a delete) and the
 * connector-version they record (APP_VERSION). The bucket policy (core-buckets.ts) refuses any put
 * under raw/ without If-None-Match; the Python side is lambda/shared/raw_copy.py.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { apiTemplate, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { synthIngestionStacks } from '../test-support/ingestion-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { appVersion } from '../utils/connector-version';
import { byCodeUnit } from '../utils/compare';
import { WORKSPACE_ID_PATTERN } from './core-buckets';
import { IMPORT_STAGED_EXPIRATION_DAYS } from './ingestion-stack';

interface Statement { actions: string[]; resource: string }

/** The s3: actions `statements` allow on objects under `prefix` of the raw bucket. */
function s3ActionsUnder(statements: readonly Statement[], prefix: string): string[] {
  return [...new Set(statements.filter((s) => s.resource.includes(`/${prefix}`)).flatMap((s) => s.actions)
    .filter((a) => a.startsWith('s3:')))].sort(byCodeUnit);
}

/** grantPut's object actions (PutObject and its tagging / retention / legal-hold siblings, Abort*), nothing else. */
function expectPutOnly(statements: readonly Statement[], prefix: string): void {
  const actions = s3ActionsUnder(statements, prefix);
  expect(actions).toContain('s3:PutObject');
  expect(actions.filter((a) => !a.startsWith('s3:PutObject') && a !== 's3:Abort*')).toStrictEqual([]);
}

/** Every raw-bucket object grant of the role names exactly `prefix` (no wider raw/* or bucket-wide put). */
function expectOnlyPrefix(statements: readonly Statement[], prefix: string): void {
  const raw = statements.filter((s) => s.resource.includes('/raw/'));
  expect(raw.length).toBeGreaterThan(0);
  for (const s of raw) expect(s.resource).toContain(`/${prefix}`);
}

describe('raw copies: the API writers', () => {
  let template: Template;
  beforeAll(() => { template = apiTemplate(); }, SYNTH_TIMEOUT_MS);

  it.each([
    ['FeedbackFormLambdaRole', 'raw/feedback_form/*', 'voc-feedback-form-api'],
    ['EngagementLambdaRole', 'raw/feature_requests/*', 'voc-engagement-api'],
  ])('%s may only put under %s, and its Lambda records the app version', (role, prefix, service) => {
    const statements = policyStatementsOf(template, role);
    expectPutOnly(statements, prefix);
    expectOnlyPrefix(statements, prefix);
    const env = serviceEnvironment(template, service);
    expect(env['APP_VERSION']).toBe(appVersion());
    expect(env['RAW_DATA_BUCKET']).toBeDefined();
  });

  it('the Data Explorer records the app version on a raw object it creates', () => {
    expect(serviceEnvironment(template, 'voc-data-explorer-api')['APP_VERSION']).toBe(appVersion());
  });
});

describe('raw copies: the processor fallback', () => {
  let template: Template;
  beforeAll(() => { template = synthProcessingTemplate(); }, SYNTH_TIMEOUT_MS);

  it('may put under raw/ (any source: the fallback writes the message source) but never read or delete it', () => {
    const statements = policyStatementsOf(template, 'ProcessingLambdaRole');
    expectPutOnly(statements, 'raw/*');
  });

  it('may put a workspace message\'s copies under ws/{one id}/raw/ and ws/{one id}/silver/, put only', () => {
    const statements = policyStatementsOf(template, 'ProcessingLambdaRole');
    const oneWorkspace = `ws/${WORKSPACE_ID_PATTERN}`;
    expectPutOnly(statements, `${oneWorkspace}/raw/*`);
    expect(s3ActionsUnder(statements, `${oneWorkspace}/silver/*`)).toStrictEqual(['s3:PutObject']);
    // Never the whole ws/ tree, nor a pattern that crosses a workspace's folder (IAM's * matches /).
    const workspaceGrants = statements.filter((s) => s.resource.includes('/ws/'));
    expect(workspaceGrants.length).toBeGreaterThan(0);
    for (const s of workspaceGrants) expect(s.resource).toContain(`/${oneWorkspace}/`);
  });

  it('the processor gets the bucket and the app version', () => {
    const env = serviceEnvironment(template, 'voc-processor');
    expect(env['APP_VERSION']).toBe(appVersion());
    expect(env['RAW_DATA_BUCKET']).toBeDefined();
  });
});

describe('raw copies: the email inbox (-c inboundEmailDomain)', () => {
  let template: Template;
  beforeAll(() => { template = synthIngestionStacks([], { inboundEmailDomain: 'voc.example.com' }).ingestion; },
    SYNTH_TIMEOUT_MS);

  it('the intake may only put under raw/email_intake/, and records the app version', () => {
    const statements = policyStatementsOf(template, 'EmailIntakeRole');
    expectPutOnly(statements, 'raw/email_intake/*');
    expectOnlyPrefix(statements, 'raw/email_intake/*');
    const env = serviceEnvironment(template, 'voc-email-intake');
    expect(env['APP_VERSION']).toBe(appVersion());
    expect(env['RAW_DATA_BUCKET']).toBeDefined();
  });
});

describe('raw copies: the S3 import reprocess message', () => {
  it('names the staged-file expiry the import bucket really has', () => {
    expect(serviceEnvironment(apiTemplate(), 'voc-s3-import-api')['IMPORT_STAGED_EXPIRATION_DAYS'])
      .toBe(String(IMPORT_STAGED_EXPIRATION_DAYS));
  });
});
