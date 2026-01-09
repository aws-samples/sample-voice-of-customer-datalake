import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { generateDeploymentHash } from '../utils/naming';

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

    // Generate deployment hash for unique naming
    const hash = generateDeploymentHash(this.account, this.region);

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

    // Build the sign-in URL
    const signInUrl = frontendDomain ? `https://${frontendDomain}` : 'http://localhost:5173';

    // Custom Message Lambda Trigger - customizes email content for different scenarios
    const customMessageLambda = new lambda.Function(this, 'CustomMessageLambda', {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
def handler(event, context):
    trigger_source = event.get('triggerSource', '')
    user_attrs = event.get('request', {}).get('userAttributes', {})
    code = event['request']['codeParameter']
    sign_in_url = '${signInUrl}'
    
    # Get display name: prefer 'name' attribute, fall back to email
    display_name = user_attrs.get('name') or user_attrs.get('email', '').split('@')[0] or 'there'
    
    # Admin-initiated user creation (invite)
    if trigger_source == 'CustomMessage_AdminCreateUser':
        event['response']['emailSubject'] = 'VoC Analytics - Welcome! Set up your account'
        event['response']['emailMessage'] = f'''
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Welcome to VoC Analytics</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <p style="font-size: 16px;">Hello <strong>{display_name}</strong>,</p>
    <p>You have been invited to VoC Analytics. Use the temporary password below to sign in and set up your account.</p>
    <div style="background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
      <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">Your temporary password:</p>
      <p style="font-family: monospace; font-size: 20px; font-weight: bold; color: #667eea; margin: 0; letter-spacing: 1px;">{code}</p>
    </div>
    <p style="color: #666; font-size: 14px;">You will be prompted to change this password on your first login.</p>
    <div style="text-align: center; margin: 25px 0;">
      <a href="{sign_in_url}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 16px;">Sign In to VoC Analytics</a>
    </div>
    <p style="color: #999; font-size: 12px; text-align: center;">If the button doesn't work, copy and paste this URL into your browser:<br><a href="{sign_in_url}" style="color: #667eea;">{sign_in_url}</a></p>
  </div>
  <div style="padding: 20px; text-align: center; color: #999; font-size: 12px;">
    <p>Best regards,<br>The VoC Analytics Team</p>
  </div>
</body>
</html>
'''
    
    # Forgot password / admin reset password
    elif trigger_source == 'CustomMessage_ForgotPassword':
        event['response']['emailSubject'] = 'VoC Analytics - Reset your password'
        event['response']['emailMessage'] = f'''
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Password Reset</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <p style="font-size: 16px;">Hello,</p>
    <p>We received a request to reset your password for VoC Analytics.</p>
    <div style="background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
      <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">Your password reset code:</p>
      <p style="font-family: monospace; font-size: 20px; font-weight: bold; color: #667eea; margin: 0; letter-spacing: 1px;">{code}</p>
    </div>
    <p style="color: #666; font-size: 14px;">If you did not request this, please ignore this email.</p>
    <div style="text-align: center; margin: 25px 0;">
      <a href="{sign_in_url}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 16px;">Go to VoC Analytics</a>
    </div>
    <p style="color: #999; font-size: 12px; text-align: center;">If the button doesn't work, copy and paste this URL into your browser:<br><a href="{sign_in_url}" style="color: #667eea;">{sign_in_url}</a></p>
  </div>
  <div style="padding: 20px; text-align: center; color: #999; font-size: 12px;">
    <p>Best regards,<br>The VoC Analytics Team</p>
  </div>
</body>
</html>
'''
    
    # Email verification
    elif trigger_source == 'CustomMessage_VerifyUserAttribute':
        event['response']['emailSubject'] = 'VoC Analytics - Verify your email'
        event['response']['emailMessage'] = f'''
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Verify Your Email</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <p style="font-size: 16px;">Hello,</p>
    <p>Please use the code below to verify your email address.</p>
    <div style="background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
      <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">Your verification code:</p>
      <p style="font-family: monospace; font-size: 20px; font-weight: bold; color: #667eea; margin: 0; letter-spacing: 1px;">{code}</p>
    </div>
    <p style="color: #666; font-size: 14px;">This code expires in 24 hours.</p>
    <div style="text-align: center; margin: 25px 0;">
      <a href="{sign_in_url}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 16px;">Go to VoC Analytics</a>
    </div>
    <p style="color: #999; font-size: 12px; text-align: center;">If the button doesn't work, copy and paste this URL into your browser:<br><a href="{sign_in_url}" style="color: #667eea;">{sign_in_url}</a></p>
  </div>
  <div style="padding: 20px; text-align: center; color: #999; font-size: 12px;">
    <p>Best regards,<br>The VoC Analytics Team</p>
  </div>
</body>
</html>
'''
    
    # Resend confirmation code
    elif trigger_source == 'CustomMessage_ResendCode':
        event['response']['emailSubject'] = 'VoC Analytics - Your verification code'
        event['response']['emailMessage'] = f'''
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Verification Code</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <p style="font-size: 16px;">Hello,</p>
    <p>Here is your verification code for VoC Analytics.</p>
    <div style="background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
      <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">Your verification code:</p>
      <p style="font-family: monospace; font-size: 20px; font-weight: bold; color: #667eea; margin: 0; letter-spacing: 1px;">{code}</p>
    </div>
    <div style="text-align: center; margin: 25px 0;">
      <a href="{sign_in_url}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 16px;">Go to VoC Analytics</a>
    </div>
    <p style="color: #999; font-size: 12px; text-align: center;">If the button doesn't work, copy and paste this URL into your browser:<br><a href="{sign_in_url}" style="color: #667eea;">{sign_in_url}</a></p>
  </div>
  <div style="padding: 20px; text-align: center; color: #999; font-size: 12px;">
    <p>Best regards,<br>The VoC Analytics Team</p>
  </div>
</body>
</html>
'''
    
    return event
`),
      timeout: cdk.Duration.seconds(10),
      description: 'Customizes Cognito email messages for different scenarios',
    });

    // Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'VocUserPool', {
      userPoolName: `voc-user-pool-${hash}`,
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
        emailSubject: `VoC Analytics - Verify your email`,
        emailBody: `Welcome to VoC Analytics!\n\nYour verification code is {####}\n\nThis code expires in 24 hours.`,
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      userInvitation: {
        emailSubject: `VoC Analytics - You've been invited`,
        emailBody: `Hello {username},\n\nYou have been invited to VoC Analytics.\n\nYour temporary password is: {####}\n\nPlease sign in and change your password.`,
      },
      lambdaTriggers: {
        customMessage: customMessageLambda,
      },
    });

    // User Pool Client for frontend
    this.userPoolClient = this.userPool.addClient('VocWebClient', {
      userPoolClientName: `voc-web-client-${hash}`,
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
    const domainPrefix = `voc-${hash}`;
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

    // Output initial admin credentials (for reference)
    new cdk.CfnOutput(this, 'InitialAdminUsername', {
      value: initialAdminUsername,
      description: 'Initial admin username',
    });

    new cdk.CfnOutput(this, 'InitialAdminEmail', {
      value: initialAdminEmail,
      description: 'Initial admin user email',
    });

    new cdk.CfnOutput(this, 'InitialAdminPassword', {
      value: initialAdminPassword,
      description: 'Initial admin user password (change after first login)',
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
