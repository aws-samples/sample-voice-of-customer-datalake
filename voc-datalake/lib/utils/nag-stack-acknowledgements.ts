/**
 * The stack-wide cdk-nag acknowledgements of the four core stacks (bin/voc-datalake.ts applies them).
 *
 * cdk-nag 3 acknowledges each finding exactly, so every stack names the buckets and key prefixes ITS
 * roles are granted (the lists cdk-nag 2's stack-wide regexes matched in the 5.73.02 synth, both the default
 * and the all-features shape). A grant on another table or prefix is reported, not silently covered.
 *
 * VocWebSearchStack deliberately gets NONE: the gateway half has always passed cdk-nag unacknowledged (its
 * IAM is scoped to the concrete gateway ARN), and the use-case half carries its own resource-scoped
 * acknowledgements inside AnthropicUseCaseSubmission.
 */
import type { VocApiStack } from '../stacks/api-stack';
import type { VocCoreStack } from '../stacks/core-stack';
import type { VocIngestionStack } from '../stacks/ingestion-stack';
import type { VocProcessingStack } from '../stacks/processing-stack-consolidated';
import { acknowledgeNag } from './nag-ack';
import {
  bedrockModelSuppressions, rawDataPrefixSuppressions, s3ObjectSuppressions,
} from './nag-suppressions';

export interface CoreStacks {
  readonly core: VocCoreStack;
  readonly ingestion: VocIngestionStack;
  readonly processing: VocProcessingStack;
  readonly api: VocApiStack;
}

export function acknowledgeStackFindings({ core, ingestion, processing, api }: CoreStacks): void {
  const raw = core.rawDataBucket;
  acknowledgeNag(ingestion, [
    ...s3ObjectSuppressions([raw.arnForObjects('raw/*'), ingestion.s3ImportBucket.arnForObjects('*')]),
    ...rawDataPrefixSuppressions(raw, [
      'company-context/design/logo_preview_*', 'company-context/design/icons_*', 'raw/email_intake/*',
    ]),
  ]);
  acknowledgeNag(processing, [
    ...s3ObjectSuppressions([raw.arnForObjects('raw/*')]),
    ...rawDataPrefixSuppressions(raw, ['memory-imports/*', 'prototypes/*', 'scratch/research_jobs/*']),
    ...bedrockModelSuppressions,
  ]);
  acknowledgeNag(api, [
    ...s3ObjectSuppressions([
      raw.arnForObjects('*'), raw.arnForObjects('raw/*'), ingestion.s3ImportBucket.arnForObjects('*'),
      core.websiteBucket.arnForObjects('*'),
    ]),
    ...rawDataPrefixSuppressions(raw, [
      'avatars/*', 'company-context/*', 'company-context/design/logo_preview_*', 'company-context/design/icons_*',
      'memory-imports/*', 'projects/*/product_docs/*', 'projects/*/product_docs/extracted/*', 'prototypes/*',
      'raw/github_issues/*', 'raw/feedback_form/*', 'raw/feature_requests/*', 'scratch/document_jobs/*',
    ]),
    ...bedrockModelSuppressions,
  ]);
}
