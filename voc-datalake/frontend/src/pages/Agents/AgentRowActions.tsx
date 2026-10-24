/**
 * @fileoverview Rename and Delete on a row of the agent list (admins).
 *
 * - **Rename** asks for a new name (`PUT /agents/{id}` `{name}`; nothing else changes).
 * - **Delete** asks first, then archives the agent (`DELETE /agents/{id}`): it is
 *   disabled and leaves the list; its runs, projects and documents are kept (an
 *   agent is never erased), and a run in progress finishes.
 *
 * Both sit beside the row's link, not inside it: a link cannot hold buttons.
 *
 * @module pages/Agents/AgentRowActions
 */
import { useState } from 'react'
import { Loader2, Pencil, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { NameDialog } from '../../components/NameDialog/NameDialog'
import { API_AGENT_LIMITS } from '../../api/agentsApi'
import { useAgentMutations } from './useAgents'
import type { Agent } from '../../api/agentsApi'

export function AgentRowActions({ agent }: Readonly<{ agent: Agent }>) {
  const { t } = useTranslation('agents')
  const { update, archive } = useAgentMutations(agent.agent_id)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  return (
    <div className="flex flex-col items-end justify-center gap-1">
      <div className="flex items-center gap-1">
      <button type="button" className="icon-btn" title={t('list.rename')} aria-label={t('list.renameNamed', { name: agent.name })}
        onClick={() => { update.reset(); setRenaming(true) }}>
        <Pencil size={16} aria-hidden="true" />
      </button>
      <button type="button" className="icon-btn hover:text-danger" title={t('list.delete')} disabled={archive.isPending}
        aria-label={t('list.deleteNamed', { name: agent.name })} onClick={() => { archive.reset(); setDeleting(true) }}>
        {archive.isPending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
      </button>
      </div>
      {archive.isError && <p role="alert" className="text-[12px] text-danger">{t('list.deleteFailed')}</p>}
      {renaming && (
        <NameDialog title={t('list.renameTitle')} label={t('fields.name')} maxLength={API_AGENT_LIMITS.maxNameChars}
          submitLabel={t('list.rename')} initialName={agent.name} saving={update.isPending}
          error={update.isError ? t('list.renameFailed') : undefined}
          onSave={(name) => update.mutate({ name }, { onSuccess: () => setRenaming(false) })}
          onClose={() => setRenaming(false)} />
      )}
      <ConfirmModal
        isOpen={deleting}
        title={t('list.deleteTitle')}
        message={t('list.deleteMessage', { name: agent.name })}
        confirmLabel={t('list.delete')}
        cancelLabel={t('common.cancel')}
        variant="danger"
        onConfirm={() => { archive.mutate(); setDeleting(false) }}
        onCancel={() => setDeleting(false)}
      />
    </div>
  )
}
