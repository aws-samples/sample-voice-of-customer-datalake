/**
 * @fileoverview The icon of a mention kind: everyone (`@all`), one persona, a document, a library item.
 *
 * @module assistant/mentions/MentionIcon
 */
import { FileText, Library, UserRound, Users } from 'lucide-react'
import type { MentionOption } from './mentionModel'

export default function MentionIcon({ kind, size }: Readonly<{ kind: MentionOption['kind']; size: number }>) {
  if (kind === 'all') return <Users size={size} aria-hidden />
  if (kind === 'document') return <FileText size={size} aria-hidden />
  if (kind === 'library') return <Library size={size} aria-hidden />
  return <UserRound size={size} aria-hidden />
}
