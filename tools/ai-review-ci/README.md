# AI review on pull requests: the AWS side

Development tooling for this repository, not part of the Voice of Customer platform. Nothing here is deployed with
the solution (`cdk deploy`, `npm run deploy:*`, the workshop packaging): it is one standalone CloudFormation stack a
maintainer deploys by hand into the AWS account that pays for the reviews.

The workflow [`.github/workflows/ai-review.yml`](../../.github/workflows/ai-review.yml) runs the two local AI reviews
of `scripts/validate.sh` (the tenets review, then the code review, see
[CONTRIBUTING.md](../../CONTRIBUTING.md#ai-reviews-in-validatesh)) on every pull request and posts them as one
comment. It reaches Amazon Bedrock with the role this stack creates.

## What the stack creates

[`ai-review-role.json`](ai-review-role.json), two resources:

- **The GitHub OIDC identity provider** (`token.actions.githubusercontent.com`, audience `sts.amazonaws.com`). An
  account holds one per URL: if yours already has it, pass its ARN as `ExistingOidcProviderArn` and none is created.
- **The role `voc-ai-review-github`**, which only the `pull_request` runs of `GitHubRepository` can assume
  (`sub` = `repo:<owner>/<name>:pull_request`, exact match), and which can only call `bedrock:InvokeModel` on three
  models: `ReviewModelId` (Claude Opus 5.5, the one the review asks for) and the two Bedrock may serve a declined
  request with (Opus 5, then Opus 4.8). No other permission, no managed policy.

`scripts/ai-review/ci-role.test.mjs` (part of `scripts/validate.sh`) fails when the trust or the permissions widen.

## Deploy

With credentials for the target account (Bedrock access to the three models in its region):

```bash
aws cloudformation deploy \
  --stack-name voc-ai-review-ci \
  --template-file tools/ai-review-ci/ai-review-role.json \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1
# The account already has a GitHub OIDC provider:
#   --parameter-overrides ExistingOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com
```

Then give the repository the role (a repository admin):

```bash
role_arn="$(aws cloudformation describe-stacks --stack-name voc-ai-review-ci --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='AiReviewRoleArn'].OutputValue" --output text)"
gh secret set AI_REVIEW_ROLE_ARN --repo aws-samples/sample-voice-of-customer-datalake --body "$role_arn"
gh variable set AI_REVIEW_REGION --repo aws-samples/sample-voice-of-customer-datalake --body us-east-1
```

The role ARN is a secret so the account id stays out of the repository and the logs. `AI_REVIEW_MODEL` (default
`global.anthropic.claude-opus-5-5`) is a repository variable too; a different model needs the stack's
`ReviewModelId` changed to match, or Bedrock refuses the call.

## Check it

- The next push to a pull request runs **AI review** → `review`, then `post` writes the comment.
- Anything else is refused: a role assumption from another repository, from a branch push, from a fork, and any AWS
  call other than `InvokeModel` on the three models.
- Without the secret, the workflow skips with a notice, so a fork of this sample stays green.

### What the `review` job's log says

| Log line | Meaning |
| --- | --- |
| `no AI_REVIEW_ROLE_ARN secret in this repository; skipped` (notice) | The secret is not set: nothing ran. |
| `the default branch has no scripts/ai-review/ci-review.mjs yet` (notice) | The reviewer is not on `main` yet (the pull request that adds it). |
| `ai review: skipped: the event is not a pull request with a head SHA` | The event JSON has no pull request, or its head SHA is missing or malformed: nothing ran. |
| `ai review: skipped: refs/pr/base and refs/pr/head have no merge base` | Both refs were fetched but share no commit (unrelated histories): nothing ran. A failed fetch never gets here: the `Review` step does not run. |
| `ai review: nothing to review since <sha>` | The diff is empty once the paths the review skips are left out (secret-shaped files, lockfiles, build output, locales: `REVIEW_PATHSPEC` in `scripts/ai-review/lib.mjs`). |
| `ai review: the diff is the one reviewed at <sha>: no new review` | The push left the diff unchanged (a rebase): no model call, no comment. |
| `REVIEW.md is missing from the trusted checkout` (warning) | `main` has no REVIEW.md: the review runs without its guide. |
| `ai review: round <n> (tenets: <range>, commit: <range>), depth <tier>, <n> repository files, <model>` | The round starts. Each pass reviews the `whole diff` or the `commits since <sha>`; `, diff cut` means the whole diff was over the size cap. Whether a pass's review is partial is said in the comment: in an incremental round the whole diff is context only, so its cut is not a gap. |
| `the <kind> review was not run: <error>` (warning) | That Bedrock call failed; the comment marks the pass as not run and carries its open findings. |
| `ai review: no review was run (see the warnings above): nothing to post` | Both calls failed. With `; open blocking findings carried: <ids>`, an enforced check still fails. |
| `ai review: tenets: PASS` / `ai review: commit: WARN` … | The verdicts posted in the comment (`not run` for a failed pass). |
| `ai review: BLOCK: a complete VIOLATION or MUST-FIX is open (AI_REVIEW_ENFORCED=true)` | Enforced mode only: the check fails. |

The `post` job logs the URL of the comment it posted. `the review produced no postable body` (warning) means GitHub
dropped the output because it held a masked value, such as the account id quoted in a diff.

## Cost and switches

Each push that changes the diff makes two Bedrock calls (more when a long answer is continued), billed to the
account at the model's on-demand price. A push that leaves the diff unchanged makes none. To pause the review,
delete the `AI_REVIEW_ROLE_ARN` secret; to remove it, delete the stack:

```bash
aws cloudformation delete-stack --stack-name voc-ai-review-ci --region us-east-1
```
