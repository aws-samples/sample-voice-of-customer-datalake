import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';
import { uniqueBucketName } from '../utils/naming';

/**
 * Props for the frontend infrastructure (S3 + CloudFront).
 * This stack creates the hosting infrastructure without deploying content.
 */
export interface VocFrontendInfraStackProps extends cdk.StackProps {
  // No dependencies - this stack is created first
}

/**
 * Frontend Infrastructure Stack - Creates S3 bucket and CloudFront distribution.
 * This stack is deployed BEFORE the analytics stack so the CloudFront domain
 * can be used for CORS configuration.
 */
export class VocFrontendInfraStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly websiteBucket: s3.Bucket;
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props?: VocFrontendInfraStackProps) {
    super(scope, id, props);

    // S3 bucket for hosting the React app
    this.websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketName: uniqueBucketName('voc-frontend', this.account, this.region),
      encryption: s3.BucketEncryption.S3_MANAGED,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront distribution with S3BucketOrigin
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
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
    });

    this.distributionDomainName = this.distribution.distributionDomainName;

    // Outputs
    new cdk.CfnOutput(this, 'WebsiteURL', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'CloudFront Distribution URL',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: this.websiteBucket.bucketName,
      description: 'S3 Bucket Name',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront Distribution ID',
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront Distribution Domain Name',
      exportName: 'VocFrontendDomainName',
    });
  }
}

/**
 * Props for the frontend deployment stack.
 * This stack deploys the built frontend content to S3.
 */
export interface VocFrontendStackProps extends cdk.StackProps {
  websiteBucket: s3.IBucket;
  distribution: cloudfront.IDistribution;
  apiEndpoint: string;
  artifactBuilderEndpoint?: string;
  userPoolId: string;
  userPoolClientId: string;
  cognitoRegion: string;
}

/**
 * Frontend Deployment Stack - Deploys the built frontend to S3.
 * This stack is deployed AFTER the analytics stack so it can include
 * the API endpoint in the environment configuration.
 */
export class VocFrontendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VocFrontendStackProps) {
    super(scope, id, props);

    const { apiEndpoint, artifactBuilderEndpoint } = props;

    // Runtime config.json - loaded by frontend at startup
    // This allows the same build to work across multiple environments
    const runtimeConfig = {
      apiEndpoint,
      artifactBuilderEndpoint: artifactBuilderEndpoint || '',
      cognito: {
        userPoolId: props.userPoolId,
        clientId: props.userPoolClientId,
        region: props.cognitoRegion,
      },
    };

    // Deploy frontend to S3
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [
        s3deploy.Source.asset('frontend/dist'),
        s3deploy.Source.data('config.json', JSON.stringify(runtimeConfig, null, 2)),
      ],
      destinationBucket: props.websiteBucket,
      distribution: props.distribution,
      distributionPaths: ['/*'],
    });

    // Outputs
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
