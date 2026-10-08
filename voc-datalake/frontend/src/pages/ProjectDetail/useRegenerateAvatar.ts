/**
 * Regenerate one persona's avatar from the persona detail (QA s3 F3: the route
 * existed but nothing in the UI called it).
 *
 * The new URL is shown straight from the answer, so the detail updates without
 * waiting for the project refetch; the refetch then refreshes the persona list.
 * The answer names a NEW key per image, so this is never the CDN's cached copy.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'

export function useRegenerateAvatar(projectId: string, personaId: string) {
  const queryClient = useQueryClient()
  // Keyed by persona, so selecting another persona never shows this one's image.
  const [fresh, setFresh] = useState<{ personaId: string; url: string } | null>(null)
  const mutation = useMutation({
    mutationFn: () => projectsApi.regeneratePersonaAvatar(projectId, personaId),
    onSuccess: ({ avatar_url: url }) => {
      if (url !== null) setFresh({ personaId, url })
      void queryClient.invalidateQueries({ queryKey: projectKey(projectId) })
    },
  })
  return {
    regenerate: () => mutation.mutate(),
    isPending: mutation.isPending,
    failed: mutation.isError,
    avatarUrl: fresh?.personaId === personaId ? fresh.url : undefined,
  }
}
