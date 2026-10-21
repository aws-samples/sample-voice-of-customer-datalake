/**
 * NOTE ON THIS FILE'S NAME: it exports two Constructs, not a stack, despite
 * living in lib/stacks/ and being called *-stack.ts. This used to be
 * BedrockAccessStack; it was folded into other stacks to stay within Workshop
 * Studio's five-template ceiling, and later split in two:
 *
 *   - AnthropicUseCaseSubmission — Anthropic's first-time use case form. Opt-in
 *     (`anthropicUseCase` in context), hosted by the us-east-1 VocWebSearchStack.
 *   - BedrockModelAgreements — a Marketplace agreement per allowlisted model.
 *     On for every deploy, hosted by VocCoreStack in the app's own region.
 *
 * They were split so the agreements no longer need the us-east-1 stack: with the
 * form unset and `-c enableWebSearch=false`, a deployment touches no region but
 * its own.
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

export interface AnthropicUseCaseSubmissionProps {
  /** The form's contents. Validated again here, since a caller may skip bin's parse. */
  readonly anthropicUseCase: AnthropicUseCaseConfig;
}

/**
 * Submits Anthropic's first-time use case form (PutUseCaseForModelAccess).
 *
 * Anthropic requires the form once per account, or once at the organization's
 * management account, before Claude can be invoked. Opt-in: built only when
 * `anthropicUseCase` is set, because the form states who the deployer is, and a
 * committed default would file it in every deployer's account under somebody
 * else's name. Without it, the form is submitted once in the Bedrock console.
 *
 * The call is made in us-east-1 (the `region` below), which is why the hosting
 * stack is VocWebSearchStack. Whether PutUseCaseForModelAccess also works in
 * other regions is untested; GetUseCaseForModelAccess does answer in us-west-2.
 */
export class AnthropicUseCaseSubmission extends Construct {
  constructor(scope: Construct, id: string, props: AnthropicUseCaseSubmissionProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const parseResult = AnthropicUseCaseSchema.safeParse(props.anthropicUseCase);
    if (!parseResult.success) {
      throw new Error(
        'Invalid anthropicUseCase configuration: ' +
        parseResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
      );
    }
    const validatedConfig = parseResult.data;

    // Prepare form data for the API - must match exact format
    const formDataJson = JSON.stringify({
      companyName: validatedConfig.companyName,
      companyWebsite: validatedConfig.companyWebsite,
      intendedUsers: validatedConfig.intendedUsers,
      industryOption: validatedConfig.industryOption,
      otherIndustryOption: validatedConfig.otherIndustryOption,
      useCases: validatedConfig.useCases,
    });

    const logGroup = new logs.LogGroup(this, 'BedrockAccessLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const submitUseCase = new cr.AwsCustomResource(this, 'SubmitAnthropicUseCase', {
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
        // invoking a model surfaces any real access problem.
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

    // Object-based rather than path-based: this is a Construct, so a hardcoded
    // `<stackName>/SubmitAnthropicUseCase/...` path would not resolve (the real
    // path gains this construct's id as a segment).
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

    // Outputs. Informational only — nothing imports these.
    new cdk.CfnOutput(this, 'BedrockAccessStatus', {
      value: 'SUBMITTED',
      description: 'Status of Anthropic model access request',
    });

    new cdk.CfnOutput(this, 'CompanyName', {
      value: validatedConfig.companyName,
      description: 'Company name submitted for Anthropic access',
    });
  }
}

/**
 * Creates the Bedrock model agreement (the Marketplace subscription that
 * accepts the EULA) for every allowlisted model, in the hosting stack's region.
 *
 * Bedrock also subscribes a model on its first invocation, but only when the
 * caller holds `aws-marketplace:Subscribe`, and most of this app's Lambda roles
 * do not. Without these agreements, a new account's first call from such a role
 * fails, and keeps failing until a role that can subscribe calls the same model.
 *
 * Best effort by design: the hosting stack is VocCoreStack, where a failed
 * custom resource rolls back the stack that holds every table, so an account
 * that cannot take an agreement gets an UNAVAILABLE result and a log line, not a
 * failed deploy. See the handler for the one error that still fails.
 *
 * Runs on Create only. An agreement is account state, and Update and Delete
 * leave it alone, so removing this construct revokes nothing.
 */
export class BedrockModelAgreements extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Created where the app runs. The handler is told the region explicitly
    // rather than reading its own, so the custom-resource property states it.
    const modelRegion = cdk.Stack.of(this).region;

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

