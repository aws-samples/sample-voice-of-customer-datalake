/**
 * Synthesizes VocCoreStack alone, under cdk.json's committed feature flags (see
 * the CDK_FEATURE_FLAGS comment in core-stack.test.ts for why the flags matter).
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { VocCoreStack } from '../stacks/core-stack';
import { SYNTH_ACCOUNT, SYNTH_REGION, committedFeatureFlags } from './synth-app';

export function synthCoreTemplate(context: Record<string, unknown> = {}): Template {
  // Skip asset bundling (Docker) — template assertions only need structure.
  const app = new cdk.App({
    context: {
      ...committedFeatureFlags(),
      'aws:cdk:bundling-stacks': [],
      skipFrontendBuildCheck: true,
      ...context,
    },
  });
  const stack = new VocCoreStack(app, 'TestCoreStack', {
    env: { account: SYNTH_ACCOUNT, region: SYNTH_REGION },
    brandName: 'TestBrand',
  });
  return Template.fromStack(stack);
}
