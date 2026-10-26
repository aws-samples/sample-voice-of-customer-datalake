/**
 * @fileoverview A background job that rewrites feedback refreshes the feedback
 * family exactly when a polled job leaves its running state — never for a job
 * first seen already finished.
 */
import { describe, expect, it } from 'vitest'
import { createAppQueryClient } from './queryPolicies'
import { watchFeedbackJobs } from './feedbackDataWatch'
import type { QueryClient } from '@tanstack/react-query'

const SUMMARY = ['summary', { days: 7 }] as const

function watched(): QueryClient {
  const client = createAppQueryClient()
  watchFeedbackJobs(client)
  client.setQueryData(SUMMARY, { total_feedback: 1 })
  return client
}

const summaryStale = (client: QueryClient) => client.getQueryState(SUMMARY)?.isInvalidated === true
const job = (status: string) => ({ job_id: 'rp_1', status })

describe('watchFeedbackJobs', () => {
  it('refreshes when a reprocess job goes from running to completed', () => {
    const client = watched()
    client.setQueryData(['category-reprocess-job'], job('running'))
    expect(summaryStale(client)).toBe(false)
    client.setQueryData(['category-reprocess-job'], job('completed'))
    expect(summaryStale(client)).toBe(true)
  })

  it('does nothing for a job first seen finished (opening the page later)', () => {
    const client = watched()
    client.setQueryData(['category-reprocess-job'], job('completed'))
    expect(summaryStale(client)).toBe(false)
  })

  it('refreshes when one erasure in the list finishes', () => {
    const client = watched()
    client.setQueryData(['erasure-jobs'], [job('completed'), { job_id: 'er_2', status: 'queued' }])
    client.setQueryData(['erasure-jobs'], [job('completed'), { job_id: 'er_2', status: 'running' }])
    expect(summaryStale(client)).toBe(false)
    client.setQueryData(['erasure-jobs'], [job('completed'), { job_id: 'er_2', status: 'completed' }])
    expect(summaryStale(client)).toBe(true)
  })

  it('refreshes when a staged S3 import file is processed', () => {
    const client = watched()
    const files = (status: string) => ({ files: [{ key: 'default/a.json', status }], bucket: 'b' })
    client.setQueryData(['s3-import-files', ''], files('pending'))
    client.setQueryData(['s3-import-files', ''], files('processed'))
    expect(summaryStale(client)).toBe(true)
  })

  it('ignores unrelated queries and malformed job payloads', () => {
    const client = watched()
    client.setQueryData(['projects'], [job('running')])
    client.setQueryData(['projects'], [job('completed')])
    client.setQueryData(['category-reprocess-job'], { unexpected: true })
    expect(summaryStale(client)).toBe(false)
  })
})
