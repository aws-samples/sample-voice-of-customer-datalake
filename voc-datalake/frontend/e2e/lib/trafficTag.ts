/**
 * The test traffic tag: every request this suite sends carries the User-Agent token
 * `voc-e2e/<run tag>`, so the API Gateway access log (`userAgent`) and the Lambda logs
 * (`test_run`, lambda/shared/e2e_tag.py) can exclude it from an error sweep. A
 * User-Agent needs no CORS change (a custom header would be preflighted).
 *
 * The run tag is `E2E_TAG_RUN_ID`, pinned ONCE per run by `pinRunTag()` in the config
 * process (`sharedConfig`, and each config that does not use it) and inherited by every
 * worker. Unset, it is the run id (`E2E_RUN_ID`, which names this run's entities), else
 * `<epoch ms>`. run-sharded.sh sets one tag for all its shards, which keep their own run
 * ids. Read lazily from the env (never an import-time constant), so the config process
 * and the workers agree.
 */
import { devices } from '@playwright/test'

/** What a run tag may be (the Lambda side matches the same set, shared/e2e_tag.py). */
export const RUN_TAG_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export const RUN_TAG_ENV = 'E2E_TAG_RUN_ID'

type Env = Record<string, string | undefined>

const nonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/** The run tag `env` names (tag, else run id, else a timestamp), validated. */
export function runTagFrom(env: Readonly<Env>, now: () => number = Date.now): string {
  const tag = nonEmpty(env[RUN_TAG_ENV]) ?? nonEmpty(env['E2E_RUN_ID']) ?? `${now()}`
  if (!RUN_TAG_PATTERN.test(tag)) throw new Error(`${RUN_TAG_ENV} / E2E_RUN_ID must match ${String(RUN_TAG_PATTERN)}`)
  return tag
}

/** Resolves the run tag once and writes it back to `env`, so every worker inherits the same one. */
export function pinRunTag(env: Env = process.env): string {
  const tag = runTagFrom(env)
  env[RUN_TAG_ENV] = tag
  return tag
}

/** `voc-e2e/<run tag>`. Pins the tag on first use, so a process that skipped `pinRunTag` still sends one tag. */
export function trafficToken(env: Env = process.env): string {
  return `voc-e2e/${pinRunTag(env)}`
}

export function taggedUserAgent(base: string, env: Env = process.env): string {
  return `${base} ${trafficToken(env)}`
}

/** The browser contexts' User-Agent (`use.userAgent`): Desktop Chrome + the token. */
export function browserUserAgent(env: Env = process.env): string {
  return taggedUserAgent(devices['Desktop Chrome'].userAgent, env)
}

/** The Node-side User-Agent (direct API calls, APIRequestContext). */
export function nodeUserAgent(env: Env = process.env): string {
  return taggedUserAgent('node', env)
}

/**
 * The statuses a request is EXPECTED to be refused with (a gate, a fake id, a GET after a DELETE): only 4xx. They
 * travel as a second User-Agent token, `voc-e2e-expect/<status>[,<status>]`, which the API access log keeps
 * (`userAgent`), so the log sweep (scripts/ops/log_sweep.py) counts that 4xx as expected and reports every other
 * one. A 2xx, 3xx or 5xx is never declared expected: a 5xx is always a finding.
 */
export type ExpectedStatuses = readonly number[]

/** `voc-e2e-expect/<statuses>`, or null when none are declared; a status outside 400-499 is refused. */
export function expectedStatusToken(expect: ExpectedStatuses = []): string | null {
  if (expect.length === 0) return null
  for (const status of expect) {
    if (!Number.isInteger(status) || status < 400 || status > 499) throw new Error(`an expected status must be a 4xx, got ${String(status)}`)
  }
  return `voc-e2e-expect/${[...new Set(expect)].sort((a, b) => a - b).join(',')}`
}

/** The Node-side User-Agent of a request that declares its expected refusal statuses. */
export function nodeUserAgentExpecting(expect: ExpectedStatuses = [], env: Env = process.env): string {
  const token = expectedStatusToken(expect)
  return token === null ? nodeUserAgent(env) : `${nodeUserAgent(env)} ${token}`
}

/**
 * `fetch` with the tagged User-Agent. Every Node-side request of the suite goes through
 * this (unit/trafficTag.spec.ts fails on a bare `fetch(` in lib/ or tests/). `expect` declares the 4xx statuses this
 * request is meant to be refused with (see `expectedStatusToken`).
 */
export function e2eFetch(input: string | URL, init: RequestInit = {}, options: { expect?: ExpectedStatuses } = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('User-Agent', nodeUserAgentExpecting(options.expect))
  return fetch(input, { ...init, headers })
}
