/**
 * @fileoverview An owner's gate brief as a document (§6.4 [52] step 5, gap N): the adapter the Registry's Quality
 * gates and the flow editor's gate inspector (7.52 C2) hand DocumentSurface, the hook that reads a brief's text only
 * when it is opened (`GET …/gates/briefs/<id>`: 45-156 KB each, so `GET …/gates` carries none). Its full-page address
 * is registryPaths.ts `gateBriefPath`.
 *
 * A brief is the owner's Markdown, shipped with a release in `templates/orchestration/gates/briefs/`: read only
 * (`managedByTemplate`), named by its digest (a new release, a new token), on the `stored` policy. A brief of 45 KB and
 * more needs its Contents: the page variant gives them, and a panel offers "Open full page".
 *
 * @module pages/Agents/Registry/gateBriefAdapter
 */
import { useQuery } from '@tanstack/react-query'
import { engineeringRegistryApi, engineeringRegistryKeys } from '../../../api/engineeringRegistryApi'
import { retryOnceUnlessNotFound } from '../../../api/apiErrorStatus'
import { unlessGone } from '../documents/readOnly'
import { useConfigStore } from '../../../store/configStore'
import type { DocumentAdapter, StoredDocument } from '../../../components/Document/types'
import type { GateBriefText } from '../../../api/engineeringRegistryApi'

export interface GateBriefDocument extends StoredDocument {
  readonly digest: string
  readonly packs: readonly string[]
}

/** A brief's file name (`python-ts.md`), its title. */
export const briefFileName = (path: string, id: string) => path.split('/').pop() ?? `${id}.md`

export function gateBriefDocumentOf(brief: GateBriefText): GateBriefDocument {
  return {
    title: briefFileName(brief.path, brief.id), content: brief.text, digest: brief.digest, packs: brief.packs,
  }
}

/** The surface's adapter for one brief (`load` reads it again; undefined: no such brief in this release). */
export function gateBriefAdapter(briefId: string): DocumentAdapter<GateBriefDocument> {
  return {
    id: `gate-brief:${briefId}`,
    contentType: 'markdown',
    policy: 'stored',
    permissions: { edit: 'managedByTemplate' },
    versionOf: (stored) => ({ token: stored.digest }),
    load: async () => {
      const brief = await unlessGone(() => engineeringRegistryApi.brief(briefId))
      return brief && gateBriefDocumentOf(brief)
    },
  }
}

/** A brief's text, read once it is opened (`enabled`); cached for the session: a brief changes only with a release. */
export function useGateBrief(briefId: string, enabled = true) {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  return useQuery({
    queryKey: engineeringRegistryKeys.brief(briefId),
    queryFn: async () => gateBriefDocumentOf(await engineeringRegistryApi.brief(briefId)),
    enabled: configured && enabled,
    staleTime: Infinity,
    retry: retryOnceUnlessNotFound,
  })
}
