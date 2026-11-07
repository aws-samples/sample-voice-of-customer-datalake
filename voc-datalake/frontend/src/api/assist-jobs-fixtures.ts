/**
 * @fileoverview Test fixtures for the api/assistJobs.ts specs: a start answer, an identity result parser
 * and a poll stub.
 */
import { vi } from 'vitest'

/** What an assist route answers when it starts a job (202). */
export const STARTED = { success: true, job_id: 'job_1', status: 'pending' }

/** A result parser that keeps the result as it is. */
export const identity = (result: unknown) => result

/** A poll stub answering `answers` in order, then repeating the last one. */
export function pollAnswers(...answers: unknown[]) {
  const poll = vi.fn<(jobId: string) => Promise<unknown>>()
  answers.forEach((answer) => poll.mockResolvedValueOnce(answer))
  poll.mockResolvedValue(answers.at(-1))
  return poll
}
