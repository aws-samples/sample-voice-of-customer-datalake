/**
 * @fileoverview The PR/FAQ jobs that "Draft PR/FAQ" started from the project's
 * decisions, read from the project's jobs list (the same cache entry the page's
 * jobs panel polls, so a finishing job updates the card). Read only when some
 * decision has seeded a job.
 *
 * Jobs come from DynamoDB records with no schema on the client, so each one is
 * normalised leniently here: a malformed job is skipped, not trusted.
 *
 * @module pages/ProjectDetail/decisions/useSeededPrfaqs
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { projectsApi } from '../../../api/projectsApi'
import { projectJobsKey } from '../../../api/projectQueryKeys'
import type { Decision } from '../../../api/decisionSchema'

const SeededJobSchema = z.object({
  job_id: z.string().min(1),
  status: z.enum(['pending', 'running', 'completed', 'failed']).catch('pending'),
  result: z.object({
    document_id: z.string().min(1).optional().catch(undefined),
    title: z.string().optional().catch(undefined),
  }).nullish().catch(null).transform((result) => result ?? {}),
})
export type SeededJob = z.output<typeof SeededJobSchema>

const JobsAnswerSchema = z.object({ jobs: z.array(z.unknown()).catch([]) }).catch({ jobs: [] })

function jobsById(answer: unknown): ReadonlyMap<string, SeededJob> {
  return new Map(JobsAnswerSchema.parse(answer).jobs.flatMap((job): Array<[string, SeededJob]> => {
    const parsed = SeededJobSchema.safeParse(job)
    return parsed.success ? [[parsed.data.job_id, parsed.data]] : []
  }))
}

/** The job each decision seeded, by job id (empty until the jobs list is read). */
export function useSeededPrfaqs(projectId: string, decisions: readonly Decision[]): ReadonlyMap<string, SeededJob> {
  const seeded = decisions.some((decision) => decision.seededPrfaqJobId !== null)
  const { data } = useQuery({
    queryKey: projectJobsKey(projectId),
    queryFn: () => projectsApi.getJobs(projectId),
    enabled: seeded,
  })
  return useMemo(() => jobsById(data), [data])
}
