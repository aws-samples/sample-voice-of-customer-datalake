/**
 * @fileoverview One action on a skill version (api/engineeringSkillActionsApi.ts), for the Skills screens: on success
 * every skills read is read again; a 409 saying the version or the current one moved since the screen read it reads
 * them again too and says so; any other refusal (the store's own 409s included) is said in the server's words.
 *
 * @module pages/Agents/useSkillAction
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { engineeringSkillActionsApi } from '../../api/engineeringSkillActionsApi'
import { engineeringSkillsKeys } from '../../api/engineeringSkillsApi'
import { ApiError } from '../../lib/errors'
import type { ActionBody } from '../../api/engineeringSkillActionsApi'
import type { SkillRole } from '../../api/engineeringSkillsApi'

/** How an action failed: it changed meanwhile (reloaded), or another refusal with the server's words. */
export type ActionFailure = { kind: 'changed' } | { kind: 'refused'; message: string } | null

/** How the server starts a 409 for what the screen showed having moved (skills/store.py CHANGED); every other 409 is
 * the store's own refusal (a base no longer current, a benchmark recorded already), said in its words. */
const CHANGED = 'it changed since you opened it'

/** Whether ``error`` says what the screen showed moved before the write. */
const isChanged = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409 && error.message.startsWith(CHANGED)

export function useSkillAction(connection: string, role: SkillRole, version: number, onDone: () => void) {
  const queryClient = useQueryClient()
  const reload = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: engineeringSkillsKeys.all() }),
    queryClient.invalidateQueries({ queryKey: engineeringSkillsKeys.allScorecards() }),
  ])
  const mutation = useMutation({
    mutationFn: ({ body, reason }: { body: ActionBody; reason: string }) =>
      engineeringSkillActionsApi.act(connection, role, version, body, reason),
    onSuccess: async () => {
      await reload()
      onDone()
    },
    onError: async (error) => {
      if (isChanged(error)) await reload()
    },
  })
  return { run: mutation.mutate, pending: mutation.isPending, failure: failureOf(mutation.error) }
}

function failureOf(error: Error | null): ActionFailure {
  if (error === null) return null
  return isChanged(error) ? { kind: 'changed' } : { kind: 'refused', message: error.message }
}
