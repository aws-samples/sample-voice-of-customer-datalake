/**
 * @fileoverview The account actions of a person's editor (password reset, disable, enable, delete): the one being
 * confirmed, the mutation that runs it once confirmed, and what the sheet's status line says when it went through
 * (UserAccountActions.tsx renders them).
 * @module components/UserAdmin/useAccountAction
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { usersKey } from '../../api/queryKeys'
import type { CognitoUser } from '../../api/types'
import type { SheetSaveReport } from './useSheetSave'

type AccountAction = 'reset' | 'disable' | 'enable' | 'delete'

interface ActionCopy {
  readonly titleKey: string
  readonly messageKey: string
  readonly confirmKey: string
  readonly doneKey: string
}

/** Each action's confirmation and what the status line says once it went through (its keys spelled out for i18n). */
export const ACCOUNT_COPY_KEYS: Readonly<Record<AccountAction, ActionCopy>> = {
  reset: { titleKey: 'components:userAdmin.resetPassword', messageKey: 'components:userAdmin.confirmReset', confirmKey: 'components:userAdmin.sendResetEmail', doneKey: 'components:userAdmin.passwordResetSent' },
  disable: { titleKey: 'components:userAdmin.disableUser', messageKey: 'components:userAdmin.confirmDisable', confirmKey: 'components:userAdmin.disable', doneKey: 'components:userAdmin.userDisabled' },
  enable: { titleKey: 'components:userAdmin.enableUser', messageKey: 'components:userAdmin.confirmEnable', confirmKey: 'components:userAdmin.enable', doneKey: 'components:userAdmin.userEnabled' },
  delete: { titleKey: 'components:userAdmin.deleteUser', messageKey: 'components:userAdmin.confirmDelete', confirmKey: 'components:userAdmin.delete', doneKey: 'components:userAdmin.userDeleted' },
}

const RUN: Readonly<Record<AccountAction, (username: string) => Promise<{ success: boolean; message: string }>>> = {
  reset: (username) => api.resetUserPassword(username),
  disable: (username) => api.disableUser(username),
  enable: (username) => api.enableUser(username),
  delete: (username) => api.deleteUser(username),
}

async function run(action: AccountAction, username: string): Promise<void> {
  const answer = await RUN[action](username)
  if (!answer.success) throw new Error(answer.message)
}

/**
 * The action being confirmed, and the mutation that runs it once confirmed (shared by the section and the foot);
 * `report` is the sheet's status line (the sheet calls this outside its own report's provider).
 */
export function useAccountAction(user: CognitoUser, onDeleted: (said: string) => void, report: SheetSaveReport) {
  const { t } = useTranslation('components')
  const queryClient = useQueryClient()
  const [asking, setAsking] = useState<AccountAction | null>(null)
  const mutation = useMutation({
    mutationFn: (action: AccountAction) => run(action, user.username),
    onSuccess: (_answer, action) => {
      void queryClient.invalidateQueries({ queryKey: usersKey() })
      if (action === 'delete') onDeleted(t(ACCOUNT_COPY_KEYS.delete.doneKey))
      else report.saved(t(ACCOUNT_COPY_KEYS[action].doneKey))
    },
    onSettled: () => { setAsking(null) },
  })
  const ask = (action: AccountAction) => {
    report.edited()
    mutation.reset()
    setAsking(action)
  }
  return { asking, ask, cancel: () => setAsking(null), mutation }
}

export type AccountState = ReturnType<typeof useAccountAction>
