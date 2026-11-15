/**
 * @fileoverview A prototype version's saved walkthrough steps (`GET …/prototypes/{document_id}/walkthrough`), read
 * once per version under the project's key (a save invalidates the project): the editor starts from them, and the
 * assistant's set_prototype_walkthrough card says how many of them a proposal replaces.
 * @module components/PrototypeWalkthrough/useSavedWalkthrough
 */
import { useQuery } from '@tanstack/react-query'
import { projectsApi } from '../../api/projectsApi'
import { walkthroughQueryKey } from './walkthroughSteps'

export function useSavedWalkthrough(projectId: string, documentId: string) {
  return useQuery({
    queryKey: walkthroughQueryKey(projectId, documentId),
    queryFn: () => projectsApi.getPrototypeWalkthrough(projectId, documentId),
  })
}
