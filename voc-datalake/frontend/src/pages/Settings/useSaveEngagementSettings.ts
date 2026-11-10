/**
 * @fileoverview The partial save of the engagement settings (`PUT /participants/settings`), shared by
 * the participant-email card (Users) and the company domains card (Boards): each sends only its own
 * fields, so neither overwrites the other's. The card owns "Saved." (its form restarts after a save).
 * @module pages/Settings/useSaveEngagementSettings
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import type { SettingsInput } from '../../api/participantsApi'

export function useSaveEngagementSettings(onSavedChange: (saved: boolean) => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: Partial<SettingsInput>) => participantsApi.saveSettings(input),
    onMutate: () => onSavedChange(false),
    onSuccess: () => {
      onSavedChange(true)
      return queryClient.invalidateQueries({ queryKey: participantsKeys.settings() })
    },
  })
}
