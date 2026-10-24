/**
 * The email inbox (docs/email-intake.md), VocIngestionStack, created ONLY with `-c inboundEmailDomain`:
 *
 *   sender -> MX -> SES receiving (spam/virus scan) -> S3 `inbound/` -> SQS `voc-email-intake` (+DLQ)
 *     -> `voc-email-intake` Lambda -> the processing queue
 *
 * - The inbound bucket is private, versioned, KMS-encrypted (the platform key) and access-logged
 *   (`createPrivateVersionedBucket`); `inbound/` (as SES wrote it) and `inbound-raw/` (the original
 *   of every accepted email) expire after INBOUND_RETENTION_DAYS.
 * - SES may write ONLY `inbound/*`, and only for THIS receipt rule (`aws:SourceAccount` +
 *   `aws:SourceArn`). Its KMS use goes through S3 for this bucket only (`kms:ViaService` +
 *   the `aws:s3:arn` encryption context); S3's use of the key for the notification goes through
 *   SQS for this queue only (the `aws:sqs:arn` encryption context). Both statements name the
 *   bucket and queue by their deterministic names, so the platform key's policy (VocCoreStack)
 *   takes no reference to this stack.
 * - The rule joins an EXISTING rule set (`-c inboundEmailRuleSet`) or a new one of ours, which is
 *   never activated here (see lib/utils/inbound-email.ts).
 * - With a hosted zone CDK writes the MX record and the identity's DKIM CNAMEs; without one the
 *   records to add are stack outputs.
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEvents from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

import { createPrivateVersionedBucket } from './core-buckets';
import { dataProtectionOf } from '../utils/data-protection';
import type { InboundEmailConfig } from '../utils/inbound-email';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { pythonLambdaAsset } from '../utils/python-lambda-asset';
import { stackModelArns } from '../utils/model-allowlist';
import { bedrockModelSuppressions } from '../utils/nag-suppressions';
import { PII_REDACTION_ENV, piiDetectionStatement } from '../utils/pii-redaction';

/** `inbound/` and `inbound-raw/` keep an email this many days (plan Q6, option a). */
export const INBOUND_RETENTION_DAYS = 90;
/** A deleted or overwritten version is gone after a day: the copies are already short-lived. */
const NONCURRENT_VERSION_DAYS = 1;
const INTAKE_TIMEOUT = cdk.Duration.minutes(5);
/** Receives before the DLQ: a deferral (model budget spent) costs up to two per day. */
export const INTAKE_MAX_RECEIVE_COUNT = 8;
/** At most this many intake workers at once: bounds Bedrock/Comprehend spend under a mail burst. */
export const INTAKE_MAX_CONCURRENCY = 2;
const INTAKE_BATCH_SIZE = 5;
/** The prefix SES writes; the S3 notification, the bucket policy and the Lambda all key on it. */
const INBOUND_PREFIX = 'inbound/';
const INBOUND_RAW_PREFIX = 'inbound-raw/';
const HANDLER = 'email_intake/handler.lambda_handler';
/**
 * This bundle's own excludes, after the shared lists: re-include its tree (the shared list drops
 * /email_intake/ for every other bundle) and drop every other handler tree.
 */
export const EMAIL_INTAKE_OWN_EXCLUDES = [
  '!/email_intake/',
  '/aggregator/', '/api/', '/jobs/', '/processor/', '/product_doc_extractor/', '/research/',
];
/** The addresses the inbox answers (ALIASES in lambda/shared/email_intake_settings.py). */
const INBOX_ALIASES = ['feedback', 'ideas', 'bugs', 'reviews'] as const;
const MX_PRIORITY = 10;

/** SES's receiving endpoint for the stack's region (the MX target). */
function inboundSmtpHost(): string {
  return `inbound-smtp.${cdk.Aws.REGION}.amazonaws.com`;
}

interface EmailIntakeNames {
  readonly bucket: string;
  readonly queue: string;
  readonly dlq: string;
  readonly functionName: string;
  readonly logGroup: string;
  readonly rule: string;
  /** Used only when no existing rule set is given. */
  readonly ownRuleSet: string;
}

export interface EmailIntakeProps {
  readonly config: InboundEmailConfig;
  readonly names: EmailIntakeNames;
  readonly kmsKey: kms.Key;
  readonly accessLogsBucket: s3.IBucket;
  readonly watermarksTable: dynamodb.ITable;
  readonly aggregatesTable: dynamodb.ITable;
  readonly processingQueue: sqs.IQueue;
  readonly layer: lambda.ILayerVersion;
  readonly denyInsecureTransport: (queue: sqs.Queue) => void;
}

