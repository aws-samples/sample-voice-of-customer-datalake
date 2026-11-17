/**
 * @fileoverview People → a person's editor: the account actions, each through a confirmation (ConfirmModal) — send a
 * password reset, disable or enable sign-in — and the editor's foot, "Delete {{name}}…". What an action did is said in
 * the sheet's one status line until the next edit (useSheetSave.ts); a failed one says so in words where it was asked.
 * @module components/UserAdmin/UserAccountActions
 */
import { useTranslation } from 'react-i18next'
import { Key, Trash2, UserCheck, UserX } from 'lucide-react'
import type { CognitoUser } from '../../api/types'
import ConfirmModal from '../ConfirmModal/ConfirmModal'
import SheetSection from './SheetSection'
import { ACCOUNT_COPY_KEYS } from './useAccountAction'
import type { AccountState } from './useAccountAction'
import { displayName } from './userFacts'

/** The failed action is said where it was asked: the section's buttons, or the foot's Delete. */
function failedHere(state: AccountState, atFoot: boolean): boolean {
  return state.mutation.isError && (state.mutation.variables === 'delete') === atFoot
}

function Confirmation({ user, state }: Readonly<{ user: CognitoUser; state: AccountState }>) {
  const { t } = useTranslation('components')
  const { asking, mutation } = state
  if (asking === null) return null
  const copy = ACCOUNT_COPY_KEYS[asking]
  return (
    <ConfirmModal isOpen title={t(copy.titleKey)} message={t(copy.messageKey, { email: user.email || user.username })}
      confirmLabel={t(copy.confirmKey)} variant={asking === 'delete' ? 'danger' : 'info'} isLoading={mutation.isPending}
      onConfirm={() => mutation.mutate(asking)} onCancel={state.cancel} />
  )
}

/** Reset password and disable or enable sign-in, with the one confirmation they and the foot's Delete share. */
export function AccountSection({ user, state }: Readonly<{ user: CognitoUser; state: AccountState }>) {
  const { t } = useTranslation('components')
  return (
    <SheetSection title={t('userAdmin.editor.sections.account')} hint={t('userAdmin.editor.accountHint')}
      error={failedHere(state, false) ? t('userAdmin.editor.actionFailed') : null}>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => state.ask('reset')}>
          <Key size={14} aria-hidden="true" /> {t('userAdmin.editor.resetPassword')}
        </button>
        {user.enabled ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => state.ask('disable')}>
            <UserX size={14} aria-hidden="true" /> {t('userAdmin.editor.disable')}
          </button>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => state.ask('enable')}>
            <UserCheck size={14} aria-hidden="true" /> {t('userAdmin.editor.enable')}
          </button>
        )}
      </div>
      <Confirmation user={user} state={state} />
    </SheetSection>
  )
}

/** The editor's foot: "Delete {{name}}…" (confirmed in AccountSection's dialog). */
export function DeleteAction({ user, state }: Readonly<{ user: CognitoUser; state: AccountState }>) {
  const { t } = useTranslation('components')
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className="btn btn-danger btn-sm" onClick={() => state.ask('delete')}>
        <Trash2 size={14} aria-hidden="true" /> {t('userAdmin.editor.delete', { name: displayName(user) })}
      </button>
      {failedHere(state, true) ? <p role="alert" className="text-xs text-danger">{t('userAdmin.editor.actionFailed')}</p> : null}
    </div>
  )
}
