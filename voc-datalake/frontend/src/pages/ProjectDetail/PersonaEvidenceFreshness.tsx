/**
 * @fileoverview "N new matching reviews since ‹date›" in a project persona's header, and **Refresh evidence**
 * (docs/project-workspace.md → Persona focus groups): the reviews of the persona's categories, within the project's
 * filters, that arrived since it was generated or its evidence was last refreshed, of those the person may see.
 * Refreshing (edit access) adds them to the persona's evidence (`evidence_updates`, who, when and which reviews); it
 * never rewrites the persona, which stays the generation's to redo. Manual only: nothing refreshes on its own.
 *
 * @module pages/ProjectDetail/PersonaEvidenceFreshness
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw } from 'lucide-react'
import { personaGroundingApi } from '../../api/personaGroundingApi'
import { projectKey } from '../../api/projectQueryKeys'
import { formatDate } from '../../utils/dateUtils'

const personaEvidenceKey = (projectId: string, personaId: string) => ['persona-evidence', projectId, personaId] as const

/** The badge's words: up to date, or how many new reviews (at least that many when the count was cut short). */
function freshnessKey(count: number, lowerBound: boolean): string {
  if (count === 0) return 'personas.evidence.upToDate'
  return lowerBound ? 'personas.evidence.atLeastNew' : 'personas.evidence.new'
}

export default function PersonaEvidenceFreshness({ projectId, personaId, canEdit }: Readonly<{
  projectId: string; personaId: string; canEdit: boolean
}>) {
  const { t, i18n } = useTranslation('projectDetail')
  const queryClient = useQueryClient()
  const key = personaEvidenceKey(projectId, personaId)
  const freshness = useQuery({ queryKey: key, queryFn: () => personaGroundingApi.getEvidenceFreshness(projectId, personaId) })
  const refresh = useMutation({
    mutationFn: () => personaGroundingApi.refreshEvidence(projectId, personaId),
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: key }), queryClient.invalidateQueries({ queryKey: projectKey(projectId) })])
    },
  })
  const data = freshness.data
  if (data === undefined || data.since === '') return null
  const since = formatDate(data.since, i18n.language)
  const line = t(freshnessKey(data.count, data.count_is_lower_bound), { count: data.count, date: since })
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs" data-testid="persona-evidence-freshness">
      <span className={data.count === 0 ? 'text-muted' : 'badge badge-info'}>{line}</span>
      {canEdit && data.count > 0 && (
        <button type="button" className="btn btn-ghost btn-sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw size={12} aria-hidden />}
          {t('personas.evidence.refresh')}
        </button>
      )}
      {refresh.isSuccess && <span className="text-muted" role="status">{t('personas.evidence.added', { count: refresh.data.added })}</span>}
      {refresh.isError && <span className="text-danger" role="alert">{t('personas.evidence.refreshFailed')}</span>}
    </div>
  )
}
