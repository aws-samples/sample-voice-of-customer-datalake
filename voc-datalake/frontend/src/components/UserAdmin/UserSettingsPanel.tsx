/**
 * @fileoverview The shell the per-user settings panels of Settings → Users share (the flags,
 * the ways of working with AI): a titled fieldset with its description, a failed save said
 * in words, and one row per user, each saving its own change (`useUserSettingSave`).
 *
 * @module components/UserAdmin/UserSettingsPanel
 */
import { AlertCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { QueryKey } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { CognitoUser } from '../../api/types'
import RefusalAlert from '../../workspace/RefusalAlert'
import type { Refusal } from '../../workspace/workspaceRefusals'
import { useUserSettingSave } from './useUserSettingSave'

/** What a row may do: save a change for its user, and whether a save is in flight. */
interface UserRowEdit<Patch> {
  readonly disabled: boolean
  readonly change: (patch: Patch) => void
}

interface UserSettingsPanelProps<Patch> {
  readonly icon: LucideIcon
  readonly copy: { readonly title: string; readonly description: string; readonly saveFailed: string }
  /** Save one user's change; the users list (and `alsoRefresh`) is refetched once it settles. */
  readonly save: (username: string, patch: Patch) => Promise<unknown>
  readonly alsoRefresh?: readonly QueryKey[]
  readonly users: readonly CognitoUser[]
  /** One user's row (a list item). */
  readonly row: (user: CognitoUser, edit: UserRowEdit<Patch>) => ReactNode
  /** Say the server's refusal instead of `copy.saveFailed` (`workspace/workspaceRefusals.ts`). */
  readonly refusals?: readonly Refusal[]
}

export default function UserSettingsPanel<Patch>({ icon: Icon, copy, save, alsoRefresh, users, row, refusals }: UserSettingsPanelProps<Patch>) {
  const mutation = useUserSettingSave(({ username, patch }: { username: string; patch: Patch }) => save(username, patch), alsoRefresh)
  return (
    // A fieldset, not a heading: the Settings card owns the only section heading.
    <fieldset className="border border-border rounded-lg p-4">
      <legend className="flex items-center gap-2 px-1 text-sm font-semibold tracking-tight text-text-strong">
        <Icon size={14} className="text-accent" /> {copy.title}
      </legend>
      <p className="text-xs text-muted mb-3">{copy.description}</p>
      {mutation.isError && refusals !== undefined ? <RefusalAlert error={mutation.error} refusals={refusals} className="mb-2" /> : null}
      {mutation.isError && refusals === undefined ? (
        <p role="alert" className="text-xs text-danger flex items-center gap-1 mb-2">
          <AlertCircle size={12} /> {copy.saveFailed}
        </p>
      ) : null}
      <ul className="divide-y divide-border">
        {users.map((user) => row(user, {
          disabled: mutation.isPending,
          change: (patch) => mutation.mutate({ username: user.username, patch }),
        }))}
      </ul>
    </fieldset>
  )
}
