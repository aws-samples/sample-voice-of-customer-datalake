import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { uniqueBucketName, uniqueTableName, uniqueUserPoolName, generateDeploymentHash } from '../utils/naming';

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

  // Frontend infrastructure exports
  public readonly frontendDistribution: cloudfront.Distribution;
  public readonly websiteBucket: s3.Bucket;
  public readonly frontendDomainName: string;

  // Auth exports
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: VocCoreStackProps) {
    super(scope, id, props);

    const { brandName } = props;
    const hash = generateDeploymentHash(this.account, this.region);
    const corsAllowedOrigins = ['http://localhost:5173', 'http://localhost:3000'];

    // ============================================
    // KMS KEY
    // ============================================
    this.kmsKey = new kms.Key(this, 'VocKmsKey', {
      alias: `voc-datalake-key-${hash}`,
      description: 'KMS key for VoC Data Lake encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ============================================
    // S3 BUCKETS
    // ============================================
    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      bucketName: uniqueBucketName('voc-access-logs', this.account, this.region),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
    });

    this.rawDataBucket = new s3.Bucket(this, 'RawDataBucket', {
      bucketName: uniqueBucketName('voc-raw-data', this.account, this.region),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'raw-data-bucket/',
      cors: [{
        allowedMethods: [s3.HttpMethods.GET],
        allowedOrigins: corsAllowedOrigins,
        allowedHeaders: ['*'],
        maxAge: 3600,
      }],
    });

    // Frontend hosting bucket
    this.websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketName: uniqueBucketName('voc-frontend', this.account, this.region),
      encryption: s3.BucketEncryption.S3_MANAGED,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ============================================
    // CLOUDFRONT DISTRIBUTIONS
    // ============================================
    
    // Avatars CDN
    const avatarsCorsPolicy = new cloudfront.ResponseHeadersPolicy(this, 'AvatarsCorsPolicy', {
      responseHeadersPolicyName: `voc-avatars-cors-policy-${hash}`,
      corsBehavior: {
        accessControlAllowOrigins: corsAllowedOrigins,
        accessControlAllowMethods: ['GET', 'HEAD'],
        accessControlAllowHeaders: ['*'],
        accessControlMaxAge: cdk.Duration.hours(1),
        originOverride: true,
        accessControlAllowCredentials: false,
      },
    });

    const avatarsDistribution = new cloudfront.Distribution(this, 'AvatarsDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.rawDataBucket, {
          originPath: '/avatars',
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: avatarsCorsPolicy,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: 'VoC Persona Avatars CDN',
    });
    cdk.Annotations.of(this).acknowledgeWarning('@aws-cdk/aws-cloudfront-origins:wildcardKeyPolicyForOac');
    this.avatarsCdnUrl = `https://${avatarsDistribution.distributionDomainName}`;

    // Frontend hosting distribution
    this.frontendDistribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });
    this.frontendDomainName = this.frontendDistribution.distributionDomainName;


    // ============================================
    // DYNAMODB TABLES
    // ============================================

    // Feedback Table
    this.feedbackTable = new dynamodb.Table(this, 'FeedbackTable', {
      tableName: uniqueTableName('voc-feedback', this.account, this.region),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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
      tableName: uniqueTableName('voc-aggregates', this.account, this.region),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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
      tableName: uniqueTableName('voc-watermarks', this.account, this.region),
      partitionKey: { name: 'source', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Projects Table
    this.projectsTable = new dynamodb.Table(this, 'ProjectsTable', {
      tableName: uniqueTableName('voc-projects', this.account, this.region),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.projectsTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-by-type',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Jobs Table
    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      tableName: uniqueTableName('voc-jobs', this.account, this.region),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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
      tableName: uniqueTableName('voc-conversations', this.account, this.region),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // Idempotency Table
    this.idempotencyTable = new dynamodb.Table(this, 'IdempotencyTable', {
      tableName: uniqueTableName('voc-idempotency', this.account, this.region),
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiration',
    });


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
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(this.getCustomMessageLambdaCode(signInUrl)),
      timeout: cdk.Duration.seconds(10),
      description: 'Customizes Cognito email messages for different scenarios',
    });

    // Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'VocUserPool', {
      userPoolName: `voc-user-pool-${hash}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true, username: true },
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
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      userVerification: {
        emailSubject: `VoC Analytics - Verify your email`,
        emailBody: `Welcome to VoC Analytics!\n\nYour verification code is {####}\n\nThis code expires in 24 hours.`,
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      userInvitation: {
        emailSubject: `VoC Analytics - You've been invited`,
        emailBody: `Hello {username},\n\nYou have been invited to VoC Analytics.\n\nYour temporary password is: {####}\n\nPlease sign in and change your password.`,
      },
      lambdaTriggers: { customMessage: customMessageLambda },
    });

    // User Pool Client
    this.userPoolClient = this.userPool.addClient('VocWebClient', {
      userPoolClientName: `voc-web-client-${hash}`,
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
    const domainPrefix = `voc-${hash}`;
    this.userPoolDomain = this.userPool.addDomain('VocUserPoolDomain', {
      cognitoDomain: { domainPrefix },
    });

    // User groups
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admins',
      description: 'VoC administrators with full access',
    });

    new cognito.CfnUserPoolGroup(this, 'ViewerGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'viewers',
      description: 'VoC viewers with read-only access',
    });

    // ============================================
    // INITIAL ADMIN USER (for greenfield deployments)
    // ============================================
    // Create initial admin user using custom resource
    const initialAdminUsername = 'admin';
    const initialAdminEmail = 'admin@local.host';
    const initialAdminPassword = 'VocAnalytics@@2026';

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
          MessageAction: 'SUPPRESS', // Don't send email for initial admin
        },
        physicalResourceId: cr.PhysicalResourceId.of(`admin-user-${hash}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminCreateUser'],
          resources: [this.userPool.userPoolArn],
        }),
      ]),
    });

    // Set permanent password for admin user
    const setAdminPassword = new cr.AwsCustomResource(this, 'SetAdminPassword', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminSetUserPassword',
        parameters: {
          UserPoolId: this.userPool.userPoolId,
          Username: initialAdminUsername,
          Password: initialAdminPassword,
          Permanent: true,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`admin-password-${hash}`),
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
        physicalResourceId: cr.PhysicalResourceId.of(`admin-group-${hash}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminAddUserToGroup'],
          resources: [this.userPool.userPoolArn],
        }),
      ]),
    });
    addAdminToGroup.node.addDependency(setAdminPassword);

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
    
    // Initial admin credentials (for reference)
    new cdk.CfnOutput(this, 'InitialAdminUsername', { value: initialAdminUsername, description: 'Initial admin username' });
    new cdk.CfnOutput(this, 'InitialAdminPassword', { value: initialAdminPassword, description: 'Initial admin password (change after first login)' });
  }

  private getCustomMessageLambdaCode(signInUrl: string): string {
    return `
def handler(event, context):
    trigger_source = event.get('triggerSource', '')
    user_attrs = event.get('request', {}).get('userAttributes', {})
    code = event['request']['codeParameter']
    sign_in_url = '${signInUrl}'
    
    display_name = user_attrs.get('name') or user_attrs.get('email', '').split('@')[0] or 'there'
    
    if trigger_source == 'CustomMessage_AdminCreateUser':
        event['response']['emailSubject'] = 'VoC Analytics - Welcome! Set up your account'
        event['response']['emailMessage'] = f'''<html><body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;"><div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;"><h1 style="color: white; margin: 0; font-size: 24px;">Welcome to VoC Analytics</h1></div><div style="padding: 30px; background: #f9f9f9;"><p style="font-size: 16px;">Hello <strong>{display_name}</strong>,</p><p>You have been invited to VoC Analytics. Use the temporary password below to sign in.</p><div style="background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;"><p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">Your temporary password:</p><p style="font-family: monospace; font-size: 20px; font-weight: bold; color: #667eea; margin: 0; letter-spacing: 1px;">{code}</p></div><div style="text-align: center; margin: 25px 0;"><a href="{sign_in_url}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 16px;">Sign In</a></div></div></body></html>'''
    elif trigger_source == 'CustomMessage_ForgotPassword':
        event['response']['emailSubject'] = 'VoC Analytics - Reset your password'
        event['response']['emailMessage'] = f'''<html><body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;"><div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;"><h1 style="color: white; margin: 0; font-size: 24px;">Password Reset</h1></div><div style="padding: 30px; background: #f9f9f9;"><p>Your password reset code:</p><div style="background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;"><p style="font-family: monospace; font-size: 20px; font-weight: bold; color: #667eea; margin: 0;">{code}</p></div></div></body></html>'''
    
    return event
`;
  }
}
