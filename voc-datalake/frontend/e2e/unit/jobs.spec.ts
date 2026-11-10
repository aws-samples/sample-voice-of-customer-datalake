/** `followJob` (lib/jobs.ts) stops on the first answer polling cannot change. */
import { expect, test } from '@playwright/test'
import { pollEnds } from '../lib/jobs'

test('a gone job or project (404 / 410) and a refused session (401 / 403) end the follow at once', () => {
  for (const status of [401, 403, 404, 410]) expect(pollEnds(status, ''), String(status)).toBe(true)
})

test('a terminal job status ends it; a running job and a transient error keep polling', () => {
  expect(pollEnds(200, 'completed')).toBe(true)
  expect(pollEnds(200, 'failed')).toBe(true)
  expect(pollEnds(200, 'running')).toBe(false)
  expect(pollEnds(200, 'pending')).toBe(false)
  expect(pollEnds(502, '')).toBe(false)
  expect(pollEnds(429, '')).toBe(false)
})
