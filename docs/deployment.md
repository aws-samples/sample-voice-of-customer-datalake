# Deployment Guide

This guide is for the person who deploys and runs the VoC Data Lake in an AWS account. It covers the
prerequisites, Bedrock model access, the five CDK stacks and their deploy options, production data
protection, the frontend deployment, diagnostics, and troubleshooting.

## Prerequisites

- **AWS CLI** configured with credentials for the target account
- **Node.js** 22.12+ and npm
- **Python** 3.12+ for the local lint and tests (the Lambdas run Python 3.14; their code and layers are built in
  containers)
- **Docker or Finch** for the Lambda layers and CDK asset bundling

## Project Structure

```
sample-voice-of-customer-datalake/
├── package.json              # Root scripts (shortcuts)
├── voc-datalake/
│   ├── package.json          # CDK infrastructure
│   ├── bin/voc-datalake.ts   # CDK app entry point
│   ├── lib/stacks/           # CDK stack definitions
│   ├── lambda/               # Python Lambdas; lambda/stream is the TypeScript AI assistant
│   ├── plugins/              # Data source plugins
│   └── frontend/
│       ├── package.json      # React frontend
│       └── scripts/deploy.sh # Frontend deployment script
```

## Quick Start

From the project root:

```bash
# Install the Node dependencies (root, CDK, frontend), and the AI assistant Lambda's
npm run install:all
npm install --prefix voc-datalake/lambda/stream

# Python environment for the backend lint and tests (npm run check uses it)
cd voc-datalake
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt \
  -r lambda/layers/ingestion-deps/requirements.txt \
  -r lambda/layers/processing-deps/requirements.txt \
  -r lambda/layers/signing-deps/requirements.txt \
  -r lambda/layers/email-intake-deps/requirements.txt
cd ..

# Build Lambda layers (requires Docker; Finch users: CDK_DOCKER=finch npm run build:layers).
# Unchanged layers are skipped; FORCE_LAYER_BUILD=1 rebuilds them all (see "Faster deploys" below).
npm run build:layers

# Bootstrap CDK (first time per account and region)
npm run cdk:bootstrap

# Run the quality checks, deploy every stack, then the frontend
npm run deploy:all
```

