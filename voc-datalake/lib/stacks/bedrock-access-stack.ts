/**
 * NOTE ON THIS FILE'S NAME: it exports Constructs, not a stack, despite living in
 * lib/stacks/ and being called *-stack.ts. This used to be BedrockAccessStack; it
 * was folded into other stacks to stay within the five-template ceiling, and later
 * split in two (ported from PR #429 by @aws-bryan):
 *
 *   - AnthropicUseCaseSubmission: Anthropic's first-time use case form. Opt-in
 *     (`anthropicUseCase` in context), hosted by the us-east-1 VocWebSearchStack.
 *   - BedrockModelAgreements: a Marketplace agreement per allowlisted Claude model
 *     (in the app region) plus the persona-avatar image model's. Every deploy,
 *     best effort, hosted by VocCoreStack.
 *
 * So with no form and `-c enableWebSearch=false`, a deployment touches no region
 * but its own.
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
import { ALLOWED_FOUNDATION_MODEL_IDS, IMAGE_MODEL_ID, IMAGE_MODEL_REGION } from '../utils/model-allowlist';
import { NagSuppressions } from 'cdk-nag';
import { cdkCustomResourceSuppressions, lambdaBasicExecutionRoleSuppressions, pluginSystemSuppressions, bedrockAgreementSuppressions, marketplaceSuppressions, suppressAwsCustomResourceProvider } from '../utils/nag-suppressions';

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
  companyWebsite: z.url('Company website must be a valid URL'),
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
 * (issue #96) has its agreement created — Opus 5.5, Sonnet 5.5, Sonnet 5,
 * Sonnet 4.6, Opus 5, Opus 4.8, Haiku 5.5 and Haiku 4.5. Opus 5 and Opus 4.8
 * need their agreements both as picker options and as safety-fallback targets
 * (Opus 5.5 falls back to Opus 5, Opus 5 to Opus 4.8). Kept in lockstep with
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
 * Anthropic requires the form once per account (or once at the organization's
 * management account) before Claude can be invoked. Opt-in: built only when the
 * deployer passes their own `anthropicUseCase` block, because the form states who
 * the deployer is, and a committed default would file it in every deployer's
 * account under somebody else's name. Without it, the form is filed once in the
 * Bedrock console (docs/deployment.md → Bedrock model access).
 *
 * The call is made in us-east-1 (the `region` below), which is why the hosting
 * stack is VocWebSearchStack. The model agreements are NOT here: they are
 * BedrockModelAgreements, in VocCoreStack, and bin/voc-datalake.ts makes Core wait
 * for this stack when there is a form to submit.
 */
export class AnthropicUseCaseSubmission extends Construct {
  /**
   * Adds the submission to `scope`. VocWebSearchStack passes the id
   * `BedrockModelAccess` (the construct's name before the split), so the
   * submission's logical id, and with it the deployed resource, stays the same:
   * a new logical id would be a new Create, i.e. a second submission.
   */
  public static addTo(scope: Construct, id: string, props: AnthropicUseCaseSubmissionProps): AnthropicUseCaseSubmission {
    return new AnthropicUseCaseSubmission(scope, id, props);
  }

