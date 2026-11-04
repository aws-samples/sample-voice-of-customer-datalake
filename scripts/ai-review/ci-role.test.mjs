// The AWS role of the pull request AI review (tools/ai-review-ci/ai-review-role.json) stays as narrow as it is:
// assumable only by one repository's `pull_request` runs, and able only to invoke the review models. Anyone with
// write access can edit the workflow inside a pull request, so the role, not the workflow, is the limit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_MODEL } from './ci-review.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const template = JSON.parse(readFileSync(join(ROOT, 'tools/ai-review-ci/ai-review-role.json'), 'utf8'))
const workflow = readFileSync(join(ROOT, '.github/workflows/ai-review.yml'), 'utf8')
// The YAML without its comment lines (the header explains why `pull_request_target` is NOT used).
const workflowCode = workflow.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
const role = template.Resources.ReviewRole.Properties
const MODEL_PARAMETERS = ['ReviewModelId', 'FallbackModelId', 'SecondFallbackModelId']

test('the template holds the role and, optionally, the GitHub OIDC provider: nothing else', () => {
  assert.deepEqual(Object.keys(template.Resources).sort(), ['GitHubOidcProvider', 'ReviewRole'])
  assert.equal(template.Resources.GitHubOidcProvider.Condition, 'CreateOidcProvider')
  assert.deepEqual(template.Resources.GitHubOidcProvider.Properties, {
    Url: 'https://token.actions.githubusercontent.com', ClientIdList: ['sts.amazonaws.com'],
  })
  assert.equal(role.ManagedPolicyArns, undefined, 'no managed policy widens the role')
  assert.equal(role.PermissionsBoundary, undefined)
  assert.equal(role.MaxSessionDuration, 3600)
})

test('only the pull_request runs of one repository may assume the role', () => {
  const [statement, ...more] = role.AssumeRolePolicyDocument.Statement
  assert.deepEqual(more, [])
  assert.equal(statement.Effect, 'Allow')
  assert.equal(statement.Action, 'sts:AssumeRoleWithWebIdentity')
  // StringEquals only: a StringLike `repo:*` or a missing `sub` would let any repository on GitHub in.
  assert.deepEqual(statement.Condition, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': { 'Fn::Sub': 'repo:${GitHubRepository}:pull_request' },
    },
  })
  assert.equal(template.Parameters.GitHubRepository.Default, 'aws-samples/sample-voice-of-customer-datalake')
  assert.match(template.Parameters.GitHubRepository.AllowedPattern, /^\^\[A-Za-z0-9_\.-\]\+\/\[A-Za-z0-9_\.-\]\+\$$/)
})

test('the role may invoke the three review models and nothing else', () => {
  const [policy, ...morePolicies] = role.Policies
  assert.deepEqual(morePolicies, [])
  const [statement, ...more] = policy.PolicyDocument.Statement
  assert.deepEqual(more, [])
  assert.equal(statement.Effect, 'Allow')
  assert.equal(statement.Action, 'bedrock:InvokeModel', 'not InvokeModel*, not bedrock:*')
  const templates = statement.Resource.map((resource) => (Array.isArray(resource['Fn::Sub']) ? resource['Fn::Sub'][0] : resource['Fn::Sub']))
  const profile = 'arn:${AWS::Partition}:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/'
  assert.deepEqual(templates, [
    ...MODEL_PARAMETERS.map((name) => `${profile}\${${name}}`),
    ...MODEL_PARAMETERS.map(() => 'arn:${AWS::Partition}:bedrock:*::foundation-model/${Model}'),
  ])
  // The foundation-model ARNs are the same three models, each without its `global.` prefix.
  assert.deepEqual(statement.Resource.slice(3).map((resource) => resource['Fn::Sub'][1].Model['Fn::Select'][1]['Fn::Split']),
    MODEL_PARAMETERS.map((name) => ['global.', { Ref: name }]))
  for (const name of MODEL_PARAMETERS) {
    assert.equal(template.Parameters[name].AllowedPattern, '^global\\.anthropic\\.[a-z0-9.-]+$', `${name} cannot be a wildcard`)
  }
})

test('the model the review asks for is the role\'s, the workflow\'s and the script\'s default, and the app allows all three', () => {
  assert.equal(template.Parameters.ReviewModelId.Default, DEFAULT_MODEL)
  assert.match(workflow, new RegExp(`AI_REVIEW_MODEL: \\$\\{\\{ vars\\.AI_REVIEW_MODEL \\|\\| '${DEFAULT_MODEL.replaceAll('.', '\\.')}' \\}\\}`))
  const allowlist = readFileSync(join(ROOT, 'voc-datalake/lib/utils/model-allowlist.ts'), 'utf8')
  for (const name of MODEL_PARAMETERS) assert.ok(allowlist.includes(`'${template.Parameters[name].Default}'`), `${name} is a known model`)
})

test('the workflow runs on pull_request, never pull_request_target, and only one job may write', () => {
  assert.doesNotMatch(workflowCode, /pull_request_target/)
  assert.match(workflowCode, /^on:\n {2}pull_request:\n/m)
  assert.match(workflowCode, /^permissions: \{\}$/m)
  assert.deepEqual(workflowCode.match(/^ {6}[a-z-]+: write\b.*$/gm), [
    '      id-token: write # the OIDC token exchanged for the Bedrock-only role',
    '      pull-requests: write # the review comment, the only write this workflow makes',
  ])
  assert.equal(workflowCode.match(/secrets\./g).length, 1, 'one secret: the role ARN')
})

test('the workflow skips, not fails, while the default branch has no reviewer, before any AWS call', () => {
  // The pull request that adds the reviewer runs it from `main`, where it does not exist yet (PR #533's first run).
  const guard = workflowCode.indexOf('if [ ! -f "$reviewer" ]; then')
  assert.ok(guard > 0, 'the reviewer-present guard exists')
  assert.ok(guard < workflowCode.indexOf('ACTIONS_ID_TOKEN_REQUEST_URL'), 'the guard runs before the OIDC exchange')
  assert.match(workflowCode, /node "\$reviewer" \\/)
})
