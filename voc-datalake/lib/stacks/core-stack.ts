import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import { uniqueName } from '../utils/naming';
import { ALLOWED_MODEL_IDS } from '../utils/model-allowlist';
import { NagSuppressions } from 'cdk-nag';
import { idempotencyTableSuppressions, websiteBucketSuppressions, cloudfrontDefaultCertSuppressions, cognitoSecuritySuppressions, cdkCustomResourceSuppressions, lambdaBasicExecutionRoleSuppressions, cdnSigningKeySuppressions, dynamoDbGsiSuppressions, kmsEncryptionSuppressions } from '../utils/nag-suppressions';

export interface VocCoreStackProps extends cdk.StackProps {
  brandName: string;
}

/**
 * VocCoreStack - Consolidated foundational resources
 * 
 * Merges: VocStorageStack + VocAuthStack + VocFrontendInfraStack
 * 
 * Contains:
 * - DynamoDB tables (feedback, aggregates, watermarks, projects, jobs, conversations, idempotency)
 * - KMS encryption key
 * - S3 buckets (raw data, access logs)
 * - CloudFront distributions (avatars CDN, frontend hosting)
 * - Cognito User Pool + Client
 */
export class VocCoreStack extends cdk.Stack {
  // Storage exports
  public readonly feedbackTable: dynamodb.Table;
  public readonly aggregatesTable: dynamodb.Table;
  public readonly watermarksTable: dynamodb.Table;
  public readonly projectsTable: dynamodb.Table;
  public readonly jobsTable: dynamodb.Table;
  public readonly conversationsTable: dynamodb.Table;
  public readonly idempotencyTable: dynamodb.Table;
  public readonly kmsKey: kms.Key;
  public readonly rawDataBucket: s3.Bucket;
  public readonly accessLogsBucket: s3.Bucket;
  public readonly avatarsCdnUrl: string;
  public readonly prototypesCdnUrl: string;

  // CloudFront URL-signing material for the private /avatars/* and
  // /prototypes/* paths. Consumed by the API stack, whose Lambdas mint signed
  // URLs for the browser (issue #229).
  //
  // The ARN is exported as a STRING, not the Secret construct, and deliberately:
  // `secret.grantRead(role)` on a CMK-encrypted secret adds a KMS KEY-POLICY
  // statement naming the grantee, and since the key lives here while the roles
  // live in the API stack, that makes CoreStack reference ApiStack and
  // CloudFormation rejects the cycle. Consumers add an explicit
  // `secretsmanager:GetSecretValue` statement instead — the same pattern the
  // ingestion `secretsArn` already uses — and get KMS access from the
  // kmsKey.grantEncryptDecrypt/grantDecrypt calls they already have.
  public readonly cdnSigningSecretArn: string;
  public readonly cdnSigningKeyPairId: string;

  // Frontend infrastructure exports
  public readonly frontendDistribution: cloudfront.Distribution;
  public readonly websiteBucket: s3.Bucket;
  public readonly frontendDomainName: string;

  // Auth exports
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;
  public readonly identityPool: cognito.CfnIdentityPool;
  public readonly authenticatedRole: iam.Role;

