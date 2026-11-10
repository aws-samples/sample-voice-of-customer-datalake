/**
 * @fileoverview One person in a list of people (a list's members, a project's linked people):
 * the name (or email), what else is known, their status, and an optional per-row action.
 * @module pages/Participants/PersonRow
 */
import type { ReactNode } from 'react'
import type { Person } from '../../api/participantsSchema'
import { PersonStatusBadge } from './ParticipantBadges'
import { displayName, secondaryLine } from './personLabel'

export default function PersonRow({ person, action }: Readonly<{ person: Person; action?: ReactNode }>) {
  const detail = secondaryLine(person)
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
      <span className="min-w-0 flex-1 text-sm text-text-strong break-words">
        {displayName(person)}
        {detail === '' ? null : <span className="block text-xs text-muted break-all">{detail}</span>}
      </span>
      <PersonStatusBadge status={person.status} />
      {action}
    </li>
  )
}
