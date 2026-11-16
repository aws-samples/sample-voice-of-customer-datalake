/**
 * @fileoverview The older version the address asks the page to show (`…/documents/<docId>/v/<n>`), read from the
 * History list (the picker's and the History dialog's query, fetched only while one is asked for). The page's own
 * version is never `/v/` (the latest has none), a document edited elsewhere (a decision) has no versions here, and a
 * number the list does not hold names nothing: for each of these the address should drop its `/v/` (`dropVersion`).
 *
 * @module components/DocumentCanvas/page/useOlderVersion
 */
import { useQuery } from '@tanstack/react-query'
import { projectsApi } from '../../../api/projectsApi'
import { documentRevision, documentVersionsKey } from '../../../pages/ProjectDetail/documentEdit'
import { isEditedElsewhere } from '../actions/documentKinds'
import { latestNumber } from '../actions/versionChoices'
import type { ViewedVersion } from './OlderVersion'
import type { ProjectDocument } from '../../../api/types'

export function useOlderVersion(projectId: string, document: ProjectDocument, requested: number | null): {
  readonly viewed: ViewedVersion | null
  readonly dropVersion: boolean
} {
  const own = documentRevision(document) ?? null
  const asked = requested !== null && requested !== own && !isEditedElsewhere(document.document_type) ? requested : null
  const versions = useQuery({
    queryKey: documentVersionsKey(projectId, document.document_id),
    queryFn: () => projectsApi.getDocumentVersions(projectId, document.document_id),
    enabled: asked !== null,
  })
  if (asked === null) return { viewed: null, dropVersion: requested !== null }
  const list = versions.data
  const version = list?.find((candidate) => candidate.version === asked) ?? null
  return {
    viewed: { number: asked, version, latest: list === undefined ? null : latestNumber(list), loadFailed: versions.isError },
    dropVersion: list !== undefined && version === null,
  }
}
