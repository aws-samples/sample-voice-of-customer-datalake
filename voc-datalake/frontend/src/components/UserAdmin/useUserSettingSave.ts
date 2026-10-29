/**
 * @fileoverview The save of a per-user settings panel in Settings → Users (the flags, the ways
 * of working with AI): one mutation that refetches the users list, plus any other key the
 * change moves, once it settles.
 *
 * @module components/UserAdmin/useUserSettingSave
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'
import { usersKey } from '../../api/queryKeys'

export function useUserSettingSave<Change>(save: (change: Change) => Promise<unknown>, alsoRefresh: readonly QueryKey[] = []) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: save,
    onSettled: () => {
      for (const queryKey of [usersKey(), ...alsoRefresh]) void queryClient.invalidateQueries({ queryKey })
    },
  })
}
