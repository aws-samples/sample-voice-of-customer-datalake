/**
 * @fileoverview An automation's Rename… and Delete… / Archive… dialogs (7.52.00 C1, useAutomationActions.tsx): its new
 * name (`PUT /agents/{id}` `{name}`), and its archive after a confirmation (`DELETE /agents/{id}`: it stops running
 * and leaves the list; its runs, projects and documents are kept; a run in progress finishes).
 *
 * @module pages/Agents/Automations/AutomationDialogs
 */
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import { NameDialog } from '../../../components/NameDialog/NameDialog'
import { API_AGENT_LIMITS } from '../../../api/agentsApi'
import type { Agent } from '../../../api/agentsApi'
import type { useAgentMutations } from '../useAgents'

/** Whether the removal is the list's Delete or the page's Archive (the same archive on the server). */
export type Removal = 'delete' | 'archive'

/** The rename and removal dialogs. */
export function NameAndRemoval({ agent, open, removal, mutations, onClose, onRemoved }: Readonly<{
  agent: Agent; open: 'rename' | 'remove' | null; removal: Removal; mutations: ReturnType<typeof useAgentMutations>
  onClose: () => void; onRemoved: () => void
}>) {
  const { t } = useTranslation('agents')
  const { update, archive } = mutations
  const list = removal === 'delete'
  return (
    <>
      {open === 'rename' && (
        <NameDialog title={t('list.renameTitle')} label={t('fields.name')} maxLength={API_AGENT_LIMITS.maxNameChars}
          submitLabel={t('list.rename')} initialName={agent.name} saving={update.isPending}
          error={update.isError ? t('list.renameFailed') : undefined}
          onSave={(name) => update.mutate({ name }, { onSuccess: onClose })} onClose={onClose} />
      )}
      <ConfirmModal
        isOpen={open === 'remove'}
        title={list ? t('list.deleteTitle') : t('detail.archiveTitle')}
        message={list ? t('list.deleteMessage', { name: agent.name }) : t('detail.archiveMessage')}
        confirmLabel={list ? t('list.delete') : t('detail.archive')}
        cancelLabel={t('common.cancel')}
        variant={list ? 'danger' : 'warning'}
        isLoading={archive.isPending}
        onConfirm={() => archive.mutate(undefined, { onSuccess: () => { onClose(); onRemoved() } })}
        onCancel={onClose}
      />
    </>
  )
}
