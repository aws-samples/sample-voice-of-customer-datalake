/**
 * @fileoverview Agent approval previews: `update_agent` shows each replaced
 * field before → after (current values from the same query the agent page
 * reads); enable / disable / run / cancel name the agent on screen.
 *
 * @module assistant/approvals/previews/AgentPreviews
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { agentsApi, agentsKeys } from '../../../api/agentsApi'
import { FieldChanges } from './FieldChangesPreview'
import type { AgentActionArgs, CancelAgentRunArgs, UpdateAgentArgs } from '../agentSchemas'

function useAgentRecord(agentId: string) {
  return useQuery({ queryKey: agentsKeys.detail(agentId), queryFn: () => agentsApi.get(agentId), retry: false })
}

function AgentName({ agentId }: Readonly<{ agentId: string }>) {
  const { t } = useTranslation('assistantTools')
  const { data } = useAgentRecord(agentId)
  return (
    <p className="text-sm">
      <span className="text-[12px] font-medium text-muted">{t('preview.agent')}: </span>
      {data?.name ?? agentId}
    </p>
  )
}

export function AgentChangesPreview({ args }: Readonly<{ args: UpdateAgentArgs }>) {
  const { data, isLoading } = useAgentRecord(args.agent_id)
  const current: Record<string, unknown> | undefined = data === undefined ? undefined : { ...data }
  return (
    <div className="space-y-2">
      <AgentName agentId={args.agent_id} />
      <p className="text-sm text-text">{args.change_summary}</p>
      <FieldChanges updates={{ ...args.updates }} current={current} isLoading={isLoading} />
    </div>
  )
}

export function AgentActionPreview({ args }: Readonly<{ args: AgentActionArgs | CancelAgentRunArgs }>) {
  const { t } = useTranslation('assistantTools')
  return (
    <div className="space-y-1">
      <AgentName agentId={args.agent_id} />
      {'run_id' in args && <p className="text-[12px] text-muted font-mono">{t('preview.run')}: {args.run_id}</p>}
    </div>
  )
}
