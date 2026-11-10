/**
 * @fileoverview How a person is named in a row: the name when there is one (else the
 * email), and a secondary line with what the first line did not show.
 * @module pages/Participants/personLabel
 */
import type { Person } from '../../api/participantsSchema'

type Named = Pick<Person, 'name' | 'email' | 'company'>

export function displayName(person: Pick<Person, 'name' | 'email'>): string {
  return person.name === '' ? person.email : person.name
}

export function secondaryLine(person: Named): string {
  const parts = person.name === '' ? [person.company] : [person.email, person.company]
  return parts.filter((part) => part !== '').join(' · ')
}