/** S3 -> SQS without SqsDestination's unconditioned key-policy statement (see the file comment). */
class ScopedQueueDestination implements s3.IBucketNotificationDestination {
  constructor(private readonly queue: sqs.Queue, private readonly bucketArn: string) {}

  bind(): s3.BucketNotificationDestinationConfig {
    // A queue resource-policy statement, NOT grantSendMessages: on a KMS queue that would also add
    // the principal (with this bucket's ARN) to the platform key's policy in VocCoreStack, a
    // cross-stack cycle. keyStatements() grants S3 the key, scoped to this queue.
    this.queue.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
      actions: ['sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
      resources: [this.queue.queueArn],
      conditions: { ArnLike: { 'aws:SourceArn': this.bucketArn }, StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID } },
    }));
    return { arn: this.queue.queueArn, type: s3.BucketNotificationDestinationType.QUEUE, dependencies: [this.queue] };
  }
}

function inboundBucket(scope: Construct, props: EmailIntakeProps): s3.Bucket {
  const expire = cdk.Duration.days(INBOUND_RETENTION_DAYS);
  return createPrivateVersionedBucket(scope, 'InboundEmailBucket', {
    bucketName: props.names.bucket,
    // The originals here are the ONLY copy of a received email (a redact profile keeps no raw
    // archive), so -c protectData keeps them on stack deletion like the raw lake; they still
    // expire after INBOUND_RETENTION_DAYS by lifecycle.
    protection: dataProtectionOf(scope),
    kmsKey: props.kmsKey,
    accessLogsBucket: props.accessLogsBucket,
    accessLogPrefix: 'inbound-email-bucket/',
    lifecycleRules: [
      { id: 'inbound-expiry', prefix: INBOUND_PREFIX, expiration: expire },
      { id: 'inbound-raw-expiry', prefix: INBOUND_RAW_PREFIX, expiration: expire },
      {
        id: 'version-hygiene',
        noncurrentVersionExpiration: cdk.Duration.days(NONCURRENT_VERSION_DAYS),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
      },
      { id: 'remove-expired-delete-markers', expiredObjectDeleteMarker: true },
    ],
  });
}

function intakeQueues(scope: Construct, props: EmailIntakeProps): { queue: sqs.Queue; dlq: sqs.Queue } {
  const dlq = new sqs.Queue(scope, 'EmailIntakeDLQ', {
    queueName: props.names.dlq,
    encryption: sqs.QueueEncryption.KMS,
    encryptionMasterKey: props.kmsKey,
    retentionPeriod: cdk.Duration.days(14),
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const queue = new sqs.Queue(scope, 'EmailIntakeQueue', {
    queueName: props.names.queue,
    encryption: sqs.QueueEncryption.KMS,
    encryptionMasterKey: props.kmsKey,
    visibilityTimeout: cdk.Duration.seconds(INTAKE_TIMEOUT.toSeconds() * 6),
    retentionPeriod: cdk.Duration.days(14),
    deadLetterQueue: { queue: dlq, maxReceiveCount: INTAKE_MAX_RECEIVE_COUNT },
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  props.denyInsecureTransport(dlq);
  props.denyInsecureTransport(queue);
  return { queue, dlq };
}

function intakeCode(): lambda.Code {
  // Staged from lambda/, pruned to email_intake/ and shared/. PY_LAMBDA_ASSET_EXCLUDES drops
  // /email_intake/ for every OTHER bundle; the negation re-includes it for this one.
  return pythonLambdaAsset('lambda', {
    exclude: [
      ...PY_LAMBDA_ASSET_EXCLUDES,
      ...WORKER_TREE_ASSET_EXCLUDES,
      ...EMAIL_INTAKE_OWN_EXCLUDES,
    ],
    copy: ['mkdir -p /asset-output', 'cp -r /asset-input/email_intake /asset-output/', 'cp -r /asset-input/shared /asset-output/'],
  });
}

function intakeRole(scope: Construct, props: EmailIntakeProps, bucket: s3.Bucket): iam.Role {
  const stack = cdk.Stack.of(scope);
  const role = new iam.Role(scope, 'EmailIntakeRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
  });
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:DeleteObject'], resources: [bucket.arnForObjects(`${INBOUND_PREFIX}*`)],
  }));
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['s3:PutObject'], resources: [bucket.arnForObjects(`${INBOUND_RAW_PREFIX}*`)],
  }));
  props.kmsKey.grantEncryptDecrypt(role);
  props.watermarksTable.grant(role, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem');
  // Caps row, the day's counters, the source profiles and the model picker's settings.
  props.aggregatesTable.grant(role, 'dynamodb:GetItem', 'dynamodb:UpdateItem');
  props.processingQueue.grantSendMessages(role);
  role.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: stackModelArns(stack) }));
  role.addToPolicy(piiDetectionStatement());
  NagSuppressions.addResourceSuppressions(role, [
    ...bedrockModelSuppressions,
    {
      id: 'AwsSolutions-IAM5',
      reason: 'Object-level S3 actions are scoped to the inbox prefixes (inbound/*, inbound-raw/*) of the '
        + 'inbox bucket only',
      appliesTo: [{ regex: '/^Resource::<InboundEmailBucket.*\\.Arn>/inbound(-raw)?/\\*$/g' }],
    },
  ], true);
  return role;
}

