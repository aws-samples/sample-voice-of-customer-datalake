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
 * ``projectId`` is null outside a project (the company library offers no promote): the
 * request then refuses before any call, so `/projects//personas/…` can never be sent.
 */
export function usePromotePersona({ projectId, personaId }: Readonly<{ projectId: string | null; personaId: string }>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => projectId === null || projectId === ''
      ? Promise.reject(new Error('Only a project persona can be promoted'))
      : companyPersonasApi.promotePersona(projectId, personaId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: companyPersonasKey() })
      void queryClient.invalidateQueries({ queryKey: copySourcesRootKey() })
    },
  })
}
