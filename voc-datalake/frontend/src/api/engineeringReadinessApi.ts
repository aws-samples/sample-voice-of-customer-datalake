/**
 * @fileoverview An engineering automation's readiness (7.50.00; administrators, while the engineering agents are on;
 * docs/autonomous-engineering.md "Readiness"): what a run of it needs, checked before Enable.
 *
 * - `GET /agents/engineering/readiness?automation=<agent id>` (an engineering agent) or `?flow=<template id>` (a flow
 *   not saved yet) → `{subject, ready, checks: [{id, status: pass | fail | warn | unknown, detail, fix, docs,
 *   required}]}`: each check with what it found, how to fix it, where the docs explain it, and whether a run needs it;
 *   `&connection=<id>&language=<language>` (7.50.01) answers for the agent as if it were set up with them, read-only
 *   (the Set up dialog's selection; the setup guide's only connection): a connection not stored or a language with no
 *   image is a 400;
 * - Enable (`POST /agents/<id>/enable`, and a save that turns an engineering agent on) answers 409 `{error, checks}`
 *   with the required checks that do not pass; the client keeps that list on the ApiError (`checks`), and
 *   {@link failingChecksOf} reads it.
 *
 * A status the page does not know reads as `unknown`, and a check that does not say whether it is required as
 * required: neither is ever taken for a pass (the server's 409 is the boundary). Every text is the server's, shown as
 * text; a doc link is followed only when it is the repository's docs or an https address ({@link docsHref}).
 *
 * @module api/engineeringReadinessApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { parseEach } from './lenientFields'
import { ApiError } from '../lib/errors'
import { isRecord } from '../lib/typeGuards'

const CHECK_STATUSES = ['pass', 'fail', 'warn', 'unknown'] as const
export type CheckStatus = (typeof CHECK_STATUSES)[number]

const text = z.string().catch('')
const CheckSchema = z.object({
  id: z.string().min(1),
  status: z.enum(CHECK_STATUSES).catch('unknown'),
  detail: text,
  fix: text,
  docs: text,
  required: z.boolean().catch(true),
})
export type ReadinessCheck = z.output<typeof CheckSchema>

/** The way of working the enabling administrator has stored (connectors/dial.py): set in Administration → Users. */
export const WAY_OF_WORKING_CHECK = 'dial'

/**
 * What the readiness is asked of: a saved engineering agent, or a default flow before it is saved. An agent's
 * `connection` and `language` (7.50.01) ask for it as if it were set up with them; '' or none keeps its own.
 */
export type ReadinessSubject =
  | { readonly automation: string; readonly connection?: string; readonly language?: string }
  | { readonly flow: string }

/** An answer with no list of checks is an error, never "nothing to check" (a false statement). */
export function parseReadiness(raw: unknown): ReadinessCheck[] {
  if (!isRecord(raw) || !Array.isArray(raw.checks)) throw new Error('The readiness answer was unreadable')
  return parseEach(CheckSchema, raw.checks)
}

/** The checks an Enable's 409 named as failing, or null when the error is not one (any other refusal). */
export function failingChecksOf(error: unknown): ReadinessCheck[] | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.checks === undefined) return null
  return parseEach(CheckSchema, error.checks)
}

/** A check that holds Enable: one a run needs that does not pass (an unknown one included: never assumed). */
export const isBlocking = (check: ReadinessCheck): boolean => check.required && check.status !== 'pass'

/** Whether Enable waits: a check a run needs does not pass (a warning, or an advisory check, never holds it). */
export const blocksEnable = (checks: readonly ReadinessCheck[]): boolean => checks.some(isBlocking)

const REPOSITORY_DOCS = 'https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/'
const DOCS_PATH = /^docs\/[a-z0-9-]+\.md(?:#[a-z0-9-]+)?$/u

/**
 * Where a check's doc link goes: a repository doc (`docs/<name>.md#<anchor>`) on the repository's page, an https
 * address as it is; null for anything else (a link the page cannot vouch for is not offered).
 */
export function docsHref(docs: string): string | null {
  const trimmed = docs.trim()
  if (DOCS_PATH.test(trimmed)) return `${REPOSITORY_DOCS}${trimmed}`
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.toString() : null
  } catch {
    return null
  }
}

/** The connection and language an agent's readiness is asked as if set up with (none named: ''). */
function previewOf(subject: ReadinessSubject): { connection: string; language: string } {
  return 'automation' in subject
    ? { connection: subject.connection ?? '', language: subject.language ?? '' }
    : { connection: '', language: '' }
}

function readinessPath(subject: ReadinessSubject): string {
  const params = new URLSearchParams()
  if ('automation' in subject) params.set('automation', subject.automation)
  else params.set('flow', subject.flow)
  const { connection, language } = previewOf(subject)
  if (connection !== '') params.set('connection', connection)
  if (language !== '') params.set('language', language)
  return `/agents/engineering/readiness?${params.toString()}`
}

export const engineeringReadinessKeys = {
  /** One entry per subject; a preview's starts with its agent's, so invalidating the agent's reaches its previews. */
  of: (subject: ReadinessSubject) => {
    const { connection, language } = previewOf(subject)
    const base = ['engineering-readiness', 'automation' in subject ? `automation:${subject.automation}` : `flow:${subject.flow}`]
    return connection === '' && language === '' ? base : [...base, `as:${connection}:${language}`]
  },
}

export const engineeringReadinessApi = {
  checks: async (subject: ReadinessSubject): Promise<ReadinessCheck[]> =>
    parseReadiness(await fetchApi<unknown>(readinessPath(subject))),
}
