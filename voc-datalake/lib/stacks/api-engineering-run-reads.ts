/**
 * The Agents API's reads of a run's own objects for the run workspace (7.51.00; lambda/engineering/run_objects.py,
 * views_thread.py, views_inspector.py, run_overview.py), with `-c engineeringAgents=true` only. Beside the reports it
 * already reads (api-assistant-lambdas.ts), exactly:
 *
 * - `s3:GetObject` on the agents' transcripts, patches and gate records
 *   (`ws/default/runs/<run>/<agent>/commits/<sha>/{_transcripts,_patches,_gate}/…`) and the runs' manifests
 *   (`ws/default/runs/<run>/_manifest/…`): an agent's thread, its changes (the patches the gate judged and the committer
 *   pushed, D51-1), its gate tab, an ended run's manifest;
 * - `s3:ListBucket` on the bucket with `s3:prefix` held to the transcripts' and patches' prefixes alone (as Learn's
 *   `LearnListsTranscripts`): an attempt's chunks and patches are found by listing them; a gate record and a manifest
 *   are read by the keys the layout spells, never listed.
 *
 * No Put, no Delete, no other run object (a checkpoint, a finding, a seed). The objects' key is the reports' own
 * `EngineeringReportsKey` (kms:Decrypt through S3 alone). The workspace is spelled out (`ws/default/…`): an IAM wildcard
 * crosses `/`.
 */
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';

import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { ENGINEERING_WORKSPACE } from './core-buckets';

const RUN_AGENT_COMMITS = `ws/${ENGINEERING_WORKSPACE}/runs/*/*/commits/*`;
/** An agent's transcript chunks (runtime/harness/transcript.py). */
export const RUN_TRANSCRIPT_KEYS = `${RUN_AGENT_COMMITS}/_transcripts/*`;
/** An agent's patches: the submitted ones and each checkpoint's (runtime/harness/tools.py snapshot). */
export const RUN_PATCH_KEYS = `${RUN_AGENT_COMMITS}/_patches/*`;
/** An agent's gate record (`…/_gate/attempt-<n>/record.json`, quality_gate/record.py). */
export const RUN_GATE_KEYS = `${RUN_AGENT_COMMITS}/_gate/*`;
/** A run's manifest versions (runtime/manifest.py). */
export const RUN_MANIFEST_KEYS = `ws/${ENGINEERING_WORKSPACE}/runs/*/_manifest/*`;
/** What the role may list: an attempt's transcript chunks and its patches. */
export const RUN_LISTED_PREFIXES = [RUN_TRANSCRIPT_KEYS, RUN_PATCH_KEYS];

export function grantEngineeringRunReads(role: iam.Role, bucket: s3.IBucket): void {
  const objects = [RUN_TRANSCRIPT_KEYS, RUN_PATCH_KEYS, RUN_GATE_KEYS, RUN_MANIFEST_KEYS]
    .map((keys) => bucket.arnForObjects(keys));
  role.addToPolicy(new iam.PolicyStatement({ sid: 'EngineeringRunObjects', actions: ['s3:GetObject'], resources: objects }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'EngineeringRunListings', actions: ['s3:ListBucket'], resources: [bucket.bucketArn],
    conditions: { StringLike: { 's3:prefix': RUN_LISTED_PREFIXES } },
  }));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'Read-only on the agents\' transcripts, patches and gate records and the runs\' manifests (one per run, agent, '
      + 'commit and attempt, known only at run time), and a listing held to the transcripts\' and patches\' prefixes',
    findings: objects.map(resourceFinding),
  }]);
}
