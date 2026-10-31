/**
 * @fileoverview Data for Knowledge → Company → Personas (5.60): the library list
 * (`GET /company-personas`, with `can_edit` for admins), its background jobs (polled
 * like a project's, see `jobsPollInterval`), the list refetch when a job finishes, and
 * the additive generate start.
 *
 * @module pages/Company/useCompanyPersonas
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { companyPersonaJobsKey, companyPersonasApi, companyPersonasKey } from '../../api/companyPersonasApi'
import { recentlyCompletedJobs } from '../ProjectDetail/jobCompletion'
import { jobsPollInterval } from '../ProjectDetail/useProjectData'
import type { PersonaToolConfig } from '../ProjectDetail/types'
import type { ContextConfig } from '../../components/DataSourceWizard/types'

interface GenerateInput {
  readonly contextConfig: ContextConfig
  readonly personaConfig: PersonaToolConfig
}

/** Mounted only when the API is configured (Company.tsx checks), so its queries are always enabled. */
export function useCompanyPersonas() {
  const queryClient = useQueryClient()
  const { i18n } = useTranslation()
  // A job started here keeps the jobs poll alive until its row is readable (see JOB_START_POLL_WINDOW_MS).
  const [jobStartedAt, setJobStartedAt] = useState<number | null>(null)

  const library = useQuery({ queryKey: companyPersonasKey(), queryFn: companyPersonasApi.list })
  const jobs = useQuery({
    queryKey: companyPersonaJobsKey(),
    queryFn: companyPersonasApi.getJobs,
    // Jobs are read by everyone, but only admins start them: a reader's list only polls while one runs.
    refetchInterval: (query) => jobsPollInterval(query.state.data?.jobs ?? [], jobStartedAt, Date.now()),
  })

  // Refetch the library when a job finishes: each poll tick inside the "recently completed"
  // window brings a new `jobs.data`, and only completions not seen before invalidate the list,
  // once per tick however many there are (a job leaving the window, or dropping out of a
  // truncated list, never does). The set grows by
  // one key per finished job while the page is open: a handful, so it is not pruned.
  const handledCompletions = useRef(new Set<string>())
  useEffect(() => {
    const fresh = recentlyCompletedJobs(jobs.data?.jobs ?? [], Date.now())
      .map((job) => `${job.job_id}@${job.completed_at ?? ''}`)
      .filter((key) => !handledCompletions.current.has(key))
    if (fresh.length === 0) return
    for (const key of fresh) handledCompletions.current.add(key)
    void queryClient.invalidateQueries({ queryKey: companyPersonasKey() })
  }, [jobs.data, queryClient])

  const jobStarted = () => {
    setJobStartedAt(Date.now())
    void queryClient.invalidateQueries({ queryKey: companyPersonaJobsKey() })
  }

  const generate = useMutation({
    mutationFn: ({ contextConfig, personaConfig }: GenerateInput) => companyPersonasApi.generate({
      sources: contextConfig.sources,
      categories: contextConfig.categories,
      sentiments: contextConfig.sentiments,
      days: contextConfig.days,
      persona_count: personaConfig.personaCount,
      custom_instructions: personaConfig.customInstructions,
      response_language: i18n.language,
    }),
    onSuccess: jobStarted,
  })

  return {
    personas: library.data?.personas ?? [],
    canEdit: library.data?.canEdit ?? false,
    isLoading: library.isLoading,
    loadFailed: library.isError,
    jobs: jobs.data?.jobs ?? [],
    jobStarted,
    generate,
  }
}
