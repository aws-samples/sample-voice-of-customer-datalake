/**
 * @fileoverview "Build from this PRD" (7.47.00): on a project's PRD, an administrator hands it to an enabled feature
 * engineering agent (Agents: `engineering.feedback_type` `feature_request`, such as the seeded Feature builder), which
 * starts an engineering run of its flow with the PRD as its input (`POST /agents/{id}/run` `{prd: {project_id,
 * document_id}}`; the run's goal names the PRD by its ids) and opens a pull request for review (since 7.50, a draft
 * only when its flow says `pr: draft`; merging stays with a person). This is how the Autonomous Product agent's PRD
 * reaches the builder. Shown only where the engineering module is on, to an
 * administrator, while such an agent is enabled, and never inside a workspace (7.80.00: the agents API builds only the
 * deployment's own PRDs); the run is followed on its run monitor.
 *
 * @module pages/ProjectDetail/BuildFromPrd
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Hammer } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { agentsApi, agentsKeys } from '../../api/agentsApi'
import { isEngineeringAvailable } from '../../runtimeConfig'
import { useIsAdmin } from '../../store/authStore'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import { EngineeringStartError } from '../Agents/EngineeringStartError'
import { featureBuilders } from '../Agents/engineeringAgentRules'
import { engineeringRunPagePath } from '../Agents/workflowPaths'
import type { Agent } from '../../api/agentsApi'

interface PrdRef { readonly projectId: string; readonly documentId: string }

function useBuild({ projectId, documentId }: PrdRef) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (agentId: string) => agentsApi.run(agentId, { prd: { project_id: projectId, document_id: documentId } }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: agentsKeys.list() }) },
  })
}

function ConfirmBuild({ builders, starting, onConfirm, onCancel }: Readonly<{
  builders: readonly Agent[]; starting: boolean; onConfirm: (agentId: string) => void; onCancel: () => void
}>) {
  const { t } = useTranslation('agents')
  const [agentId, setAgentId] = useState(builders.at(0)?.agent_id ?? '')
  const name = builders.find((agent) => agent.agent_id === agentId)?.name ?? ''
  return (
    <ConfirmModal isOpen title={t('prdBuild.title')} message={t('prdBuild.message', { name })}
      confirmLabel={t('prdBuild.confirm')} cancelLabel={t('common.cancel')} variant="info" isLoading={starting}
      onConfirm={() => onConfirm(agentId)} onCancel={onCancel}>
      {builders.length > 1 && (
        <label className="mt-3 block text-sm text-text">
          <span className="block text-[12px] text-muted">{t('prdBuild.agent')}</span>
          <select className="select w-full" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {builders.map((agent) => <option key={agent.agent_id} value={agent.agent_id}>{agent.name}</option>)}
          </select>
        </label>
      )}
      <p className="mt-3 text-[12px] text-muted">{t('prdBuild.inputHint')}</p>
    </ConfirmModal>
  )
}

function BuildButton(prd: Readonly<PrdRef>) {
  const { t } = useTranslation('agents')
  const { data: agents } = useQuery({ queryKey: agentsKeys.list(), queryFn: agentsApi.list })
  const builders = featureBuilders(agents ?? [])
  const [confirming, setConfirming] = useState(false)
  const build = useBuild(prd)
  if (builders.length === 0) return null
  const engineeringRunId = build.data?.engineering_run_id ?? null
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="build-from-prd">
      <button type="button" className="btn btn-secondary btn-sm" disabled={build.isPending}
        onClick={() => { build.reset(); setConfirming(true) }}>
        <Hammer size={14} aria-hidden="true" /> {t('prdBuild.button')}
      </button>
      {engineeringRunId !== null && (
        <Link className="text-[12px] link" to={engineeringRunPagePath(engineeringRunId)}>{t('prdBuild.started')}</Link>
      )}
      {build.isError && <EngineeringStartError error={build.error} />}
      {confirming && (
        <ConfirmBuild builders={builders} starting={build.isPending} onCancel={() => setConfirming(false)}
          onConfirm={(agentId) => build.mutate(agentId, { onSettled: () => setConfirming(false) })} />
      )}
    </div>
  )
}

/** The PRD's "Build from this PRD", or nothing (module doc). */
export default function BuildFromPrd({ projectId, documentId }: Readonly<PrdRef>) {
  const isAdmin = useIsAdmin()
  const workspace = useCurrentWorkspace()
  if (!isAdmin || !isEngineeringAvailable() || workspace !== null) return null
  return <BuildButton projectId={projectId} documentId={documentId} />
}
