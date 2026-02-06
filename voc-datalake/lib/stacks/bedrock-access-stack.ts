import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { z } from 'zod';
import { NagSuppressions } from 'cdk-nag';
import { cdkCustomResourceSuppressions, lambdaBasicExecutionRoleSuppressions, pluginSystemSuppressions } from '../utils/nag-suppressions';

/**
 * Valid industry options for Anthropic use case form.
 * These match the options in the AWS Console form.
 */
const INDUSTRY_OPTIONS = [
  'Technology',
  'Healthcare',
  'Financial Services',
  'Retail',
  'Manufacturing',
  'Media & Entertainment',
  'Education',
  'Government',
  'Other',
] as const;

/**
 * Valid intended users options (index-based).
 * 0 = Internal employees only
 * 1 = External customers
 * 2 = Both internal and external
 */
const INTENDED_USERS_OPTIONS = ['0', '1', '2'] as const;

/**
 * Zod schema for validating Anthropic use case configuration.
 * All fields are required by the PutUseCaseForModelAccess API.
 */
export const AnthropicUseCaseSchema = z.object({
  companyName: z.string().min(1, 'Company name is required'),
  companyWebsite: z.string().url('Company website must be a valid URL'),
  // intendedUsers is an index: "0" = internal, "1" = external, "2" = both
  intendedUsers: z.enum(INTENDED_USERS_OPTIONS).default('0'),
  industryOption: z.enum(INDUSTRY_OPTIONS).default('Technology'),
  useCases: z.string().min(10, 'Use cases description must be at least 10 characters'),
  otherIndustryOption: z.string().optional().default(''),
});

export type AnthropicUseCaseConfig = z.infer<typeof AnthropicUseCaseSchema>;

/**
 * Models that require agreement acceptance for VoC platform.
 */
const REQUIRED_MODELS = [
  'anthropic.claude-sonnet-4-5-20250929-v1:0',  // Chat/API
  'anthropic.claude-haiku-4-5-20251001-v1:0',   // Processor
];

export interface BedrockAccessStackProps extends cdk.StackProps {
  /**
   * Anthropic use case configuration for first-time model access.
   * If not provided, the stack will skip the use case submission.
   */
  anthropicUseCase?: AnthropicUseCaseConfig;
  
  /**
   * AWS region where the models will be used.
   * Model agreements are created in this region.
   * Defaults to us-west-2.
   */
  modelRegion?: string;
  
  /**
   * Skip the use case submission step.
   * @default false
   */
  skipUseCaseSubmission?: boolean;
}

/**
 * Stack that handles Anthropic model access for Amazon Bedrock.
 * 
 * This stack performs two operations:
 * 1. Submits the Anthropic use case form (required once per account, us-east-1 only)
 * 2. Creates model agreements for required Claude models (accepts EULA)
 * 
 * IMPORTANT: The PutUseCaseForModelAccess API ONLY works in us-east-1 region.
 * Model agreements can be created in any region where the models are available.
 */
export class BedrockAccessStack extends cdk.Stack {
  public readonly accessGranted: boolean;

