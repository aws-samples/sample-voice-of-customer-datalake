/**
 * The ModelPin custom resource (VocCoreStack, core-auth.ts) writes the default model pin with one UpdateItem on the
 * aggregates table, which is encrypted with the customer-managed data key. A write there needs kms:Decrypt; without
 * it every FRESH deployment rolled VocCoreStack back ("not authorized to perform: kms:Decrypt"). This pins the
 * deployed role, not only the grant helper (lib/utils/table-write-grants.test.ts).
 *
 * ModelPin exists only with `-c defaultModelId` (the workshop artifacts pass it), so the default synth pinned by
 * lib/test-support/baseline.json has no ModelPin at all: this suite synthesizes with the value the workshop script
 * passes, read from package.json so the two cannot drift.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cleanupAssemblyDirs, synthApp, SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

const ResourcesSchema = z.object({ Resources: z.record(z.string(), z.object({ Type: z.string(), Properties: z.unknown() })) });
const PolicySchema = z.object({
  Roles: z.array(z.unknown()).optional(),
  PolicyDocument: z.object({
    Statement: z.array(z.object({ Effect: z.string(), Action: z.union([z.string(), z.array(z.string())]), Resource: z.unknown() })),
  }),
});
const PackageJsonSchema = z.object({ scripts: z.record(z.string(), z.string()) });

/** The `-c defaultModelId=…` of `npm run generate:workshop-artifacts`. */
function workshopModelId(): string {
  const { scripts } = PackageJsonSchema.parse(JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')));
  const match = /-c\s+defaultModelId=(\S+)/.exec(scripts['generate:workshop-artifacts'] ?? '');
  if (!match?.[1]) throw new Error('generate:workshop-artifacts passes no -c defaultModelId');
  return match[1];
}

afterAll(cleanupAssemblyDirs);

describe('ModelPin custom resource (VocCoreStack)', () => {
  it('can decrypt with the data key that encrypts the aggregates table it writes', () => {
    const { Resources } = ResourcesSchema.parse(synthApp({ defaultModelId: workshopModelId() }).template('VocCoreStack'));
    const logicalId = (prefix: string, type: string): string => {
      const found = Object.keys(Resources).filter((id) => id.startsWith(prefix) && Resources[id]?.Type === type);
      expect(found, `${prefix} (${type})`).toHaveLength(1);
      return found[0] ?? '';
    };
    const roleRef = JSON.stringify({ Ref: logicalId('ModelPinLambdaServiceRole', 'AWS::IAM::Role') });
    const keyArn = { 'Fn::GetAtt': [logicalId('VocKmsKey', 'AWS::KMS::Key'), 'Arn'] };
    const onKey = [JSON.stringify(keyArn), JSON.stringify([keyArn])];

    const actions = Object.values(Resources)
      .filter((r) => r.Type === 'AWS::IAM::Policy')
      .map((r) => PolicySchema.parse(r.Properties))
      .filter((p) => (p.Roles ?? []).some((r) => JSON.stringify(r) === roleRef))
      .flatMap((p) => p.PolicyDocument.Statement)
      .filter((s) => s.Effect === 'Allow' && onKey.includes(JSON.stringify(s.Resource)))
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions).toContain('kms:Decrypt');
  }, SYNTH_TIMEOUT_MS);
});
