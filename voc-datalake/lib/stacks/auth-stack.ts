import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface VocAuthStackProps extends cdk.StackProps {
  brandName: string;
  frontendDomain?: string;  // CloudFront domain for production callback URLs
}

export class VocAuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: VocAuthStackProps) {
    super(scope, id, props);

    const { brandName, frontendDomain } = props;

    // Build callback URLs - always include localhost for dev
    const callbackUrls = [
      'http://localhost:5173',
      'http://localhost:5173/callback',
    ];
    const logoutUrls = ['http://localhost:5173'];
    
    // Add CloudFront domain if provided
    if (frontendDomain) {
      callbackUrls.push(`https://${frontendDomain}`);
      callbackUrls.push(`https://${frontendDomain}/callback`);
      logoutUrls.push(`https://${frontendDomain}`);
    }

    // Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'VocUserPool', {
      userPoolName: 'voc-user-pool',
      selfSignUpEnabled: false, // Admin creates users
      signInAliases: {
        email: true,
        username: true,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
        fullname: {
          required: false,
          mutable: true,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change to RETAIN for production
    });

    // User Pool Client for frontend
    this.userPoolClient = this.userPool.addClient('VocWebClient', {
      userPoolClientName: 'voc-web-client',
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls,
        logoutUrls,
      },
      preventUserExistenceErrors: true,
      generateSecret: false, // No secret for SPA
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // User Pool Domain for hosted UI (optional)
    const domainPrefix = `voc-${this.account.slice(-8)}`;
    this.userPoolDomain = this.userPool.addDomain('VocUserPoolDomain', {
      cognitoDomain: {
        domainPrefix,
      },
    });

    // Create admin group
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admins',
      description: 'VoC administrators with full access',
    });

    // Create viewer group
    new cognito.CfnUserPoolGroup(this, 'ViewerGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'viewers',
      description: 'VoC viewers with read-only access',
    });

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID for frontend',
    });

    new cdk.CfnOutput(this, 'UserPoolDomain', {
      value: `${domainPrefix}.auth.${this.region}.amazoncognito.com`,
      description: 'Cognito User Pool Domain',
    });

    new cdk.CfnOutput(this, 'CognitoRegion', {
      value: this.region,
      description: 'AWS Region for Cognito',
    });
  }
}
