/**
 * @fileoverview The project record for approval previews, read through the SAME
 * react-query entry the Project Detail page uses (`projectKey`), so a preview on
 * the project page costs no request and a preview elsewhere warms that page.
 *
 * @module assistant/approvals/previews/useProjectDetail
 */
import { useQuery } from '@tanstack/react-query'
import { projectKey } from '../../../api/projectQueryKeys'
import { projectsApi } from '../../../api/projectsApi'

export function useProjectDetail(projectId: string) {
  return useQuery({
    queryKey: projectKey(projectId),
    queryFn: () => projectsApi.getProject(projectId),
    enabled: projectId !== '',
    retry: false,
  })
}
