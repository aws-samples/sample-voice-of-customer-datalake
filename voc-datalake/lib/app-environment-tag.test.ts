/**
 * The `Environment` cost tag follows the `environment` context key (cdk.context.json),
 * the same key the API stack reads for its CORS mode. It used to default to 'dev' from
 * CDK_ENV alone, so a production deployment was tagged dev.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SYNTH_TIMEOUT_MS, cleanupAssemblyDirs, synthApp } from './test-support/synth-app';

const TaggedResources = z.record(
  z.string(),
  z.object({ Type: z.string(), Properties: z.object({ Tags: z.array(z.object({ Key: z.string(), Value: z.string() })).optional() }).optional() }),
);

/** The Environment tag values on every DynamoDB table of the core stack. */
function coreTableEnvironmentTags(context: Record<string, unknown>): string[] {
  const resources = TaggedResources.parse(synthApp(context).template('VocCoreStack').Resources);
  return Object.values(resources)
    .filter((resource) => resource.Type === 'AWS::DynamoDB::Table')
    .flatMap((resource) => resource.Properties?.Tags ?? [])
    .filter((tag) => tag.Key === 'Environment')
    .map((tag) => tag.Value);
}

afterAll(cleanupAssemblyDirs);

describe('Environment cost tag', { timeout: SYNTH_TIMEOUT_MS }, () => {
  it('tags a production deployment production', () => {
    expect([...new Set(coreTableEnvironmentTags({ environment: 'production' }))]).toStrictEqual(['production']);
  });

  it('tags a dev deployment dev', () => {
    expect([...new Set(coreTableEnvironmentTags({ environment: 'dev' }))]).toStrictEqual(['dev']);
  });
});
