/**
 * @fileoverview An owner's gate brief, read only, in the shared document component (X1's `DocumentSurface`, its
 * `panel` variant in read mode: Rendered and Source, Contents): its text read when opened
 * (`GET …/gates/briefs/<id>`, 45–156 KB each). It ships with the templates, so it is never edited here. Loaded lazily
 * by GatePacks.tsx, so the editor does not bring the document engine until a brief is opened.
 *
 * @module components/WorkflowEditor/inspector/GateBriefDocument
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import DocumentSurface from '../../Document/DocumentSurface'
import LoadFailed from '../../LoadFailed/LoadFailed'
import { useGateBrief } from './useFlowSetup'
import type { DocumentAdapter } from '../../Document/types'
import type { GateBrief } from '../../../api/flowSetupApi'

interface StoredBrief { readonly title: string; readonly content: string; readonly digest: string }

/** The owner's brief, in the shared document component (read only: it ships with the templates). */
export default function GateBriefDocument({ brief }: Readonly<{ brief: GateBrief }>) {
  const { t } = useTranslation('agents')
  const read = useGateBrief(brief.id, true)
  const stored = useMemo((): StoredBrief | undefined => (
    read.data === undefined ? undefined : { title: brief.path, content: read.data.text, digest: read.data.digest }
  ), [read.data, brief.path])
  const adapter = useMemo((): DocumentAdapter<StoredBrief> => ({
    id: `gate-brief:${brief.id}`,
    contentType: 'markdown',
    permissions: { edit: 'managedByTemplate' },
    versionOf: (each) => ({ token: each.digest }),
    load: () => Promise.resolve(stored),
  }), [brief.id, stored])
  if (read.isError) return <LoadFailed onRetry={() => { void read.refetch() }} retrying={read.isFetching} />
  return (
    <DocumentSurface adapter={adapter} variant="panel" title={t('inspector.gate.brief', { path: brief.path })} headingLevel={3}
      meta={null} stored={stored} mode="read" compare={null} comments={null} onSaved={ignoreSaved} fullPath={null}
      footer={null} onClose={null} page={null}>
      {null}
    </DocumentSurface>
  )
}

/** A brief is never saved here (it ships with the templates). */
function ignoreSaved(): void {
  // Nothing to select: the brief is read only.
}

