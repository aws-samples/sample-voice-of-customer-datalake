/**
 * @fileoverview Which threads the margin shows: by author kind, by one persona, resolved or not.
 *
 * @module components/DocumentComments/commentFilters
 */
import { AUTHOR_KINDS } from '../../api/documentReviewSchema'
import type { CommentAuthorKind, CommentThread } from '../../api/documentReviewSchema'

export type AuthorFilter = 'all' | CommentAuthorKind

export interface CommentFilter {
  readonly author: AuthorFilter
  /** One persona's threads only ('' = every persona); read when `author` is `persona`. */
  readonly personaId: string
  readonly showResolved: boolean
}

export const DEFAULT_FILTER: CommentFilter = { author: 'all', personaId: '', showResolved: false }

export function matchesFilter(thread: CommentThread, filter: CommentFilter): boolean {
  if (!filter.showResolved && thread.status === 'resolved') return false
  if (filter.author === 'all') return true
  if (thread.author.kind !== filter.author) return false
  return filter.author !== 'persona' || filter.personaId === '' || thread.author.persona_id === filter.personaId
}

export interface PersonaOption {
  readonly personaId: string
  readonly name: string
}

/** The personas that have threads, in first-seen order. */
export function personaOptions(threads: readonly CommentThread[]): PersonaOption[] {
  const seen = new Map<string, string>()
  for (const thread of threads) {
    const id = thread.author.persona_id
    if (thread.author.kind === 'persona' && id !== undefined && !seen.has(id)) seen.set(id, thread.author.name)
  }
  return [...seen].map(([personaId, name]) => ({ personaId, name }))
}

/** The kinds present, so the filter offers only what exists. */
export function authorKindsPresent(threads: readonly CommentThread[]): CommentAuthorKind[] {
  const kinds = new Set(threads.map((thread) => thread.author.kind))
  return AUTHOR_KINDS.filter((kind) => kinds.has(kind))
}