  private constructor(scope: Construct, id: string, props: AnthropicUseCaseSubmissionProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // Validate and transform config at runtime
    const parseResult = AnthropicUseCaseSchema.safeParse(props.anthropicUseCase);
    if (!parseResult.success) {
      throw new Error(
        'Invalid anthropicUseCase configuration: ' +
        parseResult.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
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
    suppressAwsCustomResourceProvider(stack, stack.node.id);

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
 * The Bedrock model agreements (EULA + Marketplace subscription), on EVERY
 * deployment, best effort: one per allowlisted Claude model (REQUIRED_MODELS) in
 * the hosting stack's region, and the persona-avatar image model's (IMAGE_MODEL_ID
 * in IMAGE_MODEL_REGION, us-west-2 whatever the app region).
 *
 * Bedrock also subscribes a model on its first invocation, but only when the
 * caller holds `aws-marketplace:Subscribe`, and most of this app's Lambda roles do
 * not: without these agreements a new account's first enrichment call would fail.
 *
 * Hosted by VocCoreStack (bin/voc-datalake.ts): it always exists, deploys first (so
 * the subscriptions are in place before Ingestion and Processing call a model),
 * runs in the app's region, and is far from the 500-resource ceiling. The Claude
 * agreements lived in the us-east-1 VocWebSearchStack until they moved here (ported
 * from PR #429 by @aws-bryan), and were created only alongside the use case form.
 *
 * Best effort: a failure of any kind (a Private Marketplace refusal, a model not
 * offered in the region, throttling, a dropped connection, even the role's own
 * AccessDenied) is logged and reported as UNAVAILABLE, never a failed deploy: a
 * raise here would roll back the stack that holds every table. Runs on Create only;
 * Update and Delete leave the account's agreements alone, so moving or removing a
 * resource revokes nothing. Administration → AI models shows what is usable.
 */
/** `-c modelAgreementRetry`: absent, or a short token (a new one re-attempts the agreements). */
export const ModelAgreementRetrySchema = z.string().regex(/^[\w.-]{1,64}$/).optional();

export interface ModelAgreementOptions {
  /**
   * `-c modelAgreementRetry=<value>`: any new value re-attempts every agreement on the next deploy
   * (best effort, like the first attempt). Use it after filing the use-case form in the console, or
   * after fixing what refused an agreement. Absent = nothing re-runs.
   */
  readonly retry?: string;
}

export class BedrockModelAgreements extends Construct {
  /**
   * Adds the agreements to `scope`. bin/voc-datalake.ts passes the id
   * `ImageModelAccess` (the construct's name when it held only the image
   * agreement), so the image agreement and the shared provider keep their logical
   * ids, log group names and service token: CloudFormation refuses to change a
   * custom resource's ServiceToken.
   */
  public static addTo(scope: Construct, id: string, options: ModelAgreementOptions = {}): BedrockModelAgreements {
    return new BedrockModelAgreements(scope, id, options);
  }

  private constructor(scope: Construct, id: string, options: ModelAgreementOptions) {
    super(scope, id);
    const agreements = new ModelAgreementProvider(this, options.retry);
    agreements.agree(this, 'ImageModelAgreement', IMAGE_MODEL_ID, IMAGE_MODEL_REGION);
    // Where the app runs. Passed as a property rather than read by the handler, so the
    // template states it.
    const appRegion = cdk.Stack.of(this).region;
    REQUIRED_MODELS.forEach((modelId, index) => {
      agreements.agree(this, `ClaudeModelAgreement${index}`, modelId, appRegion);
    });
  }
}

/**
 * The custom-resource provider that accepts one Bedrock model's agreement (EULA +
 * Marketplace subscription) per custom resource, used by BedrockModelAgreements for
 * the image model and every Claude model alike. Deliberately not a Construct: its
 * resources are created directly in the host construct, so the image agreement's
 * provider kept its logical ids when the Claude agreements joined it.
 */
class ModelAgreementProvider {
  private readonly serviceToken: string;

  constructor(host: Construct, private readonly retry?: string) {

    // Lambda function to fetch offer token and create agreement
    const modelAgreementLambda = new lambda.Function(host, 'ModelAgreementLambda', {
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      code: lambda.Code.fromInline(this.getModelAgreementLambdaCode()),
      description: 'Creates Bedrock model agreements by fetching offer tokens and accepting EULA',
      logGroup: new logs.LogGroup(host, 'ModelAgreementLambdaLogs', {
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
    const modelAgreementProvider = new cr.Provider(host, 'ModelAgreementProvider', {
      onEventHandler: modelAgreementLambda,
      logGroup: new logs.LogGroup(host, 'ModelAgreementProviderLogs', {
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
    // BedrockModelAgreements is a Construct, not a VocStack, so it has no access to
    // the prefix either; threading one through would be work with no effect. If
    // that ever stopped being true, the zero-warnings assertion over the
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

    this.serviceToken = modelAgreementProvider.serviceToken;
  }

  /**
   * One model's agreement, created in `region` (a property, not a placement: the
   * handler builds its Bedrock client there). Always best effort (`bestEffort:
   * 'true'`): the handler turns every failure into an UNAVAILABLE result instead of
   * a failed deploy.
   */
  public agree(scope: Construct, id: string, modelId: string, region: string): cdk.CustomResource {
    return new cdk.CustomResource(scope, id, {
      serviceToken: this.serviceToken,
      // A changed `retry` (-c modelAgreementRetry) makes CloudFormation send an Update, which the
      // handler treats as a new attempt; without it the properties never change and nothing re-runs.
      properties: { modelId, region, bestEffort: 'true', ...(this.retry === undefined ? {} : { retry: this.retry }) },
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
from botocore.exceptions import (
    ClientError, ConnectionClosedError, ConnectTimeoutError, EndpointConnectionError, ReadTimeoutError,
)

# A transient network failure reaching Bedrock. Deliberately NOT BotoCoreError, whose
# family also holds ParamValidationError, NoCredentialsError, NoRegionError...: those are
# a wrong model id, region or role, and must fail the deploy instead of passing as UNAVAILABLE.
TRANSIENT_ERRORS = (EndpointConnectionError, ConnectTimeoutError, ReadTimeoutError, ConnectionClosedError)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Agreement failures that are a property of the ACCOUNT, not a bug in this
# stack, and must not fail the deployment. Workshop Studio accounts sit behind
# an AWS Private Marketplace that refuses CreateFoundationModelAgreement for
# the newest models, which would otherwise take the whole stack (and, when it
# is not last in the deploy order, everything after it) down over a model the
# deployment may not even use.
NON_FATAL_ERROR_CODES = ('AccessDeniedException',)

def _unavailable(model_id, code):
    """The custom-resource result for a model whose agreement step was absorbed."""
    return {
        'PhysicalResourceId': f'model-agreement-{model_id}',
        'Data': {'status': 'UNAVAILABLE', 'modelId': model_id, 'errorCode': code}
    }

def _error_code(error):
    """The AWS error code of a ClientError, else the exception's type name."""
    response = getattr(error, 'response', None)
    details = response.get('Error') if isinstance(response, dict) else None
    code = details.get('Code') if isinstance(details, dict) else None
    return code or type(error).__name__

def handler(event, context):
    """
    Custom resource entry point. A resource with bestEffort='true' never fails the
    deploy: every error is logged and reported as UNAVAILABLE. Every agreement the
    app creates sets it (BedrockModelAgreements, in VocCoreStack, where a raise
    would roll back the stack holding every table). Without it the stricter rules
    in _handle decide: only an AccessDenied on the agreement call and a transient
    network failure are absorbed, everything else raises.
    """
    properties = event.get('ResourceProperties', {})
    if str(properties.get('bestEffort', '')).lower() != 'true':
        return _handle(event)
    try:
        return _handle(event)
    except Exception as e:
        model_id = properties.get('modelId', '')
        code = _error_code(e)
        logger.warning(
            f"Agreement step for {model_id} failed ({code}): {str(e)}. Continuing without it (best effort): "
            "accept this model's agreement in the Bedrock console if the app needs it."
        )
        return _unavailable(model_id, code)

def _handle(event):
    """
    Create one Bedrock model agreement.
    
    On Create: Fetches offer token and creates agreement (accepts EULA)
    On Update: The same attempt (CloudFormation sends one only when a property changed, e.g.
               -c modelAgreementRetry), so a refused agreement can be retried after the cause is fixed
    On Delete: No-op (agreements persist after stack deletion)
    """
    request_type = event.get('RequestType', '')
    properties = event.get('ResourceProperties', {})
    model_id = properties.get('modelId', '')
    region = properties.get('region', 'us-west-2')
    
    logger.info(f"Request type: {request_type}, Model: {model_id}, Region: {region}")
    
    # Delete leaves the account's agreement in place; Create and Update attempt it
    if request_type not in ('Create', 'Update'):
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

        # An offer without a token is as unusable as no offer at all, and is
        # reported the same way rather than raised.
        offer_token = offers[0].get('offerToken') if offers else None
        if not offer_token:
            logger.warning(f"No usable agreement offer for {model_id}")
            return {
                'PhysicalResourceId': f'model-agreement-{model_id}',
                'Data': {'status': 'NO_OFFERS', 'modelId': model_id}
            }
        
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
            return _unavailable(model_id, code)
        
        logger.info(f"Successfully created agreement for {model_id}")
        
        return {
            'PhysicalResourceId': f'model-agreement-{model_id}',
            'Data': {'status': 'CREATED', 'modelId': model_id}
        }
        
    except TRANSIENT_ERRORS as e:
        # A connection-level failure from any Bedrock call above. It carries no AWS
        # error code and says nothing about this stack's role or code, so it is
        # reported like the absorbed AccessDenied instead of rolling the stack back.
        # Listed first: it is not a ClientError, and it can occur before 'bedrock'
        # exists. Every ClientError still reaches the handlers below.
        code = type(e).__name__
        logger.warning(
            f"Agreement step for {model_id} could not reach Bedrock ({code}): {str(e)}. "
            "Continuing without it: accept this model's agreement in the Bedrock console "
            "(a later deploy does not retry it, because Update leaves the resource as created)."
        )
        return _unavailable(model_id, code)

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
