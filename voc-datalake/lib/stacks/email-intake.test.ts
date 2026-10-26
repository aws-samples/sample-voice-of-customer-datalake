/**
 * The email inbox (lib/stacks/email-intake.ts): nothing without `-c inboundEmailDomain`, and with it
 * a scoped SES rule into an existing (or a new, never activated) rule set, the inbound bucket, the
 * intake queue + DLQ and the worker, plus DNS when a hosted zone is given.
 */
import { describe, expect, it } from 'vitest';
import { Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib';
import { IgnoreStrategy } from 'aws-cdk-lib';

import {
  EMAIL_INTAKE_OWN_EXCLUDES, INBOUND_RETENTION_DAYS, INTAKE_MAX_CONCURRENCY, INTAKE_MAX_RECEIVE_COUNT,
} from './email-intake';
import { synthIngestionStacks } from '../test-support/ingestion-stack-fixture';
import { OPTIONAL_FUNCTION_SIZES } from '../sizing/policy';
import { inboundEmailConfig, inboundEmailSettingsEnv } from '../utils/inbound-email';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';

const DOMAIN = 'voc.example.com';
const ZONE = { inboundEmailHostedZoneId: 'Z0123456789ABCDEFGHIJ' };
const EXISTING = { inboundEmailRuleSet: 'ActiveRuleSet' };

function synth(context: Record<string, unknown> = {}) {
  return synthIngestionStacks([], { inboundEmailDomain: DOMAIN, ...context });
}

const INBOX_TYPES = [
  'AWS::SES::ReceiptRule', 'AWS::SES::ReceiptRuleSet', 'AWS::SES::EmailIdentity', 'AWS::Route53::RecordSet',
] as const;

describe('email inbox: off by default', () => {
  it('creates no SES rule, identity, record, inbound bucket, intake queue or worker', () => {
    const { ingestion } = synthIngestionStacks();
    for (const type of INBOX_TYPES) expect(ingestion.findResources(type), type).toStrictEqual({});
    const names = JSON.stringify(ingestion.toJSON());
    expect(names).not.toContain('voc-email-intake');
    expect(names).not.toContain('voc-inbound-email');
  });

  it('the settings Lambda gets no inbox env', () => {
    const app = new cdk.App();
    expect(inboundEmailSettingsEnv(app.node, () => 'unused')).toStrictEqual({});
  });
});

describe('email inbox: the bundle', () => {
  const ignores = (excludes: string[], relativePath: string): boolean =>
    IgnoreStrategy.git('/root', excludes).ignores(`/root/${relativePath}`);

  it('keeps email_intake/ out of every other lambda/ bundle and in its own', () => {
    expect(ignores(PY_LAMBDA_ASSET_EXCLUDES, 'email_intake/handler.py')).toBe(true);
    const own = [...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES, ...EMAIL_INTAKE_OWN_EXCLUDES];
    expect(ignores(own, 'email_intake/handler.py')).toBe(false);
    expect(ignores(own, 'shared/aws.py')).toBe(false);
    expect(ignores(own, 'api/settings_handler.py')).toBe(true);
  });
});

describe('email inbox: the flags', () => {
  it.each([
    [{ inboundEmailDomain: 'not a host' }, /is not a hostname/],
    [{ inboundEmailDomain: DOMAIN, inboundEmailHostedZoneId: 'nope' }, /hosted zone id/],
    [{ inboundEmailDomain: DOMAIN, inboundEmailRuleSet: 'bad name!' }, /rule set name/],
    [{ inboundEmailDomain: DOMAIN, ...ZONE, inboundEmailHostedZoneName: 'other.example' }, /not inside the hosted zone/],
    [{ inboundEmailDomain: DOMAIN, inboundEmailCreateIdentity: 'ture' }, /inboundEmailCreateIdentity/],
  ])('refuses %j', (context, message) => {
    expect(() => inboundEmailConfig(new cdk.App({ context }).node)).toThrow(message);
  });

  it('derives the zone name from the domain and lower-cases the domain', () => {
    const config = inboundEmailConfig(new cdk.App({ context: { inboundEmailDomain: 'VOC.Example.com', ...ZONE } }).node);
    expect(config).toStrictEqual({ domain: DOMAIN, hostedZoneId: ZONE.inboundEmailHostedZoneId,
      hostedZoneName: 'example.com', createIdentity: true });
  });
});

describe('email inbox: joining an existing rule set, with a hosted zone', () => {
  const { ingestion, deps } = synth({ ...ZONE, ...EXISTING });

  it('adds one rule to the existing set and never creates or activates a set', () => {
    expect(Object.keys(ingestion.findResources('AWS::SES::ReceiptRuleSet')), 'AWS::SES::ReceiptRuleSet').toHaveLength(0);
    expect(() => ingestion.hasResourceProperties('AWS::SES::ReceiptRule', {
      RuleSetName: 'ActiveRuleSet',
      After: Match.absent(),
      Rule: Match.objectLike({
        Name: Match.anyValue(), Enabled: true, Recipients: [DOMAIN], ScanEnabled: true,
        TlsPolicy: 'Optional',
        Actions: [{ S3Action: Match.objectLike({ ObjectKeyPrefix: 'inbound/', KmsKeyArn: Match.absent() }) }],
      }),
    })).not.toThrow();
    expect(JSON.stringify(ingestion.toJSON())).not.toContain('SetActiveReceiptRuleSet');
  });

  it('lets SES write only inbound/* for this rule', () => {
    expect(() => ingestion.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Sid: 'SesWritesInboundEmail', Principal: { Service: 'ses.amazonaws.com' }, Action: 's3:PutObject',
        Condition: Match.objectLike({ StringEquals: Match.objectLike({ 'aws:SourceAccount': Match.anyValue() }),
          ArnLike: { 'aws:SourceArn': Match.anyValue() } }),
      })]) },
    })).not.toThrow();
  });

  it('writes the MX record and the DKIM records into the zone', () => {
    expect(() => ingestion.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'MX', Name: `${DOMAIN}.`, HostedZoneId: ZONE.inboundEmailHostedZoneId,
    })).not.toThrow();
    expect(Object.keys(ingestion.findResources('AWS::Route53::RecordSet', { Properties: { Type: 'CNAME' } })))
      .toHaveLength(3);
    expect(Object.keys(ingestion.findResources('AWS::SES::EmailIdentity')), 'AWS::SES::EmailIdentity').toHaveLength(1);
  });

  it('extends the platform key only for SES-through-S3 and S3-to-this-queue', () => {
    const policy = JSON.stringify(deps.toJSON());
    expect(policy).toContain('InboundEmailSesWritesThroughS3');
    expect(policy).toContain('kms:EncryptionContext:aws:s3:arn');
    expect(policy).toContain('InboundEmailS3NotifiesTheIntakeQueue');
    expect(policy).toContain('kms:EncryptionContext:aws:sqs:arn');
  });

  it.each([
    ['InboundEmailSesWritesThroughS3', ':receipt-rule-set/ActiveRuleSet:receipt-rule/'],
    ['InboundEmailS3NotifiesTheIntakeQueue', ':s3:::'],
  ])('scopes the key statement %s to this account and its source ARN', (sid, arnPart) => {
    const keys = Object.values(deps.findResources('AWS::KMS::Key'));
    const statements = keys.flatMap((key) => key.Properties.KeyPolicy.Statement);
    const [statement] = statements.filter((candidate) => candidate.Sid === sid);
    expect(statement.Condition.StringEquals['aws:SourceAccount']).toStrictEqual({ Ref: 'AWS::AccountId' });
    expect(JSON.stringify(statement.Condition.ArnLike['aws:SourceArn'])).toContain(arnPart);
  });

  it('expires both prefixes after the retention period', () => {
    expect(() => ingestion.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: Match.arrayWith([
        Match.objectLike({ Id: 'inbound-expiry', Prefix: 'inbound/', ExpirationInDays: INBOUND_RETENTION_DAYS }),
        Match.objectLike({ Id: 'inbound-raw-expiry', Prefix: 'inbound-raw/', ExpirationInDays: INBOUND_RETENTION_DAYS }),
      ]) },
    })).not.toThrow();
  });

  it('queues S3 events for the worker, which reports partial failures at bounded concurrency', () => {
    expect(() => ingestion.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: INTAKE_MAX_RECEIVE_COUNT }),
    })).not.toThrow();
    expect(() => ingestion.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'], ScalingConfig: { MaximumConcurrency: INTAKE_MAX_CONCURRENCY },
    })).not.toThrow();
    expect(() => ingestion.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'email_intake/handler.lambda_handler',
      Environment: { Variables: Match.objectLike({ INBOUND_EMAIL_DOMAIN: DOMAIN }) },
    })).not.toThrow();
  });

  it('sizes the worker at its pin (OPTIONAL_FUNCTION_SIZES: a context-flag function lambda-memory.test.ts cannot see)', () => {
    expect(() => ingestion.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'email_intake/handler.lambda_handler',
      MemorySize: OPTIONAL_FUNCTION_SIZES['voc-email-intake'],
    })).not.toThrow();
  });
});

