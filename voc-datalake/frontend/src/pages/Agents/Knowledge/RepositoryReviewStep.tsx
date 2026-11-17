/**
 * @fileoverview The setup guide's Understand the repository and Tenets steps (7.52.00: their flows have arrived): the
 * repository's knowledge pack to compare and approve (KnowledgeReview.tsx), or its tenets drafts to accept or reject
 * (TenetsReview.tsx), for the deployment's repository connection (a select when there are several). With no
 * connection yet, the step says the prerequisites come first.
 *
 * @module pages/Agents/Knowledge/RepositoryReviewStep
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KnowledgeReview } from './KnowledgeReview'
import { TenetsReview } from './TenetsReview'
import type { EngineeringConnection } from '../../../api/engineeringConnectionsApi'

export function RepositoryReviewStep({ kind, connections }: Readonly<{
  kind: 'knowledge' | 'tenets'; connections: readonly EngineeringConnection[]
}>) {
  const { t } = useTranslation('agents')
  const id = useId()
  const [chosen, setChosen] = useState<string | null>(null)
  const connection = connections.find((each) => each.connection_id === chosen) ?? connections[0]
  if (connection === undefined) {
    return <p className="rounded-md border border-border p-3 text-sm text-muted">{t('knowledge.noConnection')}</p>
  }
  return (
    <div className="space-y-3">
      {connections.length > 1 && (
        <div>
          <label htmlFor={id} className="block text-[12px] font-semibold text-muted">{t('knowledge.repository')}</label>
          <select id={id} className="select w-auto max-w-full" value={connection.connection_id} onChange={(event) => setChosen(event.target.value)}>
            {connections.map((each) => <option key={each.connection_id} value={each.connection_id}>{each.repository}</option>)}
          </select>
        </div>
      )}
      {connections.length === 1 && <p className="text-[12px] text-muted">{t('knowledge.for', { repository: connection.repository })}</p>}
      {kind === 'knowledge'
        ? <KnowledgeReview key={connection.connection_id} connection={connection.connection_id} />
        : <TenetsReview key={connection.connection_id} connection={connection.connection_id} />}
    </div>
  )
}