function intakeFunction(scope: Construct, props: EmailIntakeProps, bucket: s3.Bucket, queue: sqs.Queue): lambda.Function {
  const fn = new lambda.Function(scope, 'EmailIntakeFunction', {
    functionName: props.names.functionName,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: HANDLER,
    code: intakeCode(),
    role: intakeRole(scope, props, bucket),
    timeout: INTAKE_TIMEOUT,
    memorySize: 1024, // CPU: 87.0 % p95 at 512 MB, 2026-10-18 (OPTIONAL_FUNCTION_SIZES, lib/sizing/policy.ts)
    layers: [props.layer],
    environment: {
      WATERMARKS_TABLE: props.watermarksTable.tableName,
      AGGREGATES_TABLE: props.aggregatesTable.tableName,
      INBOUND_BUCKET: bucket.bucketName,
      PROCESSING_QUEUE_URL: props.processingQueue.queueUrl,
      INTAKE_QUEUE_URL: queue.queueUrl,
      INBOUND_EMAIL_DOMAIN: props.config.domain,
      POWERTOOLS_SERVICE_NAME: 'voc-email-intake',
      LOG_LEVEL: 'INFO',
      ...PII_REDACTION_ENV,
    },
    logGroup: new logs.LogGroup(scope, 'EmailIntakeLogs', {
      logGroupName: props.names.logGroup,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });
  fn.addEventSource(new lambdaEvents.SqsEventSource(queue, {
    batchSize: INTAKE_BATCH_SIZE, reportBatchItemFailures: true, maxConcurrency: INTAKE_MAX_CONCURRENCY,
  }));
  return fn;
}

function ruleArn(config: InboundEmailConfig, names: EmailIntakeNames): string {
  const ruleSet = config.existingRuleSet ?? names.ownRuleSet;
  return `arn:${cdk.Aws.PARTITION}:ses:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:receipt-rule-set/${ruleSet}:receipt-rule/${names.rule}`;
}

/**
 * The platform key may serve SES (through S3, for this bucket) and S3 (through SQS, for this queue),
 * each only when the call comes from this account and from THIS receipt rule / THIS bucket
 * (`aws:SourceAccount` + `aws:SourceArn`, the confused-deputy guard).
 */
function keyStatements(props: EmailIntakeProps): void {
  const bucketArn = `arn:${cdk.Aws.PARTITION}:s3:::${props.names.bucket}`;
  const sourceAccount = { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID };
  props.kmsKey.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'InboundEmailSesWritesThroughS3',
    principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
    actions: ['kms:GenerateDataKey*', 'kms:Encrypt'],
    resources: ['*'],
    conditions: {
      StringEquals: { 'kms:ViaService': `s3.${cdk.Aws.REGION}.amazonaws.com`, ...sourceAccount },
      StringLike: { 'kms:EncryptionContext:aws:s3:arn': [bucketArn, `${bucketArn}/${INBOUND_PREFIX}*`] },
      ArnLike: { 'aws:SourceArn': ruleArn(props.config, props.names) },
    },
  }));
  props.kmsKey.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'InboundEmailS3NotifiesTheIntakeQueue',
    principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
    actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
    resources: ['*'],
    conditions: {
      StringEquals: {
        'kms:EncryptionContext:aws:sqs:arn':
          `arn:${cdk.Aws.PARTITION}:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:${props.names.queue}`,
        ...sourceAccount,
      },
      ArnLike: { 'aws:SourceArn': bucketArn },
    },
  }));
}

