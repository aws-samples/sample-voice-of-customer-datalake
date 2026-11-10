/**
 * The acknowledgement lists of nag-suppressions.ts name exactly the findings their reasons describe.
 *
 * cdk-nag 3 matches an acknowledgement to a finding by its exact id, so what is pinned here is the RENDERED
 * id (lib/utils/nag-ack.ts `renderNagFinding`): each list builder turns the resource it is handed into the
 * id cdk-nag reports for that grant, from the stack that holds the grant (a cross-stack reference becomes
 * the producer's export name), and nothing broader. lib/nag-suppressions.test.ts then proves, over the real
 * app, that every rendered id matches a finding cdk-nag computes.
 */
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { IConstruct } from 'constructs';
import { describe, expect, it } from 'vitest';

import { acknowledgeNag, acknowledgementsOn, renderNagFinding, type NagAck } from './nag-ack';
import {
  cdkAssetsSuppressions, rawDataPrefixSuppressions,
  s3ObjectSuppressions,
} from './nag-suppressions';

const env = { account: '111111111111', region: 'us-east-1' };

function fixture() {
  const app = new cdk.App();
  const producer = new cdk.Stack(app, 'pfx-Producer', { env });
  const consumer = new cdk.Stack(app, 'pfx-Consumer', { env });
  const bucket = new s3.Bucket(producer, 'Raw', { enforceSSL: true, versioned: true });
  return { producer, consumer, bucket };
}

/** The logical id of `construct`'s CloudFormation resource. */
function logicalId(construct: IConstruct): string {
  const cfn = construct.node.defaultChild;
  if (!(cfn instanceof cdk.CfnElement)) throw new Error(`${construct.node.path} has no CloudFormation resource`);
  return cdk.Stack.of(cfn).getLogicalId(cfn);
}

const rendered = (scope: cdk.Stack, acks: readonly NagAck[]) =>
  acks.flatMap((ack) => (ack.findings ?? []).map((finding) => renderNagFinding(scope, finding)));

describe('nag-suppressions.ts list builders', () => {
  it('renders a cross-stack grant through the producer\'s export', () => {
    const { consumer, bucket } = fixture();
    const [imported, ...rest] = rendered(consumer, s3ObjectSuppressions([bucket.arnForObjects('*')]));
    expect(rest).toStrictEqual([]);
    // The export name CDK gives the automatic cross-stack reference: `<producer>:ExportsOutputFnGetAtt<id>Arn<hash>`.
    expect(imported).toMatch(new RegExp(`^Resource::pfx-Producer:ExportsOutputFnGetAtt${logicalId(bucket)}Arn[0-9A-F]{8}/\\*$`));
  });

  it('names each object grant and raw-bucket prefix exactly, never the bucket or another prefix', () => {
    const { producer, bucket } = fixture();
    const arn = `<${logicalId(bucket)}.Arn>`;
    expect(rendered(producer, s3ObjectSuppressions([bucket.arnForObjects('*'), bucket.arnForObjects('raw/*')])))
      .toStrictEqual([`Resource::${arn}/*`, `Resource::${arn}/raw/*`]);
    expect(rendered(producer, rawDataPrefixSuppressions(bucket, ['avatars/*', 'projects/*/product_docs/extracted/*'])))
      .toStrictEqual([`Resource::${arn}/avatars/*`, `Resource::${arn}/projects/*/product_docs/extracted/*`]);
  });

  it('names the stack\'s own bootstrap asset bucket', () => {
    const { consumer } = fixture();
    // `stack.formatArn`, like the asset bucket CDK grants on: this bare App has no partition-literals flag, so
    // the partition stays the pseudo parameter (the app's cdk.json renders `arn:aws:`).
    expect(rendered(consumer, cdkAssetsSuppressions(consumer)))
      .toStrictEqual(['Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-111111111111-us-east-1/*']);
  });
});

describe('acknowledgeNag', () => {
  it('records one acknowledgement per finding, with the reason', () => {
    const { producer, bucket } = fixture();
    acknowledgeNag(producer, [{ id: 'AwsSolutions-IAM5', reason: 'a reason long enough', findings: ['Action::kms:ReEncrypt*'] }]);
    acknowledgeNag(producer, s3ObjectSuppressions([bucket.arnForObjects('*')]));
    expect(acknowledgementsOn(producer).map((ack) => ack.id)).toStrictEqual([
      'AwsSolutions-IAM5[Action::kms:ReEncrypt*]', `AwsSolutions-IAM5[Resource::<${logicalId(bucket)}.Arn>/*]`,
    ]);
    expect(acknowledgementsOn(producer)[0]?.reason).toBe('a reason long enough');
  });

  it('refuses a missing reason and an empty finding list', () => {
    const { producer } = fixture();
    expect(() => acknowledgeNag(producer, [{ id: 'AwsSolutions-SQS3', reason: 'short' }])).toThrow(/reason/);
    expect(() => acknowledgeNag(producer, [{ id: 'AwsSolutions-IAM5', reason: 'a reason long enough', findings: [] }]))
      .toThrow(/no finding/);
  });
});