  constructor(scope: Construct, id: string, props: VocCoreStackProps) {
    super(scope, id, props);

    // Base CORS origins for localhost development
    const corsAllowedOriginsBase = ['http://localhost:5173', 'http://localhost:3000'];

    // ============================================
    // KMS KEY
    // ============================================
    this.kmsKey = new kms.Key(this, 'VocKmsKey', {
      alias: uniqueName('voc-datalake-key'),
      description: 'KMS key for VoC Data Lake encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ============================================
    // S3 BUCKETS
    // ============================================
    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      bucketName: uniqueName('voc-access-logs'),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    });

    this.rawDataBucket = new s3.Bucket(this, 'RawDataBucket', {
      bucketName: uniqueName('voc-raw-data'),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'raw-data-bucket/',
      cors: [{
        // PUT is required for browser-side presigned uploads (project product docs).
        // The CloudFront domain is not known at bucket-creation time (the frontend
        // distribution references this bucket in its behaviors, so using its domain
        // token here would create a circular dependency) — a *.cloudfront.net
        // wildcard is safe because presigned URLs remain the actual auth gate.
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
        allowedOrigins: [...corsAllowedOriginsBase, 'https://*.cloudfront.net'],
        allowedHeaders: ['*'],
        maxAge: 3600,
      }],
    });

    // Frontend hosting bucket
    this.websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketName: uniqueName('voc-frontend'),
      encryption: s3.BucketEncryption.S3_MANAGED,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    NagSuppressions.addResourceSuppressions(this.websiteBucket, websiteBucketSuppressions);

    // ============================================
    // CLOUDFRONT DISTRIBUTIONS
    // ============================================
    
    // Security headers policy
    const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeadersPolicy', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          // frame-src 'self': required so the SPA can embed generated prototype HTML via
          // <iframe src="https://<this-domain>/prototypes/*"> (PR #131 Finding 3 fix). This is
          // a SEPARATE concern from frame-ancestors below: frame-ancestors governs who may embed
          // THIS page, frame-src governs what THIS page may embed. Without it, frame-src falls
          // back to default-src 'none' and blocks framing of anything, even same-origin content —
          // the /prototypes/* behavior's own PrototypeHeadersPolicy (script-src 'unsafe-inline')
          // still governs script execution inside that framed document; this only permits the
          // cross-document load itself.
          contentSecurityPolicy: `default-src 'none'; font-src 'self' data:; img-src 'self' data:; script-src 'self';manifest-src 'self'; style-src 'unsafe-inline' 'self'; style-src-elem 'unsafe-inline' 'self'; object-src 'none'; frame-src 'self'; connect-src 'self' https://*.amazoncognito.com https://*.amazonaws.com https://*.lambda-url.${cdk.Stack.of(this).region}.on.aws; upgrade-insecure-requests; frame-ancestors 'none'; base-uri 'none';`,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.seconds(63072000),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
    });

    // Frontend hosting distribution (created first so we can use its domain for CORS)
    this.frontendDistribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeadersPolicy,
      },
      defaultRootObject: 'index.html',
      // SPA deep-link routing: an unknown path is not a real 404, it is a
      // client-side route, so it has to return index.html.
      //
      // 403 IS DELIBERATELY NOT MAPPED HERE (issue #229). Custom error
      // responses are distribution-WIDE — CloudFront gives no way to scope
      // them per behavior — so a 403 rule laundered EVERY denial on this
      // distribution into a 200 carrying index.html. That is precisely why
      // unauthenticated access to /avatars/* and /prototypes/* went unnoticed,
      // and with trustedKeyGroups in place it would be actively harmful: a
      // rejected prototype request would render the entire SPA inside the
      // prototype iframe instead of failing, and no test could tell allow from
      // deny. Deep links keep working through the 404 rule because the
      // s3:ListBucket grant below makes S3 answer 404 (not 403) for a missing
      // key.
      errorResponses: [
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableLogging: true,
      logBucket: this.accessLogsBucket,
      logFilePrefix: 'cloudfront-frontend/',
    });
    NagSuppressions.addResourceSuppressions(this.frontendDistribution, cloudfrontDefaultCertSuppressions);
    this.frontendDomainName = this.frontendDistribution.distributionDomainName;

    // Let CloudFront distinguish "missing object" from "not allowed" on the SPA
    // bucket. Without s3:ListBucket, S3 answers 403 for a key that does not
    // exist (it will not confirm absence to a caller that cannot list), which
    // forced the 403 -> index.html mapping removed above and with it the
    // laundering of every genuine denial into a 200 (issue #229). With the
    // grant, an unknown SPA route is a clean 404 and the 404 rule serves the
    // app shell.
    //
    // Scoped to this distribution and to the SPA bucket ONLY. The raw-data
    // bucket deliberately does NOT get it: there, 403-for-missing-key is the
    // desired answer, since confirming whether a given avatar or prototype key
    // exists is itself information we do not owe an unauthenticated viewer.
    this.websiteBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      resources: [this.websiteBucket.bucketArn],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': cdk.Stack.of(this).formatArn({
            service: 'cloudfront',
            region: '',
            resource: 'distribution',
            resourceName: this.frontendDistribution.distributionId,
          }),
        },
      },
    }));

    // ── Signed-URL trust for the private CDN paths (issue #229) ──────────────
    // /avatars/* and /prototypes/* used to be world-readable: Cognito is
    // enforced at API Gateway, never at the CDN, and both were plain cache
    // behaviors on the distribution that must stay public to serve the login
    // page. They are now restricted to a trusted key group, so a viewer needs
    // a signature the already-authenticated API mints per request.
    //
    // The keypair is generated at DEPLOY time by a custom resource which writes
    // the private half straight to Secrets Manager and returns only the public
    // half. Generating at SYNTH time would break the deterministic-synth
    // guarantee that core-stack.test.ts asserts, and a KMS asymmetric key
    // cannot stand in — kms:Sign has no SHA-1 option and CloudFront requires
    // RSA-SHA1. CloudFormation still owns the PublicKey and KeyGroup below, so
    // their create/update/delete ordering is not hand-rolled.
    const cdnSigningSecret = new secretsmanager.Secret(this, 'CdnSigningKeySecret', {
      secretName: uniqueName('voc-cdn-signing-key'),
      description: 'RSA private key that signs CloudFront URLs for /avatars/* and /prototypes/*',
      encryptionKey: this.kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cdnSigningKeysLambda = new lambda.Function(this, 'CdnSigningKeysLambda', {
      functionName: uniqueName('voc-cdn-signing-keys'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'cdn_signing_keys.handler',
      // Node rather than Python: crypto.generateKeyPairSync is stdlib, so this
      // needs no layer. Python would need `cryptography`, i.e. Docker bundling
      // in CoreStack. Real, unit-tested file (lib/stacks/cdn-signing-keys.test.ts).
      //
      // fromAsset, NOT fromInline: at ~7KB this handler is comfortably past the
      // widely-cited 4096-character ceiling for an inline `Code.ZipFile`. In
      // practice CloudFormation accepted it and aws-cdk-lib 2.261.0 does not
      // check the limit at all, so the inline version deployed fine — but that
      // is undocumented tolerance, and this is a sample repo other people deploy
      // into their own accounts. An asset removes the question, and removes the
      // trap where adding a comment to the handler breaks a deploy.
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/custom_resources'), {
        // Ship only the Node handler. The directory also holds the Python
        // admin-bootstrap handler and its pytest suite, which would otherwise
        // be packaged into this function's zip.
        //
        // These patterns match AT ANY DEPTH, not just the top level: the default
        // IgnoreMode.GLOB uses .gitignore semantics, where a pattern containing
        // no slash matches by basename anywhere in the tree. Verified by staging
        // a nested `.py` and confirming it was excluded, so `**/*.py` is not
        // needed. The deployed zip contains exactly one file.
        exclude: ['*.py', '*.d.ts', 'test', '__pycache__'],
      }),
      timeout: cdk.Duration.minutes(1),
      description: 'Generates the CloudFront URL-signing keypair once, then reuses it',
      logGroup: new logs.LogGroup(this, 'CdnSigningKeysLambdaLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    // GetSecretValue is what makes the handler idempotent (reuse over rotate);
    // PutSecretValue writes the generated key.
    // Safe to use the L2 grants here: this Lambda is in THIS stack, so the
    // KMS key-policy statement they add names a same-stack role and creates no
    // cross-stack cycle (unlike the API stack's roles — see cdnSigningSecretArn).
    cdnSigningSecret.grantRead(cdnSigningKeysLambda);
    cdnSigningSecret.grantWrite(cdnSigningKeysLambda);
    this.cdnSigningSecretArn = cdnSigningSecret.secretArn;

    const cdnSigningKeysProvider = new cr.Provider(this, 'CdnSigningKeysProvider', {
      onEventHandler: cdnSigningKeysLambda,
      // Same reasoning as AdminBootstrapProvider: at INFO the provider
      // framework logs the whole custom-resource response to CloudWatch. The
      // response carries only the PUBLIC key, but keeping this at FATAL means a
      // future field added to Data cannot leak by default.
      frameworkLambdaLoggingLevel: lambda.ApplicationLogLevel.FATAL,
      logGroup: new logs.LogGroup(this, 'CdnSigningKeysProviderLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    const cdnSigningKeys = new cdk.CustomResource(this, 'CdnSigningKeys', {
      serviceToken: cdnSigningKeysProvider.serviceToken,
      resourceType: 'Custom::CdnSigningKeys',
      properties: {
        SecretId: cdnSigningSecret.secretArn,
      },
    });

    NagSuppressions.addResourceSuppressions(cdnSigningSecret, cdnSigningKeySuppressions);
    NagSuppressions.addResourceSuppressions(cdnSigningKeysLambda, lambdaBasicExecutionRoleSuppressions, true);
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/CdnSigningKeysProvider/framework-onEvent`,
      [
        ...cdkCustomResourceSuppressions,
        ...lambdaBasicExecutionRoleSuppressions,
        {
          id: 'AwsSolutions-IAM5',
          reason: 'The CDK Provider framework invokes its handler by qualified ARN, requiring a version/alias wildcard scoped to CdnSigningKeysLambda only (same pattern as AdminBootstrapLambda).',
          appliesTo: [{ regex: '/Resource::<.*CdnSigningKeysLambda.*\\.Arn>:\\*/' }],
        },
      ],
      true
    );

    // The L2 PublicKey validates the PEM prefix only for resolved strings, so
    // an unresolved custom-resource attribute is accepted here by design.
    const cdnSigningPublicKey = new cloudfront.PublicKey(this, 'CdnSigningPublicKey', {
      encodedKey: cdnSigningKeys.getAttString('PublicKeyPem'),
      comment: 'Signs /avatars/* and /prototypes/* URLs',
    });
    const cdnSigningKeyGroup = new cloudfront.KeyGroup(this, 'CdnSigningKeyGroup', {
      items: [cdnSigningPublicKey],
      comment: 'Viewers must present a signature for the private CDN paths',
    });
    this.cdnSigningKeyPairId = cdnSigningPublicKey.publicKeyId;

    // Avatars served from the same distribution under /avatars/* path
    // This avoids CSP issues (same-origin) and eliminates the need for a separate distribution
    this.frontendDistribution.addBehavior('/avatars/*', origins.S3BucketOrigin.withOriginAccessControl(this.rawDataBucket), {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      compress: true,
      // CACHING_OPTIMIZED forwards no query strings, so the signature is NOT
      // part of the cache key — signed URLs stay shareable across viewers at
      // the edge instead of fragmenting the cache per user.
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      trustedKeyGroups: [cdnSigningKeyGroup],
    });
    this.avatarsCdnUrl = `https://${this.frontendDomainName}/avatars`;

    // Prototypes served from the same distribution under /prototypes/* with their
    // OWN response-headers policy that permits inline <script>/<style>. Bedrock
    // (Opus 5) generates self-contained single-file HTML with inline JS for
    // in-prototype navigation; the main SPA's securityHeadersPolicy above
    // (script-src 'self') would block that JS entirely if reused here — hence a
    // dedicated policy scoped ONLY to this path, applied via a second cache
    // behavior (not a second distribution: cheaper, no extra propagation lag,
    // mirrors the /avatars/* pattern). This is same-origin/same-domain as the
    // main app, not a genuinely separate origin — the SCRIPT isolation that
    // matters (the model's JS can't reach the parent app's DOM/storage/cookies)
    // comes from the frontend loading this via a cross-document <iframe src=...>,
    // not from the domain differing.
    //
    // TWO THINGS THIS POLICY IS, WHICH ARE EASY TO CONFLATE (issue #229):
    //  1. It is NOT access control. Script isolation says nothing about who may
    //     fetch the URL; that is the trustedKeyGroups line below.
    //  2. It IS the EGRESS control on model-authored JS. `default-src 'none'`
    //     with no `connect-src` is what stops inline script in a prototype —
    //     running in a document holding PRD/PR-FAQ-derived content — from
    //     making outbound requests. Serving prototypes from anywhere that
    //     cannot set response headers (S3 directly, for instance) silently
    //     drops that, so this policy has to travel with the path.
    const prototypeHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'PrototypeHeadersPolicy', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'; object-src 'none'; base-uri 'none';",
          override: true,
        },
        contentTypeOptions: { override: true },
      },
    });
    this.frontendDistribution.addBehavior('/prototypes/*', origins.S3BucketOrigin.withOriginAccessControl(this.rawDataBucket), {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      compress: true,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED, // prototypes are immutable per doc_id
      responseHeadersPolicy: prototypeHeadersPolicy,
      trustedKeyGroups: [cdnSigningKeyGroup],
    });
    this.prototypesCdnUrl = `https://${this.frontendDomainName}/prototypes`;

    // ============================================
    // DYNAMODB TABLES
    // ============================================

    // Feedback Table
    this.feedbackTable = new dynamodb.Table(this, 'FeedbackTable', {
      tableName: uniqueName('voc-feedback'),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    this.feedbackTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-by-date',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.feedbackTable.addGlobalSecondaryIndex({
      indexName: 'gsi2-by-category',
      partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.feedbackTable.addGlobalSecondaryIndex({
      indexName: 'gsi3-by-urgency',
      partitionKey: { name: 'gsi3pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi3sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['feedback_id', 'source_platform', 'problem_summary', 'direct_customer_quote', 'source_url'],
    });

    this.feedbackTable.addGlobalSecondaryIndex({
      indexName: 'gsi4-by-feedback-id',
      partitionKey: { name: 'feedback_id', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Aggregates Table
    this.aggregatesTable = new dynamodb.Table(this, 'AggregatesTable', {
      tableName: uniqueName('voc-aggregates'),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    this.aggregatesTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-by-metric-type',
      partitionKey: { name: 'metric_type', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Watermarks Table
    this.watermarksTable = new dynamodb.Table(this, 'WatermarksTable', {
      tableName: uniqueName('voc-watermarks'),
      partitionKey: { name: 'source', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Projects Table
    this.projectsTable = new dynamodb.Table(this, 'ProjectsTable', {
      tableName: uniqueName('voc-projects'),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.projectsTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-by-type',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Jobs Table
    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      tableName: uniqueName('voc-jobs'),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    this.jobsTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-by-status',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Conversations Table
    this.conversationsTable = new dynamodb.Table(this, 'ConversationsTable', {
      tableName: uniqueName('voc-conversations'),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // Idempotency Table
    this.idempotencyTable = new dynamodb.Table(this, 'IdempotencyTable', {
      tableName: uniqueName('voc-idempotency'),
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiration',
    });
    NagSuppressions.addResourceSuppressions(this.idempotencyTable, idempotencyTableSuppressions);


    // ============================================
    // COGNITO AUTH
    // ============================================

    // Build callback URLs
    const callbackUrls = ['http://localhost:5173', 'http://localhost:5173/callback'];
    const logoutUrls = ['http://localhost:5173'];
    callbackUrls.push(`https://${this.frontendDomainName}`);
    callbackUrls.push(`https://${this.frontendDomainName}/callback`);
    logoutUrls.push(`https://${this.frontendDomainName}`);

    const signInUrl = `https://${this.frontendDomainName}`;

    // Custom Message Lambda Trigger
    const customMessageLambda = new lambda.Function(this, 'CustomMessageLambda', {
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(this.getCustomMessageLambdaCode(signInUrl)),
      timeout: cdk.Duration.seconds(10),
      description: 'Customizes Cognito email messages for different scenarios',
      logGroup: new logs.LogGroup(this, 'CustomMessageLambdaLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Cognito User Pool
    //
    // signInCaseSensitive (#105) maps to UsernameConfiguration, which Cognito
    // treats as CREATE-ONLY: introducing it on a pool deployed before #105
    // fails the whole stack update with "Updates are not allowed for property
    // - UsernameConfiguration" (issue #184). Pre-#105 stacks set the context
    // flag below to keep their pool untouched; greenfield deployments keep
    // case-insensitive sign-in.
    const omitUsernameConfigRaw = this.node.tryGetContext('omitUserPoolUsernameConfiguration');
    const omitUsernameConfig = omitUsernameConfigRaw === true || omitUsernameConfigRaw === 'true';
    this.userPool = new cognito.UserPool(this, 'VocUserPool', {
      userPoolName: uniqueName('voc-user-pool'),
      selfSignUpEnabled: false,
      signInAliases: { email: true, username: true },
      ...(omitUsernameConfig ? {} : { signInCaseSensitive: false }),
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      userVerification: {
        emailSubject: 'VoC Analytics - Verify your email',
        emailBody: 'Welcome to VoC Analytics!\n\nYour verification code is: {####}\n\nThis code expires in 24 hours.\n\nIf you did not request this, please ignore this email.',
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      userInvitation: {
        emailSubject: 'VoC Analytics - Welcome! Set up your account',
        emailBody: `<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
    <h1 style="margin: 0;">Welcome to VoC Analytics</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <p>You have been invited to join the platform.</p>
    <p><strong>To get started:</strong></p>
    <ol>
      <li>Go to <a href="${signInUrl}" style="color: #667eea;">${signInUrl}</a></li>
      <li>Enter your email address</li>
      <li>Use this temporary password:
        <div style="font-family: monospace; font-size: 18px; font-weight: bold; color: #667eea; margin: 8px 0;">{####}</div>
      </li>
      <li>Set your new password when prompted</li>
    </ol>
    <p style="color: #666; font-size: 13px;">(Your account ID for reference: {username})</p>
    <p style="margin-top: 24px;">Best regards,<br>The VoC Analytics Team</p>
  </div>
</body>
</html>`,
      },
      lambdaTriggers: { customMessage: customMessageLambda },
    });
    NagSuppressions.addResourceSuppressions(this.userPool, cognitoSecuritySuppressions);

    // User Pool Client
    this.userPoolClient = this.userPool.addClient('VocWebClient', {
      userPoolClientName: uniqueName('voc-web-client'),
      authFlows: { userPassword: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: true },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls,
      },
      preventUserExistenceErrors: true,
      generateSecret: false,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // User Pool Domain
    const domainPrefix = uniqueName('voc');
    this.userPoolDomain = this.userPool.addDomain('VocUserPoolDomain', {
      cognitoDomain: { domainPrefix },
    });

    // User groups
    const adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admins',
      description: 'VoC administrators with full access',
    });

    const usersGroup = new cognito.CfnUserPoolGroup(this, 'UsersGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'users',
      description: 'VoC users with standard access',
    });

    // ============================================
    // INITIAL ADMIN USER (for greenfield deployments)
    // ============================================
    // Idempotent bootstrap (issue #196). The handler generates the initial
    // password AT RUNTIME, and only when it actually creates the admin:
    //  - first deployment: create admin -> set temporary password -> add to
    //    admins group -> the real password surfaces in InitialAdminPassword
    //    (printing it is BY DESIGN: it is how operators find their first
    //    login, and first use forces a change).
    //  - any redeployment / admin already exists: strict no-op — no user
    //    creation, no password reset, no fresh password minted. All resource
    //    properties are deterministic, so the template no longer churns.
    const adminBootstrapLambda = new lambda.Function(this, 'AdminBootstrapLambda', {
      functionName: uniqueName('voc-admin-bootstrap'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      // Real, unit-tested file (lambda/custom_resources/test), inlined so a
      // ~3KB handler needs no asset bundling.
      code: lambda.Code.fromInline(
        fs.readFileSync(path.join(__dirname, '../../lambda/custom_resources/admin_bootstrap.py'), 'utf8'),
      ),
      timeout: cdk.Duration.minutes(1),
      description: 'Idempotent initial-admin bootstrap (create once, never reset)',
      logGroup: new logs.LogGroup(this, 'AdminBootstrapLambdaLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    adminBootstrapLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminSetUserPassword',
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:AdminListGroupsForUser',
      ],
      resources: [this.userPool.userPoolArn],
    }));

    const adminBootstrapProvider = new cr.Provider(this, 'AdminBootstrapProvider', {
      onEventHandler: adminBootstrapLambda,
      // MUST stay FATAL: at INFO the provider framework logs the full
      // custom resource response — including Data.Password — to CloudWatch.
      // FATAL is the aws-cdk-lib default today; pinning it guards against a
      // default change and against anyone raising it while debugging.
      frameworkLambdaLoggingLevel: lambda.ApplicationLogLevel.FATAL,
      logGroup: new logs.LogGroup(this, 'AdminBootstrapProviderLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    const adminBootstrap = new cdk.CustomResource(this, 'AdminBootstrap', {
      serviceToken: adminBootstrapProvider.serviceToken,
      resourceType: 'Custom::AdminBootstrap',
      properties: {
        UserPoolId: this.userPool.userPoolId,
        Username: 'admin',
        Email: 'admin@local.host',
        GroupName: 'admins',
      },
    });
    adminBootstrap.node.addDependency(adminGroup);

    NagSuppressions.addResourceSuppressions(adminBootstrapLambda, lambdaBasicExecutionRoleSuppressions, true);
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/AdminBootstrapProvider/framework-onEvent`,
      [
        ...cdkCustomResourceSuppressions,
        ...lambdaBasicExecutionRoleSuppressions,
        {
          id: 'AwsSolutions-IAM5',
          reason: 'The CDK Provider framework invokes its handler by qualified ARN, requiring a version/alias wildcard scoped to AdminBootstrapLambda only (same pattern as ModelAgreementLambda).',
          appliesTo: [{ regex: '/Resource::<.*AdminBootstrapLambda.*\\.Arn>:\\*/' }],
        },
      ],
      true
    );

    // ============================================
    // GLOBAL MODEL PIN (opt-in, for accounts that cannot use the newest models)
    // ============================================
    // `-c defaultModelId=<allowlisted id>` seeds settings.model_id, the legacy
    // global override that outranks SURFACE_DEFAULTS in both resolvers
    // (shared/model_config.py and lambda/stream/src/bedrock/model-override.ts).
    // One attribute therefore repoints every AI surface without touching the
    // built-in defaults, so deployments that CAN use the newer models are
    // unaffected.
    //
    // Motivating case: Workshop Studio events sit behind a Private Marketplace
    // that refuses the model agreements for Sonnet 5 / Opus 5, and they are
    // fully automated — there is no human to pick a model per participant
    // account. Without the flag nothing below is created at all.
    const defaultModelIdRaw = this.node.tryGetContext('defaultModelId');
    if (defaultModelIdRaw !== undefined && defaultModelIdRaw !== null && defaultModelIdRaw !== '') {
      const defaultModelId = String(defaultModelIdRaw);
      // Fail at synth rather than writing a value the app would ignore:
      // _allowlisted() drops non-allowlisted ids at read time, which would
      // silently fall back to the defaults this flag exists to avoid.
      if (!ALLOWED_MODEL_IDS.includes(defaultModelId)) {
        throw new Error(
          `defaultModelId '${defaultModelId}' is not in the model allowlist. ` +
          `Allowed: ${ALLOWED_MODEL_IDS.join(', ')}`,
        );
      }

      const modelPinLambda = new lambda.Function(this, 'ModelPinLambda', {
        functionName: uniqueName('voc-model-pin'),
        runtime: lambda.Runtime.PYTHON_3_14,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        // Real, unit-tested file (lambda/custom_resources/test), inlined so a
        // small handler needs no asset bundling — same pattern as
        // AdminBootstrapLambda.
        code: lambda.Code.fromInline(
          fs.readFileSync(path.join(__dirname, '../../lambda/custom_resources/model_pin.py'), 'utf8'),
        ),
        timeout: cdk.Duration.minutes(1),
        description: 'Seeds the global Bedrock model pin (create once, never reset)',
        logGroup: new logs.LogGroup(this, 'ModelPinLambdaLogs', {
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      });
      this.aggregatesTable.grantWriteData(modelPinLambda);

      const modelPinProvider = new cr.Provider(this, 'ModelPinProvider', {
        onEventHandler: modelPinLambda,
        logGroup: new logs.LogGroup(this, 'ModelPinProviderLogs', {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      });

      new cdk.CustomResource(this, 'ModelPin', {
        serviceToken: modelPinProvider.serviceToken,
        resourceType: 'Custom::ModelPin',
        properties: {
          TableName: this.aggregatesTable.tableName,
          ModelId: defaultModelId,
        },
      });

      new cdk.CfnOutput(this, 'DefaultModelPin', { value: defaultModelId });

      // grantWriteData() emits the standard GSI (<TableArn>/index/*) and KMS
      // (GenerateDataKey*/ReEncrypt*) wildcards, so reuse the shared
      // suppressions rather than restating the same evidence.
      NagSuppressions.addResourceSuppressions(
        modelPinLambda,
        [...lambdaBasicExecutionRoleSuppressions, ...dynamoDbGsiSuppressions, ...kmsEncryptionSuppressions],
        true,
      );
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        `${this.stackName}/ModelPinProvider/framework-onEvent`,
        [
          ...cdkCustomResourceSuppressions,
          ...lambdaBasicExecutionRoleSuppressions,
          {
            id: 'AwsSolutions-IAM5',
            reason: 'The CDK Provider framework invokes its handler by qualified ARN, requiring a version/alias wildcard scoped to ModelPinLambda only (same pattern as AdminBootstrapLambda).',
            appliesTo: [{ regex: '/Resource::<.*ModelPinLambda.*\\.Arn>:\\*/' }],
          },
        ],
        true
      );
    }

    // ============================================
    // COGNITO IDENTITY POOL (for AWS IAM authentication)
    // ============================================
    this.identityPool = new cognito.CfnIdentityPool(this, 'VocIdentityPool', {
      identityPoolName: uniqueName('voc-identity-pool'),
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [{
        clientId: this.userPoolClient.userPoolClientId,
        providerName: this.userPool.userPoolProviderName,
      }],
    });

    // Create authenticated role for Identity Pool users
    this.authenticatedRole = new iam.Role(this, 'CognitoAuthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'authenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
      description: 'Role for authenticated Cognito Identity Pool users',
    });

    // Grant permission to invoke chat stream Lambda Function URL
    // Use wildcard to avoid circular dependency (specific Lambda is in ApiStack)
    this.authenticatedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunctionUrl', 'lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:*voc-chat-stream*`],
    }));

    // Suppress wildcard warning - necessary to avoid circular dependency
    NagSuppressions.addResourceSuppressions(
      this.authenticatedRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard required to avoid circular dependency between CoreStack and ApiStack. Lambda name pattern ensures least-privilege.',
        },
      ],
      true
    );

    // Attach role to Identity Pool
    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: this.authenticatedRole.roleArn,
      },
    });
    
    // Suppress CDK custom resource Lambda runtime warnings
    // The AwsCustomResource construct creates a singleton Lambda with a deterministic UUID
    const customResourceId = `AWS${cr.AwsCustomResource.PROVIDER_FUNCTION_UUID.split('-').join('')}`;
    const customResourceSuppressPaths = new Set([
      `/${this.stackName}/${customResourceId}/ServiceRole/Resource`,
      `/${this.stackName}/${customResourceId}/Resource`,
    ]);
    
    const allExistingPaths = new Set(
      this.node.findAll().map((node) => `/${node.node.path}`)
    );
    
    for (const path of customResourceSuppressPaths) {
      if (allExistingPaths.has(path)) {
        NagSuppressions.addResourceSuppressionsByPath(
          this,
          path,
          [...cdkCustomResourceSuppressions, ...lambdaBasicExecutionRoleSuppressions],
          true
        );
      }
    }

    // ============================================
    // OUTPUTS
    // ============================================
    
    // Storage outputs
    new cdk.CfnOutput(this, 'FeedbackTableName', { value: this.feedbackTable.tableName });
    new cdk.CfnOutput(this, 'FeedbackTableArn', { value: this.feedbackTable.tableArn });
    new cdk.CfnOutput(this, 'AggregatesTableName', { value: this.aggregatesTable.tableName });
    new cdk.CfnOutput(this, 'WatermarksTableName', { value: this.watermarksTable.tableName });
    new cdk.CfnOutput(this, 'ProjectsTableName', { value: this.projectsTable.tableName });
    new cdk.CfnOutput(this, 'JobsTableName', { value: this.jobsTable.tableName });
    new cdk.CfnOutput(this, 'ConversationsTableName', { value: this.conversationsTable.tableName });
    new cdk.CfnOutput(this, 'IdempotencyTableName', { value: this.idempotencyTable.tableName });
    new cdk.CfnOutput(this, 'KmsKeyArn', { value: this.kmsKey.keyArn });
    new cdk.CfnOutput(this, 'RawDataBucketName', { value: this.rawDataBucket.bucketName });
    new cdk.CfnOutput(this, 'RawDataBucketArn', { value: this.rawDataBucket.bucketArn });
    new cdk.CfnOutput(this, 'AccessLogsBucketName', { value: this.accessLogsBucket.bucketName });
    new cdk.CfnOutput(this, 'AvatarsCdnUrl', { value: this.avatarsCdnUrl, description: 'CloudFront URL for persona avatar images (signature required)' });
    new cdk.CfnOutput(this, 'PrototypesCdnUrl', { value: this.prototypesCdnUrl, description: 'CloudFront URL for generated HTML prototypes (signature required)' });
    new cdk.CfnOutput(this, 'CdnSigningKeyPairId', { value: this.cdnSigningKeyPairId, description: 'CloudFront public key id used to sign /avatars/* and /prototypes/* URLs' });

    // Frontend outputs
    new cdk.CfnOutput(this, 'WebsiteURL', { value: `https://${this.frontendDomainName}`, description: 'CloudFront Distribution URL' });
    new cdk.CfnOutput(this, 'WebsiteBucketName', { value: this.websiteBucket.bucketName, description: 'S3 Bucket Name' });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.frontendDistribution.distributionId, description: 'CloudFront Distribution ID' });
    new cdk.CfnOutput(this, 'DistributionDomainName', { value: this.frontendDomainName, description: 'CloudFront Distribution Domain Name', exportName: 'VocFrontendDomainName' });

    // Auth outputs
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId, description: 'Cognito User Pool ID' });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId, description: 'Cognito User Pool Client ID for frontend' });
    new cdk.CfnOutput(this, 'UserPoolDomain', { value: `${domainPrefix}.auth.${this.region}.amazoncognito.com`, description: 'Cognito User Pool Domain' });
    new cdk.CfnOutput(this, 'CognitoRegion', { value: this.region, description: 'AWS Region for Cognito' });
    new cdk.CfnOutput(this, 'IdentityPoolId', { value: this.identityPool.ref, description: 'Cognito Identity Pool ID for AWS IAM auth' });
    new cdk.CfnOutput(this, 'InitialAdminPassword', { 
      value: adminBootstrap.getAttString('Password'), 
      // ASCII only: CloudFormation mangles non-ASCII in output descriptions
      // ('?'), which makes every subsequent cdk diff dirty.
      description: 'Initial admin password (username: admin) - real only on the deployment that created the admin; forced to change at first login'
    });

    // Acknowledged wildcard-key-policy warning (issue #189): the synthesized
    // KMS condition is already scoped to THIS ACCOUNT's distributions
    // (arn:...:cloudfront::ACCOUNT:distribution/*); scoping to the concrete
    // distribution id would create exactly the circular dependency the
    // warning describes, and the CDK README documents the wildcard as the
    // supported shape. Kept as the LAST statement of the constructor:
    // every withOriginAccessControl() call re-emits the warning, and
    // acknowledgeWarning only strips messages added before it runs — an
    // origin added below the ack would silently re-break warning-free synth.
    cdk.Annotations.of(this).acknowledgeWarning('@aws-cdk/aws-cloudfront-origins:wildcardKeyPolicyForOac');
  }

  private getCustomMessageLambdaCode(signInUrl: string): string {
    // Note: CustomMessage_AdminCreateUser doesn't work with COGNITO_DEFAULT email sender
    // (known AWS bug). We handle it via userInvitation config instead.
    // This Lambda handles ForgotPassword and ResendCode which DO work.
    return `
import json

def handler(event, context):
    trigger_source = event.get('triggerSource', '')
    request = event.get('request', {})
    code_param = request.get('codeParameter', '{####}')
    sign_in_url = '${signInUrl}'
    
    # ForgotPassword - styled HTML email
    if trigger_source == 'CustomMessage_ForgotPassword':
        event['response']['emailSubject'] = 'VoC Analytics - Reset your password'
        event['response']['emailMessage'] = f"""<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
    <h1 style="color: white; margin: 0;">Password Reset</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <p>We received a request to reset your password for VoC Analytics.</p>
    <div style="background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
      <p style="margin: 0 0 10px 0; color: #666;">Your password reset code:</p>
      <p style="font-family: monospace; font-size: 24px; font-weight: bold; color: #667eea; margin: 0;">{code_param}</p>
    </div>
    <p style="color: #666; font-size: 14px;">If you did not request this, please ignore this email.</p>
    <p style="text-align: center; margin-top: 20px;"><a href="{sign_in_url}" style="color: #667eea;">Go to VoC Analytics</a></p>
  </div>
</body>
</html>"""
    
    # ResendCode - styled HTML email  
    elif trigger_source == 'CustomMessage_ResendCode':
        event['response']['emailSubject'] = 'VoC Analytics - Your verification code'
        event['response']['emailMessage'] = f"""<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
    <h1 style="color: white; margin: 0;">Verification Code</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <p>Here is your verification code for VoC Analytics.</p>
    <div style="background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
      <p style="margin: 0 0 10px 0; color: #666;">Your verification code:</p>
      <p style="font-family: monospace; font-size: 24px; font-weight: bold; color: #667eea; margin: 0;">{code_param}</p>
    </div>
    <p style="text-align: center; margin-top: 20px;"><a href="{sign_in_url}" style="color: #667eea;">Go to VoC Analytics</a></p>
  </div>
</body>
</html>"""
    
    return event
`;
  }
}
