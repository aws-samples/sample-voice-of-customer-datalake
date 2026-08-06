/**
 * NOTE ON THIS FILE'S NAME: it exports a Construct (BedrockModelAccess), not a
 * stack, despite living in lib/stacks/ and being called *-stack.ts. This used
 * to be BedrockAccessStack; it was folded into VocWebSearchStack to stay within
 * Workshop Studio's five-template ceiling.
 *
 * The path was kept deliberately: lambda/shared/test/test_model_agreement_handler.py
 * reads THIS path and regexes `getModelAgreementLambdaCode()` out of it to test
 * the inline Python handler. Moving or renaming either silently breaks that
 * suite. Rename both together if the inconsistency is worth fixing.
 */
import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { z } from 'zod';
import { ALLOWED_FOUNDATION_MODEL_IDS } from '../utils/model-allowlist';
import { NagSuppressions } from 'cdk-nag';
import { cdkCustomResourceSuppressions, lambdaBasicExecutionRoleSuppressions, pluginSystemSuppressions, bedrockAgreementSuppressions, marketplaceSuppressions } from '../utils/nag-suppressions';

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
 * Models that require agreement acceptance for the VoC platform. Sourced from
 * the shared allowlist so every model the per-surface picker can select
 * (issue #96) has its agreement created — Sonnet 5, Sonnet 4.6, Opus 5, Opus
 * 4.8 and Haiku 4.5. Opus 4.8 needs its agreement both as a picker option and
 * because Opus 5 automatically falls back to it. Kept in lockstep with
 * lambda/shared/model_config.py.
 */
const REQUIRED_MODELS = [...ALLOWED_FOUNDATION_MODEL_IDS];

export interface BedrockModelAccessProps {
  /**
   * Anthropic use case configuration for first-time model access.
   *
   * Required: the caller decides whether this half is deployed at all by
   * choosing whether to construct it. See VocWebSearchStack.
   */
  anthropicUseCase: AnthropicUseCaseConfig;

  /**
   * AWS region where the models will be used.
   * Model agreements are created in this region.
   *
   * This is a custom-resource *property*, not a placement decision — the
   * handler does `boto3.client('bedrock', region_name=region)` — so the
   * agreements land in the app's region even though this construct is hosted
   * by a stack pinned to us-east-1.
   *
   * Required deliberately: a default here would be a silently-wrong region for
   * every caller that forgot to pass one, and the agreements would be created
   * somewhere the app never calls Bedrock.
   */
  modelRegion: string;

  /**
   * Skip the use case submission step.
   * @default false
   */
  skipUseCaseSubmission?: boolean;
}

/**
 * Bedrock model access for Anthropic models.
 *
 * Performs two operations:
 * 1. Submits the Anthropic use case form (required once per account, us-east-1 only)
 * 2. Creates model agreements for required Claude models (accepts EULA)
 *
 * IMPORTANT: The PutUseCaseForModelAccess API ONLY works in us-east-1, so the
 * hosting stack must be pinned there. Model agreements can be created in any
 * region where the models are available (see `modelRegion`).
 *
 * This is a Construct rather than a Stack: it is hosted by VocWebSearchStack,
 * which is already pinned to us-east-1 for the same reason. The two used to be
 * separate stacks, which put the app one template over Workshop Studio's
 * five-template ceiling. Nothing else imports from this half — it publishes no
 * consumed exports — so folding it in cost no cross-stack wiring.
 */
export class BedrockModelAccess extends Construct {
  constructor(scope: Construct, id: string, props: BedrockModelAccessProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const anthropicUseCase = props.anthropicUseCase;
    const modelRegion = props.modelRegion;

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
    const skipUseCaseSubmission = props.skipUseCaseSubmission ?? false;
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
          // Best-effort submission: accounts that already have Anthropic
          // access (prior submission, org-level grants, internal accounts)
          // reject the call, e.g. with "Internal Accounts should not submit
          // use case details". That must not fail the whole deployment —
          // model agreements in Step 2 will surface any real access problem.
          // Access/permission/throttling errors still fail loudly. See #103.
          ignoreErrorCodesMatching: 'ValidationException|ConflictException',
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
      
      // Suppress CDK custom resource Lambda runtime warnings for AwsCustomResource.
      // Object-based rather than path-based: this is now a Construct, so a
      // hardcoded `<stackName>/SubmitAnthropicUseCase/...` path would no longer
      // resolve (the real path gains this construct's id as a segment).
      NagSuppressions.addResourceSuppressions(
        submitUseCase,
        [...cdkCustomResourceSuppressions, ...bedrockAgreementSuppressions],
        true
      );

      // The AwsCustomResource construct creates a singleton Lambda with a
      // deterministic UUID. It is scoped to the STACK, not to this construct,
      // so these paths stay stack-relative.
      //
      // Built from the stack's CONSTRUCT ID, not `stack.stackName`: these are
      // matched against `node.path`, which uses construct ids. The two only
      // coincide while no explicit `stackName` is set, so using stackName here
      // would silently stop matching — and therefore silently drop the
      // suppressions — the day someone overrides it.
      const customResourceId = `AWS${cr.AwsCustomResource.PROVIDER_FUNCTION_UUID.split('-').join('')}`;
      const customResourceSuppressPaths = new Set([
        `/${stack.node.id}/${customResourceId}/ServiceRole/Resource`,
        `/${stack.node.id}/${customResourceId}/Resource`,
      ]);

      const allExistingPaths = new Set(
        stack.node.findAll().map((node) => `/${node.node.path}`)
      );

      for (const path of customResourceSuppressPaths) {
        if (allExistingPaths.has(path)) {
          NagSuppressions.addResourceSuppressionsByPath(
            stack,
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
    NagSuppressions.addResourceSuppressions(
      modelAgreementProvider,
      [...cdkCustomResourceSuppressions, ...lambdaBasicExecutionRoleSuppressions, ...pluginSystemSuppressions],
      true
    );
    
    // Suppress for ModelAgreementLambda
    NagSuppressions.addResourceSuppressions(
      modelAgreementLambda,
      [...lambdaBasicExecutionRoleSuppressions, ...bedrockAgreementSuppressions, ...marketplaceSuppressions],
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

    // Outputs. Informational only — nothing imports these, which is precisely
    // why this half could be folded into another stack without rewiring.
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
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Agreement failures that are a property of the ACCOUNT, not a bug in this
# stack, and must not fail the deployment. Workshop Studio accounts sit behind
# an AWS Private Marketplace that refuses CreateFoundationModelAgreement for
# the newest models, which would otherwise take the whole stack (and, when it
# is not last in the deploy order, everything after it) down over a model the
# deployment may not even use.
NON_FATAL_ERROR_CODES = ('AccessDeniedException',)

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

        # Create the agreement (accepts EULA).
        # The non-fatal absorption below is scoped to THIS call only. An
        # AccessDeniedException from get_foundation_model_availability or
        # list_foundation_model_agreement_offers above means this stack's own
        # role is missing a permission — a real bug — and must still fail the
        # deployment rather than be reported as an unavailable model.
        try:
            bedrock.create_foundation_model_agreement(
                modelId=model_id,
                offerToken=offer_token
            )
        except ClientError as e:
            code = e.response.get('Error', {}).get('Code', '')
            if code not in NON_FATAL_ERROR_CODES:
                # Includes ConflictException, which the outer handler below
                # turns into ALREADY_EXISTS.
                raise
            # The account is not allowed to accept this model's agreement (e.g.
            # a Private Marketplace restriction). Report it instead of failing:
            # the models whose agreements DID succeed remain usable, and a
            # model that is unavailable here would only surface as an
            # AccessDenied at inference time anyway.
            logger.warning(
                f"Agreement unavailable for {model_id} ({code}): {str(e)}. "
                "Continuing — this model will not be invocable in this account."
            )
            return {
                'PhysicalResourceId': f'model-agreement-{model_id}',
                'Data': {'status': 'UNAVAILABLE', 'modelId': model_id, 'errorCode': code}
            }
        
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