function receiptRule(scope: Construct, props: EmailIntakeProps, bucket: s3.Bucket): void {
  const { config, names } = props;
  const policy = bucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'SesWritesInboundEmail',
    principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
    actions: ['s3:PutObject'],
    resources: [bucket.arnForObjects(`${INBOUND_PREFIX}*`)],
    conditions: {
      StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
      ArnLike: { 'aws:SourceArn': ruleArn(config, names) },
    },
  }));
  const ruleSetName = config.existingRuleSet ?? names.ownRuleSet;
  const rule = new ses.CfnReceiptRule(scope, 'InboundEmailRule', {
    ruleSetName,
    rule: {
      name: names.rule,
      enabled: true,
      recipients: [config.domain],
      scanEnabled: true,
      // Public senders: TLS is accepted, never required.
      tlsPolicy: 'Optional',
      actions: [{ s3Action: { bucketName: bucket.bucketName, objectKeyPrefix: INBOUND_PREFIX } }],
    },
  });
  // SES writes a setup object while the rule is created: the bucket policy must exist first.
  if (policy.policyDependable) rule.node.addDependency(policy.policyDependable);
  if (config.existingRuleSet === undefined) {
    const ruleSet = new ses.CfnReceiptRuleSet(scope, 'InboundEmailRuleSet', { ruleSetName });
    rule.addDependency(ruleSet);
    new cdk.CfnOutput(scope, 'InboundEmailActivateRuleSet', {
      description: 'This rule set is NOT active. Only one rule set is active per region: activate it only if no other '
        + 'receiving rule set is needed, or rerun with -c inboundEmailRuleSet=<the active set>.',
      value: `aws ses set-active-receipt-rule-set --rule-set-name ${ruleSetName} --region ${cdk.Aws.REGION}`,
    });
  }
}

function dnsRecords(scope: Construct, config: InboundEmailConfig): void {
  const mx = `${MX_PRIORITY} ${inboundSmtpHost()}`;
  const zone = config.hostedZoneId === undefined || config.hostedZoneName === undefined
    ? undefined
    : route53.PublicHostedZone.fromPublicHostedZoneAttributes(scope, 'InboundEmailZone', {
      hostedZoneId: config.hostedZoneId, zoneName: config.hostedZoneName,
    });
  if (zone) {
    new route53.MxRecord(scope, 'InboundEmailMx', {
      zone, recordName: `${config.domain}.`,
      values: [{ priority: MX_PRIORITY, hostName: inboundSmtpHost() }],
    });
  } else {
    new cdk.CfnOutput(scope, 'InboundEmailMxRecord', { description: `Add this MX record for ${config.domain}`, value: mx });
  }
  if (!config.createIdentity) return;
  const identity = new ses.EmailIdentity(scope, 'InboundEmailIdentity', { identity: ses.Identity.domain(config.domain) });
  identity.dkimRecords.forEach((record, index) => {
    if (zone) {
      new route53.CnameRecord(scope, `InboundEmailDkim${index + 1}`, {
        zone, recordName: `${record.name}.`, domainName: record.value,
      });
      return;
    }
    new cdk.CfnOutput(scope, `InboundEmailDkimRecord${index + 1}`, {
      description: `Add this DKIM CNAME for ${config.domain}`, value: `${record.name} CNAME ${record.value}`,
    });
  });
}

/** Everything the inbox needs. Call it only when `inboundEmailConfig()` returned a config. */
export function createEmailIntake(scope: Construct, props: EmailIntakeProps): void {
  const bucket = inboundBucket(scope, props);
  const { queue, dlq } = intakeQueues(scope, props);
  keyStatements(props);
  bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new ScopedQueueDestination(queue, bucket.bucketArn),
    { prefix: INBOUND_PREFIX });
  intakeFunction(scope, props, bucket, queue);
  receiptRule(scope, props, bucket);
  dnsRecords(scope, props.config);
  new cdk.CfnOutput(scope, 'InboundEmailAddresses', {
    value: INBOX_ALIASES.map((alias) => `${alias}@${props.config.domain}`).join(','),
  });
  new cdk.CfnOutput(scope, 'InboundEmailBucketName', { value: bucket.bucketName });
  new cdk.CfnOutput(scope, 'InboundEmailDlqUrl', { value: dlq.queueUrl });
}
