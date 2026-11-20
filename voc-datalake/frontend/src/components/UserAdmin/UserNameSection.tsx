/**
 * @fileoverview People → a person's editor → their name (the Cognito given and family names, `PUT /users/{username}`),
 * saved with its own "Save name". An edited name is under the shared unsaved-changes guard: closing the sheet is a
 * move to `/admin/access/users`, so the router's blocker asks before the edit is lost (Save, Discard or Cancel).
 * @module components/UserAdmin/UserNameSection
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Save } from 'lucide-react'
import { api } from '../../api/client'
import { usersKey } from '../../api/queryKeys'
import type { CognitoUser } from '../../api/types'
import { useUnsavedChangesGuard } from '../UnsavedChangesGuard/useUnsavedChangesGuard'
import NameFields from './NameFields'
import SheetSection from './SheetSection'
import { useSheetReport } from './useSheetSave'

/** `PUT /users/{username}` answers `{success: false, message}` for a refusal it explains: a failed save. */
async function saveName(username: string, given: string, family: string): Promise<boolean> {
  const answer = await api.updateUser(username, { given_name: given, family_name: family })
  if (!answer.success) throw new Error(answer.message)
  return true
}

const errorText = (error: unknown): string | null => (error instanceof Error && error.message !== '' ? error.message : null)

/** The two name fields as typed, what is stored, and the save. */
function useNameDraft(user: CognitoUser) {
  const queryClient = useQueryClient()
  const report = useSheetReport()
  const storedGiven = user.given_name ?? ''
  const storedFamily = user.family_name ?? ''
  const [givenName, setGivenName] = useState(storedGiven)
  const [familyName, setFamilyName] = useState(storedFamily)
  const save = useMutation({
    mutationFn: () => saveName(user.username, givenName, familyName),
    onSuccess: () => {
      report?.saved()
      void queryClient.invalidateQueries({ queryKey: usersKey() })
    },
  })
  // (until the refetch brings the stored name, a save that landed leaves nothing unsaved)
  const dirty = (givenName !== storedGiven || familyName !== storedFamily) && !save.isSuccess
  const edit = (apply: (value: string) => void) => (value: string) => {
    report?.edited()
    save.reset()
    apply(value)
  }
  const discard = () => { setGivenName(storedGiven); setFamilyName(storedFamily) }
  const hasName = givenName.trim() !== '' || familyName.trim() !== ''
  return { givenName, familyName, setGiven: edit(setGivenName), setFamily: edit(setFamilyName), discard, dirty, hasName, save }
}

export default function UserNameSection({ user }: Readonly<{ user: CognitoUser }>) {
  const { t } = useTranslation('components')
  const draft = useNameDraft(user)
  const { save } = draft
  const guard = useUnsavedChangesGuard({ dirty: draft.dirty, canSave: draft.hasName, onSave: () => save.mutateAsync(), onDiscard: draft.discard })
  const failed = save.isError ? errorText(save.error) ?? t('userAdmin.editor.nameFailed') : null
  return (
    <SheetSection title={t('userAdmin.editor.sections.name')} error={failed}>
      <div className="grid gap-3 sm:grid-cols-2">
        <NameFields givenName={draft.givenName} familyName={draft.familyName}
          onGivenNameChange={draft.setGiven} onFamilyNameChange={draft.setFamily} />
      </div>
      <button type="button" className="btn btn-secondary btn-sm" disabled={!draft.dirty || !draft.hasName || save.isPending}
        onClick={() => save.mutate()}>
        {save.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
        {t('userAdmin.editor.saveName')}
      </button>
      {guard.dialog}
    </SheetSection>
  )
}