describe('email inbox: its own rule set, no zone', () => {
  const { ingestion } = synth({ inboundEmailCreateIdentity: 'false' });

  it('creates its rule set and tells the operator how to activate it', () => {
    expect(Object.keys(ingestion.findResources('AWS::SES::ReceiptRuleSet')), 'AWS::SES::ReceiptRuleSet').toHaveLength(1);
    const outputs = ingestion.findOutputs('*');
    expect(Object.keys(outputs)).toStrictEqual(expect.arrayContaining([
      'InboundEmailActivateRuleSet', 'InboundEmailMxRecord', 'InboundEmailAddresses',
    ]));
  });

  it('creates no identity and no DNS record', () => {
    expect(Object.keys(ingestion.findResources('AWS::SES::EmailIdentity')), 'AWS::SES::EmailIdentity').toHaveLength(0);
    expect(Object.keys(ingestion.findResources('AWS::Route53::RecordSet')), 'AWS::Route53::RecordSet').toHaveLength(0);
  });

  it('the settings Lambda is told the set needs activation', () => {
    const app = new cdk.App({ context: { inboundEmailDomain: DOMAIN } });
    expect(inboundEmailSettingsEnv(app.node, () => 'own-set')).toStrictEqual({
      INBOUND_EMAIL_DOMAIN: DOMAIN, INBOUND_EMAIL_RULE_SET: 'own-set', INBOUND_EMAIL_RULE_SET_OWNED: '1',
    });
  });
});

describe('email inbox: data protection', () => {
  const inboundBucket = (context: Record<string, unknown>) => {
    const { ingestion } = synth(context);
    const buckets = ingestion.findResources('AWS::S3::Bucket');
    const entry = Object.entries(buckets).find(([id]) => id.startsWith('InboundEmailBucket'))?.[1];
    return { entry, ingestion };
  };

  it('keeps the original emails on stack deletion under -c protectData=true', () => {
    const { entry } = inboundBucket({ protectData: 'true' });
    expect(entry?.DeletionPolicy).toBe('RetainExceptOnCreate');
    expect(JSON.stringify(entry?.Properties?.Tags ?? [])).not.toContain('aws-cdk:auto-delete-objects');
  });

  it('is emptied and deleted with the stack without protectData (demos)', () => {
    const { entry } = inboundBucket({});
    expect(entry?.DeletionPolicy).toBe('Delete');
    expect(JSON.stringify(entry?.Properties?.Tags ?? [])).toContain('aws-cdk:auto-delete-objects');
  });
});
