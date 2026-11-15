/**
 * @fileoverview "Revise from comments" on the client (docs/document-review.md): the pass is an assist
 * job polled on the project job route and its result goes through the normaliser (an ungrounded change
 * is dropped, an unknown outcome is refused); marking (or clearing) threads addressed posts on the
 * saved version's path and answers the threads with their `addressed` mark.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetFetchApi, routeFetchApi as route, sentFetchApiBody } from '@test/fetchApiRoutes'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { appDocumentCommentsApi } = await import('./documentReviewApi')
const { parseCommentsAnswer, parseReviseResult } = await import('./documentReviewSchema')

const THREAD = 'dc_00000000000000000001abcdef'
const RESULT = {
  outcome: 'proposal', base_document_id: 'prd_3', base_version: 3,
  recommendations: [{ thread_id: THREAD, text: 'Add the urgent-order exception.' }],
  changes: [
    { change_id: 'ch_1', thread_ids: [THREAD], before: 'Quiet hours', after: 'Quiet hours, except urgent orders', reason: 'Asked' },
    { change_id: 'ch_2', thread_ids: [THREAD], before: '', after: 'x' },
  ],
  applied_version: null, addressed_thread_ids: [], dropped: 1,
}

function sentBody(path: string): unknown {
  return sentFetchApiBody(path, 'POST')
}

beforeEach(() => {
  resetFetchApi()
})

describe('reviseFromComments', () => {
  it('starts the pass with the chosen threads and resolves with the normalised result', async () => {
    route({
      'POST /projects/proj_1/documents/prd_3/revise-from-comments': () => ({ success: true, job_id: 'job_r', status: 'pending' }),
      'GET /projects/proj_1/jobs/job_r': () => ({ job_id: 'job_r', status: 'completed', result: RESULT }),
    })

    const result = await appDocumentCommentsApi.reviseFromComments('proj_1', 'prd_3', [THREAD])

    expect(sentBody('/projects/proj_1/documents/prd_3/revise-from-comments')).toStrictEqual({ thread_ids: [THREAD] })
    expect(result.outcome).toBe('proposal')
    expect(result.changes.map((c) => c.change_id)).toStrictEqual(['ch_1'])
    expect(result.dropped).toBe(1)
  })

  it('carries the polled job id (a save of the proposal names it: revise_job_id), over one the result claims', async () => {
    route({
      'POST /projects/proj_1/documents/prd_3/revise-from-comments': () => ({ success: true, job_id: 'job_t', status: 'pending' }),
      'GET /projects/proj_1/jobs/job_t': () => ({ job_id: 'job_t', status: 'completed', result: { ...RESULT, job_id: 'job_other' } }),
    })

    const result = await appDocumentCommentsApi.reviseFromComments('proj_1', 'prd_3')

    expect(result.job_id).toBe('job_t')
  })

  it('sends an empty body for every waiting thread', async () => {
    route({
      'POST /projects/proj_1/documents/prd_3/revise-from-comments': () => ({ success: true, job_id: 'job_s', status: 'pending' }),
      'GET /projects/proj_1/jobs/job_s': () => ({
        job_id: 'job_s', status: 'completed',
        result: { ...RESULT, outcome: 'applied', applied_version: { document_id: 'prd_4', version: 4 }, addressed_thread_ids: [THREAD] },
      }),
    })

    const result = await appDocumentCommentsApi.reviseFromComments('proj_1', 'prd_3')

    expect(sentBody('/projects/proj_1/documents/prd_3/revise-from-comments')).toStrictEqual({})
    expect(result.applied_version).toStrictEqual({ document_id: 'prd_4', version: 4 })
    expect(result.addressed_thread_ids).toStrictEqual([THREAD])
  })
})

describe('markAddressed and clearAddressed', () => {
  it('posts the threads on the saved version (the server reads its number), and answers the marked threads', async () => {
    route({
      'POST /projects/proj_1/documents/prd_4/comments/addressed': () => ({
        threads: [{ comment_id: THREAD, addressed: { version: 4, at: '2026-11-12T00:00:00Z', by_kind: 'user' } }, { nope: 1 }],
      }),
    })

    const threads = await appDocumentCommentsApi.markAddressed('proj_1', 'prd_4', [THREAD])

    expect(sentBody('/projects/proj_1/documents/prd_4/comments/addressed')).toStrictEqual({ thread_ids: [THREAD], addressed: true })
    expect(threads.map((t) => [t.comment_id, t.addressed?.version])).toStrictEqual([[THREAD, 4]])
  })

  it('clears the mark on the restored version and answers the threads unmarked', async () => {
    route({
      'POST /projects/proj_1/documents/prd_5/comments/addressed': () => ({ threads: [{ comment_id: THREAD, addressed: null }] }),
    })

    const threads = await appDocumentCommentsApi.clearAddressed('proj_1', 'prd_5', [THREAD])

    expect(sentBody('/projects/proj_1/documents/prd_5/comments/addressed')).toStrictEqual({ thread_ids: [THREAD], addressed: false })
    expect(threads.map((t) => [t.comment_id, t.addressed])).toStrictEqual([[THREAD, null]])
  })
})

describe('the revise and addressed shapes', () => {
  it('refuses a result without a known outcome', () => {
    expect(() => parseReviseResult({ ...RESULT, outcome: 'rewrite' }, 'job_1')).toThrow('Unexpected response')
  })

  it('falls back field by field', () => {
    const result = parseReviseResult({ outcome: 'recommendations', changes: 'x', base_version: 'v3' }, 'job_1')
    expect(result).toStrictEqual({
      outcome: 'recommendations', base_document_id: '', base_version: null, recommendations: [], changes: [],
      applied_version: null, addressed_thread_ids: [], dropped: 0, job_id: 'job_1',
    })
  })

  it('reads a thread without an addressed mark as null and an unreadable one as null', () => {
    const answer = parseCommentsAnswer({ threads: [
      { comment_id: 'a' },
      { comment_id: 'b', addressed: { version: 'four' } },
      { comment_id: 'c', addressed: { version: 2, by_kind: 'robot' } },
    ] })
    expect(answer.threads.map((t) => t.addressed)).toStrictEqual([null, null, { version: 2, at: '', by_kind: 'user' }])
  })
})
