/**
 * Test support: VocIngestionStack synthesized against throwaway dependency
 * tables, buckets and key — shared by the ingestion-stack and DLQ-alarm suites.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';

import { VocIngestionStack } from '../stacks/ingestion-stack';
import { pkSkTable } from './api-stack-fixture';
import { fixtureBucket } from './fixture-resources';
import { SYNTH_ACCOUNT, SYNTH_REGION, committedFeatureFlags } from './synth-app';

/** The stack with `enabledSources` switched on (none by default: no scheduled plugin). */
export function synthIngestionTemplate(enabledSources: string[] = []): Template {
  const env = { account: SYNTH_ACCOUNT, region: SYNTH_REGION };
  const app = new cdk.App({
    context: { ...committedFeatureFlags(), 'aws:cdk:bundling-stacks': [] },
  });
  const deps = new cdk.Stack(app, 'Deps', { env });
  const stack = new VocIngestionStack(app, 'Ingestion', {
    env,
    watermarksTable: pkSkTable(deps, 'Watermarks'),
    aggregatesTable: pkSkTable(deps, 'Aggregates'),
    rawDataBucket: fixtureBucket(deps, 'RawData'),
    accessLogsBucket: fixtureBucket(deps, 'AccessLogs'),
    kmsKey: new kms.Key(deps, 'Key'),
    config: { brandName: 'Test', primaryLanguage: 'en', enabledSources },
    frontendDomain: 'app.example.invalid',
  });
  return Template.fromStack(stack);
}
