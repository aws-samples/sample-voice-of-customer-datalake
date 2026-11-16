/**
 * @fileoverview An engineering automation's readiness as the SPA reads it (api/engineeringReadinessApi.ts): the
 * checks, a status it does not know as unknown and a check that does not say as required (neither ever a pass), an
 * answer without its list an error; the failing checks of an Enable's 409; what holds Enable (a required check that
 * does not pass); which doc links are followed.
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../lib/errors'
import { blocksEnable, docsHref, failingChecksOf, parseReadiness } from './engineeringReadinessApi'

const check = (id: string, status: string, required = true) => ({
  id, status, detail: 'found', fix: 'do this', docs: 'docs/github-issues.md', required,
})

describe('the readiness answer', () => {
  it('keeps each check, a status it does not know as unknown, and one that does not say as required', () => {
    expect(parseReadiness({ subject: {}, ready: false, checks: [check('dial', 'fail'), check('network', 'warn', false),
      { id: 'pack', status: 'later' }, { status: 'pass' }] }))
      .toStrictEqual([
        { id: 'dial', status: 'fail', detail: 'found', fix: 'do this', docs: 'docs/github-issues.md', required: true },
        { id: 'network', status: 'warn', detail: 'found', fix: 'do this', docs: 'docs/github-issues.md', required: false },
        { id: 'pack', status: 'unknown', detail: '', fix: '', docs: '', required: true },
      ])
  })

  it('is an error without its list of checks, never "nothing to check"', () => {
    expect(() => parseReadiness({})).toThrow('The readiness answer was unreadable')
    expect(() => parseReadiness({ checks: 'all good' })).toThrow('The readiness answer was unreadable')
  })

  it('holds Enable while a required check does not pass, an unknown one included', () => {
    const holds = (checks: unknown[]) => blocksEnable(parseReadiness({ checks }))
    expect([holds([]), holds([check('a', 'pass')]), holds([check('a', 'fail')]), holds([check('a', 'unknown')]),
      holds([check('a', 'warn')])]).toStrictEqual([false, false, true, true, true])
  })

  it('never holds Enable for an advisory check, whatever it answers', () => {
    expect(blocksEnable(parseReadiness({ checks: [check('a', 'fail', false), check('b', 'unknown', false), check('c', 'pass')] })))
      .toBe(false)
  })
})

describe('an Enable refused', () => {
  it('reads the failing checks of a 409, and nothing of any other refusal', () => {
    expect(failingChecksOf(new ApiError(409, 'refused', undefined, undefined, [check('ci_attestation', 'fail'), 'junk'])))
      .toStrictEqual([{ id: 'ci_attestation', status: 'fail', detail: 'found', fix: 'do this', docs: 'docs/github-issues.md',
        required: true }])
    expect(failingChecksOf(new ApiError(409, 'This agent already has a run in progress'))).toBeNull()
    expect(failingChecksOf(new ApiError(400, 'refused', undefined, undefined, [check('dial', 'fail')]))).toBeNull()
    expect(failingChecksOf(new Error('offline'))).toBeNull()
  })
})

describe('a check\'s doc link', () => {
  it.each([
    ['docs/autonomous-agents.md#setup-guide',
      'https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/docs/autonomous-agents.md#setup-guide'],
    [' docs/github-issues.md ', 'https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/docs/github-issues.md'],
    ['https://docs.aws.amazon.com/bedrock/', 'https://docs.aws.amazon.com/bedrock/'],
    ['http://example.com/', null],
    ['javascript:alert(1)', null],
    ['https://user:secret@example.com/', null],
    ['docs/../lambda/secret.py', null],
    ['', null],
  ])('%s → %s', (docs, href) => {
    expect(docsHref(docs)).toBe(href)
  })
})
