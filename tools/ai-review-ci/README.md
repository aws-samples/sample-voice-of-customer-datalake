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

## Cost and switches

Each push that changes the diff makes two Bedrock calls (more when a long answer is continued), billed to the
account at the model's on-demand price. A push that leaves the diff unchanged makes none. To pause the review,
delete the `AI_REVIEW_ROLE_ARN` secret; to remove it, delete the stack:

```bash
aws cloudformation delete-stack --stack-name voc-ai-review-ci --region us-east-1
```
