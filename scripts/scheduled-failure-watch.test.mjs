import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { decide, findIssue, issueTitle, messageFor } from './scheduled-failure-watch.mjs'

test('a failing or timed-out scheduled run opens an issue, or comments when one is open', () => {
  assert.equal(decide({ event: 'schedule', conclusion: 'failure', hasOpenIssue: false }), 'open')
  assert.equal(decide({ event: 'schedule', conclusion: 'timed_out', hasOpenIssue: false }), 'open')
  assert.equal(decide({ event: 'schedule', conclusion: 'failure', hasOpenIssue: true }), 'comment')
})

test('a green scheduled run closes the open issue, and does nothing without one', () => {
  assert.equal(decide({ event: 'schedule', conclusion: 'success', hasOpenIssue: true }), 'close')
  assert.equal(decide({ event: 'schedule', conclusion: 'success', hasOpenIssue: false }), 'none')
})

test('non-scheduled runs and cancelled or skipped runs never touch issues', () => {
  for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
    assert.equal(decide({ event, conclusion: 'failure', hasOpenIssue: false }), 'none')
    assert.equal(decide({ event, conclusion: 'success', hasOpenIssue: true }), 'none')
  }
  assert.equal(decide({ event: 'schedule', conclusion: 'cancelled', hasOpenIssue: true }), 'none')
  assert.equal(decide({ event: 'schedule', conclusion: 'skipped', hasOpenIssue: false }), 'none')
})

const run = { workflow: 'dependency audit', conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/1', sha: '0123456789abcdef0123' }

test('messages name the workflow, the short commit and the run link', () => {
  assert.match(messageFor('open', run), /\*\*dependency audit\*\* on `0123456789ab`: failure\. https:\/\/github\.com\/o\/r\/actions\/runs\/1/)
  assert.match(messageFor('open', run), /docs\/dependencies\.md/)
  assert.match(messageFor('comment', run), /^Still failing\./)
  assert.match(messageFor('close', { ...run, conclusion: 'success' }), /^Green again, closing\..*: success\./)
})

test('only an open, bot-created issue with exactly the title matches (not a pull request, not a person)', () => {
  const title = issueTitle('dependency audit')
  const bot = { login: 'github-actions[bot]' }
  const issues = [
    { number: 1, title, user: { login: 'someone' } },
    { number: 2, title, user: bot, pull_request: {} },
    { number: 3, title: `${title} (old)`, user: bot },
    { number: 4, title, user: bot },
  ]
  assert.equal(findIssue(issues, title)?.number, 4)
  assert.equal(findIssue(issues.slice(0, 3), title), undefined)
})