    // Suppress CDK custom resource Lambda runtime warnings for Provider.
    //
    // pluginSystemSuppressions() takes NO prefix here, deliberately. It is a
    // function of the deployment prefix because the findings it suppresses quote
    // a concrete ARN, but the only findings it covers on THIS construct are the
    // `<...ModelAgreementLambda...Arn>:*` version/alias wildcards — CDK logical-id
    // references, which carry no VoC physical name and so no prefix. The
    // ingestor/schedule entries in that set simply do not apply here.
    //
    // If that ever stopped being true, the zero-warnings assertion over the
    // PREFIXED synth in lib/app-deployment-prefix.test.ts would fail, since an
    // unmatched suppression leaves an AwsSolutions-IAM5 finding behind.
    NagSuppressions.addResourceSuppressions(
      modelAgreementProvider,
      [...cdkCustomResourceSuppressions, ...lambdaBasicExecutionRoleSuppressions, ...pluginSystemSuppressions()],
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
      new cdk.CustomResource(this, `ModelAgreement${index}`, {
        serviceToken: modelAgreementProvider.serviceToken,
        properties: {
          modelId,
          region: modelRegion,
        },
      });
    });

    // Outputs. Informational only — nothing imports these.
    new cdk.CfnOutput(this, 'ModelsEnabled', {
      value: REQUIRED_MODELS.join(', '),
      description: 'Models this stack creates agreements for (best effort; see the ModelAgreementLambda log)',
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
from botocore.exceptions import BotoCoreError, ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# The one AWS error that still fails the deployment, and only from the two read
# calls: AccessDenied there means THIS stack's own role is missing a permission,
# which is a bug in the stack rather than a property of the account.
#
# Every other AWS error is reported as UNAVAILABLE instead of raised. This runs
# in VocCoreStack, on every deploy, in every account and region the app is
# deployed to, and a raise rolls back the stack that holds every table — over a
# step that only pre-subscribes models. The account-state failures it absorbs
# include an AWS Private Marketplace refusing the newest models (Workshop
# Studio), a model not offered in this region, a missing Anthropic use case
# form, throttling that outlasted the SDK's retries, and connection failures
# (BotoCoreError, which carries no AWS error code).
OWN_ROLE_ERROR_CODES = ('AccessDeniedException',)
AWS_ERRORS = (ClientError, BotoCoreError)

def _error_code(error):
    response = getattr(error, 'response', None)
    if isinstance(response, dict):
        return response.get('Error', {}).get('Code', '')
    return type(error).__name__

def _result(model_id, status, **extra):
    return {
        'PhysicalResourceId': f'model-agreement-{model_id}',
        'Data': {'status': status, 'modelId': model_id, **extra}
    }

def _unavailable(model_id, error):
    code = _error_code(error)
    logger.warning(
        f"Agreement unavailable for {model_id} ({code}): {str(error)}. "
        "Continuing — this model will not be invocable in this account until it is subscribed."
    )
    return _result(model_id, 'UNAVAILABLE', errorCode=code)

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
        return _result(model_id, 'SKIPPED')
    
    bedrock = boto3.client('bedrock', region_name=region)

    try:
        # Check current availability
        availability = bedrock.get_foundation_model_availability(modelId=model_id)
        agreement_status = availability.get('agreementAvailability', {}).get('status', 'UNKNOWN')

        logger.info(f"Current agreement status for {model_id}: {agreement_status}")

        # If already available, skip
        if agreement_status == 'AVAILABLE':
            logger.info(f"Model {model_id} already has agreement - skipping")
            return _result(model_id, 'ALREADY_AVAILABLE')

        # Get offer token
        logger.info(f"Fetching offer token for {model_id}")
        offers_response = bedrock.list_foundation_model_agreement_offers(modelId=model_id)
    except AWS_ERRORS as e:
        if _error_code(e) in OWN_ROLE_ERROR_CODES:
            logger.error(f"This stack's role cannot read agreement state for {model_id}: {str(e)}")
            raise
        return _unavailable(model_id, e)

    # An offer without a token is as unusable as no offer at all, and is reported
    # the same way rather than raised, for the rollback reason above.
    offers = offers_response.get('offers', [])
    offer_token = offers[0].get('offerToken') if offers else None
    if not offer_token:
        logger.warning(f"No usable agreement offer for {model_id}")
        return _result(model_id, 'NO_OFFERS')

    logger.info(f"Creating agreement for {model_id}")

    # Create the agreement (accepts EULA). ConflictException is a ClientError
    # subclass, so it must be caught first: it means the agreement exists.
    try:
        bedrock.create_foundation_model_agreement(
            modelId=model_id,
            offerToken=offer_token
        )
    except bedrock.exceptions.ConflictException as e:
        logger.info(f"Agreement already exists for {model_id}: {str(e)}")
        return _result(model_id, 'ALREADY_EXISTS')
    except AWS_ERRORS as e:
        return _unavailable(model_id, e)

    logger.info(f"Successfully created agreement for {model_id}")
    return _result(model_id, 'CREATED')
`;
  }
}
