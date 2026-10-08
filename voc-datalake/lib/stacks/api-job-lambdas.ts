/**
 * VocApiStack's async job Lambdas (persona/document generation, merge, import)
 * and the PRD/PR-FAQ document workflow, wired into the Projects API.
 * Resources are created on the stack itself — see api-context.ts.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { stackModelArns } from '../utils/model-allowlist';
import {
  PY_LAMBDA_ASSET_EXCLUDES,
  VERIFICATION_FIXTURE_PROVIDER_ASSET_EXCLUDES,
  WORKER_TREE_ASSET_EXCLUDES,
} from '../utils/lambda-asset-excludes';
import type { ApiStackContext } from './api-context';
import { createDocumentStateMachine } from './api-document-workflow';
import { grantMarketplaceSubscription } from './api-marketplace';
import type { ProjectsLambda } from './api-projects-lambda';

export function createJobLambdas(ctx: ApiStackContext, projects: ProjectsLambda): void {
  const { stack, apiLayer } = ctx;
  const { projectsLambda, projectsRole, projectTablesEnvironment } = projects;
  const { feedbackTable, aggregatesTable, projectsTable, jobsTable, kmsKey, rawDataBucket, avatarsCdnUrl } = ctx.props;

  // ── Async job Lambdas (persona/document generation) invoked by the Projects API ──
  const createJobLambdaCode = (jobFolder: string): lambda.Code => {
    return lambda.Code.fromAsset('lambda', {
      // Stages only jobs/ + api/ (projects.py, product_context.py, prompts) + shared/.
      // The private provider is not part of any ordinary job payload.
      exclude: [
        ...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES,
        ...VERIFICATION_FIXTURE_PROVIDER_ASSET_EXCLUDES,
        '/aggregator/',
        '/processor/',
        '/research/',
      ],
      ignoreMode: cdk.IgnoreMode.GIT,
      bundling: {
        image: lambda.Runtime.PYTHON_3_14.bundlingImage,
        command: [
          'bash', '-c',
          `mkdir -p /asset-output/api && ` +
          `cp /asset-input/jobs/${jobFolder}/handler.py /asset-output/ && ` +
          `cp -r /asset-input/shared /asset-output/ && ` +
          `cp /asset-input/api/projects.py /asset-output/api/ && ` +
          // document_generator's handle_job() does `from api.product_context import ...`
          // for both the product_report doc_type and the PRD/PR-FAQ product-context
          // injection — this file must ship in the bundle or both paths fail/degrade.
          `cp /asset-input/api/product_context.py /asset-output/api/ && ` +
          // INVARIANT: prompts land at the bundle ROOT (/var/task/prompts) —
          // shared/prompts.py::get_prompts_dir resolves that path first.
          `cp -r /asset-input/api/prompts /asset-output/prompts`
        ],
        platform: 'linux/arm64',
      },
    });
  };

  // Every allowlisted model (issue #96) so any AI surface can be repointed
  // via the picker. Single source of truth kept in lockstep with
  // lambda/shared/model_config.py and lambda/stream/src/bedrock/model-override.ts.
  const claudeModelResources = stackModelArns(stack);
  // Persona avatar image model — see model-allowlist.ts for its EOL deadline.
  const avatarImageModelResource = ctx.avatarImageModelArn;

  // Every job Lambda below is invoked with InvocationType='Event' (see
  // shared/aws.py::invoke_lambda_async), and AWS re-drives a FAILED async
  // invocation twice more by default, silently. That default is what turned one
  // prototype click into ~45 minutes: the function was killed at its own 15-min
  // ceiling, then re-run twice from scratch, each attempt re-writing the same
  // job row's progress so the UI looked like one job making no headway. Measured
  // live — a second START with the SAME request id is the signature.
  //
  // Zero, because an LLM generation is neither cheap nor idempotent and a retry
  // here buys nothing: the work restarts from the beginning with the same inputs
  // that just failed, and shared/jobs.py already records the job `failed` for
  // the UI to render, so the user can retry deliberately and see why. A hidden
  // retry only multiplies cost and delays the diagnosis.
  //
  // NOT a substitute for a failure destination — exhausted async invocations
  // land in ctx.asyncFailureDestination (#253). This only stops
  // the multiplier. And it does not affect the Step Functions path for PRD/PR-FAQ:
  // an EventInvokeConfig governs async invocations only, so createDocumentStateMachine's
  // own explicit, VISIBLE retries below are untouched.
  //
  // Scoped to these four on purpose. The other async targets in this app keep the
  // AWS default, because for them a re-drive is a benefit rather than a repeated
  // bill: `voc-manual-import-processor` re-does bounded, content-keyed work that
  // the processor's idempotency records already de-duplicate, and the scraper and
  // integration invocations are watermark-driven, so repeating one fetches from
  // where it left off. What sets these four apart is that ONE invocation is ONE
  // large generation: a re-drive re-pays for it in full and cannot succeed for a
  // reason the first attempt failed on.
  const JOB_ASYNC_RETRY_ATTEMPTS = 0;

  // One shape for the four: Python 3.14 on Graviton, the jobs asset, the API
  // layer, no async retry, a failure destination (ctx.asyncFailureDestination),
  // and Powertools named after the function.
  const createJobLambda = (
    id: string,
    job: {
      baseName: string;
      jobFolder: string;
      role: iam.Role;
      timeout: cdk.Duration;
      memorySize: number;
      environment: Record<string, string>;
    },
  ): lambda.Function => new lambda.Function(stack, id, {
    functionName: ctx.uniqueName(job.baseName),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'handler.lambda_handler',
    code: createJobLambdaCode(job.jobFolder),
    role: job.role,
    timeout: job.timeout,
    memorySize: job.memorySize,
    retryAttempts: JOB_ASYNC_RETRY_ATTEMPTS,
    onFailure: ctx.asyncFailureDestination,
    environment: {
      ...job.environment,
      POWERTOOLS_SERVICE_NAME: job.baseName,
      LOG_LEVEL: 'INFO',
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup(`${id}Logs`, ctx.uniqueName(job.baseName)),
  });

  // Persona Generator Job Lambda
  const personaGeneratorRole = ctx.role('PersonaGeneratorRole');
  feedbackTable.grantReadData(personaGeneratorRole);
  projectsTable.grantReadWriteData(personaGeneratorRole);
  jobsTable.grantReadWriteData(personaGeneratorRole);
  aggregatesTable.grantReadData(personaGeneratorRole);
  kmsKey.grantEncryptDecrypt(personaGeneratorRole);
  personaGeneratorRole.addToPolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    resources: [...claudeModelResources, avatarImageModelResource],
  }));
  grantMarketplaceSubscription(personaGeneratorRole);
  rawDataBucket.grantReadWrite(personaGeneratorRole, 'avatars/*');

  const personaGeneratorLambda = createJobLambda('PersonaGeneratorJob', {
    baseName: 'voc-job-persona-generator',
    jobFolder: 'persona_generator',
    role: personaGeneratorRole,
    timeout: cdk.Duration.minutes(15),
    memorySize: 1024,
    environment: {
      ...projectTablesEnvironment,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      AVATARS_CDN_URL: avatarsCdnUrl,
    },
  });

  // Document Generator Job Lambda (PRD/PRFAQ)
  const documentGeneratorRole = ctx.role('DocumentGeneratorRole');
  feedbackTable.grantReadData(documentGeneratorRole);
  projectsTable.grantReadWriteData(documentGeneratorRole);
  jobsTable.grantReadWriteData(documentGeneratorRole);
  // Model picker: read per-surface overrides (documents/prototype) from aggregates.
  aggregatesTable.grantReadData(documentGeneratorRole);
  // Prototype pin feedback (§6.2): each built prototype gets ONE `prototype_pin`
  // feedback form, created by a conditional put (attribute_not_exists) — so
  // PutItem only: no Update, no Delete, nothing that could change or remove an
  // existing form. shared/prototype_pins.py::ensure_pin_form.
  aggregatesTable.grant(documentGeneratorRole, 'dynamodb:PutItem');
  kmsKey.grantEncryptDecrypt(documentGeneratorRole);
  documentGeneratorRole.addToPolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    // Opus 5.5 (the prototype-builder default) is part of the allowlist,
    // so claudeModelResources already covers it — no separate grant needed.
    resources: claudeModelResources,
  }));
  // Product context: read extracted product-doc text when generating PRD/PR-FAQ.
  rawDataBucket.grantRead(documentGeneratorRole, 'projects/*/product_docs/extracted/*');
  // Prototype HTML: write new prototypes + read prior ones (feedback-driven
  // regeneration reads the prior prototype's HTML back out of S3). Scoped to
  // this prefix only, not a bucket-wide grant.
  rawDataBucket.grantReadWrite(documentGeneratorRole, 'prototypes/*');

  const documentGeneratorLambda = createJobLambda('DocumentGeneratorJob', {
    baseName: 'voc-job-document-generator',
    jobFolder: 'document_generator',
    role: documentGeneratorRole,
    timeout: cdk.Duration.minutes(15),
    memorySize: 1024,
    environment: {
      ...projectTablesEnvironment,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      // No PROTOTYPES_CDN_URL: this job writes prototype HTML to S3 but no
      // longer builds its URL. That moved to the projects API, which signs it
      // per request (issue #229).
    },
  });

  // Document Merger Job Lambda
  const documentMergerRole = ctx.role('DocumentMergerRole');
  feedbackTable.grantReadData(documentMergerRole);
  projectsTable.grantReadWriteData(documentMergerRole);
  jobsTable.grantReadWriteData(documentMergerRole);
  // Model picker: read the documents-surface override from aggregates.
  aggregatesTable.grantReadData(documentMergerRole);
  kmsKey.grantEncryptDecrypt(documentMergerRole);
  documentMergerRole.addToPolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: claudeModelResources,
  }));

  const documentMergerLambda = createJobLambda('DocumentMergerJob', {
    baseName: 'voc-job-document-merger',
    jobFolder: 'document_merger',
    role: documentMergerRole,
    timeout: cdk.Duration.minutes(10),
    memorySize: 1024,
    environment: {
      ...projectTablesEnvironment,
    },
  });

  // Persona Importer Job Lambda
  const personaImporterRole = ctx.role('PersonaImporterRole');
  projectsTable.grantReadWriteData(personaImporterRole);
  jobsTable.grantReadWriteData(personaImporterRole);
  // Model picker: read the documents-surface override from aggregates.
  aggregatesTable.grantReadData(personaImporterRole);
  kmsKey.grantEncryptDecrypt(personaImporterRole);
  personaImporterRole.addToPolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: [...claudeModelResources, avatarImageModelResource],
  }));
  grantMarketplaceSubscription(personaImporterRole);
  rawDataBucket.grantReadWrite(personaImporterRole, 'avatars/*');

  const personaImporterLambda = createJobLambda('PersonaImporterJob', {
    baseName: 'voc-job-persona-importer',
    jobFolder: 'persona_importer',
    role: personaImporterRole,
    timeout: cdk.Duration.minutes(5),
    memorySize: 512,
    environment: {
      PROJECTS_TABLE: projectsTable.tableName,
      AGGREGATES_TABLE: aggregatesTable.tableName,
      JOBS_TABLE: jobsTable.tableName,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      AVATARS_CDN_URL: avatarsCdnUrl,
    },
  });

  // A lease loser self-redelivers once before its own budget becomes too
  // small, so an owner crash still has a durable post-expiry attempt. Use
  // deterministic physical-name ARNs instead of Function.grantInvoke: the
  // function already depends on its role, and a role policy that GetAtts the
  // function creates a CloudFormation cycle.
  const grantSelfInvoke = (role: iam.Role, functionName: string) => {
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [stack.formatArn({
        service: 'lambda',
        resource: 'function',
        resourceName: functionName,
      })],
    }));
  };
  grantSelfInvoke(personaGeneratorRole, ctx.uniqueName('voc-job-persona-generator'));
  grantSelfInvoke(documentGeneratorRole, ctx.uniqueName('voc-job-document-generator'));
  grantSelfInvoke(documentMergerRole, ctx.uniqueName('voc-job-document-merger'));
  grantSelfInvoke(personaImporterRole, ctx.uniqueName('voc-job-persona-importer'));

  // Wire job Lambda function names into the Projects API + grant invoke
  projectsLambda.addEnvironment('PERSONA_GENERATOR_FUNCTION', personaGeneratorLambda.functionName);
  projectsLambda.addEnvironment('DOCUMENT_GENERATOR_FUNCTION', documentGeneratorLambda.functionName);
  projectsLambda.addEnvironment('DOCUMENT_MERGER_FUNCTION', documentMergerLambda.functionName);
  projectsLambda.addEnvironment('PERSONA_IMPORTER_FUNCTION', personaImporterLambda.functionName);
  personaGeneratorLambda.grantInvoke(projectsRole);
  documentGeneratorLambda.grantInvoke(projectsRole);
  documentMergerLambda.grantInvoke(projectsRole);
  personaImporterLambda.grantInvoke(projectsRole);

  // PRD/PR-FAQ generation runs as a Step Functions workflow: each LLM step is
  // its own Lambda invocation, so a long CJK document (whose steps auto-continue
  // past maxTokens and can run minutes each) never overruns the single 15-min
  // Lambda budget. Intermediate step text is stashed in S3 (claim-check) under
  // scratch/document_jobs/* — SF state stays well under its 256KB ceiling.
  rawDataBucket.grantReadWrite(documentGeneratorRole, 'scratch/document_jobs/*');
  const documentStateMachine = createDocumentStateMachine(ctx, documentGeneratorLambda);
  documentStateMachine.grantStartExecution(projectsRole);
  projectsLambda.addEnvironment('DOCUMENT_STATE_MACHINE_ARN', documentStateMachine.stateMachineArn);
}
