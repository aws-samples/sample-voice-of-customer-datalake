/**
 * Who may delete customer data, across the WHOLE app (every stack, real entrypoint).
 *
 * Customer data is never deleted except by the opt-in per-source retention /
 * erasure worker, voc-retention (docs/source-policies.md). Per-role suites pin
 * least privilege role by role; this one pins the complete inventory so a NEW
 * role that gains a delete on the feedback table or on the raw archive fails here
 * even when nobody wrote a per-role case for it.
 *
 * LEGACY entries: broad `grantReadWriteData` / `grantReadWrite` grants that predate
 * this inventory and carry delete actions their handlers never call (the processor
 * and the webhook write feedback with Put/Update only; the ingestors and manual
 * import only put raw objects). They are frozen here — not endorsed — so the set
 * can only shrink. Narrowing them is a separate, deliberate change.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cleanupAssemblyDirs, synthApp } from './test-support/synth-app';
import { byCodeUnit } from './utils/compare';

const RETENTION_ROLE = 'VocProcessingStack/RetentionWorkerRetentionRole';

const FEEDBACK_DELETERS = [
  'VocApiStack/WebhookLambdaRole', // LEGACY
  'VocProcessingStack/ProcessingLambdaRole', // LEGACY
  RETENTION_ROLE,
];

const RAW_ARCHIVE_DELETERS = [
  'VocApiStack/ManualImportLambdaRole', // LEGACY
  'VocIngestionStack/IngestionLambdaRole', // LEGACY
  // LEGACY too: the same base ingestion grant (lib/stacks/ingestion-roles.ts), on the
  // dedicated role a scheduled plugin gets for its circuit breaker since 3.05.00.
  'VocIngestionStack/IngestorRoleAppReviewsAndroid',
  'VocIngestionStack/IngestorRoleAppReviewsIos',
  'VocIngestionStack/IngestorRoleGithubIssues',
  'VocIngestionStack/IngestorRoleSyntheticReviews', // LEGACY
  'VocIngestionStack/IngestorRoleWebscraper',
  RETENTION_ROLE,
];

const StatementSchema = z.object({
  Effect: z.string().optional(),
  Action: z.union([z.string(), z.array(z.string())]),
  Resource: z.unknown(),
});
const PolicySchema = z.object({
  Type: z.literal('AWS::IAM::Policy'),
  Properties: z.object({ PolicyDocument: z.object({ Statement: z.array(StatementSchema) }) }),
});
const TemplateSchema = z.object({ Resources: z.record(z.string(), z.unknown()) });

interface Grant { role: string; actions: string[]; resource: string }

const FEEDBACK_DELETE = /^dynamodb:(DeleteItem|BatchWriteItem|\*)$/;
const S3_DELETE = /^s3:(Delete.*|\*)$/;

/** `<Stack>/<RoleId>` for a CDK default policy logical id (`<RoleId>DefaultPolicy<hash>`). */
function roleOf(stack: string, policyId: string): string {
  return `${stack}/${policyId.replace(/DefaultPolicy[0-9A-F]{8}$/, '')}`;
}

const synthed = synthApp();
afterAll(cleanupAssemblyDirs);

function allowGrants(): Grant[] {
  return synthed.stackNames.flatMap((stack) => {
    const { Resources } = TemplateSchema.parse(synthed.template(stack));
    return Object.entries(Resources).flatMap(([id, resource]) => {
      const policy = PolicySchema.safeParse(resource);
      if (!policy.success) return [];
      return policy.data.Properties.PolicyDocument.Statement
        .filter((statement) => (statement.Effect ?? 'Allow') === 'Allow')
        .map((statement) => ({
          role: roleOf(stack, id),
          actions: [statement.Action].flat(),
          resource: JSON.stringify(statement.Resource),
        }));
    });
  });
}

// Parsed once: every case filters the same statements.
const grants = allowGrants();

function holders(matches: (grant: Grant) => boolean): string[] {
  return [...new Set(grants.filter(matches).map((grant) => grant.role))].sort(byCodeUnit);
}

/** Covers objects under raw/: the whole bucket (`/*`) or a `raw/` prefix. */
const coversRawArchive = (resource: string) =>
  resource.includes('RawDataBucket') && (resource.includes('"/*"') || resource.includes('/raw/'));

describe('customer-data deletes across every stack', () => {
  it('only the frozen inventory plus voc-retention may delete feedback items', () => {
    expect(holders((g) => g.resource.includes('FeedbackTable') && g.actions.some((a) => FEEDBACK_DELETE.test(a))))
      .toStrictEqual([...FEEDBACK_DELETERS].sort(byCodeUnit));
  });

  it('only the frozen inventory plus voc-retention may delete raw-archive objects', () => {
    expect(holders((g) => coversRawArchive(g.resource) && g.actions.some((a) => S3_DELETE.test(a))))
      .toStrictEqual([...RAW_ARCHIVE_DELETERS].sort(byCodeUnit));
  });

  it('voc-retention deletes only under raw/, never bucket-wide', () => {
    const rawDeletes = grants.filter((g) => g.role === RETENTION_ROLE && g.actions.some((a) => S3_DELETE.test(a)));
    expect(rawDeletes.map((g) => g.resource.includes('/raw/*') && !g.resource.includes('"/*"'))).toStrictEqual([true]);
  });
});
