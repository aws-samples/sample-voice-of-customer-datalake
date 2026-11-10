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
 * `fetch` with the tagged User-Agent. Every Node-side request of the suite goes through
 * this (unit/trafficTag.spec.ts fails on a bare `fetch(` in lib/ or tests/).
 */
export function e2eFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('User-Agent', nodeUserAgent())
  return fetch(input, { ...init, headers })
}
