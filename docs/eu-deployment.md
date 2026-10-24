# EU deployment

Deploy with `-c inferenceScope=eu` to keep model inference inside the EU:

```bash
npm run deploy:infra -- -c inferenceScope=eu --context frontendDomain=<domain>
# with CDK_DEFAULT_REGION / AWS_REGION set to an EU region, e.g. eu-central-1
```

`inferenceScope` takes `global` (the default) or `eu`. Any other value fails the synth.

## What changes

| Area | `global` (default) | `eu` |
|---|---|---|
| Bedrock calls | `global.` cross-region inference profiles: may be served in any commercial region | `eu.` inference profiles: served only in EU regions |
| IAM | `global.` profile ARNs | **Only** the `eu.` profile ARNs. A stray `global.` call is AccessDenied, not a silent residency breach |
| Stored / allowlisted model ids | Canonical `global.…` | Unchanged (still canonical). The prefix is mapped at call time |
| Web search (AgentCore gateway) | On by default | **Never deployed.** An explicit `-c enableWebSearch=true` throws, because the connector runs only in us-east-1 |
| Persona avatars | Image model in us-west-2 | **Disabled** (`AVATARS_ENABLED=false`); personas have no avatar |
| Anthropic use-case form (`anthropicUseCase`) | Allowed | Still allowed. It is an account-level form submitted in us-east-1, and no inference or customer data passes through it (the synth adds an info annotation) |

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

Checked with
`aws bedrock list-inference-profiles --region eu-central-1 --query "inferenceProfileSummaries[].inferenceProfileId"`
(and the same in eu-west-1; Opus 5.5 and Haiku 5.5 checked in eu-central-1 on 2026-10-08).
Every allowlisted model has an `eu.` profile:

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

## Choosing a region

- Use a region that has the `eu.` Bedrock profiles, Comprehend, Translate and Titan
  Embeddings V2. Frankfurt (`eu-central-1`) and Ireland (`eu-west-1`) are the safe choices.
- Request Bedrock model access in that region.
- Cognito, DynamoDB, S3, Lambda, Step Functions, SQS, API Gateway and KMS all run in the
  deployment region.
- CloudFront is a global edge service. It serves the static SPA and avatar images, not
  feedback data.

## Not verified here

- Bedrock service tiers (`SURFACE_SERVICE_TIERS`) on `eu.` profiles.
- A full EU deploy.

The synth, the IAM grants and the call-time mapping are covered by tests:
`lib/app-inference-scope.test.ts`, `lib/utils/inference-scope.test.ts`,
`lambda/shared/test/test_inference_scope.py` and the stream `model-override.test.ts`.
