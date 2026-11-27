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
  WORKSPACE_EXPORTS_PREFIX, WORKSPACE_LIBRARY_PREFIX, WORKSPACE_MEMORY_IMPORTS_PREFIX, WORKSPACE_OBJECTS_PREFIX,
  WORKSPACE_RAW_LAYER_PREFIX, WORKSPACE_SILVER_HISTORY_PREFIX,
} from '../stacks/core-buckets';
import { DEPLOYMENT_PRODUCT_DOC_READS, LIBRARY_TEXT_READS, WORKSPACE_PRODUCT_DOC_READS } from '../stacks/retention-worker';
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
    // ws/{one id}/memory-imports/*: the memory extractor reads a workspace's imported page.
    ...s3ObjectSuppressions([
      raw.arnForObjects('raw/*'), raw.arnForObjects('silver/*'),
      raw.arnForObjects(`${WORKSPACE_RAW_LAYER_PREFIX}*`), raw.arnForObjects(`${WORKSPACE_SILVER_HISTORY_PREFIX}*`),
      raw.arnForObjects(`${WORKSPACE_MEMORY_IMPORTS_PREFIX}*`),
      // ws/{one id}/exports/*: a workspace's export, written by voc-workspace-export, and deleted with every version
      // by voc-retention when an erasure reaches that workspace (a derived copy, TENETS.md D5).
      raw.arnForObjects(`${WORKSPACE_EXPORTS_PREFIX}*`),
      // ws/{one id}/exports/*/work/*: the work objects an export that may not go on deletes (its own only).
      raw.arnForObjects(`${WORKSPACE_EXPORTS_PREFIX}*/work/*`),
      // ws/{one id}/*: every object of one workspace, read (GetObject only) into its export by voc-workspace-export
      // (slice 4b; lambda/shared/ws_repo.py WorkspaceObjects reads the event's workspace only, never its exports).
      raw.arnForObjects(WORKSPACE_OBJECTS_PREFIX),
      // ws/{one id}/projects/*/product_docs/raw/* and …/extracted/*: voc-retention reads a workspace's text product
      // documents for an erased address (GetObject only; lambda/jobs/retention/project_people.py, 7.43.00).
      ...WORKSPACE_PRODUCT_DOC_READS.map((key) => raw.arnForObjects(key)),
      // projects/*/product_docs/extracted/*: voc-retention reads the deployment's product documents' extracted text
      // for an erased address (GetObject only, never an upload; 7.48.00).
      ...DEPLOYMENT_PRODUCT_DOC_READS.map((key) => raw.arnForObjects(key)),
      // library/*/extracted and ws/{one id}/library/*/extracted: voc-retention reads the Documents Library's extracted
      // text for an erased address (GetObject only, never an original; 7.62.00).
      ...LIBRARY_TEXT_READS.map((key) => raw.arnForObjects(key)),
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
      // ws/{one id}/raw/*: the manual-import API's write-once archives of an import in a workspace (7.67.00, the
      // import wizard; lambda/shared/raw_versions.py raw_root), as raw/* above for the deployment's: one workspace id
      // per pattern, its bronze layer only (api-data-lambdas.ts ManualImportLambdaRole).
      raw.arnForObjects(`${WORKSPACE_RAW_LAYER_PREFIX}*`),
      // ws/{one id}/memory-imports/*: the memory API keeps a workspace's imported page (and the extractor reads it).
      raw.arnForObjects(`${WORKSPACE_MEMORY_IMPORTS_PREFIX}*`),
      // ws/{one id}/exports/*: a workspace's export, signed for download by the workspaces API
      // (lib/stacks/api-workspace-export.ts; each object's name is the job's, never a caller's).
      raw.arnForObjects(`${WORKSPACE_EXPORTS_PREFIX}*`),
      // ws/{one id}/library/*: a workspace's Documents Library, as library/* below for the deployment's (7.62.00: the
      // projects API's presigned uploads and downloads, extracted text and deletes; lambda/shared/library_objects.py).
      raw.arnForObjects(`${WORKSPACE_LIBRARY_PREFIX}*`),
      ingestion.s3ImportBucket.arnForObjects('*'),
      core.websiteBucket.arnForObjects('*'),
    ]),
    ...rawDataPrefixSuppressions(raw, [
      'avatars/*', 'company-context/*', 'company-context/design/logo_preview_*', 'company-context/design/icons_*',
      'library/*', 'memory-imports/*', 'projects/*/product_docs/*',
      // The document generator's read of the product sources (7.104.00): their text and an image upload, never source/.
      'projects/*/product_docs/extracted/*', 'projects/*/product_docs/raw/*',
      'prototypes/*', 'raw/github_issues/*', 'raw/feedback_form/*', 'raw/feature_requests/*', 'scratch/document_jobs/*',
      // With -c voicePersonas=true (7.69.00): the projects API's voice sessions' scratch files.
      'scratch/voice/*',
    ]),
  ]);
}
