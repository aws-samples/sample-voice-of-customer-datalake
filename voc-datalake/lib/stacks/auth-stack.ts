import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
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

    // Custom Message Lambda Trigger - customizes email content for different scenarios
    const customMessageLambda = new lambda.Function(this, 'CustomMessageLambda', {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json

def handler(event, context):
    brand_name = "${brandName}"
    trigger_source = event.get('triggerSource', '')
    
    # Admin-initiated password reset
    if trigger_source == 'CustomMessage_AdminCreateUser':
        event['response']['emailSubject'] = f'{brand_name} - Welcome! Set up your account'
        event['response']['emailMessage'] = f'''Hello {event['request']['usernameParameter']},

You have been invited to {brand_name}.

Your temporary password is: {event['request']['codeParameter']}

Please sign in and change your password.

Best regards,
The {brand_name} Team'''
    
    # Forgot password / admin reset password
    elif trigger_source == 'CustomMessage_ForgotPassword':
        event['response']['emailSubject'] = f'{brand_name} - Reset your password'
        event['response']['emailMessage'] = f'''Hello,

We received a request to reset your password for {brand_name}.

Your password reset code is: {event['request']['codeParameter']}

If you did not request this, please ignore this email.

Best regards,
The {brand_name} Team'''
    
    # Email verification
    elif trigger_source == 'CustomMessage_VerifyUserAttribute':
        event['response']['emailSubject'] = f'{brand_name} - Verify your email'
        event['response']['emailMessage'] = f'''Hello,

Your verification code for {brand_name} is: {event['request']['codeParameter']}

This code expires in 24 hours.

Best regards,
The {brand_name} Team'''
    
    # Resend confirmation code
    elif trigger_source == 'CustomMessage_ResendCode':
        event['response']['emailSubject'] = f'{brand_name} - Your verification code'
        event['response']['emailMessage'] = f'''Hello,

Your verification code for {brand_name} is: {event['request']['codeParameter']}

Best regards,
The {brand_name} Team'''
    
    return event
`),
      timeout: cdk.Duration.seconds(10),
      description: 'Customizes Cognito email messages for different scenarios',
    });

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
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Prevent accidental user data loss
      // Custom email messages
      userVerification: {
        emailSubject: `${brandName} - Verify your email`,
        emailBody: `Welcome to ${brandName}!\n\nYour verification code is {####}\n\nThis code expires in 24 hours.`,
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      userInvitation: {
        emailSubject: `${brandName} - You've been invited`,
        emailBody: `Hello {username},\n\nYou have been invited to ${brandName}.\n\nYour temporary password is: {####}\n\nPlease sign in and change your password.`,
      },
      lambdaTriggers: {
        customMessage: customMessageLambda,
      },
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
