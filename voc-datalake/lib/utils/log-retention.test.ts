/**
 * Every Lambda the app synthesizes logs to a log group with a retention period (lib/utils/log-retention.ts).
 *
 * Found in the 5.25.03 logging audit: the functions CDK creates for us (S3 auto-delete and bucket-notification
 * providers, BucketDeployment's singleton) had no LoggingConfig, so Lambda created their log groups with no
 * retention and those logs never expired. The cross-region export providers are added after aspects run
 * and are the documented exception.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cleanupAssemblyDirs, synthApp, SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import type { SynthResult } from '../test-support/synth-app';
import { byCodeUnit } from './compare';

const ResourceSchema = z.object({ Type: z.string(), Properties: z.record(z.string(), z.unknown()).optional() });
const TemplateSchema = z.object({ Resources: z.record(z.string(), ResourceSchema) });
const LoggingSchema = z.object({ LogGroup: z.object({ Ref: z.string() }) });

/** Added by CDK during synthesis, after aspects: they cannot be reached (see log-retention.ts). */
const CROSS_REGION_PROVIDER = /^CustomCrossRegionExport(Reader|Writer)CustomResourceProviderHandler/;

describe('Lambda log retention', () => {
  let synth: SynthResult;
  beforeAll(() => { synth = synthApp(); }, SYNTH_TIMEOUT_MS);
  afterAll(() => { cleanupAssemblyDirs(); });

  it('gives every function a log group in its own stack with a retention period', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const stack of synth.stackNames) {
      const { Resources } = TemplateSchema.parse(synth.template(stack));
      for (const [id, resource] of Object.entries(Resources)) {
        if (resource.Type !== 'AWS::Lambda::Function' || CROSS_REGION_PROVIDER.test(id)) continue;
        checked += 1;
        const logging = LoggingSchema.safeParse(resource.Properties?.LoggingConfig);
        const group = logging.success ? Resources[logging.data.LogGroup.Ref] : undefined;
        const retention = group?.Type === 'AWS::Logs::LogGroup' ? group.Properties?.RetentionInDays : undefined;
        if (typeof retention !== 'number') problems.push(`${stack}/${id}`);
      }
    }
    expect(checked).toBeGreaterThan(60);
    expect([...problems].sort(byCodeUnit)).toStrictEqual([]);
  });
});
