/**
 * What every ingestion choke point needs to apply a source's PII policy BEFORE
 * the raw archive and the processing queue (lambda/shared/source_policy.py,
 * docs/source-policies.md): the source profile row (aggregates GetItem, read
 * through `shared/source_profiles.cached_source_profile` on AGGREGATES_TABLE)
 * and Comprehend PII detection for names/addresses.
 *
 * One definition so the manual import, feedback form, data explorer, webhook and
 * plugin-ingestor roles cannot drift apart (pinned by pii-redaction.test.ts).
 */
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * `PII_COMPREHEND=1` turns on Comprehend `DetectPiiEntities` (NAME/ADDRESS) on top
 * of the always-on regex redaction — only for the languages Comprehend PII
 * supports (en, es); everything else keeps the regex result.
 */
export const PII_REDACTION_ENV: Readonly<Record<string, string>> = { PII_COMPREHEND: '1' };

/** Comprehend PII detection. Comprehend's detect APIs have no resource-level ARN. */
export function piiDetectionStatement(): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'ComprehendPiiDetection',
    actions: ['comprehend:DetectPiiEntities'],
    resources: ['*'],
  });
}
