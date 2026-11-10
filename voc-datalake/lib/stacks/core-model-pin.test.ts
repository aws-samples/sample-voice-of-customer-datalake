/**
 * The ModelPin custom resource (VocCoreStack, core-auth.ts) writes the default model pin with one UpdateItem on the
 * aggregates table, which is encrypted with the customer-managed data key. A write there needs kms:Decrypt; without
 * it every FRESH deployment rolled VocCoreStack back ("not authorized to perform: kms:Decrypt"). This pins the
 * deployed role, not only the grant helper (lib/utils/table-write-grants.test.ts).
 *
 * ModelPin exists only with `-c defaultModelId` (the workshop artifacts pass it), so the default synth pinned by
 * lib/test-support/baseline.json has no ModelPin at all: this suite synthesizes with the workshop's value.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cleanupAssemblyDirs, synthApp, SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

const ResourcesSchema = z.object({ Resources: z.record(z.string(), z.object({ Type: z.string(), Properties: z.unknown() })) });
const PolicySchema = z.object({
  Roles: z.array(z.object({ Ref: z.string() })),
  PolicyDocument: z.object({
    Statement: z.array(z.object({ Effect: z.string(), Action: z.union([z.string(), z.array(z.string())]), Resource: z.unknown() })),
  }),
});

/** The value `npm run generate:workshop-artifacts` passes. */
const WORKSHOP_MODEL_ID = 'global.anthropic.claude-sonnet-4-6';

afterAll(cleanupAssemblyDirs);

describe('ModelPin custom resource (VocCoreStack)', SYNTH_TIMEOUT_MS, () => {
  const { Resources } = ResourcesSchema.parse(synthApp({ defaultModelId: WORKSHOP_MODEL_ID }).template('VocCoreStack'));
  const logicalId = (prefix: string, type: string): string => {
    const found = Object.keys(Resources).filter((id) => id.startsWith(prefix) && Resources[id]?.Type === type);
    expect(found, `${prefix} (${type})`).toHaveLength(1);
    return found[0] ?? '';
  };

  it('can decrypt with the data key that encrypts the aggregates table it writes', () => {
    const role = logicalId('ModelPinLambdaServiceRole', 'AWS::IAM::Role');
    const key = logicalId('VocKmsKey', 'AWS::KMS::Key');
    const keyArn = JSON.stringify({ 'Fn::GetAtt': [key, 'Arn'] });
    const actions = Object.values(Resources)
      .filter((r) => r.Type === 'AWS::IAM::Policy')
      .map((r) => PolicySchema.parse(r.Properties))
      .filter((p) => p.Roles.some((r) => r.Ref === role))
      .flatMap((p) => p.PolicyDocument.Statement)
      .filter((s) => s.Effect === 'Allow' && JSON.stringify(s.Resource) === keyArn)
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions).toContain('kms:Decrypt');
  });
});
