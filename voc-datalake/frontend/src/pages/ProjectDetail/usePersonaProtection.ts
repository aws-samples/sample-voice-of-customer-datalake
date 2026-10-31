/**
 * @fileoverview Protect a persona (or release it) so a replace regeneration keeps it
 * (`PUT /projects/{id}/personas/{pid}/protection`, ported from #429 by @aws-bryan).
 *
 * One mutation for the whole Personas tab, with its pending and failed state SCOPED to the
 * persona being saved (bbdc635a): switching to another persona mid-save leaves that one's
 * toggle usable, and switching back still shows the save in flight. The saved state is read
 * back from the project (the refetch after success), never from a click-time copy.
 *
 * @module pages/ProjectDetail/usePersonaProtection
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'

interface ProtectionChange {
  readonly personaId: string
  readonly isProtected: boolean
}

export interface PersonaProtection {
  readonly setProtected: (personaId: string, isProtected: boolean) => void
  /** True while a save for `personaId` is in flight. */
  readonly isPendingFor: (personaId: string) => boolean
  /** True when the last save for `personaId` failed. */
  readonly failedFor: (personaId: string) => boolean
}

export function usePersonaProtection(projectId: string): PersonaProtection {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ personaId, isProtected }: ProtectionChange) =>
      projectsApi.setPersonaProtected(projectId, personaId, isProtected),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKey(projectId) }),
  })
  const isFor = (personaId: string) => mutation.variables?.personaId === personaId
  return {
    setProtected: (personaId, isProtected) => mutation.mutate({ personaId, isProtected }),
    isPendingFor: (personaId) => mutation.isPending && isFor(personaId),
    failedFor: (personaId) => mutation.isError && isFor(personaId),
  }
}
