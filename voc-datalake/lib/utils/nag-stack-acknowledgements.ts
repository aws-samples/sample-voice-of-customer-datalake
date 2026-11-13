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
import {
  WORKSPACE_EXPORTS_PREFIX, WORKSPACE_RAW_LAYER_PREFIX, WORKSPACE_SILVER_HISTORY_PREFIX,
} from '../stacks/core-buckets';
import { acknowledgeNag } from './nag-ack';
import {
  rawDataPrefixSuppressions, s3ObjectSuppressions,
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
    // raw/* and ws/{one id}/raw/*: a plugin ingestor's deployment-wide run writes raw/, a run in a workspace only that
    // workspace's bronze layer, ws/{ws}/raw/ (write-once Puts).
    ...s3ObjectSuppressions([
      raw.arnForObjects('raw/*'), raw.arnForObjects(`${WORKSPACE_RAW_LAYER_PREFIX}*`), ingestion.s3ImportBucket.arnForObjects('*'),
    ]),
    ...rawDataPrefixSuppressions(raw, [
      'company-context/design/logo_preview_*', 'company-context/design/icons_*', 'raw/email_intake/*',
    ]),
  ]);
  acknowledgeNag(processing, [
    // silver/*: the processor and the reprocess worker keep an item's previous version (write-once Put), and
    // voc-retention deletes those versions with the item (lambda/shared/silver_provenance.py). ws/{one id}/raw/* and
    // ws/{one id}/silver/*: the processor's write-once Puts for a workspace's message (docs/multi-workspace.md).
    ...s3ObjectSuppressions([
      raw.arnForObjects('raw/*'), raw.arnForObjects('silver/*'),
      raw.arnForObjects(`${WORKSPACE_RAW_LAYER_PREFIX}*`), raw.arnForObjects(`${WORKSPACE_SILVER_HISTORY_PREFIX}*`),
      // ws/{one id}/exports/*: a workspace's export, written by voc-workspace-export, and deleted with every version
      // by voc-retention when an erasure reaches that workspace (a derived copy, TENETS.md D5).
      raw.arnForObjects(`${WORKSPACE_EXPORTS_PREFIX}*`),
      // ws/{one id}/exports/*/work/*: the work objects an export that may not go on deletes (its own only).
      raw.arnForObjects(`${WORKSPACE_EXPORTS_PREFIX}*/work/*`),
    ]),
    ...rawDataPrefixSuppressions(raw, ['memory-imports/*', 'prototypes/*', 'scratch/research_jobs/*']),
  ]);
  acknowledgeNag(api, [
    ...s3ObjectSuppressions([
      // silver/*: the feedback-edit API keeps the review as it was before an edit (write-once Put); ws/{one id}/silver/*
      // a workspace's review (docs/multi-workspace.md).
      raw.arnForObjects('*'), raw.arnForObjects('raw/*'), raw.arnForObjects('silver/*'),
      raw.arnForObjects(`${WORKSPACE_SILVER_HISTORY_PREFIX}*`),
      // ws/{one id}/raw/feedback_form/*: the feedback-form API's write-once copy of a workspace form's submission
      // (lambda/shared/feedback_form_raw.py), as raw/feedback_form/* below for a deployment form; and
      // ws/{one id}/raw/github_issues/*: the GitHub webhook's archive of a delivery to a workspace's endpoint
      // (plugins/_shared/base_webhook.py), as raw/github_issues/* below for the deployment's.
      raw.arnForObjects(`${WORKSPACE_RAW_LAYER_PREFIX}feedback_form/*`),
      raw.arnForObjects(`${WORKSPACE_RAW_LAYER_PREFIX}github_issues/*`),
      // ws/{one id}/exports/*: a workspace's export, signed for download by the workspaces API
      // (lib/stacks/api-workspace-export.ts; each object's name is the job's, never a caller's).
      raw.arnForObjects(`${WORKSPACE_EXPORTS_PREFIX}*`),
      ingestion.s3ImportBucket.arnForObjects('*'),
      core.websiteBucket.arnForObjects('*'),
    ]),
    ...rawDataPrefixSuppressions(raw, [
      'avatars/*', 'company-context/*', 'company-context/design/logo_preview_*', 'company-context/design/icons_*',
      'memory-imports/*', 'projects/*/product_docs/*', 'projects/*/product_docs/extracted/*', 'prototypes/*',
      'raw/github_issues/*', 'raw/feedback_form/*', 'raw/feature_requests/*', 'scratch/document_jobs/*',
    ]),
  ]);
}
