/**
 * @fileoverview The Skills tab's library read (7.56.00, `GET /agents/engineering/skill-library`), shared by the list
 * (SkillLibrary.tsx) and a skill's page (SkillLibraryDetail.tsx): one read per page, as it changes only with a release.
 *
 * @module pages/Agents/useSkillLibrary
 */
import { useQuery } from '@tanstack/react-query'
import { engineeringSkillLibraryApi, engineeringSkillLibraryKeys } from '../../api/engineeringSkillLibraryApi'
import { useConfigStore } from '../../store/configStore'

/** The library, read once per page (it changes only with a release). */
export function useSkillLibrary() {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  return useQuery({
    queryKey: engineeringSkillLibraryKeys.list(),
    queryFn: engineeringSkillLibraryApi.list,
    enabled: configured,
    staleTime: Infinity,
  })
}
