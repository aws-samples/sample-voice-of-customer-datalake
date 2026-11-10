/**
 * The "Promote to company" request (admins, 5.60): copies a project persona into the
 * company library. On success the library list and every "Copy from…" source list
 * (whose library part just changed) are refetched.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { companyPersonasApi, companyPersonasKey } from '../../api/companyPersonasApi'
import { copySourcesRootKey } from './useCopyPersonas'

/** Where the promote notice links: Knowledge → Company, Personas tab. */
export const COMPANY_PERSONAS_PATH = '/company?tab=personas'

/**
 * Raised when promote runs outside a project. A programming error, never shown to a person:
 * the button is only offered on a project persona, and the notice shows only a server reason
 * (`serverReason`) or its own translated fallback.
 */
export class NotAProjectPersonaError extends Error {
  constructor() {
    super('usePromotePersona: no project id (promote is only offered on a project persona)')
    this.name = 'NotAProjectPersonaError'
  }
}

/**
 * ``projectId`` is null outside a project (the company library offers no promote): the
 * request then refuses before any call, so `/projects//personas/…` can never be sent.
 */
export function usePromotePersona({ projectId, personaId }: Readonly<{ projectId: string | null; personaId: string }>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => projectId
      ? companyPersonasApi.promotePersona(projectId, personaId)
      : Promise.reject(new NotAProjectPersonaError()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: companyPersonasKey() })
      void queryClient.invalidateQueries({ queryKey: copySourcesRootKey() })
    },
  })
}
