# EU deployment

An EU deployment keeps every Bedrock model call inside EU regions. It is for operators with EU data-residency
requirements. Deploy with `-c inferenceScope=eu`, with the AWS region set to an EU region:

```bash
AWS_REGION=eu-central-1 npm run deploy:infra -- -c inferenceScope=eu
```

Set the region with `AWS_REGION`, `AWS_DEFAULT_REGION` or `--profile`. The CDK CLI overwrites
`CDK_DEFAULT_REGION` itself, so exporting that variable has no effect. Pass the same flag on every later deploy.

`inferenceScope` takes `global` (the default) or `eu`. Any other value fails the synth.

## What changes

| Area | `global` (default) | `eu` |
|---|---|---|
| Bedrock calls | `global.` cross-region inference profiles: may be served in any commercial region | `eu.` inference profiles: served only in EU regions |
| IAM | `global.` profile ARNs, the in-Region model and the Region-agnostic global model (`arn:aws:bedrock:::foundation-model/…`), both only through those profiles | **Only** the `eu.` profile ARNs, and each model in the profile's EU destination Regions, only through those profiles. A stray `global.` call is AccessDenied, not a silent residency breach |
| Stored / allowlisted model ids | Canonical `global.…` | Unchanged (still canonical). The prefix is mapped at call time |
| Web search (AgentCore gateway) | On by default | **Never deployed.** An explicit `-c enableWebSearch=true` throws, because the connector runs only in us-east-1 |
| Persona avatars | Image model in us-west-2 | **Disabled** (`AVATARS_ENABLED=false`); personas have no avatar |
| Anthropic use-case form (`anthropicUseCase`) | Opt-in: only with your own block (none is committed); otherwise filed in the Bedrock console | The same. With a block, `VocWebSearchStack` is created in us-east-1 for the account-level form only; no inference or customer data passes through it (the synth adds an info annotation). Without one, **no stack deploys to us-east-1** |
| AWS WAF (`-c enableWaf=true`, opt-in) | The SPA distribution's `CLOUDFRONT` web ACL lives in `VocWebSearchStack`, us-east-1 | The same: CloudFront requires its web ACL in us-east-1, so this flag creates `VocWebSearchStack` there with only that ACL. It stores no request content (no WAF logging; metrics and sampled requests only). The API's web ACL stays in your EU app region ([deployment.md](deployment.md#aws-waf-and-cognito-plus-opt-in)) |
| Model agreements (Claude) | Created by `VocCoreStack` on every deploy, in the app region, best effort | The same, in your EU app region |

### How the scope applies at runtime

- Every Lambda of an EU deployment gets `BEDROCK_INFERENCE_SCOPE=eu` and
  `AVATARS_ENABLED=false`, applied by a CDK aspect. A `global` deployment's templates are
  unchanged.
- Python: `shared/model_config.invocation_model_id` maps `global.x` to `eu.x`.
  `shared/converse.py` sends the mapped id. Raw `converse` / `invoke_model` call sites go
  through `scope_bedrock_client`, a botocore hook on the Bedrock client.
- Stream Lambda (AI assistant): `invocationModelId` is applied to every `ConverseStream`
  and to the `consult_personas` calls.
- Capability checks (for example, which models reject `temperature`), the model picker,
  usage records and fallbacks all keep working on the canonical id.

## Model availability

Every allowlisted model has an `eu.` profile (checked with
`aws bedrock list-inference-profiles --region eu-central-1 --query "inferenceProfileSummaries[].inferenceProfileId"`
and the same in eu-west-1 in October 2026; Opus 5.5 and Haiku 5.5 were checked in eu-central-1 only):

| Canonical id (picker) | EU profile |
|---|---|
| `global.anthropic.claude-opus-5-5` | `eu.anthropic.claude-opus-5-5` |
| `global.anthropic.claude-sonnet-5-5` | `eu.anthropic.claude-sonnet-5-5` |
| `global.anthropic.claude-sonnet-5` | `eu.anthropic.claude-sonnet-5` |
| `global.anthropic.claude-sonnet-4-6` | `eu.anthropic.claude-sonnet-4-6` |
| `global.anthropic.claude-opus-5` | `eu.anthropic.claude-opus-5` |
| `global.anthropic.claude-opus-4-8` | `eu.anthropic.claude-opus-4-8` |
| `global.anthropic.claude-haiku-5-5` | `eu.anthropic.claude-haiku-5-5` |
| `global.anthropic.claude-haiku-4-5-20251001-v1:0` | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` |

**A model without an `eu.` profile is excluded.** `EU_PROFILE_MODEL_IDS` in
`lib/utils/model-allowlist.ts` lists the verified models, and an EU deployment is granted
only those. If you add a model to the allowlist, run the command above first and add the
model to `EU_PROFILE_MODEL_IDS` only once its profile exists. Otherwise an admin who picks it
in an EU deployment gets AccessDenied.

Two other services are called in-region, so the region you deploy to must offer them:

- **Memory embeddings**: Amazon Titan Text Embeddings V2, called as an in-region foundation
  model (no profile).
- **Comprehend and Translate**: sentiment, language detection, key phrases, translation.

## PII redaction language limits

Source-policy redaction ([source-policies.md](source-policies.md)) works in two layers:

- The regex rules (email, phone, IBAN, card, IP) apply to text in every language.
- Comprehend `DetectPiiEntities`, which detects names and addresses, supports only
  **English and Spanish**. German, French, Italian and other EU-language text therefore gets
  regex redaction only.

For sources where names in free text matter, use `pii: summary_only`.

## Bedrock IAM grant and destination Regions

AWS authorizes a geographic cross-Region call against the `eu.` profile in your region AND the foundation model
in every destination Region the profile can route to
([geographic cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html)).
The grant lists those Regions explicitly (no Region wildcard), from the "Geo: EU" table on each model's card in
the Bedrock user guide, in `EU_PROFILE_DESTINATION_REGIONS` (`lib/utils/model-allowlist.ts`). From every EU
source Region the profiles route to `eu-central-1`, `eu-north-1`, `eu-south-1`, `eu-south-2`, `eu-west-1` and
`eu-west-3`; from `eu-central-2` and `eu-west-2` also to the source Region itself (confirmed with
`GetInferenceProfile` for all eight models from every EU source Region enabled in the test account; `eu-south-1`
and `eu-south-2` are opt-in Regions and rest on the model cards). The synth refuses `inferenceScope=eu` in any
other region.

AWS states that a geographic profile's destination list never changes (a new Region comes as a new profile;
[Supported Regions and models for inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)).
If it ever does, the calls Bedrock routes to the new Region fail with `AccessDeniedException` (on
`foundation-model/<model>` there) until the table lists it. To check:

```bash
aws bedrock get-inference-profile --region <your region> \
  --inference-profile-identifier eu.anthropic.claude-sonnet-5-5 --query "models[].modelArn"
```

add the new Region to `EU_PROFILE_DESTINATION_REGIONS`, then redeploy.

## Your own models

A model of your own (`-c customModels`, 7.65.00, [deployment.md](deployment.md#bring-your-own-model--c-custommodels))
must keep the same residency, and the synth checks it: under `-c inferenceScope=eu` every custom model needs
`"eu": true`, and `"eu": true` needs an `eu.` inference profile or an in-Region model (a Bedrock model id, or an
imported model's ARN in the app Region and account). A `global.` profile, a `us.` or other non-EU profile and an
imported model in another Region are refused. An `eu.` custom profile is granted through the profile in each Region
of `EU_PROFILE_DESTINATION_REGIONS` by default, or of its own `regions` (EU Regions only, the app Region included):
at the time of writing (2026-11-21) the non-Claude `eu.` profiles listed from `eu-central-1` routed to a subset of
those Regions (`eu.amazon.nova-pro-v1:0` to `eu-central-1`, `eu-north-1`, `eu-west-1`, `eu-west-3`;
`eu.meta.llama3-2-3b-instruct-v1:0` to `eu-central-1`, `eu-west-1`, `eu-west-3`), and a profile that routes elsewhere
in the EU names its `regions`. Custom Model Import answered in `eu-central-1` and was refused in `eu-west-1`,
`eu-west-2`, `eu-west-3` and `eu-north-1` that day: an imported model needs an app Region that offers it, so check the
current list on the AWS page [Supported Regions and models for Custom Model Import](https://docs.aws.amazon.com/bedrock/latest/userguide/model-customization-import-model.html).

## Voice personas

Talking to the personas by voice (`-c voicePersonas=true`, [voice-personas.md](voice-personas.md)) uses Amazon Nova 2
or 2.5 Sonic, which run in-Region only and, in the EU, only in eu-north-1, where VoC cannot run (no Amazon
Comprehend). So the synth refuses the flag in eu-central-1, eu-west-1 and every other EU Region: an EU deployment has
no voice in v1, and no voice call ever leaves its Region.

## Choosing a region

- Use a region that has the `eu.` Bedrock profiles, Comprehend, Translate and Titan
  Embeddings V2. Frankfurt (`eu-central-1`) and Ireland (`eu-west-1`) are the safe choices.
- Request Bedrock model access in that region.
- Cognito, DynamoDB, S3, Lambda, Step Functions, SQS, API Gateway and KMS all run in the
  deployment region.
- CloudFront is a global edge service. It serves the static SPA and generated prototypes, not
  feedback data.

## Limits of the testing

The synth, the IAM grants and the call-time mapping are covered by tests:
`lib/app-inference-scope.test.ts`, `lib/utils/inference-scope.test.ts`,
`lambda/shared/test/test_inference_scope.py` and the stream `model-override.test.ts`.
Bedrock service tiers (`SURFACE_SERVICE_TIERS`, the Flex tier used for memory extraction) have not been
tested on `eu.` profiles. Check a full EU deployment in your own account before relying on it.
