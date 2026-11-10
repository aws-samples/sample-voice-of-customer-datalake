/**
 * @fileoverview Approval previews of the user-administration write tools.
 * Deterministic: every row is computed from the validated args and ONE fetch
 * of the stored state at render — no model-written prose.
 *
 * - create_user: a fixed table of what is created (email, role, names) and the
 *   note that Cognito emails a temporary password and nothing else is created;
 * - update_user: before → after of the changed fields against the user read
 *   fresh; the fingerprint of that user goes on the shown record, so the
 *   executor refuses if the user changed before approval;
 * - set_user_access: before → after of the categories and sources against the
 *   stored grant, fingerprinted the same way.
 *
 * @module assistant/approvals/previews/UserPreviews
 */
import { useContext, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { categoryAccessApi } from '../../../api/categoryAccessApi'
import { fetchUser } from '../userExecutors'
import { ShownContext, recordAccessBase, recordUserBase } from '../shown'
import { accessFingerprint, proposedAccess, updatedUserRecord, userFingerprint } from '../userSchemas'
import { CardNote, FieldDiff, FieldTable, NothingSavedNote } from './FieldDiff'
import { accessRows, identityRows, userRows } from './userRows'
import type { ShownRecord } from '../shown'
import type { CreateUserArgs, SetUserAccessArgs, UpdateUserArgs } from '../userSchemas'

export function CreateUserPreview({ args }: Readonly<{ args: CreateUserArgs }>) {
  const { t } = useTranslation('assistantTools')
  const created = { username: args.email, email: args.email, given_name: args.given_name ?? '', family_name: args.family_name ?? '', groups: [args.role], enabled: true }
  return (
    <div className="space-y-2">
      <FieldTable rows={identityRows(created, t)} label={t('preview.users.userFields')} />
      <CardNote text={t('preview.users.temporaryPasswordNote')} />
      <NothingSavedNote />
    </div>
  )
}

/**
 * The stored state a diff is computed against, read fresh under a card-local
 * key, with its fingerprint recorded on the shown record (undefined while it is
 * loading or missing, so the executor refuses rather than writes blind).
 */
function useShownBase<T>(key: readonly string[], read: () => Promise<T | undefined>, fingerprint: (value: T) => string,
  record: (shown: ShownRecord, fingerprint: string | undefined) => void) {
  const shown = useContext(ShownContext)
  const query = useQuery({ queryKey: key, queryFn: read, retry: false, staleTime: 0 })
  const { data } = query
  useEffect(() => {
    if (shown !== null) record(shown, data === undefined ? undefined : fingerprint(data))
  }, [shown, data, fingerprint, record])
  return query
}

function NotFound({ username }: Readonly<{ username: string }>) {
  const { t } = useTranslation('assistantTools')
  return <p role="alert" className="text-[12px] text-danger">{t('preview.users.notFound', { username })}</p>
}

export function UpdateUserPreview({ args }: Readonly<{ args: UpdateUserArgs }>) {
  const { t } = useTranslation('assistantTools')
  const { data, isLoading, isError } = useShownBase(
    ['assistant', 'user-preview', args.username], () => fetchUser(args.username), userFingerprint, recordUserBase,
  )
  if (isLoading) return <p className="text-[12px] text-muted">{t('preview.loading')}</p>
  if (isError || data === undefined) return <NotFound username={args.username} />
  return (
    <div className="space-y-2">
      <FieldDiff beforeRows={userRows(data, t)} afterRows={userRows(updatedUserRecord(data, args.updates), t)} />
      <NothingSavedNote />
    </div>
  )
}

export function UserAccessPreview({ args }: Readonly<{ args: SetUserAccessArgs }>) {
  const { t } = useTranslation('assistantTools')
  const { data, isLoading, isError } = useShownBase(
    ['assistant', 'user-access-preview', args.username], () => categoryAccessApi.getUserGrant(args.username), accessFingerprint, recordAccessBase,
  )
  if (isLoading) return <p className="text-[12px] text-muted">{t('preview.loading')}</p>
  if (isError || data === undefined) return <NotFound username={args.username} />
  const { grant, sourceGrant } = proposedAccess(args)
  return (
    <div className="space-y-2">
      <FieldDiff beforeRows={accessRows(data, data.sourceGrant, t)} afterRows={accessRows(grant, sourceGrant ?? data.sourceGrant, t)} />
      <NothingSavedNote />
    </div>
  )
}
