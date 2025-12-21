import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface VocFrontendStackProps extends cdk.StackProps {
  apiEndpoint: string;
  userPoolId: string;
  userPoolClientId: string;
  cognitoRegion: string;
}

export class VocFrontendStack extends cdk.Stack {
  public readonly distributionDomainName: string;
  public readonly bucketName: string;

  constructor(scope: Construct, id: string, props: VocFrontendStackProps) {
    super(scope, id, props);

    const { apiEndpoint } = props;

    // S3 bucket for hosting the React app
    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketName: `voc-datalake-frontend-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ============================================
    // WAF WebACL for CloudFront (CLOUDFRONT scope)
    // Protects against common web attacks
    // ============================================
    const cloudfrontWaf = new wafv2.CfnWebACL(this, 'CloudFrontWaf', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'VocCloudFrontWaf',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'CloudFrontCommonRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'CloudFrontKnownBadInputs',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'RateLimitRule',
          priority: 3,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'CloudFrontRateLimit',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // CloudFront distribution with S3BucketOrigin (non-deprecated)
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      webAclId: cloudfrontWaf.attrArn,
    });

    // Create .env file content for the frontend build
    const envContent = `VITE_API_ENDPOINT=${apiEndpoint}
VITE_COGNITO_USER_POOL_ID=${props.userPoolId}
VITE_COGNITO_CLIENT_ID=${props.userPoolClientId}
VITE_COGNITO_REGION=${props.cognitoRegion}`;

    // Deploy frontend to S3
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [
        s3deploy.Source.asset('frontend/dist'),
        s3deploy.Source.data('.env.production', envContent),
      ],
      destinationBucket: websiteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    this.distributionDomainName = distribution.distributionDomainName;
    this.bucketName = websiteBucket.bucketName;

    // Outputs
    new cdk.CfnOutput(this, 'WebsiteURL', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront Distribution URL',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: websiteBucket.bucketName,
      description: 'S3 Bucket Name',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront Distribution ID',
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: apiEndpoint,
      description: 'API Gateway Endpoint',
    });

    new cdk.CfnOutput(this, 'CognitoUserPoolId', {
      value: props.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'CognitoClientId', {
      value: props.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });
  }
}
