/**
 * @fileoverview A public repository's licence as GitHub answers it now (`GET /agents/engineering/public-repositories?q=
 * <owner/name>`), not the one stored when it was connected: what a contribution is acknowledged under (7.58.00's
 * ForkLines, and since 7.58.01 the Contribute dialog: the server refuses a licence that is not the current one).
 *
 * @module pages/Agents/useCurrentLicence
 */
import { useQuery } from '@tanstack/react-query'
import { publicRepositoriesApi, publicRepositoriesKeys } from '../../api/publicRepositoriesApi'

/** The repository's licence now (its SPDX id; null for none), undefined while it is read; `failed`: it could not be. */
export function useCurrentLicence(repository: string): { licence: string | null | undefined; failed: boolean } {
  const found = useQuery({
    queryKey: publicRepositoriesKeys.search(repository), queryFn: () => publicRepositoriesApi.search(repository), retry: false,
  })
  if (found.isError) return { licence: undefined, failed: true }
  if (found.data === undefined) return { licence: undefined, failed: false }
  const match = found.data.repositories.find((candidate) => candidate.repository.toLowerCase() === repository.toLowerCase())
  return { licence: match?.licence?.spdx ?? null, failed: false }
}