`npm run deploy:all` is `npm run check && npm run deploy:infra && npm run deploy:frontend`. To deploy without
running the checks, build the frontend first (the API stack uploads `frontend/dist`, see
[Frontend Build Freshness Guard](#frontend-build-freshness-guard)) and run `npm run build && npm run deploy:infra`.

Before the first deploy, read [Anthropic Model Access](#anthropic-model-access-first-time-setup). Web search is on by
default and deploys a stack to us-east-1, so a deployment in another region also needs
`cdk bootstrap aws://ACCOUNT_ID/us-east-1` ([Web Search](#web-search-amazon-bedrock-agentcore)). A production
deployment should set [`protectData`](#production-protectdata).

## Deploy Options Reference

Every option is a CDK context key: pass it as `-c <key>=<value>` on each deploy (`npm run deploy:infra -- -c key=value`)
or set it in `voc-datalake/cdk.context.json`. An invalid value fails the synth.

| Key | Default | Effect |
|-----|---------|--------|
| `pluginStatus` | every built-in plugin on (committed file) | Which data source plugins deploy ([Configuration](#configuration)) |
| `menuStatus` | every menu item on (committed file) | Which pages the menu shows ([Configuration](#configuration)) |
| `protectData` | `false` | `true` keeps data resources on stack deletion and adds deletion and termination protection ([Production: protectData](#production-protectdata)) |
| `inferenceScope` | `global` | `eu` keeps Bedrock inference in EU regions ([eu-deployment.md](eu-deployment.md)) |
| `enableWebSearch` | `true` | `false` removes the web search gateway and its us-east-1 stack ([Web Search](#web-search-amazon-bedrock-agentcore)) |
| `anthropicUseCase` | none | Your own Anthropic use-case form, filed by the deploy ([Submit the form from CDK](#submit-the-form-from-cdk-instead-opt-in)) |
| `skipUseCaseSubmission` | `false` | `true` validates an `anthropicUseCase` block but does not submit it |
| `modelAgreementRetry` | none | A new value re-attempts every Bedrock model agreement ([Model agreements](#model-agreements-every-deploy-in-the-app-region-best-effort)) |
| `defaultModelId` | none | Pins every AI surface to one allowlisted model ([Pinning All AI Surfaces](#pinning-all-ai-surfaces-to-one-model)) |
| `emailFrom` | none | Sender address for participant asks and board sign-in codes through SES ([Participant email](#participant-email-and-feedback-boards--c-emailfrom)) |
| `inboundEmailDomain` (+ `inboundEmailHostedZoneId`, `inboundEmailHostedZoneName`, `inboundEmailRuleSet`, `inboundEmailCreateIdentity`) | none | Receives feedback by email through SES ([email-intake.md](email-intake.md)) |
| `deploymentPrefix` | none | Namespaces a second copy in the same account and region ([Two Deployments](#two-deployments-in-one-account-and-region)) |
| `mcpReservedConcurrency` | `20` | Reserved concurrency of the MCP endpoint ([below](#reserved-concurrency-of-the-mcp-endpoint--c-mcpreservedconcurrency)) |
| `performanceTier` | `false` | `true` turns on every performance feature that carries a fixed monthly cost (today: `snapStart`); for a deployment that runs as a managed service rather than a sample ([lambda-sizing.md](lambda-sizing.md#the-performance-tier--c-performancetier)) |
| `snapStart` | `false` | `true` turns on Lambda SnapStart for the four cold-start-bound APIs (a fixed monthly cache charge, about $20; off by default per [TENETS.md](../TENETS.md), tenet 7) ([lambda-sizing.md](lambda-sizing.md#snapstart-off-by-default)) |
| `mcpTokenMinting`, `mcpOAuthCursorCallbacks`, `mcpOAuthWebCallbacks`, `mcpOAuthResourceIndicator` | see [mcp.md](mcp.md) | MCP token minting and OAuth client settings |
| `brandName` | `MyBrand` (`VoC Analytics` in the committed file) | Brand name stamped on feedback forms and their submissions |
| `primaryLanguage` | `en` | Language that enrichment translates feedback into |
| `environment` | `production` | `dev` opens the API and raw bucket to `localhost` origins (CORS `*`); never use it for a shared deployment |
| `skipFrontendBuildCheck` | `false` | Skips the frontend freshness guard ([below](#frontend-build-freshness-guard)) |
| `omitUserPoolUsernameConfiguration` | `false` | Compatibility flag for old user pools ([Troubleshooting](#voccorestack-fails-updates-are-not-allowed-for-property---usernameconfiguration)) |
| `skipFeedbackFormItemRoutes` | `false` | One-time upgrade step for old API stages ([Troubleshooting](#vocapistack-fails-a-sibling-proxy-of-this-resource-already-has-a-variable-path-part)) |
| `enableVerificationFixtureProvider`, `verificationFixtureInvokerArn` | off | Test-only fixture Lambda, never on production ([below](#verification-fixture-provider-opt-in-never-on-production)) |

## Quality Checks

The full gate is `npm run validate` (`scripts/validate.sh`): every check below plus ruff, vulture, pyright,
knip, jscpd, the i18n audit, the mock-coverage check, a gitleaks scan of the working tree and the code-audit
detectors ([Code audit → In the gate](code-audit.md#in-the-gate)), run in parallel
lanes with a per-step timing table at the end. CI runs it on every pull request. When and how to run it is in
[CONTRIBUTING.md](../CONTRIBUTING.md#quality-gates).

The narrower npm scripts are for iterating on one area:

```bash
# From project root
npm run lint         # frontend + stream ESLint, and ruff over lambda/ + plugins/ + scripts/
npm run typecheck    # frontend TypeScript only
npm run test         # frontend Vitest only

# Or run all at once
npm run check        # lint + typecheck:all + test + check:mock + check:i18n + build + test:cdk + test:stream + test:backend
```

### What Each Check Does

| Command | Covers |
|---------|--------|
| `npm run lint` | `lint:cdk` + `lint:frontend` + `lint:stream` + `lint:gates` (ESLint; `lint:gates` lints `eslint-rules/` itself) + `lint:python` (ruff over `lambda/`, `plugins/`, and `scripts/`) |
| `npm run typecheck` | Frontend only; use `typecheck:all` for frontend + CDK + stream |
| `npm run test` | Frontend Vitest only |
| `npm run check:mock` | Every `fetchApi` call site (and every raw `fetch` of the API base, `` fetch(`${getBaseUrl()}…`) ``) is listed in `frontend/mock-coverage.json` and its probes reach a real mock route |
| `npm run check:i18n` | The i18n audit (`frontend/scripts/i18n-check.mjs`, after its own regression tests): every key the source uses exists in English, and no locale has missing, extra or empty keys (untranslated values and unused keys only warn). It never writes files. The frontend's `i18n:validate` / `i18n:extract` run `i18next-parser`, which REWRITES the locale files (re-sorted, new keys empty), so they are an authoring tool, not a gate |
| `npm run test:cdk` | CDK Vitest (`voc-datalake`) |
| `npm run test:stream` | AI assistant stream Lambda Vitest |
| `npm run test:backend` | Python pytest via `.venv/bin/python` |
| `npm run check` | All of the above, chained with `&&`; it runs `npm run build` (the SPA) before `test:cdk`, whose synth needs `frontend/dist` |
| `npm run test:coverage` | Frontend tests with coverage report |

Two things to know about the gate:

- **`check` chains with `&&`, so the first failure hides every later step.** If
  `lint:python` fails you never find out whether the CDK or backend tests pass.
  When triaging, run the individual scripts rather than inferring from `check`.
- **`test:cdk` alone needs a built SPA.** The API stack deploys `frontend/dist`; without
  it the synth fails with `CannotFindAsset`. Run `npm run build` first (`check` does).

### Python Lambda Tests

Lambda handlers have their own test suite using pytest, run from the virtual environment of the
[Quick Start](#quick-start):

```bash
cd voc-datalake

# Run all Lambda tests (in parallel: pytest-xdist is in requirements-dev.txt)
.venv/bin/python -m pytest -n auto

# Run with coverage report
.venv/bin/python -m pytest --cov=lambda --cov-report=html:coverage_html

# Run specific handler tests
.venv/bin/python -m pytest lambda/processor/test/
.venv/bin/python -m pytest lambda/aggregator/test/
.venv/bin/python -m pytest lambda/api/test/
```

Test coverage reports are generated in `voc-datalake/coverage_html/`.

## Anthropic Model Access (First-Time Setup)

Two separate things stand between a new AWS account and Claude on Amazon Bedrock:

1. **Anthropic's use-case form**, required once per account (or once at the
   organization's management account). It states who you are, so you file it
   yourself. The deploy does **not** file it unless you pass your own details.
2. **A model agreement per model** (the EULA and Marketplace subscription). The
   deploy creates these for you in the app's region, once: on the first deploy that
   includes them. A later deploy retries a refused one only when asked (see below).

### File the use-case form in the Bedrock console (recommended)

Do this once, before or after the first deploy:

1. Open the Amazon Bedrock console in the region you deploy to.
2. Open **Model catalog** and choose any Anthropic model (for example Claude Sonnet).
3. Choose **Submit use case details**, fill in your company's details, and submit.

Access is granted shortly after a successful submission. The console route keeps
your company details out of CloudFormation entirely.

**Do you need it at all?** Per the Bedrock guide
([Request access to models](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)),
a submission made at the organization's management account is inherited by the
other accounts in the organization; it must be repeated in opt-in Regions. To check
an account, run
`aws bedrock get-foundation-model-availability --model-id <claude model id> --region <app region>`
and look at `authorizationStatus` / `agreementAvailability.status`.

### Model agreements: every deploy, in the app region, best effort

`VocCoreStack` carries the agreements (`BedrockModelAgreements` in
`lib/stacks/bedrock-access-stack.ts`, construct id `ImageModelAccess`): one custom
resource per allowlisted Claude model (`lib/utils/model-allowlist.ts`), created in
the app's region, plus one for the persona-avatar image model
(`stability.stable-image-core-v1:1`, in us-west-2 whatever the app region). Each runs
`GetFoundationModelAvailability`, then `ListFoundationModelAgreementOffers` +
`CreateFoundationModelAgreement`; a model already `AVAILABLE` is skipped.

Why the deploy does this: Bedrock enables a serverless third-party model the first
time it is invoked, but only when the caller holds `aws-marketplace:Subscribe` /
`ViewSubscriptions`, and this platform's runtime Lambda roles do not hold them for
the Claude listings (the only API-stack Marketplace grant is scoped to the image
model, `lib/stacks/api-marketplace.ts`). Without the agreements, a new account's
first enrichment call would fail.

**Best effort.** Any failure (a Private Marketplace refusal, a model not offered in
the region, a missing use-case form, throttling, a dropped connection, even an
AccessDenied on the agreement role) is logged as a warning in the
`ModelAgreementLambda` log group and reported as `UNAVAILABLE`. It never fails or
rolls back the deploy. Each resource runs when it is created, and a later deploy
does not repeat it on its own. Administration → AI models shows which models answer
(each row's **Test** button, below).

**See a missing agreement.** Administration → AI models lists every Claude model the account
cannot call yet under **Model agreements**, with what is missing (no agreement, no access, not
offered in the region), what to do, and a **Test** button. `GET /settings/model/capacity` reads
each model's live state with `GetFoundationModelAvailability` in the app region
(`lambda/shared/model_agreements.py`, cached 5 minutes, the same read as the image model's row),
so an agreement accepted later in the Bedrock console clears the notice without a redeploy.

**Retry a refused agreement.** After filing the use-case form in the console, or fixing
what refused it (a Private Marketplace rule, a missing permission), deploy once with a
new value of `-c modelAgreementRetry` (for example the date:
`npm run deploy:infra -- -c modelAgreementRetry=2026-11-01`). Every agreement then runs
again, best effort as before; the value only needs to differ from the last one used.
You can also accept a missing agreement in the Bedrock console, or invoke the model once
from the console playground.

### Submit the form from CDK instead (opt-in)

You can have the deploy file the form by passing your own `anthropicUseCase` block.
The committed `cdk.context.json` carries none. The block must be a
JSON object, so put it in a context file that you do not commit, or in the deploy
job of your pipeline; a plain `-c anthropicUseCase=…` arrives as a string and is
skipped with a warning.

```json
{
  "anthropicUseCase": {
    "companyName": "Example Air",
    "companyWebsite": "https://example.com",
    "intendedUsers": "0",
    "industryOption": "Technology",
    "useCases": "Analyzing customer feedback to identify product improvement opportunities, sentiment analysis, and generating insights from voice of customer data."
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `companyName` | Yes | Your company or organization name |
| `companyWebsite` | Yes | Your company website URL |
| `intendedUsers` | No (default `"0"`) | An index: `"0"` internal users, `"1"` external customers, `"2"` both |
| `industryOption` | No (default `Technology`) | One of `Technology`, `Healthcare`, `Financial Services`, `Retail`, `Manufacturing`, `Media & Entertainment`, `Education`, `Government`, `Other` |
| `useCases` | Yes | How you will use the models (at least 10 characters) |
| `otherIndustryOption` | No | Your industry when `industryOption` is `Other` |

The submission is made in us-east-1 by `VocWebSearchStack`, so a deployment with a
block always has that stack, even with `-c enableWebSearch=false`, and
`VocCoreStack` waits for it (the form goes in before the agreements are attempted).
An account that already has access rejects the call; that is treated as a
no-op. Permission and throttling errors on the submission still fail the deploy.

`skipUseCaseSubmission: true` (or `--context skipUseCaseSubmission=true`) keeps a
block from being submitted. With it, the block is still validated but nothing is
submitted and the block alone no longer creates `VocWebSearchStack`.

**The form values end up in the template.** The stack passes them to the
`PutUseCaseForModelAccess` custom resource as properties, so every field is a
literal in the synthesized `VocWebSearchStack` template (`cdk.out/`, and the
template CloudFormation stores), and `companyName` is also a stack output
(`CompanyName`). Treat them as public: don't commit them, or a `cdk.out/` built
with them, to a public repository, and drop the block once the submission has been
accepted.

How the switches combine:

| Context | Use-case submission | Model agreements | Stack in us-east-1 | Form values in a template |
|---|---|---|---|---|
| no `anthropicUseCase` (the committed default) | no: file it in the console | yes, in `VocCoreStack`, app region | only with web search on | none |
| no `anthropicUseCase`, `-c enableWebSearch=false` | no: file it in the console | yes, in `VocCoreStack`, app region | **none**: nothing is deployed to, or names, us-east-1 | none |
| `anthropicUseCase` + `skipUseCaseSubmission` | no | yes, in `VocCoreStack`, app region | only with web search on | none |
| `anthropicUseCase` | yes, in us-east-1 | yes, in `VocCoreStack`, app region (after the submission) | yes | every field |

## CDK Stacks

The platform consists of 4 core stacks plus 1 AI-enablement stack.

> **Keep to five stacks.** Some packaging targets for this sample, such as AWS Workshop Studio, accept at most
> five CloudFormation templates, and the app has exactly five. A sixth stack breaks that packaging, and the
> failure does not show at `cdk synth`. Fold new infrastructure into an existing stack. Nested stacks do not
> help here: they inherit the parent's region, and `VocWebSearchStack` must stay in us-east-1.
>
> **Upgrading from a release that had a separate `BedrockAccessStack`:** run `cdk deploy --all`, then delete
> the old stack with `cdk destroy BedrockAccessStack`. CDK does not remove a stack that was dropped from the
> app. Bedrock agreements persist per account, so nothing is lost.

| Stack | Description | Dependencies |
|-------|-------------|--------------|
| `VocCoreStack` | DynamoDB tables (incl. `voc-memory`, `voc-agents`), KMS, S3 buckets, Cognito, CloudFront, the `voc/design-integrations` secret, the Bedrock model agreements (every deploy, best effort) | `VocWebSearchStack` only when an `anthropicUseCase` form is submitted |
| `VocIngestionStack` | Plugin Lambdas, EventBridge schedules, SQS, Secrets | Core |
| `VocProcessingStack` | Processor, Aggregator, Step Functions (research, `voc-agent-run`), category reprocess worker, memory workers (scanner, `voc-memory-extract` queue + extractor, retention), agent heartbeat / conductor / persona panel, Bedrock | Core, Ingestion |
| `VocApiStack` | API Gateway, domain-specific API Lambdas (incl. `voc-memory-api`, `voc-agents-api`), Webhooks | Core, Ingestion, Processing |
| `VocWebSearchStack` (AI enablement) | **Two independently switchable halves in one us-east-1 stack:** (a) the AgentCore Gateway for public web search, on by default, opt out with `enableWebSearch: false`; (b) the Anthropic use-case form submission, only when you pass your own `anthropicUseCase` block and `skipUseCaseSubmission` is not set. The model agreements are in `VocCoreStack`, not here. The stack is not created when both halves are off, and then nothing deploys to us-east-1. It always deploys to us-east-1 because the web-search connector exists only there. A deployment in another region must bootstrap us-east-1 once (`cdk bootstrap aws://ACCOUNT_ID/us-east-1`) or set the opt-out flag | None |

### Deploy All Stacks

```bash
npm run deploy:infra    # Deploy all CDK stacks, then refresh the API stage
```

### Faster deploys: skip what did not change

Two ways a deploy avoids redoing work:

- **Layer builds skip unchanged layers.** `npm run build:layers` writes a stamp
  (`lambda/layers/<layer>/.build-stamp`, gitignored) holding a SHA-256 of the
  layer's `requirements*.txt`, the install recipe, the build image and the
  platform. When the hash matches and the layer's `python/` dir exists, the layer
  is skipped with one log line. A missing or unreadable stamp rebuilds it, and so
  does a stamp older than 7 days (`LAYER_STAMP_MAX_AGE_DAYS=<days>` changes the
  limit): a requirement without an exact pin (`>=`) is re-resolved at least once a
  week instead of keeping the version of the first build.
  `FORCE_LAYER_BUILD=1 npm run build:layers` (or `build-layers.sh --force`)
  rebuilds every layer; do that after pulling a new build image, because the
  `:latest` tag can move without the hash changing.
- **Deploy only the stacks that changed (opt-in).**
  `CDK_DEPLOY_CHANGED=1 npm run deploy:infra -- -c protectData=true`
  runs `cdk diff --all` once (with the `-c`/`--context` and `--profile`
  arguments), then `cdk deploy --exclusively <changed stacks>`; CDK orders them
  by dependency. The stage refresh (next section) then ALWAYS runs, also when
  VocApiStack had no differences or no stack differs (nothing is deployed then):
  an earlier deploy whose refresh never ran would otherwise keep removed routes
  live until VocApiStack next changes. When `cdk diff` fails
  or its output cannot be read with certainty (`scripts/cdk-changed-stacks.mjs`
  cross-checks the per-stack results against the diff's own "Number of stacks
  with differences"), the script falls back to the full deploy and the refresh.
  Use it for whole-app deploys only: `--all` is replaced by the changed list, so
  do not name stacks in the arguments. `cdk diff` reads the deployed templates,
  so it needs the same read access as `cdk deploy`. The default (no variable)
  is the full deploy.

### Refresh the API stage after every deploy (removed routes)

Every deploy command (`npm run deploy:infra` at the root, `npm run deploy` and
`npm run deploy:api` in `voc-datalake/`) runs `voc-datalake/scripts/cdk-deploy.sh`:
`cdk deploy <args>` and then `scripts/refresh-api-stage.sh`, which creates a fresh
deployment of the `v1` stage. Arguments pass through
(`npm run deploy:infra -- -c protectData=true`).

Why: when a route is removed from `lib/stacks/api-routes.ts`, CloudFormation
creates the new `AWS::ApiGateway::Deployment` (a snapshot of the API) during the
update phase but deletes the removed methods only in the **cleanup** phase,
afterwards. The snapshot still holds them, so without the refresh the stage keeps
serving the removed routes, typically answering 500.
Nothing inside the stack can run after its own cleanup phase, so the refresh is a
deploy step. It is idempotent, keeps the stage's settings, and makes one write
(`apigateway create-deployment`).

**If you run `cdk deploy` directly**, or deploy the synthesized templates with
CloudFormation, run the refresh yourself once the stack update is complete:

```bash
bash voc-datalake/scripts/refresh-api-stage.sh                           # default deployment
API_STACK=b-VocApiStack bash voc-datalake/scripts/refresh-api-stage.sh   # -c deploymentPrefix=b
```

The post-deploy ops check in the end-to-end suite (`voc-datalake/frontend/e2e/tests/ops-postdeploy.spec.ts`, run
with `E2E_OPS=1` and `E2E_API=<api url>`) fails when the stage serves a method the API definition no longer has.

### Deploy Individual Stacks

```bash
cd voc-datalake

# Deploy specific stack (npx uses the CDK CLI pinned in voc-datalake/package.json)
npx cdk deploy VocCoreStack
npx cdk deploy VocIngestionStack
npx cdk deploy VocProcessingStack
npm run deploy:api            # VocApiStack + the stage refresh (or: npx cdk deploy VocApiStack && bash scripts/refresh-api-stage.sh)

# Deploy multiple stacks
npx cdk deploy VocCoreStack VocIngestionStack

# Deploy with auto-approve (no confirmation prompts), then refresh the stage
npx cdk deploy --all --require-approval never && bash scripts/refresh-api-stage.sh
```

A clean `cdk synth`/`cdk deploy` prints **zero warnings**. Treat a new warning as something to investigate.

### Two Deployments in One Account and Region

Every physical name is `{base}-{account}-{region}`, which keeps two AWS accounts
apart but **not** two deployments inside one account and region: those resolve
to identical names, so a second deploy would update the first deployment's
stacks. `-c deploymentPrefix=<prefix>` supplies the missing dimension, so a
staging copy can sit beside a demo copy in one account:

```bash
# the original deployment: unchanged, no flag, nothing to migrate
npm run deploy:infra

# a second, fully independent copy (API_STACK points the stage refresh at its API)
API_STACK=b-VocApiStack npm run deploy:infra -- -c deploymentPrefix=b
```

The prefix reaches stack names (`b-VocCoreStack`), every physical resource name
(`b-voc-feedback-<account>-<region>`), all CloudFormation exports, and the IAM
wildcards that would otherwise let one copy invoke the other's ingestors. Pass
the same flag on **every** command for that deployment: `cdk deploy`,
`cdk diff`, `cdk destroy`.

The two frontend shell scripts cannot see CDK context, so they take the stack
names as environment variables instead. **Both** need them. Forgetting them
on `deploy:frontend` is the costly mistake: the script then resolves the *unprefixed*
deployment's bucket and CloudFront distribution and syncs this build over that
site without any error.

```bash
# frontend of the prefixed deployment (build + S3 sync + invalidation),
# from the repository root
CORE_STACK=b-VocCoreStack API_STACK=b-VocApiStack npm run deploy:frontend

# local .env pointed at the prefixed deployment, from voc-datalake/frontend/
cd voc-datalake/frontend
CORE_STACK=b-VocCoreStack API_STACK=b-VocApiStack bash scripts/update-env.sh
```

There is no limit of two: the prefix is a namespace, so any number of copies can
coexist. Copies with different prefixes share no stack name, physical resource name,
export name or IAM policy ARN. What they do share is listed under
"Known limitations" below.

Three things to know before using it:

- **The prefix must start with a lowercase letter.** It reaches CloudFormation
  *stack* names, which must match `/^[A-Za-z][A-Za-z0-9-]*$/`, so a leading digit
  is rejected at synth. Combined with the one-character budget below, that makes 26
  usable prefixes on the committed defaults, plus the unprefixed deployment.
- **It is opt-in, and it must stay that way for an existing deployment.**
  Renaming a DynamoDB table, S3 bucket or Cognito user pool is a
  CloudFormation *replacement*, not a rename: adding the flag to a deployment
  that was created without it would leave the old data behind in orphaned
  resources. For that reason `cdk.context.json` has no `deploymentPrefix`;
  it is a per-deployment CLI flag. With no flag the synthesized templates are
  the same as without the feature (`lib/app-baseline.test.ts` checks this).
- **On the committed defaults the prefix has to be ONE character.** That is why
  the example above is `b` and not `stg`. Lambda function, IAM role and
  EventBridge rule names cap at 64 characters, and with the `pluginStatus` in
  `cdk.context.json` the longest name the app generates
  (`voc-ingest-app_reviews_android-schedule` plus `-<account>-<region>`) already
  uses 62 of them in `us-east-1`. So `-c deploymentPrefix=stg` does not
  synthesize until you widen the budget by disabling a plugin with a long id.
  A longer region name costs more still. Synth fails immediately, naming the
  offending resource and the remaining budget:

  ```
  [staging-VocIngestionStack] deploymentPrefix "staging" makes
  "staging-voc-ingest-app_reviews_android-schedule-<account>-<region>" 70
  characters, over the 64-character limit for Lambda function, IAM role and
  EventBridge rule names. Use a prefix of at most 1 character, or shorten the
  resource name (e.g. disable the plugin that owns it).
  ```

  Disabling unused plugins in `pluginStatus` widens the budget: each character
  removed from the longest plugin id buys one for the prefix. S3 bucket names
  and the Cognito hosted-UI domain prefix are checked against **63** characters
  rather than 64, since both must be a single DNS label.

#### Known limitations of a prefixed deployment

Neither is a resource collision, and nothing shared can cause data loss,
but both are worth knowing before running several copies:

- **CloudWatch metrics co-mingle.** The Lambdas publish EMF metrics to a
  fixed namespace (`Metrics(namespace="VoC")` in `lambda/shared/logging.py`)
  with a `service` dimension from `POWERTOOLS_SERVICE_NAME`, and that value is
  the same literal in every deployment (`voc-metrics-api`, `voc-processor`, …).
  So two copies' metrics land on the same namespace and dimension, and a
  dashboard or alarm cannot tell them apart. **Logs are not affected**: log
  group names carry the prefix, so each deployment's logs stay separate.
- **API Gateway authorizer names are shared** (`voc-cognito-authorizer`,
  `voc-mcp-token-authorizer`). Those names only have to be unique
  inside their own RestApi, and each deployment has its own, so prefixing them
  would add churn without preventing a collision.

### Verification fixture provider (opt-in, never on production)

`.abca/fixture-manifest.json` at the repository root is this repo's contract with
[ABCA](https://github.com/aws-samples/sample-autonomous-cloud-coding-agents), an
autonomous coding-agent harness that deploys a pull request to a throwaway slot
and verifies it. The manifest is **declaration only**: it states which fixture
capability the repo offers, the shape of the records, and a protocol version. It
carries no ARN, IAM, secret, table name or write recipe, so a commit cannot grant
itself privileged access by editing it.

The half that *has* authority is a private Lambda, `voc-fixture-provider`
(`lambda/api/verification_fixture_provider.py`), which seeds and removes a
deterministic prioritization baseline. It can **write and delete rows in the live
Projects and Aggregates tables**, so it is created only when *both* of these hold:

```bash
API_STACK=b-VocApiStack npm run deploy:infra -- -c deploymentPrefix=b -c enableVerificationFixtureProvider=true
```

- `deploymentPrefix`: a throwaway side-by-side copy, never the primary deployment.
- `enableVerificationFixtureProvider`: explicit intent. Accepts only `true` or
  `"true"`; `TRUE`, `1`, `yes` and anything else mean off.

**Never set `enableVerificationFixtureProvider` on a production deployment.** The
prefix alone is not a safeguard: a production copy can also be prefixed, which is
why the flag exists as a second, independent condition. Omit it and the function,
its role, its table and KMS grants, its log group and its ARN output do not exist
at all (`lib/app-baseline.test.ts` checks that a default synth is unchanged).

The provider has no API Gateway route, Function URL, Cognito authorizer, frontend
configuration or model access; it is reachable only by direct
`lambda:InvokeFunction`. By default that is governed by identity policies alone,
which for a same-account caller means any principal holding that permission on the
ARN. To pin it to exactly one caller, pass its role ARN and a resource-based
policy is attached:

```bash
API_STACK=b-VocApiStack npm run deploy:infra -- -c deploymentPrefix=b -c enableVerificationFixtureProvider=true \
  -c verificationFixtureInvokerArn=arn:aws:iam::111122223333:role/my-verification-role
```

The value must be an IAM role or user ARN; anything else fails at synth rather
than deploying a policy that grants nobody. Fixture rows are indexed like ordinary projects
on purpose, so the fixture exercises the real read paths, and they are excluded
from the project list *and* from the one read that enumerates the prioritization
partition, by the `verification_fixture_id` marker (`is_verification_fixture` in
`lambda/shared/project_writes.py`). Every other access to that partition is by
exact key (voting sessions and ballot writes name a single row), so those are
unaffected.

Cleanup is an explicit teardown call, and the TTL backstop is **partial**: the
provider stamps a `ttl` attribute on every record, but only the Aggregates table
has TTL enabled, so the prioritization row expires on its own while the fixture's
project and document rows do not. An abandoned fixture therefore needs its
teardown; `lib/stacks/core-stack.test.ts` pins both halves of that asymmetry.

### Stack Deployment Order

Due to dependencies, stacks should be deployed in this order:

1. `VocWebSearchStack` (no dependencies, but it must come **before** Processing
   and Api, which import its gateway exports when web search is enabled)
2. `VocCoreStack` (no dependencies)
3. `VocIngestionStack`
4. `VocProcessingStack`
5. `VocApiStack`

The `cdk deploy --all` command handles this automatically.

### EU deployment (`-c inferenceScope=eu`)

`-c inferenceScope=eu` keeps Bedrock inference in the EU. Bedrock calls use `eu.` inference
profiles, and IAM grants only those profiles. Web search is never deployed; an explicit
`enableWebSearch=true` fails the synth. Persona avatars are disabled. The default is
`global`. Model availability, region choice and the PII language limits are covered in
[eu-deployment.md](eu-deployment.md).

### Source policies and the retention worker

`voc-retention` (VocProcessingStack) runs daily at 04:15 UTC. It deletes data only for
sources whose profile sets `retention_days`, and for erasure requests an admin starts. It
is the only role with a delete permission on customer data. Sources without a profile are
kept forever, so a deploy changes nothing until an admin configures one. See
[source-policies.md](source-policies.md) and [dimensions.md](dimensions.md).

<a id="participant-email-and-the-feature-request-board--c-emailfrom"></a>

### Participant email and feedback boards (`-c emailFrom`)

Participants (people, lists, project links) and feedback boards always
deploy: two tables in VocCoreStack (`voc-participants`, `voc-feature-requests`; KMS, PITR,
`-c protectData` like every data table) and one API Lambda, `voc-engagement-api`
(`/participants/*`, `/feature-requests/*`, the public `POST /unsubscribe`, with its own stage throttle in
`voc-datalake/lib/stacks/api-gateway.ts`).
Without the flag below nobody can be emailed (`POST /participants/asks` answers 409
`email_not_configured`, `config.json` ships `features.email: false`).

**The board pool exists on every deployment (since 5.45.00).** `voc-board-user-pool` (VocCoreStack) and
its authorizer (VocApiStack, on `/feature-requests/*` and the document review links' `/review/*`)
are created with or without the flag; `config.json` always carries
`board: {userPoolId, clientId, signIn}` and the stack outputs `BoardUserPoolId`,
`BoardUserPoolClientId` and `BoardSignInMode`. Without `-c emailFrom` the pool sends its codes with
Cognito's own sender (`no-reply@verificationemail.com`, **50 emails a day per AWS account**, may
land in spam): a new person confirms the sign-up with the emailed code, a returning one gets a
password-reset code and the SPA sets a random password it never keeps (`signIn: code`, account
recovery by email). With the flag it sends through SES with Email OTP (`signIn: email_otp`); an
existing `-c emailFrom` pool is updated in place, never replaced. Sign-ups are never auto-confirmed:
the emailed code proves the person owns the inbox. See [document-review.md](document-review.md).
With the flag, `config.json` carries `features.email: true`, written by the CDK deploy and, from the
`EmailAvailable` (VocApiStack) output, by `npm run deploy:frontend` too.

`-c emailFrom=noreply@voc.example.com` (or `"emailFrom"` in `cdk.context.json`) turns on both
email features:

- **Asks:** `voc-engagement-api` may `ses:SendEmail` only with that From address
  (`ses:FromAddress` condition) on the SES identity of its domain (or of the address itself).
  Each ask carries `List-Unsubscribe` / one-click headers.
- **The board's own sign-in** (`/board`, for people without an app account): the board pool sends
  its codes through SES and signs returning people in with an emailed one-time code and a link
  (`EMAIL_OTP`, no password to remember, no account recovery). The pool and its authorizer exist
  without the flag too (above); the authorizer accepts the app pool AND the board pool on
  `/feature-requests/*` and `/review/*` only; a board token reaches no other route. The pool
  allows self sign-up, but its PreSignUp trigger refuses any email that no board audience (see
  **Participants → Settings → company domains**) and no active review link admits. The pool runs on
  the Cognito **Essentials** feature plan, billed per monthly active user; the app's own pool is
  unchanged.

The address is validated at synth (a plain `local@domain`, no display name). Before deploying:

1. **Verify the SES domain identity** of the address (`voc.example.com` above) in the
   deployment's region, with its DKIM records published. CDK neither creates nor verifies it.
2. **Leave the SES sandbox** (request production access). In the sandbox SES delivers only to
   verified recipients, so neither participants nor board users would get mail.
3. Check the account's SES sending quota against your **daily send cap** (Participants →
   Settings, default 500 per day).

Bounces and complaints are handled by the SES **account-level suppression list**: turn it on
for both reasons (SES console → Configuration → Suppression list). An address on it is not
mailed again. A recipient's unsubscribe link marks the person `unsubscribed`, and every later
ask skips them.

Turning the flag off later removes the board pool and its users (with `-c protectData=true`
the pool is retained, detached from the stack).

### System errors (Administration → System → Logs → System errors)

The default tab of the Logs page is built so that someone **without access to the AWS
account** (a developer reading the page, or its JSON download) can tell what failed and
why. Nothing needs a deploy flag or a debug mode: every source below is on by default.

It lists every ERROR / CRITICAL line (with "Errors and warnings", also WARNING) that this
deployment wrote in the last 1, 7 or 30 days, grouped, newest first. An API Lambda logs a
4xx it answers on purpose at INFO, not WARNING: a refused authorization ("Admin access
required", "You do not have permission to …"), a 400 validation error, a 404, a 409 conflict,
a 413 and a 429 quota (`_EXCEPTION_ANSWERS` in `lambda/shared/api.py`), so warnings mode shows
faults and degraded paths only; a 5xx is ERROR. Each group carries `source`:

| `source` | Log groups read | What becomes a group |
|----------|-----------------|----------------------|
| `lambda` | `/aws/lambda/[<prefix>-]voc-*-<account>-<region>` (env `SYSTEM_LOG_GROUP_PATTERN`), plus VocCoreStack's own Lambdas whose log group CloudFormation named (product-doc extractor, Cognito custom message, admin bootstrap, CDN signing keys, the two board-pool triggers; env `SYSTEM_EXTRA_LOG_GROUPS`, `<function>=<stack>-<construct id>` name prefixes) | Powertools / Node ERROR, CRITICAL, FATAL (+ WARNING / WARN); Lambda's own lines (`Task timed out`, `Runtime.*Error`, a `REPORT` with `Status: timeout` or `error`) as `PLATFORM` |
| `workflow` | `/aws/stepfunctions/[<prefix>-]voc-*-<account>-<region>` (env `SYSTEM_WORKFLOW_LOG_GROUP_PATTERN`): agent runs, research, documents | `ExecutionFailed`, `ExecutionTimedOut`, `ExecutionAborted`, `TaskFailed`, `TaskTimedOut`, `LambdaFunctionFailed`, `LambdaFunctionTimedOut` as `ERROR`; function = the state machine (`agent-run`); message = type, error and cause (≤ 2,000); `request_id` = the execution name |
| `api` | the stage access log `/aws/apigateway/[<prefix>-]voc-analytics-api-<account>-<region>` (env `SYSTEM_API_ACCESS_LOG_GROUP`) | every 5xx as `HTTP`; with warnings also every 4xx except 401 / 403 / 404 / 409 / 410 (a signed-out caller, a refusal, a missing record, a conflict, an expired or closed link; 400 and 429 stay) as `WARNING`; message `<METHOD> <path, ids as {id}> → <status> <gateway error or integration status>`; requests with a `voc-e2e/` User-Agent (the e2e suite) are left out; the caller IP is never read |

**Not covered:** the CDK provider and custom-resource handlers (`*Provider*`, bucket
notifications, auto-delete, BucketDeployment), which are framework code, not the app. The
Bedrock model-agreement Lambda is in `VocCoreStack` and is covered, under the function
name `image-model-access` (its construct id; it also handles the Claude agreements): a refused
or failed agreement shows there as a warning.

- **Routes** (all admin-only, 403 otherwise, `Cache-Control: no-store`, every returned
  text through the regex PII redaction, results never logged):
  - `GET /logs/system?days=1|7|30&level=error|warning[&query_id=…]` — the groups
    (`lambda/shared/system_logs.py`; sources `system_log_sources.py`, rows
    `system_log_rows.py`, grouping `system_log_groups.py`). One Logs Insights query per
    ≤ 50 Lambda groups (at most 4), one for the state machines, one for the access log,
    started and read concurrently and polled for up to 18 s (the first two reads 0.5 s apart, then 1 s; a
    finished query is not read again); a slower search answers `running` with up to 6 comma-separated
    `query_id`s and the page polls again. The log groups are listed once per 5 minutes per warm
    Lambda (`DISCOVERY_TTL_SECONDS`), so a poll does not list them again. Each group: `source`, `function`, `level`,
    `message` (≤ 300, ids / times / numbers / quoted values replaced), `sample` (the newest
    full line with its stack trace, ≤ 6,000), `count`, `first_seen`, `last_seen`,
    `request_id`. At most 200 groups; `truncated` = a query hit Insights' 10,000-row cap;
    `log_groups_by_source` counts what was searched.
  - `GET /logs/system/request?function=<short>&request_id=<id>&at=<iso>[&query_id=…]` —
    every line of that one invocation, any level (INFO included), oldest first, ≤ 500
    (`truncated` beyond), each `{timestamp, level, message ≤ 4,000}`
    (`system_request_log.py`). The function's ONE log group, `at` ± 20 minutes, matched on
    `@requestId`, Powertools `function_request_id` or the id in a Node line; a state
    machine on its execution name. 404 for an unknown function and for `api` (an access
    log line has no invocation lines). Same `running` / `query_id` contract.
  - `GET /logs/system/queues` — every dead-letter / failure queue alerting watches
    (`OPS_ALERTS_QUEUES`, the table below): `{name, messages, oldest_age_seconds?,
    sample: [≤ 3 bodies, ≤ 2,000 each], sample_sent_at}` (`system_queues.py`). A queue
    that cannot be read answers `messages: null` with `error`. The peek is
    `ReceiveMessage` with `VisibilityTimeout=0`: nothing is deleted and the messages stay
    visible, but each look raises their receive count by one (these queues have no
    further redrive, so that moves nothing). The age is the larger of CloudWatch's
    `ApproximateAgeOfOldestMessage` and the oldest sampled message's send time: once a
    message has been received three times, CloudWatch's age points at the second-oldest
    message, so on a peeked dead-letter queue it alone can read hours for a message days
    old. Omitted when neither is known. The peek waits up to 1 s (a short poll often
    answers nothing for a queue holding one message).
  - `GET /logs/system/environment` — region, the account's last four digits, the
    deployment prefix, enabled sources, web search on/off, inference scope, the avatar
    image model `{id, region, avatars_enabled}`, the model in force per AI surface and the
    admin overrides, alerting `{configured, enabled, alarms: [{name, state}], in_alarm}`,
    the sources whose circuit breaker is open (`last_error` redacted) and `log_coverage`
    (what the search can read) (`system_environment.py`). A section that cannot be read
    answers `{"unavailable": true}`. The platform version is the SPA's build constant
    (System → Version), not a Lambda variable (it would change every template each release).
- **IAM** (`lib/stacks/api-logs-diagnostics.ts`): `logs:DescribeLogGroups` on
  `log-group:*`; `logs:StartQuery` on the three name patterns above (+ `:*`) and the
  VocCoreStack name prefixes only; `logs:GetQueryResults` / `logs:StopQuery` and
  `cloudwatch:GetMetricData` on `*` (no resource type); `sqs:GetQueueUrl`,
  `sqs:GetQueueAttributes`, `sqs:ReceiveMessage` on exactly the failure queues (no delete);
  `kms:Decrypt` conditioned on `kms:ViaService` = SQS and the SQS encryption context of
  exactly those queues (the schedule DLQ has its own key in VocIngestionStack; no key ARN
  crosses a stack). No new resource and no cross-stack export.
- **Cost:** Logs Insights bills per GB scanned (check CloudWatch pricing); each page load
  or refresh runs one search over the chosen window (30 days on a busy deployment scans
  the most), and each "Show the whole request" a 40-minute search of one group. Lines
  older than a log group's retention (two weeks for most) are gone.

### Operational alerts (Administration → System → Logs → Alerts)

No CloudWatch alarm is deployed by CDK: an alarm is billed every hour it exists,
and one nobody is subscribed to notifies nobody. An admin turns alerting on in
**Administration → System → Logs → Alerts**; the logs API (`voc-logs-api`,
`lambda/shared/ops_alerts.py`) then creates the alarms with `PutMetricAlarm`, and
turning it off deletes them. Turning it on twice is harmless (an alarm is
overwritten), and turning it off deletes exactly the alarms under this
deployment's reserved prefix, `voc-alerts-<account>-<region>-` (with a
`deploymentPrefix`, `<prefix>-voc-alerts-…`). The on/off state, who changed it
and when are kept in the aggregates table (`SETTINGS#alerts`); when that row is
missing, the alarms themselves say whether alerting is on.

| Alarm (`voc-alerts-<account>-<region>-…`) | Watches | Fires when |
|-------|---------|------------|
| `processing-dlq` | `voc-processing-dlq` (Ingestion): feedback the processor failed 3 times | Max of `ApproximateNumberOfMessagesVisible` > 0 over one 5-minute period |
| `ingest-schedule-dlq` (only when an enabled plugin is scheduled) | `voc-ingest-schedule-dlq`: schedule ticks EventBridge could not deliver | same |
| `aggregator-stream-failures` | `voc-aggregator-stream-failures` (Processing): stream ranges the aggregator gave up on | same |
| `memory-extract-dlq` | `voc-memory-extract-dlq` (Processing): memory-extraction messages that failed 3 times | same |
| `api-async-failures` | `voc-api-async-failures` (Core): failed/expired async invocations of API-stack Lambdas | same |
| `briefing-dlq` | `voc-briefing-dlq` (Processing): morning-brief builds that failed 3 times ([docs/briefing.md](briefing.md)) | same |
| `email-intake-dlq` | `voc-email-intake-dlq` (Ingestion, only with `-c inboundEmailDomain`): received emails that failed 8 times ([docs/email-intake.md](email-intake.md)) | same |
| `processor-errors` | `voc-feedback-processor` Lambda `Errors` | Sum > 0 over 5 minutes |
| `aggregator-errors` | `voc-aggregation-processor` Lambda `Errors` | Sum > 0 over 5 minutes |
| `aggregator-iterator-age` | `voc-aggregation-processor` `IteratorAge` | Max > 15 minutes for 3 consecutive 5-minute periods (dashboard metrics going stale) |
| `ingestor-errors` | every enabled plugin ingestor's `Errors`, one metric-math `SUM` | Sum > 0 over 5 minutes (more than 10 ingestors split into `ingestor-errors-2`, …) |
| `mcp-auth-denied`, `mcp-tool-denied`, `mcp-tool-failed`, `mcp-rate-limited` | `VoC-MCP-Global` metrics of `/mcp/global` | Sum over 5 minutes > 50 / 20 / 5 / 30 ([docs/mcp.md](mcp.md#alarms-and-concurrency)) |

Missing data is never breaching, so an idle queue or function stays OK.

**Recipients.** All alarms notify ONE SNS topic, `voc-ops-alarms-<account>-<region>`,
created in VocCoreStack (its own rotating KMS key that CloudWatch may use, TLS-only
publishes). Add or remove email addresses on the same card (at most 10). AWS mails
each address a confirmation link; the card shows **Pending confirmation** until it
is clicked, and nothing is delivered before then. A pending address added on the
card can be removed again; one added elsewhere (console, CLI) cannot be cancelled
until it is confirmed, and SNS deletes an unconfirmed subscription on its own. For
other channels (Slack via AWS Chatbot, PagerDuty, …) subscribe them to the topic
yourself; the card lists email recipients only.

**Permissions.** The logs API role may `PutMetricAlarm` / `DeleteAlarms` /
`DescribeAlarms` only on `arn:aws:cloudwatch:<region>:<account>:alarm:voc-alerts-<account>-<region>-*`,
and `Subscribe` / `Unsubscribe` / `ListSubscriptionsByTopic` only on the topic ARN.
Every route is admin-only. Addresses are never logged.

**Cost.** CloudWatch bills $0.10 per standard alarm metric per month (us-east-1, at
the time of writing), and the first 10 alarm metrics in an account each month are
free. A metric-math alarm is billed per metric it reads, so the one ingestor `SUM`
costs the same as one alarm per ingestor, but notifies once. With every alarm above
and N enabled ingestors that is 12 + N alarm metrics (8 + N, plus the 4 MCP alarms): about
$1.80 a month with 6 ingestors, before the free tier. The topic's KMS key is about $1 per month whether
or not alerting is on; SNS email delivery is free at alarm volumes. Check current
CloudWatch and KMS pricing for your region.

**Upgrading from a release that deployed the alarms with CDK (before 5.00.00).** The next deploy deletes the
five `…-messages-visible` alarms and any `-c alarmEmail` subscription; the
`alarmEmail` context key is no longer read (remove it from `cdk.context.json`). Turn
alerting on in Administration → System → Logs → Alerts and add the addresses there.
<a id="failure-queue-alarms-alarmemail"></a>

**VocApiStack resource budget (for contributors).** A CloudFormation template holds at most 500 resources, and
VocApiStack is the largest. Each Lambda behind API Gateway therefore gets ONE invoke permission scoped to this
RestApi rather than CDK's default of two per method (`frugalIntegration` in `lib/stacks/api-routes.ts`), CORS
preflights exist only on resources that serve a browser method, and several route families sit behind a
`{proxy+}`. Never put a `{proxy+}` beside an existing `{param}` (or the reverse): API Gateway allows one variable
path part per level, and CloudFormation creates before it deletes, so the update fails.
`lib/stacks/api-stack-cors-preflight.test.ts`, `api-stack-snapstart.test.ts` (at least 75 resources of headroom,
measured in the largest shape: every plugin on and `-c snapStart=true`, which adds a version and an alias for each of
four functions) and `api-stack-invoke-permissions.test.ts` check these rules.

**No fixed cost by default (for contributors).** `lib/fixed-cost-guard.test.ts` synthesizes every stack, in the default
and the all-features shape, and fails on any resource or setting that bills whether or not the platform is used: WAF,
SnapStart, provisioned concurrency, NAT gateways, EC2 instances, ECS services, RDS, ElastiCache, OpenSearch,
PROVISIONED DynamoDB or Kinesis capacity, an API Gateway cache cluster, a CloudFront dedicated IP, or a hosted zone
the app creates ([TENETS.md](../TENETS.md), tenet 7). Such a feature goes behind an opt-in context flag, listed in the
test's `OPT_IN_FIXED_COSTS` with exactly what it adds (today: `snapStart`, and `performanceTier`, which turns it on).
A new performance feature reads `performanceTierEnabled` (`lib/utils/performance-tier.ts`) as well as its own flag. Lambda reserved concurrency costs nothing
and is allowed.

### Lambda sizing and post-deploy capacity check

Every function's MemorySize follows the sizing policy in [lambda-sizing.md](lambda-sizing.md): peak memory
≤ 70 % (≤ 60 % for variable-payload functions) and CPU ≤ 70 % of the function's share. After a deploy that
had traffic, run the read-only check (`voc-datalake/scripts/capacity/capacity-query.sh --hours 24`, or the
`E2E_OPS=1` ops specs in `frontend/e2e`). For a function the check flags, AWS Lambda Power Tuning is the next
step; the runbook is in [lambda-sizing.md](lambda-sizing.md).

### Reserved concurrency of the MCP endpoint (`-c mcpReservedConcurrency`)

`voc-mcp-global-api` reserves 20 concurrent executions by default, taken from the account's unreserved
Lambda pool, which must stay at 100 or more: an account whose concurrency quota is under 120 fails the
VocApiStack deploy. Either raise the quota first, or deploy with `-c mcpReservedConcurrency=<n>` (a whole
number; the quota must then be at least `n` + 100) or `-c mcpReservedConcurrency=0` (no reservation: the
endpoint shares the unreserved pool). Anything else fails the synth. See
[mcp.md → Alarms and concurrency](mcp.md#alarms-and-concurrency).

### What a Python Lambda bundle contains

Every Python function's code asset is built by one helper, `pythonLambdaAsset` in
`voc-datalake/lib/utils/python-lambda-asset.ts`. Docker bundling mounts the source tree unfiltered as
`/asset-input`, so the staging `exclude` lists (`lambda-asset-excludes.ts`) decide only the asset hash; what
ships is what the bundling command copies, and every command ends by deleting `test/`, `tests/`,
`__pycache__/`, `.pytest_cache/`, `test_*.py`, `*_test.py`, `conftest.py`, `*.pyc` and `.env*` from the
output. A local `cdk synth` with Docker writes the bundles to `voc-datalake/cdk.out/asset.*` if you want to
inspect one. `lib/utils/python-lambda-asset.test.ts` checks every bundling command, and (when Docker and the
`public.ecr.aws/sam/build-python3.14` image are present locally) builds one bundle and checks its contents.

<a id="data-retention-nothing-is-ever-deleted"></a>

## Data Retention: nothing is deleted while the platform runs

A VoC data lake reads and interprets customer feedback; while it runs it does not
delete it (apart from the opt-in per-source retention and erasure of
[Source policies](source-policies.md)). The platform enforces that at two layers;
deleting the stacks is the one way to remove everything:

- **No expiry.** Feedback items in `voc-feedback` carry no `ttl` (TTL is
  disabled on that table), and the aggregator writes its `METRIC#…` rows in
  `voc-aggregates` without one. `voc-aggregates` keeps TTL *enabled* because its
  operational rows (processor logs, voting sessions, fixtures) still expire.
  Every window accepts `days` from 0 to 9999, and `days=0` means all time.
- **No delete path.** The Data Explorer has no delete route
  (`/data-explorer/{proxy+}` carries GET and PUT only), its role holds no
  `s3:DeleteObject*` or `dynamodb:DeleteItem`, and `PUT /data-explorer/s3`
  refuses to overwrite an existing object under `raw/`. Category corrections and
  reprocessing update items in place.
- **Deleted with the stack.** Unless `protectData` is set, the data tables, the raw-data
  bucket (`voc-raw-data-…`) and the KMS key that encrypts them are deleted with the
  stacks: see [Teardown deletes everything](#teardown-deletes-everything-back-up-first).

### Upgrading from a release with a 90-day TTL (before 2.03.00)

Older releases stamped a `ttl` on feedback items and `METRIC#` rows. Current code writes
none, but items written before the upgrade still carry it, and the `METRIC#` rows would
keep expiring because the aggregates table keeps TTL enabled. Run the migration once,
promptly after deploying (from `voc-datalake/`, with credentials for the target account):

```bash
# Dry run (default): scans and reports what it would change. Writes nothing.
.venv/bin/python scripts/retention/remove_ttl.py --stack VocCoreStack --region us-east-1

# Apply: REMOVE ttl from feedback items and METRIC# rows, and lower the
# earliest-data watermark (METRIC#meta / earliest_date) to the oldest feedback date.
.venv/bin/python scripts/retention/remove_ttl.py --stack VocCoreStack --region us-east-1 --apply

# Explicit table names instead of reading them from the stack outputs
.venv/bin/python scripts/retention/remove_ttl.py \
  --feedback-table <voc-feedback-name> --aggregates-table <voc-aggregates-name> --apply
```

Every write is conditional and idempotent, so the script is safe to interrupt
and re-run. It never deletes anything. Without the watermark, `days=0` falls
back to a 365-day window until the aggregator records a new earliest date.

### Memory and autonomous agents: model requirement

Memory dedup and recall use the Titan Text Embeddings V2 model (`amazon.titan-embed-text-v2:0`), which must be
available in the deployment region. Both features start empty: no agent runs until an admin creates and enables
one, and the memory scanner starts learning from assistant sessions that have been idle for 30 minutes on its
15-minute tick. See [Memory](memory.md), [Autonomous agents](autonomous-agents.md) and
[Company context](company-context.md).

### Teardown deletes everything: back up first

Deleting the stacks (`npm run destroy`, `cdk destroy --all`, or deleting them in
the CloudFormation console) is a **full cleanup** unless `protectData` is set
([below](#production-protectdata)): no customer data is left behind
in the account. With the Core stack go the customer-data tables
(`voc-feedback`, `voc-aggregates`, `voc-projects`, `voc-memory`, `voc-agents`,
`voc-participants`, `voc-feature-requests`), the operational tables, the `voc/design-integrations` secret, every bucket and
the KMS key:

- **Buckets are emptied first.** The raw-data bucket (`voc-raw-data-…`) is
  versioned; its `autoDeleteObjects` custom resource deletes every object
  version and delete marker, then CloudFormation deletes the bucket.
- **A replacement never deletes data.** Only deleting the stack does: the data
  tables, the raw bucket, the KMS key and the Cognito user pool carry
  `UpdateReplacePolicy: Retain`, so a change that forces CloudFormation to
  replace one leaves the old resource for you to migrate or remove. One caveat:
  the raw bucket's `autoDeleteObjects` provider still empties the OLD bucket
  when the bucket's name changes, so never change `deploymentPrefix` (or the
  account/region suffix) of a live deployment.
- **Tables have no deletion protection** (it would block the teardown) and keep
  point-in-time recovery on. DynamoDB keeps a **system backup** of each deleted
  PITR table for 35 days.
- **The KMS key is scheduled for deletion with a 30-day pending window** (the
  maximum KMS allows). Until the window ends the deletion can be cancelled with
  `aws kms cancel-key-deletion --key-id <key id>`; afterwards anything still
  encrypted with that key, including those system backups and any on-demand
  `create-backup` backup you took, can no longer be restored. Keep your copy
  outside the key (below).
- A redeploy into the same account and region starts with empty tables and
  buckets.

To keep a copy, back up **before** deleting, into a bucket that is not part of
the platform (from any shell with credentials for the account; replace the
placeholders):

```bash
BACKUP_BUCKET=<your-backup-bucket>   # created outside the VoC stacks
ACCOUNT=<account id>; REGION=<region>

# Raw data lake (current object versions)
aws s3 sync "s3://voc-raw-data-${ACCOUNT}-${REGION}" "s3://${BACKUP_BUCKET}/voc-raw-data/"

# Every customer-data table, exported from point-in-time recovery to S3. Exports run
# asynchronously and read from PITR, so they do not consume table capacity.
for table in voc-feedback voc-aggregates voc-projects voc-memory voc-agents voc-participants voc-feature-requests; do
  aws dynamodb export-table-to-point-in-time \
    --table-arn "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${table}-${ACCOUNT}-${REGION}" \
    --s3-bucket "${BACKUP_BUCKET}" --s3-prefix "voc-dynamodb/${table}" \
    --export-format DYNAMODB_JSON --s3-sse-algorithm AES256 \
    --region "${REGION}"
done

# Wait until every export reports COMPLETED before deleting the stacks
aws dynamodb list-exports --region "${REGION}" \
  --query 'ExportSummaries[].[ExportArn,ExportStatus]' --output table
```

Under a deployment prefix the names carry it (`<prefix>-voc-feedback-…`); the
exact names are the `VocCoreStack` resources (`aws cloudformation
list-stack-resources --stack-name VocCoreStack`). `--s3-sse-algorithm AES256`
keeps the export readable after the platform's KMS key is gone. An export can be
loaded into a new table with `aws dynamodb import-table`.

**Upgrading from a release before 5.00.00** changes only the
`DeletionPolicy` of those resources (and sets the KMS key's pending window); the
next deploy deletes and replaces nothing. Data is removed only when the stacks
are deleted. Releases before 5.00.00 retained the customer-data resources, so a
stack deleted earlier may have left them in the account: delete those by hand
once you no longer need them.

`lib/stacks/core-stack-teardown.test.ts` checks these policies, with and without `protectData`.

### Production: protectData

**Deploying for production? Set `protectData`.** The full-cleanup default above is
right for demos, workshops and temporary environments; a production deployment
should keep its data whatever happens to the stacks:

```bash
npm run deploy:infra -- -c protectData=true
# or in voc-datalake/cdk.context.json: { "protectData": true }
```

With it on (lib/utils/data-protection.ts):

- the data tables, the raw-data bucket, the KMS key, the `voc/design-integrations`
  secret and the Cognito user pool use CloudFormation's `RetainExceptOnCreate`:
  deleting the stacks, or a change that replaces one of them, leaves the
  resource and its data in the account (a failed FIRST deploy still cleans up);
- every DynamoDB table and the user pool get **deletion protection**, which also
  blocks a delete from the console, the CLI or an SDK;
- the raw-data bucket has **no auto-delete provider**, so neither a teardown nor
  a rename (a changed `deploymentPrefix`) can empty it;
- every Lambda and API log group keeps **365 days** (the AWS Config
  `cw-loggroup-retention-period-check` and Security Hub CloudWatch.16 default)
  and is **retained** on stack deletion, and the S3 server access-log bucket is
  kept too: they are the record of who touched the data (demo deployments keep
  14 days and delete them);
- every stack gets CloudFormation **termination protection**.

Only the value `true` or `false` is accepted; anything else (a typo) fails the
synth rather than deploying an unprotected stack. Turning it on for an existing
deployment changes deletion policies and protection only, nothing is replaced.
To tear down a protected deployment on purpose, deploy once with
`-c protectData=false` (or remove deletion protection by hand), turn termination
protection off (`aws cloudformation update-termination-protection
--no-enable-termination-protection --stack-name <stack>`), then delete the
stacks; the retained log groups and access-log bucket are left to delete by hand.
The website bucket and the operational queues hold no customer data and are
always deleted with their stacks.

### Passkeys

The app user pool offers **opt-in passkeys** (WebAuthn): after sign-in the app
asks each person once whether to add one, **Account → Profile → Passkey** lists
theirs, adds one later and removes one (a lost or replaced device; Amplify
`deleteWebAuthnCredential`, the person's own token), and **Login** has *Sign in with a passkey* (type the username or email
first). The password keeps working and MFA is not enforced. In the stack
(`lib/stacks/core-auth.ts`): the pool is on the **Essentials** plan, allows
`PASSWORD` and `WEB_AUTHN` as first factors with user verification required, and
its relying party is the site's own CloudFront domain; the web client has the
`USER_AUTH` flow. `config.json`
carries `features.passkey: true`, and the SPA offers nothing in a browser
without WebAuthn. Essentials bills about $0.015 per monthly active user after the
first 10,000, which are free. A passkey is bound to the domain: moving the site
to another domain means everyone adds a new one.

## Frontend Deployment

### Option 1: Via CDK

`VocApiStack` uploads the built frontend (`voc-datalake/frontend/dist`) and writes its `config.json`. CDK does not
build the frontend, so build it first:

```bash
npm run build                 # from the repository root
cd voc-datalake && npm run deploy:api
```

### Option 2: Direct Deployment (Faster for Updates)

For frontend-only changes, use the direct deployment script:

```bash
npm run deploy:frontend
```

This script:
1. Fetches environment config from CloudFormation
2. Builds the frontend (`npm run build`)
3. Syncs to S3
4. Invalidates CloudFront cache

### Frontend Caching Model

The caching rules make sure a returning browser never mixes a new app with old locale files:

- **Hashed assets** (`dist/assets/*`) upload with
  `Cache-Control: public,max-age=31536000,immutable`. Content-hashed
  names change on every code change, so they can cache forever.
- **Stable-name files** (`index.html`, `config.json`, `locales/**`,
  manifests) upload with `Cache-Control: no-cache`, so browsers revalidate
  with ETags (cheap 304s) and never serve a stale copy. Without this header,
  browsers apply *heuristic* caching (about 10 % of the object's age) and can serve
  old locale files for days, whatever CloudFront invalidations run.
- **Locale URLs are version-stamped** (`/locales/en/common.json?v=<git-sha>`
  via `import.meta.env.APP_VERSION`, injected at build): each new bundle
  requests URLs that no old cache entry can match.
- The assets sync does **not** `--delete`: visitors holding a
  previously cached `index.html` still reference the previous deploy's
  chunks, and deleting them would turn a stale but working page into 404s.

### Frontend Build Process

```bash
cd voc-datalake/frontend

# Generate plugin manifests and menu config
npm run prebuild

# Build for production
npm run build

# Output in dist/ folder
```

### Frontend Build Freshness Guard

`VocApiStack` deploys the frontend by packaging `voc-datalake/frontend/dist`
as-is (`s3deploy.Source.asset('frontend/dist')`). **CDK does not rebuild the
frontend**: whatever is in `dist` at synth time is what ships.

To prevent shipping a stale UI (a common mistake after switching branches or
editing `src/` without rebuilding), a synth-time guard runs at the top of the
`VocApiStack` constructor. It fails `cdk synth`/`diff`/`deploy` if:

- `frontend/dist/index.html` is missing (frontend never built), or
- any source input (`src/`, `public/`, `index.html`, `vite.config.ts`,
  `tsconfig*.json`, `package.json`) is newer than the built `dist/index.html`.

The error names the offending file and tells you to rebuild:

```bash
cd voc-datalake/frontend && npm run build
```

Always run `npm run deploy:frontend` (which builds, syncs, and invalidates) or
rebuild `dist` before `cdk deploy`. The guard is a safety net, not a substitute
for building.

> ### Never `aws s3 sync --delete` the website bucket
>
> **The build does not produce `config.json`.** It is generated at deploy time
> (`s3deploy.Source.data('config.json', …)` in `api-stack.ts`, and by
> `scripts/deploy.sh`), so a hand-rolled
> `aws s3 sync frontend/dist s3://<bucket> --delete` after a plain build **deletes it** and the app
> loses every Cognito value: the login screen reads "Cognito not configured".
>
> **A `curl` of the deleted path returns 200, not 404**: CloudFront serves the
> SPA's `index.html` fallback, so the site looks healthy from the shell while
> being broken in the browser. Check the app, or assert the body parses as JSON.
>
> Deploy the frontend with `npm run deploy:frontend` or `npm run deploy:api`.
> If you must sync by hand, omit `--delete`. To recover, run
> `npx cdk deploy VocApiStack --exclusively` (from `voc-datalake/`), which regenerates the file from the
> stack. Do not write it by hand: a missing user pool or client id makes
> `RuntimeConfigSchema` blank every Cognito value and reproduces the same
> symptom (see "Environment Variables" below).

**Bypass** (rare, intentional cases only):

```bash
npx cdk deploy VocApiStack -c skipFrontendBuildCheck=true
# or
SKIP_FRONTEND_BUILD_CHECK=1 npx cdk deploy VocApiStack
```

## Configuration

### Plugin Status

Enable/disable plugins in `voc-datalake/cdk.context.json`. The committed file enables all seven built-in plugins
(`webscraper`, `web_reviews`, `app_reviews_ios`, `app_reviews_android`, `github_issues`, `s3_import`,
`synthetic_reviews`); a disabled plugin's ingestor Lambda and schedule are not deployed.

```json
{
  "pluginStatus": {
    "webscraper": true,
    "synthetic_reviews": false
  }
}
```

### Menu Configuration

Enable/disable menu items in `voc-datalake/cdk.context.json`. The keys are `home`, `dashboard`, `categories`,
`problems`, `radar`, `chat`, `projects`, `prioritization`, `data-explorer`, `scrapers`, `feedback-forms`,
`participants`, `feature-requests`, `memory`, `agents`, `company`, `connect` and `settings`; all are on in the
committed file. Turning a menu item off hides the page but leaves its API and workers deployed: the memory
scanner and the agent heartbeat still run (an agent only runs when an admin enabled it).

```json
{
  "menuStatus": {
    "dashboard": true,
    "radar": false,
    "scrapers": true
  }
}
```

After changing either, regenerate the frontend config and deploy:

```bash
npm run generate:config   # Regenerate manifests and menu
npm run deploy:all        # a plugin change (new Lambda) + frontend; a menu-only change needs only npm run deploy:frontend
```

### Web Search (Amazon Bedrock AgentCore)

AI Chat, Projects research and agent research steps can ground answers with public web
results via the AWS-managed [Web Search Tool connector](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-connector-web-search-tool.html)
behind an AgentCore Gateway (`VocWebSearchStack`). Queries are served
entirely within AWS and are billed per search ($7 per 1,000 at the time of writing; check AgentCore
pricing). The gateway itself has no standing cost. In the UI, search is opt-in per request
(chat toggle, research wizard checkbox).

The connector only exists in **us-east-1**, so the stack always deploys
there. Deployment is **on by default**:

- App deployed to us-east-1: nothing else needed.
- App deployed to any other region: a us-east-1 bootstrap
  (`cdk bootstrap aws://ACCOUNT_ID/us-east-1`); CDK cross-region references
  carry the gateway URL/ARN to the app region.

To opt out (for example when a us-east-1 bootstrap isn't possible), set
`"enableWebSearch": false` in `cdk.context.json` or deploy with
`-c enableWebSearch=false`. The UI then hides the web-search controls
(the deployment reports `WebSearchAvailable=false` and
`config.json` ships `features.webSearch: false`). Under `-c inferenceScope=eu` web search is never deployed.

> **Setting the app region:** `bin/voc-datalake.ts` reads
> `process.env.CDK_DEFAULT_REGION`, but **the CDK CLI overwrites that variable**
> for the app subprocess from the resolved AWS environment, so exporting it
> yourself has no effect. Use `AWS_REGION` / `AWS_DEFAULT_REGION`, or
> `--profile`. This matters here because `VocWebSearchStack` is the only
> region-pinned stack, so it is the only one whose region can differ from the
> app's, and that difference is what triggers the cross-region wiring above.

**Data residency note:** search queries are processed by the connector in
us-east-1 regardless of where the app is deployed. Queries are derived from
user input (the research question is sent as-is, and in chat the model
composes queries from the conversation), so deployments with regional
data-handling requirements should factor this in, or opt out.

The frontend discovers availability through the `features.webSearch` flag in
`config.json` (set by CDK and by `scripts/deploy.sh` from the
`WebSearchAvailable` stack output). For local development against the mock,
set `VITE_ENABLE_WEB_SEARCH=true`.

### Pinning All AI Surfaces to One Model

Each AI surface has its own default model: Claude Sonnet 5.5 for the AI
assistant (chat), documents, utilities, agent workers and the persona panel;
Claude Opus 5.5 for prototypes and the agent conductor and final reviewer;
Claude Haiku 5.5 for enrichment and memory. Some accounts cannot invoke all of them: Bedrock model access
is granted per account, and organizations behind an AWS Private Marketplace are
often restricted to a subset. When a surface's model is unavailable, the
request falls back to the next model of that surface's chain (see
[Model Capacity Fallback](#model-capacity-fallback)). Pin a model when you want
a predictable choice rather than a per-request fallback.

To pin every surface to one known-available model at deploy time:

```bash
npm run deploy:infra -- -c defaultModelId=global.anthropic.claude-sonnet-4-6
```

This creates a `Custom::ModelPin` resource in `VocCoreStack` that writes
`model_id` to the `SETTINGS#model` configuration item. Behaviour worth knowing:

- **Write-once.** The value is only set if absent, so an administrator's later
  choice in Administration → AI models is never overwritten by a redeploy. It is a floor, not a lock:
  per-surface overrides still take precedence.
- **Validated at synth.** The id must be in `ALLOWED_MODEL_IDS`
  (`lib/utils/model-allowlist.ts`); an unrecognized value fails the synth rather
  than being discarded at read time.
- **Absent flag creates nothing**: no Lambda, no custom resource, no log group.

To check which models an account can actually invoke, call Converse. Agreement
and availability APIs can report a model as available when inference still
returns `AccessDeniedException`:

```bash
aws bedrock-runtime converse --region us-east-1 \
  --model-id global.anthropic.claude-sonnet-4-6 \
  --messages '[{"role":"user","content":[{"text":"say ok"}]}]' \
  --inference-config '{"maxTokens":5}'
```

### E2E Test Users Run on Haiku 5.5 (the `e2e` Cognito group)

VocCoreStack creates a Cognito group `e2e` next to `admins` and `users`. For a member, every model
call the app makes on that user's behalf resolves to Claude Haiku 5.5 (`global.anthropic.claude-haiku-5-5`,
mapped to `eu.` under `-c inferenceScope=eu`) on every surface, whatever is picked in Administration →
AI models, and the capacity fallback stays on Haiku (then Haiku 4.5). It keeps an end-to-end test suite
that runs against a deployment from spending on the larger models; real users and the admin picker are
unaffected, and the image model (persona avatars) is not part of it. The group grants no permission.

The profile is read only from verified data: the Cognito authorizer's `cognito:groups`, the claims the
assistant stream forwards, the approver's groups the plan conductor re-reads in Cognito, and a
`model_profile` field that a verified request stamped on a job (project jobs, assist jobs, agent runs,
manual-import queue messages). A request body cannot set it. Logs: `[BEDROCK] Starting converse call
… model_profile=e2e` in the Python Lambdas, `model profile applied` in `voc-chat-stream` / `voc-plan-step`.
Not covered: background memory extraction, product-document extraction on upload, scheduled agent runs
and global MCP token calls (no verified caller groups there).

Add a test user once (admin only; the e2e suite's setup fails when a user is missing from the group):

```bash
aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> --username '<e2e user>' --group-name e2e
```

<a id="testing-a-model-before-saving-it-settings--ai-models"></a>

### Testing a Model Before Saving It (Administration → AI models)

The AI models card edits a **draft**: changing a surface's select does not save
it. Each row has a **Test** button that sends ONE minimal Converse request
("Reply with OK", `maxTokens` 16) to exactly the model the draft resolves to,
Automatic included, shaped like every other request to that model
(`shared/converse.py::build_single_turn_request`: no `temperature` or thinking
budget where the model rejects them, no Flex, the `eu.` profile under
`-c inferenceScope=eu`). There is **no fallback and no retry**: a test of model X
is never answered by model Y. **Save** / **Discard** appear while the draft
differs from what is stored; saving a model whose last test was not *Available*
(or that was never tested) asks for confirmation but is allowed. **Test all
models** runs the test for every allowlisted model one at a time and shows a
table with each model's status, latency and tokens-per-minute quota (the quota
column is filled before any test from `GET /settings/model/capacity`, which reads
Service Quotas and calls no model).

| Status | Meaning | What to do |
|---|---|---|
| Available | The model answered (latency and tokens/min shown) | Nothing |
| No access | `AccessDeniedException`, or a validation error about model access / use case / agreement | Fix model access ([Anthropic Model Access](#anthropic-model-access-first-time-setup)) |
| No capacity | Throttled AND the account's tokens-per-minute quota for this profile is **0** | The model is subscribed but has no capacity in this account. Use another model (the fallback below does this per request), and request a quota increase in Service Quotas when the account is eligible |
| Throttled | Throttled with a non-zero or unknown quota | Retry in a moment |
| Not in this region | `ResourceNotFoundException` / unknown profile | Use a region or scope that offers it |
| Not ready / Unavailable | `ModelNotReadyException` / `ServiceUnavailableException`, `ModelTimeoutException` | Retry later |
| Error | Anything else (only the error code is shown) | Check the settings Lambda log |

The quota is matched by name in `servicequotas:ListServiceQuotas` (service code
`bedrock`): `Global cross-region model inference tokens per minute for Anthropic
<model>` for `global.` profiles, `Cross-region model inference tokens per minute for
Anthropic <model>` for `eu.` / `us.` profiles. Listing all ~1,050 Bedrock quotas takes
10-15 s, so it runs once: the Anthropic token quotas and their quota codes are kept in
the aggregates table (`SETTINGS#model_quotas` / `current`, `shared/model_quota_store.py`)
and in each container's memory for 10 minutes. The stored reading is used as-is for an
hour. After that, or when a model was added to the allowlist since the reading, the request
still answers at once with the stored values marked `"stale": true`, and async-invokes the
settings worker twin (`voc-settings-assist`, event `{"action": "model_quota_refresh"}`; one
per two minutes, a `refresh_requested_at` mark on the row), which re-reads each model's quota
by its code with `GetServiceQuota`, at most three at a time, or runs the full listing when a
model was added or a by-code read fails. Only a deployment's very first reading (nothing
stored yet) is read while the screen waits. Service Quotas is rate limited per
account: its client retries adaptively (botocore `adaptive` mode, 3 retries), and when a
refresh or listing is still throttled (`TooManyRequestsException`) or fails while a reading
is stored, that reading answers with `"stale": true` on the quota (the table marks it "Last
stored reading") and is retried after two minutes. With nothing stored, a denied or failed
lookup shows the quota as unknown and the test still runs. Both routes are admin-only; the
settings Lambda role holds the read-only `servicequotas:ListServiceQuotas` (on `*`, the
API has no resource-level permission) and `servicequotas:GetServiceQuota` on this
account and region's `bedrock/*` quotas, and already holds `bedrock:InvokeModel` on every
allowlisted profile.

### Image Generation (Persona Avatars) in Administration → AI models

Below the surface rows, a read-only **Image generation (persona avatars)** row shows the
image model that `lambda/api/prompts/avatar-generation.json` names (not a picker
choice), its region, the account's access, its requests-per-minute quota and a **Test**
button (`lambda/shared/image_model_status.py`):

- `GET /settings/model` carries `image_model: {id, label, region, avatars_enabled}`.
- `GET /settings/model/capacity` carries `image: {id, label, region, avatars_enabled,
  access, quota, quota_state}`. `access` comes from `bedrock:GetFoundationModelAvailability`
  in the image region (cached 5 minutes) and maps to `available`, `no_access` (authorization
  `NOT_AUTHORIZED`: IAM, SCP), `not_subscribed` (agreement or Marketplace entitlement
  missing), `not_in_region` or `unknown` (unreadable). `quota` is
  `{name, value, unit: 'requests_per_minute'}`, matched in ListServiceQuotas of the IMAGE
  region by the name `On-demand model inference requests per minute for Stability.ai
  <model>` (`shared/image_model_quota.py`). That listing takes 10-15 s, so it runs on the
  settings worker twin: the reading is kept in the aggregates table
  (`SETTINGS#image_model_quota` / `current`) for an hour and in memory for 10 minutes;
  an older or missing reading answers at once (`quota_state` `stale` or `pending`) while
  the twin re-reads it (at most once per two minutes).
- `POST /settings/model/test {model_id: <image model id>}` (admin) generates ONE small
  image from a fixed prompt, keeps nothing (no S3 write) and answers in the same shape and
  status vocabulary as a text-model test; the error is classified like an avatar failure
  (`shared/avatar_failure.py`). It costs a few US cents per click, so **Test all models**
  does not include it.

The settings role holds `bedrock:InvokeModel` on the image model ARN only,
`bedrock:GetFoundationModelAvailability` (no resource-level permission) and the
Marketplace subscription grant of `lib/stacks/api-marketplace.ts` (the first call of a
Marketplace model subscribes as the caller). Under `-c inferenceScope=eu` avatars are off;
the row says so and the model is not used.

### Model Capacity Fallback

Access is not capacity. Bedrock can grant an account a model and still give it
**zero capacity** for it, and a young account cannot request a quota increase
until it has some history. Such a model passes every access check and then
throttles every call. So when the model a surface resolved cannot serve right
now, the request is re-run on the next model of one ordered chain:

1. the surface's resolved model (admin per-surface pin › legacy global pin ›
   built-in default, or an explicit `model_id=`),
2. the surface's built-in default, when different,
3. then `MODEL_FALLBACK_ORDER`: **Sonnet 5.5 → Sonnet 5 → Sonnet 4.6 → Haiku 5.5 → Haiku 4.5**.

Opus is only ever reached as the configured or default model of a surface
(prototype, agent conductor/reviewer), never as a stand-in. This is separate
from Bedrock's own Opus **safety fallback**: Opus 5.5 re-runs a request its
classifiers decline on Opus 5, and Opus 5 on Opus 4.8, which is why both older
Opus models stay allowlisted (and so granted and agreed). The chain is defined
in `lambda/shared/model_config.py` (`MODEL_FALLBACK_ORDER`, `fallback_chain`) and
mirrored for the streaming assistant in `lambda/stream/src/bedrock/model-fallback.ts`;
`test_model_fallback_lockstep.py` fails the build on drift.

What falls back (`shared/model_fallback.py::is_model_unavailable`): a
`ThrottlingException` or `ServiceUnavailableException` that outlasted the
existing retry budget (5 attempts with backoff in `converse()`, the SDK's 3 in
the stream), `ModelNotReadyException`, `ServiceQuotaExceededException`,
`ResourceNotFoundException`, and an `AccessDeniedException` /
`ValidationException` whose message names model availability (no access to the
model, not enabled, on-demand throughput not supported, invalid model
identifier, end of life, not authorized to invoke). **Input errors never fall
back** (context too long, bad request shape, guardrail): they would fail on
every model.

Behaviour worth knowing:

- **Cooldown.** A model that failed for capacity is tried last for 5 minutes in
  that Lambda container, so a burst pays the failed attempt once. When every
  model is cooling, all are still tried, so a request never fails untried.
- **Whole request.** `converse()` re-runs the whole call (continuations
  included) on the next model, with the request rebuilt for it (temperature and
  thinking differ per model). When every model fails, the FIRST model's error is
  raised.
- **Stream: before the first token only.** The assistant falls back only while
  nothing of the turn has reached the browser; once text streamed, the error is
  shown. Later tool rounds and `consult_personas` stay on the model that served.
- **Provenance.** `ConverseResult.model_id` is the model that answered and
  `requested_model_id` the one asked for (`model_fallback` is true when they
  differ); the stream's `RUN_FINISHED` usage names the serving model.
- **Observability.** Each fallback logs a warning and emits the `ModelFallback`
  metric (namespace `VoC` for the stream, the Lambda's Powertools namespace
  otherwise) with dimensions `Surface`, `From`, `To`; a cooldown skip is counted
  too. Alarm on it to learn that a model has lost capacity.
- **Cost.** A Haiku 5.5 surface (enrichment, memory) falls back to Sonnet 5.5, which
  costs more per token. That is deliberate (availability first), and bounded by
  the 5-minute re-probe.

## Environment Variables

The frontend reads its configuration at runtime from `config.json`, which is generated at deploy time (by
`VocApiStack` and by `npm run deploy:frontend`) from the CloudFormation outputs: the API endpoint, the Cognito
user pool and client ids, the board pool, the region, and feature flags (`features.webSearch`, `features.email`,
`features.passkey`). The frontend build (`npm run build`) does not produce it.

For local development, `voc-datalake/frontend/scripts/update-env.sh` writes a `.env` from the same outputs
(`VITE_API_ENDPOINT`, `VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_CLIENT_ID`, `VITE_COGNITO_REGION`). A dev server on
`localhost` cannot call a deployed API, because the API only allows the site's own origin (CORS); use the mock
(`npm run dev`) for local work.

## Deployment Workflow

### For Infrastructure Changes

```bash
# 1. Make changes to CDK stacks
# 2. Run checks
npm run check

# 3. Preview changes
npm run cdk:diff

# 4. Deploy
npm run deploy:infra
```

### For Frontend Changes

```bash
# 1. Make changes to frontend code
# 2. Run checks
npm run check

# 3. Deploy frontend only
npm run deploy:frontend
```

### For Plugin Changes

```bash
# 1. Create/modify plugin in plugins/
# 2. Update pluginStatus in cdk.context.json
# 3. Regenerate manifests
npm run generate:config

# 4. Deploy infrastructure (for new Lambda) + frontend
npm run deploy:all
```

## CI/CD Integration

Example GitHub Actions workflow:

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
          
      - name: Install dependencies
        run: |
          npm run install:all
          npm install --prefix voc-datalake/lambda/stream
          
      - name: Install Python dev dependencies
        # The check gate needs the venv: test:backend runs
        # .venv/bin/python -m pytest and lint:python runs
        # .venv/bin/python -m ruff
        run: |
          cd voc-datalake
          python -m venv .venv
          .venv/bin/pip install -r requirements-dev.txt \
            -r lambda/layers/ingestion-deps/requirements.txt \
            -r lambda/layers/processing-deps/requirements.txt \
            -r lambda/layers/signing-deps/requirements.txt \
            -r lambda/layers/email-intake-deps/requirements.txt
          
      - name: Build Lambda layers
        run: npm run build:layers
          
      - name: Quality checks
        run: npm run check
        
      - name: Deploy infrastructure
        run: npm run deploy:infra
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
          
      - name: Deploy frontend
        run: npm run deploy:frontend
```

## Troubleshooting

### CDK Bootstrap

If deploying to a new AWS account/region:

```bash
npm run cdk:bootstrap
```

### Stack Stuck in UPDATE_ROLLBACK

```bash
aws cloudformation continue-update-rollback --stack-name STACK_NAME
```

### VocCoreStack fails: "Updates are not allowed for property - UsernameConfiguration"

User pools created by very early releases (before 0.2.0) predate case-insensitive sign-in
(`signInCaseSensitive: false`), and Cognito treats `UsernameConfiguration` as create-only. Any
stack update that introduces it on an existing pool is rejected and the
whole VocCoreStack update rolls back. (A secondary
`Invalid AttributeDataType` error on the same update is a symptom of the
same rejected pool update.)

Deploy with the compatibility flag to leave the existing pool untouched:

```bash
npm run deploy:infra -- -c omitUserPoolUsernameConfiguration=true
```

Add the flag to every later deploy of that environment (or to a
local, uncommitted context override). New deployments should NOT set it:
new pools get case-insensitive sign-in by default.

### VocApiStack fails: "A sibling ({proxy+}) of this resource already has a variable path part"

This affects only environments deployed **before** the `/feedback-forms` item
routes were declared one by one. Those routes used to sit behind a `{proxy+}`
catch-all, so the deploy has to
create `/feedback-forms/{form_id}` and delete `/feedback-forms/{proxy+}`.
CloudFormation creates new resources before deleting old ones inside a single
update, so both variable path parts exist for a moment and API Gateway rejects
the pair. The stack rolls back cleanly and the API keeps serving.

**New deployments are unaffected**: there is no proxy to remove.

Upgrade an existing environment in two deploys, using the transitional flag
(no source edits are involved), from `voc-datalake/`:

```bash
# 1. Retire the old {proxy+}. The per-form routes are not created yet.
npx cdk deploy VocApiStack --exclusively -c skipFeedbackFormItemRoutes=true

# 2. Create the explicit per-form routes, then refresh the stage.
npx cdk deploy VocApiStack --exclusively && bash scripts/refresh-api-stage.sh
```

`skipFeedbackFormItemRoutes` is a no-op when absent, so the second command is
a normal deploy. Step 1 prints a warning naming itself as the first of two deploys.
**Never leave the flag set**: while it is on, `/feedback-forms/{form_id}/*` does not exist.

Between the two deploys the per-form routes are unavailable, so the embeddable
widget stops working until the second deploy finishes. They fail closed (no data
is served, and nothing is left unauthenticated), and the window is one deploy
long. Schedule it accordingly if forms are live.

### An old feedback widget snippet stopped working

The only supported embed is the iframe page `/feedback-forms/{form_id}/iframe`, which the feedback-form Lambda
renders with the widget script inlined (`lambda/api/static/feedback-widget.js`). See
[Feedback Forms](feedback-forms.md) for the snippet. No standalone `feedback-widget.js` is served from any URL.

Older releases also published a copy at `https://<distribution>/feedback-widget.js` that called retired
`/feedback-form/*` (singular) routes. If an integration still points there, repoint it at the iframe embed. The
failure does not look like a missing file:

| Old snippet points at | Response | Why |
|---|---|---|
| the website (`https://<distribution>/feedback-widget.js`) | **`200` + `index.html`** | the distribution answers every missing path with `index.html` so app deep links work; a `<script src>` then fails with `Uncaught SyntaxError: Unexpected token '<'` |
| an API path (`/feedback-forms/{form_id}/widget.js`) | **`403 Missing Authentication Token`** | API Gateway's answer for a route that does not exist, not an authorization problem |

Shortly after the deploy that removed the copy, the CDN may still serve the old script for a while. It then shows
`Failed to load form.` inside the embed, because its configuration request goes to a retired route.

When you delete a file from `frontend/public/`, rebuild `dist` before a CDK deploy (`npm run build`, or use
`npm run deploy:frontend`). The freshness guard compares modification times, and a deletion changes none, so a
stale `dist` would publish the removed file again.

### CloudFront Cache

If changes don't appear after deployment:

```bash
aws cloudfront create-invalidation \
  --distribution-id DISTRIBUTION_ID \
  --paths '/*'
```

### Log retention of CDK's own provider Lambdas

Every Lambda logs to a log group with a 14-day retention (`lib/utils/log-retention.ts`, pinned by
`lib/utils/log-retention.test.ts`), including the functions CDK creates for you (S3 auto-delete, bucket
notifications, the website `BucketDeployment`). Two kinds need one manual step:

- **Cross-region export reader/writer** (`crossRegionReferences`): CDK adds them after the retention aspect runs,
  so Lambda creates `/aws/lambda/<Stack>-CustomCrossRegionExport…` with no retention on their first deploy. Set it
  once: `aws logs put-retention-policy --log-group-name <group> --retention-in-days 14`.
- **Deployments from before 5.25.04**: the provider functions logged to groups Lambda created, with no retention.
  After this release they log to the new stack-owned groups; the old `/aws/lambda/<Stack>-Custom…`,
  `-BucketNotificationsHandler…` and `-CustomCDKBucketDeployment…` groups are left behind. Give them a retention (as
  above) or delete them.

### View Stack Outputs

```bash
aws cloudformation describe-stacks \
  --stack-name VocApiStack \
  --query 'Stacks[0].Outputs'
```

## Useful Commands

| Command | Description |
|---------|-------------|
| `npm run install:all` | Install all dependencies (root + CDK + frontend) |
| `npm run build:layers` | Build Lambda layers with Docker (ARM64); honors `CONTAINER_CMD`/`CDK_DOCKER` (e.g. `finch`) |
| `npm run cdk:bootstrap` | Bootstrap CDK in AWS account |
| `npm run check` | Lint, type checks, every test suite and the frontend build |
| `npm run deploy:all` | Quality checks, then every stack, then the frontend |
| `npm run deploy:infra` | Deploy CDK stacks only (+ the API stage refresh) |
| `npm run deploy:frontend` | Deploy frontend only |
| `npm run generate:config` | Regenerate plugin/menu config |
| `npm run dev` | Start the mock API (`localhost:3001`, sample data) and the frontend dev server (`localhost:5173`) together; Ctrl+C stops both. An already-running mock is reused |
| `npm run dev:frontend` | Start only the frontend dev server (no mock) |
| `npm run cdk:diff` | Preview infrastructure changes |
| `npm run cdk:synth` | Generate CloudFormation templates |
| `npm run destroy` | Destroy all stacks, customer data included: back up first (see [Teardown deletes everything](#teardown-deletes-everything-back-up-first)) |
