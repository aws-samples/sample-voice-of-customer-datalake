/**
 * @fileoverview State behind renaming a conversation in the session list:
 * the shared rename mutation (optimistic list update, 409 told apart) and one
 * row's editing flag plus the pencil's ref (where focus returns).
 *
 * @module assistant/components/useSessionRename
 */
import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { renameSession } from '../sessions/sessionsApi'
import { SESSIONS_QUERY_KEY } from '../sessions/queryKeys'
import type { SessionSummary } from '../sessions/schema'

const CONFLICT = 409

export type RenameFailure = 'busy' | 'failed'

/** The rename mutation shared by every row; a failure puts the list back (refetch) and says why. */
export function useSessionRename(): { rename: (id: string, title: string) => void; failure: RenameFailure | null } {
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<RenameFailure | null>(null)
  const mutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameSession(id, title),
    onMutate: ({ id, title }) => {
      setFailure(null)
      queryClient.setQueryData<SessionSummary[]>(SESSIONS_QUERY_KEY, (list) =>
        list?.map((s) => (s.id === id ? { ...s, title, customTitle: title } : s)))
    },
    onError: (error) => setFailure(apiErrorStatus(error) === CONFLICT ? 'busy' : 'failed'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY }),
  })
  return { rename: (id, title) => mutation.mutate({ id, title }), failure }
}

/** One row's editing state plus the pencil's ref (where focus returns after Enter/Escape). */
export function useRowRename() {
  const [editing, setEditing] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  return { editing, start: () => setEditing(true), stop: () => setEditing(false), buttonRef }
}