  constructor(scope: Construct, id: string, props?: BedrockAccessStackProps) {
    // CRITICAL: Force us-east-1 region - PutUseCaseForModelAccess only works there
    super(scope, id, {
      ...props,
      env: {
        ...props?.env,
        region: 'us-east-1',
      },
      crossRegionReferences: true,
    });

    const anthropicUseCase = props?.anthropicUseCase;
    const modelRegion = props?.modelRegion || props?.env?.region || 'us-west-2';

    // Skip if no config provided
    if (!anthropicUseCase) {
      console.log('No Anthropic use case config provided. Skipping model access request.');
      this.accessGranted = false;
      
      new cdk.CfnOutput(this, 'BedrockAccessStatus', {
        value: 'SKIPPED - No anthropicUseCase config provided',
        description: 'Status of Anthropic model access request',
      });
      return;
    }

    // Validate and transform config at runtime
    const parseResult = AnthropicUseCaseSchema.safeParse(anthropicUseCase);
    if (!parseResult.success) {
      throw new Error(
        'Invalid anthropicUseCase configuration: ' +
        parseResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      );
    }

    const validatedConfig = parseResult.data;

    // Prepare form data for the API - must match exact format
    const formData = {
      companyName: validatedConfig.companyName,
      companyWebsite: validatedConfig.companyWebsite,
      intendedUsers: validatedConfig.intendedUsers,
      industryOption: validatedConfig.industryOption,
      otherIndustryOption: validatedConfig.otherIndustryOption,
      useCases: validatedConfig.useCases,
    };

    const formDataJson = JSON.stringify(formData);

    // Create log group for custom resources
    const logGroup = new logs.LogGroup(this, 'BedrockAccessLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ============================================
    // Step 1: Submit Anthropic Use Case (us-east-1 only)
    // Skip for internal accounts
    // ============================================
    const skipUseCaseSubmission = props?.skipUseCaseSubmission ?? false;
    let submitUseCase: cr.AwsCustomResource | undefined;
    
    if (!skipUseCaseSubmission) {
      submitUseCase = new cr.AwsCustomResource(this, 'SubmitAnthropicUseCase', {
        onCreate: {
          service: 'Bedrock',
          action: 'putUseCaseForModelAccess',
          parameters: {
            formData: formDataJson,
          },
          physicalResourceId: cr.PhysicalResourceId.of('anthropic-use-case-submission'),
          region: 'us-east-1',
        },
        onUpdate: undefined,
        onDelete: undefined,
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['bedrock:PutUseCaseForModelAccess'],
            resources: ['*'],
          }),
        ]),
        logGroup,
        installLatestAwsSdk: true,
      });
      
      // Suppress CDK custom resource Lambda runtime warnings for AwsCustomResource
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        `${this.stackName}/SubmitAnthropicUseCase/CustomResourcePolicy/Resource`,
        cdkCustomResourceSuppressions
      );
      
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
    }

    // ============================================
    // Step 2: Create Model Agreements (accepts EULA)
    // ============================================
    // Lambda function to fetch offer token and create agreement
    const modelAgreementLambda = new lambda.Function(this, 'ModelAgreementLambda', {
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      code: lambda.Code.fromInline(this.getModelAgreementLambdaCode()),
      description: 'Creates Bedrock model agreements by fetching offer tokens and accepting EULA',
      logGroup: new logs.LogGroup(this, 'ModelAgreementLambdaLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Grant Bedrock permissions to the Lambda
    modelAgreementLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:ListFoundationModelAgreementOffers',
        'bedrock:CreateFoundationModelAgreement',
        'bedrock:GetFoundationModelAvailability',
      ],
      resources: ['*'],
    }));

    // AWS Marketplace permissions required for Bedrock model subscriptions
    modelAgreementLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
      resources: ['*'],
    }));

    // Create a custom resource provider
    const modelAgreementProvider = new cr.Provider(this, 'ModelAgreementProvider', {
      onEventHandler: modelAgreementLambda,
      logGroup: new logs.LogGroup(this, 'ModelAgreementProviderLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    
    // Suppress CDK custom resource Lambda runtime warnings for Provider
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/ModelAgreementProvider/framework-onEvent`,
      [...cdkCustomResourceSuppressions, ...lambdaBasicExecutionRoleSuppressions, ...pluginSystemSuppressions],
      true
    );
    
    // Suppress for ModelAgreementLambda
    NagSuppressions.addResourceSuppressions(
      modelAgreementLambda,
      lambdaBasicExecutionRoleSuppressions,
      true
    );

    // Create model agreements for each required model
    REQUIRED_MODELS.forEach((modelId, index) => {
      const agreement = new cdk.CustomResource(this, `ModelAgreement${index}`, {
        serviceToken: modelAgreementProvider.serviceToken,
        properties: {
          modelId,
          region: modelRegion,
        },
      });
      
      // Ensure use case is submitted before creating agreements (if not skipped)
      if (submitUseCase) {
        agreement.node.addDependency(submitUseCase);
      }
    });

    this.accessGranted = true;

    // Outputs
    new cdk.CfnOutput(this, 'BedrockAccessStatus', {
      value: 'SUBMITTED',
      description: 'Status of Anthropic model access request',
    });

    new cdk.CfnOutput(this, 'CompanyName', {
      value: validatedConfig.companyName,
      description: 'Company name submitted for Anthropic access',
    });

    new cdk.CfnOutput(this, 'ModelsEnabled', {
      value: REQUIRED_MODELS.join(', '),
      description: 'Models with agreements created',
    });

    new cdk.CfnOutput(this, 'ModelRegion', {
      value: modelRegion,
      description: 'Region where model agreements were created',
    });
  }

  /**
   * Returns the Python code for the model agreement Lambda.
   * This Lambda fetches the offer token and creates the agreement.
   */
  private getModelAgreementLambdaCode(): string {
    return `
import boto3
import json
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
    """
    Custom resource handler to create Bedrock model agreements.
    
    On Create: Fetches offer token and creates agreement (accepts EULA)
    On Update: No-op (agreements persist)
    On Delete: No-op (agreements persist after stack deletion)
    """
    request_type = event.get('RequestType', '')
    properties = event.get('ResourceProperties', {})
    model_id = properties.get('modelId', '')
    region = properties.get('region', 'us-west-2')
    
    logger.info(f"Request type: {request_type}, Model: {model_id}, Region: {region}")
    
    # Only process Create requests
    if request_type != 'Create':
        logger.info(f"Skipping {request_type} request - agreements persist")
        return {
            'PhysicalResourceId': f'model-agreement-{model_id}',
            'Data': {'status': 'SKIPPED', 'modelId': model_id}
        }
    
    try:
        bedrock = boto3.client('bedrock', region_name=region)
        
        # Check current availability
        availability = bedrock.get_foundation_model_availability(modelId=model_id)
        agreement_status = availability.get('agreementAvailability', {}).get('status', 'UNKNOWN')
        
        logger.info(f"Current agreement status for {model_id}: {agreement_status}")
        
        # If already available, skip
        if agreement_status == 'AVAILABLE':
            logger.info(f"Model {model_id} already has agreement - skipping")
            return {
                'PhysicalResourceId': f'model-agreement-{model_id}',
                'Data': {'status': 'ALREADY_AVAILABLE', 'modelId': model_id}
            }
        
        # Get offer token
        logger.info(f"Fetching offer token for {model_id}")
        offers_response = bedrock.list_foundation_model_agreement_offers(modelId=model_id)
        offers = offers_response.get('offers', [])
        
        if not offers:
            logger.warning(f"No offers available for {model_id}")
            return {
                'PhysicalResourceId': f'model-agreement-{model_id}',
                'Data': {'status': 'NO_OFFERS', 'modelId': model_id}
            }
        
        offer_token = offers[0].get('offerToken')
        if not offer_token:
            raise Exception(f"Offer token not found for {model_id}")
        
        logger.info(f"Creating agreement for {model_id}")
        
        # Create the agreement (accepts EULA)
        bedrock.create_foundation_model_agreement(
            modelId=model_id,
            offerToken=offer_token
        )
        
        logger.info(f"Successfully created agreement for {model_id}")
        
        return {
            'PhysicalResourceId': f'model-agreement-{model_id}',
            'Data': {'status': 'CREATED', 'modelId': model_id}
        }
        
    except bedrock.exceptions.ConflictException as e:
        # Agreement already exists
        logger.info(f"Agreement already exists for {model_id}: {str(e)}")
        return {
            'PhysicalResourceId': f'model-agreement-{model_id}',
            'Data': {'status': 'ALREADY_EXISTS', 'modelId': model_id}
        }
        
    except Exception as e:
        logger.error(f"Error creating agreement for {model_id}: {str(e)}")
        raise
`;
  }
}
