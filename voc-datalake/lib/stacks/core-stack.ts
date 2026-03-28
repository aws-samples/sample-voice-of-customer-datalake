import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import { randomInt } from 'crypto';
import { Construct } from 'constructs';
import { uniqueName } from '../utils/naming';
import { NagSuppressions } from 'cdk-nag';
import { idempotencyTableSuppressions, websiteBucketSuppressions, cloudfrontDefaultCertSuppressions, cognitoSecuritySuppressions, cdkCustomResourceSuppressions, lambdaBasicExecutionRoleSuppressions } from '../utils/nag-suppressions';

export interface VocCoreStackProps extends cdk.StackProps {
  brandName: string;
  /** Custom domain name for CloudFront (e.g., "app.example.com"). Requires certificateArn. */
  customDomain?: string;
  /** ARN of an ACM certificate in us-east-1 for the custom domain. Enables TLS 1.2. */
  certificateArn?: string;
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
        allowedMethods: [s3.HttpMethods.GET],
        allowedOrigins: corsAllowedOriginsBase,
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
          contentSecurityPolicy: `default-src 'none'; font-src 'self' data:; img-src 'self' data: blob:; script-src 'self';manifest-src 'self'; style-src 'unsafe-inline' 'self'; style-src-elem 'unsafe-inline' 'self'; object-src 'none'; connect-src 'self' https://*.amazoncognito.com https://*.amazonaws.com https://*.lambda-url.${cdk.Stack.of(this).region}.on.aws; upgrade-insecure-requests; frame-ancestors 'none'; base-uri 'none';`,
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

    // Custom domain + ACM certificate for TLS 1.2 enforcement
    const useCustomDomain = props.customDomain && props.certificateArn;
    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'FrontendCertificate', props.certificateArn)
      : undefined;

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
      errorResponses: [
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableLogging: true,
      logBucket: this.accessLogsBucket,
      logFilePrefix: 'cloudfront-frontend/',
      ...(useCustomDomain && certificate ? {
        domainNames: [props.customDomain!],
        certificate,
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        sslSupportMethod: cloudfront.SSLMethod.SNI,
      } : {}),
    });

    // Only suppress CFR4 when using default certificate (no custom domain)
    if (!useCustomDomain) {
      NagSuppressions.addResourceSuppressions(this.frontendDistribution, cloudfrontDefaultCertSuppressions);
    } else {
      // Still suppress CFR1 (geo restrictions) and CFR2 (WAF) — those are separate concerns
      NagSuppressions.addResourceSuppressions(this.frontendDistribution, cloudfrontDefaultCertSuppressions.filter(
        s => s.id !== 'AwsSolutions-CFR4'
      ));
    }
    this.frontendDomainName = useCustomDomain ? props.customDomain! : this.frontendDistribution.distributionDomainName;

    // Avatars served from the same distribution under /avatars/* path
    // This avoids CSP issues (same-origin) and eliminates the need for a separate distribution
    // Avatars are immutable (filename = persona_id.png), so cache aggressively
    const avatarCachePolicy = new cloudfront.CachePolicy(this, 'AvatarCachePolicy', {
      cachePolicyName: uniqueName('avatar-cache'),
      comment: 'Long-lived cache for immutable persona avatar images',
      defaultTtl: cdk.Duration.days(365),
      minTtl: cdk.Duration.days(30),
      maxTtl: cdk.Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    this.frontendDistribution.addBehavior('/avatars/*', origins.S3BucketOrigin.withOriginAccessControl(this.rawDataBucket), {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      compress: true,
      cachePolicy: avatarCachePolicy,
    });
    cdk.Annotations.of(this).acknowledgeWarning('@aws-cdk/aws-cloudfront-origins:wildcardKeyPolicyForOac');
    this.avatarsCdnUrl = `https://${this.frontendDomainName}/avatars`;

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
    this.userPool = new cognito.UserPool(this, 'VocUserPool', {
      userPoolName: uniqueName('voc-user-pool'),
      selfSignUpEnabled: false,
      signInAliases: { email: true, username: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
        givenName: { required: false, mutable: true },
        familyName: { required: false, mutable: true },
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
        emailBody: `Welcome to VoC Analytics!

You have been invited to join the platform.

To get started:
1. Go to ${signInUrl}
2. Enter your email address
3. Use this temporary password: {####}
4. Set your new password when prompted

(Your account ID for reference: {username})

Best regards,
The VoC Analytics Team`,
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
    const initialAdminUsername = 'admin';
    const initialAdminEmail = 'admin@local.host';
    
    // Generate random password (16 chars: uppercase, lowercase, numbers, special chars)
    const randomPassword = Array.from({ length: 16 }, () => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';
      return chars[randomInt(0, chars.length)];
    }).join('');
    const initialAdminPassword = randomPassword;

    // Create the admin user
    const createAdminUser = new cr.AwsCustomResource(this, 'CreateAdminUser', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminCreateUser',
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          Username: initialAdminUsername,
          UserAttributes: [
            { Name: 'email', Value: initialAdminEmail },
            { Name: 'email_verified', Value: 'true' },
            { Name: 'name', Value: 'Admin' },
          ],
          MessageAction: 'SUPPRESS',
        },
        physicalResourceId: cr.PhysicalResourceId.of(uniqueName('admin-user')),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminCreateUser'],
          resources: [this.userPool.userPoolArn],
        }),
      ]),
    });

    // Set temporary password for admin user (must change on first login)
    const setAdminPassword = new cr.AwsCustomResource(this, 'SetAdminPassword', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminSetUserPassword',
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          Username: initialAdminUsername,
          Password: initialAdminPassword,
        },
        physicalResourceId: cr.PhysicalResourceId.of(uniqueName('admin-password')),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminSetUserPassword'],
          resources: [this.userPool.userPoolArn],
        }),
      ]),
    });
    setAdminPassword.node.addDependency(createAdminUser);

    // Add admin user to admins group
    const addAdminToGroup = new cr.AwsCustomResource(this, 'AddAdminToGroup', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminAddUserToGroup',
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          Username: initialAdminUsername,
          GroupName: 'admins',
        },
        physicalResourceId: cr.PhysicalResourceId.of(uniqueName('admin-group')),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminAddUserToGroup'],
          resources: [this.userPool.userPoolArn],
        }),
      ]),
    });
    addAdminToGroup.node.addDependency(setAdminPassword);
    addAdminToGroup.node.addDependency(adminGroup);
    addAdminToGroup.node.addDependency(createAdminUser);

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
    new cdk.CfnOutput(this, 'AvatarsCdnUrl', { value: this.avatarsCdnUrl, description: 'CloudFront URL for persona avatar images' });

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
      value: initialAdminPassword, 
      description: 'Initial admin user password (username: admin)'
    });
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
