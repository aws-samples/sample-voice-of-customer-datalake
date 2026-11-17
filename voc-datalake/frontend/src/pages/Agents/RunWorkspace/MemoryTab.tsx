/**
 * @fileoverview The inspector's Memory and Learn tab (7.51.00): the lessons the agent's brief recalled from memory
 * (shown as the data they were to the model), and what Learn made of its task: each lesson, what the skill coach did
 * with it and the skill version it proposed (`…/memory`).
 *
 * @module pages/Agents/RunWorkspace/MemoryTab
 */
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { formatDateTime } from '../../../utils/dateUtils'
import { useAgentMemory } from './useRunWorkspace'

export function MemoryTab({ runId, agent, live }: Readonly<{ runId: string; agent: string; live: boolean }>) {
  const { t, i18n } = useTranslation('agents')
  const memory = useAgentMemory(runId, agent, live)
  if (memory.isLoading) return <div className="skeleton h-24" />
  if (memory.data === undefined) return <LoadFailed onRetry={() => { void memory.refetch() }} retrying={memory.isFetching} />
  const { recalled, learned } = memory.data
  return (
    <div className="space-y-3">
      <section aria-labelledby={`${agent}-recalled`}>
        <h3 id={`${agent}-recalled`} className="text-[12px] font-semibold text-text-strong">{t('runWorkspace.memory.recalled')}</h3>
        {recalled.length === 0
          ? <p className="text-[12px] text-muted">{t('runWorkspace.memory.noneRecalled')}</p>
          : (
            <ul className="mt-1 space-y-1">
              {recalled.map((lesson) => (
                <li key={lesson.name} className="rounded-md bg-bg-accent px-2 py-1 text-[12px]">
                  <span className="font-mono text-muted">{lesson.name}</span>
                  <p className="whitespace-pre-wrap break-words">{lesson.text}</p>
                </li>
              ))}
            </ul>
          )}
      </section>
      <section aria-labelledby={`${agent}-learned`}>
        <h3 id={`${agent}-learned`} className="text-[12px] font-semibold text-text-strong">{t('runWorkspace.memory.learned')}</h3>
        {learned.length === 0
          ? <p className="text-[12px] text-muted">{t('runWorkspace.memory.noneLearned')}</p>
          : (
            <ul className="mt-1 space-y-1">
              {learned.map((outcome) => (
                <li key={outcome.key} className="text-[12px]">
                  <p className="break-words">{outcome.lesson}</p>
                  <p className="text-[12px] text-muted">
                    {t('runWorkspace.memory.coach', { coach: outcome.coach || '—' })}
                    {outcome.proposed_version !== null && ` · ${t('runWorkspace.memory.proposed', { n: outcome.proposed_version })}`}
                    {outcome.at !== null && ` · ${formatDateTime(outcome.at, i18n.language)}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  )
}
