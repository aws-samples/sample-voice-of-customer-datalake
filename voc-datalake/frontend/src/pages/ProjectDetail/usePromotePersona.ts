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

export function usePromotePersona({ projectId, personaId }: Readonly<{ projectId: string; personaId: string }>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => companyPersonasApi.promotePersona(projectId, personaId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: companyPersonasKey() })
      void queryClient.invalidateQueries({ queryKey: copySourcesRootKey() })
    },
  })
}
