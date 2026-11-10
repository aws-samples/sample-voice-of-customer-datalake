#!/usr/bin/env node
/**
 * Turns a failing SCHEDULED workflow run into one GitHub issue, and closes it when a later scheduled
 * run is green. Run by `.github/workflows/scheduled-failure-watch.yml` on `workflow_run`.
 *
 * Why it exists: a red scheduled run (the weekly dependency audit) has no pull request and no author,
 * so nobody is notified and the failure is easy to miss for weeks. An issue is visible, assignable and
 * searchable.
 *
 * Behaviour, per watched workflow (one fixed issue title each, so repeats never pile up):
 * - scheduled run failed or timed out: open the issue, or comment on the open one with the new run;
 * - scheduled run succeeded and the issue is open: comment and close it;
 * - anything else (push, pull_request, workflow_dispatch, cancelled, skipped runs): do nothing. Only
 *   scheduled runs speak for "the default branch is broken with nobody changing it".
 *
 * Every value describing the run arrives through environment variables and is used as data only (the
 * workflow never interpolates it into shell). The issue is matched on its exact title among the open
 * issues the Actions bot created, so an issue a person opened with the same title is left alone.
 *
 * Limits: it reads at most the 100 newest open issues per page and stops after 10 pages, which is
 * plenty for this repository but not a general search. It never reopens a closed issue: a new failure
 * after a close opens a fresh one, which keeps each incident's history separate.
 *
 * Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL (optional), WATCH_WORKFLOW,
 * WATCH_EVENT, WATCH_CONCLUSION, WATCH_RUN_URL, WATCH_HEAD_SHA.
 */
import { fileURLToPath } from 'node:url'

const FAILED = new Set(['failure', 'timed_out'])
const BOT_LOGIN = 'github-actions[bot]'
const MAX_PAGES = 10

/** The one issue title a workflow's scheduled failures share. */
export const issueTitle = (workflow) => `Scheduled workflow failing: ${workflow}`

/** What to do for one completed run: 'none', 'open', 'comment' (still failing) or 'close'. */
export function decide({ event, conclusion, hasOpenIssue }) {
  if (event !== 'schedule') return 'none'
  if (FAILED.has(conclusion)) return hasOpenIssue ? 'comment' : 'open'
  if (conclusion === 'success' && hasOpenIssue) return 'close'
  return 'none'
}

/** The issue or comment text for an action (`run` = {workflow, conclusion, url, sha}). */
export function messageFor(action, run) {
  const line = `Scheduled run of **${run.workflow}** on \`${run.sha.slice(0, 12)}\`: ${run.conclusion}. ${run.url}`
  if (action === 'open') {
    return [
      line,
      '',
      'This issue is managed by `.github/workflows/scheduled-failure-watch.yml`: later failing scheduled runs',
      'comment here, and the first green scheduled run closes it. How to triage: docs/dependencies.md.',
    ].join('\n')
  }
  if (action === 'comment') return `Still failing. ${line}`
  return `Green again, closing. ${line}`
}

/** The open bot-created issue whose title is exactly `title`, from a page of the issues list API. */
export function findIssue(issues, title) {
  return issues.find((issue) => issue.pull_request === undefined && issue.title === title && issue.user?.login === BOT_LOGIN)
}

function readEnv(env) {
  const names = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'WATCH_WORKFLOW', 'WATCH_EVENT', 'WATCH_CONCLUSION', 'WATCH_RUN_URL', 'WATCH_HEAD_SHA']
  const missing = names.filter((name) => !env[name])
  if (missing.length > 0) throw new Error(`missing environment: ${missing.join(', ')}`)
  return {
    token: env.GITHUB_TOKEN,
    repo: env.GITHUB_REPOSITORY,
    api: env.GITHUB_API_URL || 'https://api.github.com',
    run: { workflow: env.WATCH_WORKFLOW, event: env.WATCH_EVENT, conclusion: env.WATCH_CONCLUSION, url: env.WATCH_RUN_URL, sha: env.WATCH_HEAD_SHA },
  }
}

function client({ token, repo, api }) {
  return async (method, path, body) => {
    const response = await fetch(`${api}/repos/${repo}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
    return response.json()
  }
}

async function openIssue(request, title) {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // No `creator=` filter: the author is checked in findIssue, so a server-side filter that matched
    // nothing (bot logins are spelled differently across GitHub APIs) could not cause duplicates.
    const issues = await request('GET', `/issues?state=open&per_page=100&page=${page}`)
    const found = findIssue(issues, title)
    if (found !== undefined || issues.length < 100) return found
  }
  return undefined
}

async function main(env) {
  const config = readEnv(env)
  const request = client(config)
  const title = issueTitle(config.run.workflow)
  const existing = config.run.event === 'schedule' ? await openIssue(request, title) : undefined
  const action = decide({ event: config.run.event, conclusion: config.run.conclusion, hasOpenIssue: existing !== undefined })
  const text = messageFor(action, config.run)
  if (action === 'open') {
    const created = await request('POST', '/issues', { title, body: text })
    console.log(`opened #${created.number}: ${title}`)
  } else if (action === 'comment' || action === 'close') {
    await request('POST', `/issues/${existing.number}/comments`, { body: text })
    if (action === 'close') await request('PATCH', `/issues/${existing.number}`, { state: 'closed', state_reason: 'completed' })
    console.log(`${action === 'close' ? 'closed' : 'commented on'} #${existing.number}: ${title}`)
  } else {
    console.log(`nothing to do (${config.run.event}, ${config.run.conclusion}, open issue: ${existing !== undefined})`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.env).catch((error) => {
    console.error(`scheduled-failure-watch: ${error.message}`)
    process.exitCode = 1
  })
}
