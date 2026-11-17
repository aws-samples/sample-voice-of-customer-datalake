/**
 * @fileoverview The save of one section of the People editor sheet (UserEditorSheet.tsx): each section saves itself,
 * and the sheet says "Saved" once (components/SavedStatus) after any section's save the server accepted, until the
 * next edit in the sheet. A section reports both through {@link SheetSaveReport}; its mutation refetches the users
 * list (and any other key the change moves) once it settles, so the table and the sheet show what is stored.
 *
 * @module components/UserAdmin/useSheetSave
 */
import { createContext, useContext } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'
import { usersKey } from '../../api/queryKeys'

/** What a section tells the sheet: an edit started (the "Saved" goes), or a save landed (optionally in other words). */
export interface SheetSaveReport {
  readonly edited: () => void
  readonly saved: (label?: string) => void
}

/** The sheet's report; null outside a sheet (a section on its own reports nowhere). */
export const SheetSaveContext = createContext<SheetSaveReport | null>(null)

export function useSheetReport(): SheetSaveReport | null {
  return useContext(SheetSaveContext)
}

/** One section's save: an edit as it starts, "Saved" when it succeeds, the users (and `alsoRefresh`) refetched after. */
export function useSheetSave<Change>(save: (change: Change) => Promise<unknown>, alsoRefresh: readonly QueryKey[] = []) {
  const queryClient = useQueryClient()
  const report = useSheetReport()
  return useMutation({
    mutationFn: save,
    onMutate: () => { report?.edited() },
    onSuccess: () => { report?.saved() },
    onSettled: () => {
      for (const queryKey of [usersKey(), ...alsoRefresh]) void queryClient.invalidateQueries({ queryKey })
    },
  })
}
