/**
 * @fileoverview What adding people to a list did: how many were added, already there or
 * newly created, and each address refused with its reason.
 * @module pages/Participants/AddResultNotice
 */
import { useTranslation } from 'react-i18next'
import type { AddMembersResult } from '../../api/participantsSchema'
import { rejectReason } from './rejectReason'

export default function AddResultNotice({ result }: Readonly<{ result: AddMembersResult }>) {
  const { t } = useTranslation('participants')
  return (
    <div role="status" className="rounded-md border border-border bg-bg-accent p-2 text-xs text-text space-y-1">
      <p>{t('lists.addResult', { added: result.added, already: result.already, created: result.created })}</p>
      {result.rejected.length === 0 ? null : (
        <ul className="space-y-0.5 text-danger">
          {result.rejected.map((entry) => (
            <li key={entry.email} className="break-all">{entry.email}: {rejectReason(entry.reason, t)}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
