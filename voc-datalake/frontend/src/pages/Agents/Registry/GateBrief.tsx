/**
 * @fileoverview An owner's gate brief on the shared document component (§6.4 [52] step 5; gateBriefAdapter.ts):
 *
 * - `GateBriefPanel`: collapsed by default (nothing is read or parsed until it is opened: a brief is 45-156 KB), then
 *   the **panel** variant: its file name, "From the template" in `badge-info` and the packs it is for, the read-only
 *   reason (`managedByTemplate`), Rendered / Source, the text scrolling inside, and **Open full page**. The Registry's
 *   Quality gates use it; so may the flow editor's gate inspector (7.52 C2).
 * - `GateBriefPage`: the **page** variant at `/agents/registry/gates/briefs/<id>`, with its Contents.
 *
 * @module pages/Agents/Registry/GateBrief
 */
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react'
import DocumentSurface from '../../../components/Document/DocumentSurface'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import { briefFileName, gateBriefAdapter, useGateBrief } from './gateBriefAdapter'
import { gateBriefPath, registryPath } from './registryPaths'
import { neverSaved } from '../documents/readOnly'
import type { GateBrief } from '../../../api/engineeringRegistryApi'

/** "From the template · for python, typescript". */
function BriefMeta({ packs }: Readonly<{ packs: readonly string[] }>) {
  const { t } = useTranslation('agents')
  return (
    <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
      <span className="badge badge-info">{t('gates.brief.fromTemplate')}</span>
      {packs.length > 0 && <span>{t('gates.brief.packs', { list: packs.join(', ') })}</span>}
    </p>
  )
}

/** A brief's text on the surface, read once `open`: loading lines, its read failure, or none in this release. The
 * flow editor's gate inspector shows its briefs with it too (7.52.00 C2's GatePacks.tsx). */
export function BriefSurface({ brief, variant, headingLevel, open }: Readonly<{
  brief: Pick<GateBrief, 'id' | 'path' | 'packs'>; variant: 'panel' | 'page'; headingLevel: 1 | 2 | 3; open: boolean
}>) {
  const { t } = useTranslation('agents')
  const read = useGateBrief(brief.id, open)
  if (apiErrorStatus(read.error) === 404) return <p className="text-sm text-muted">{t('gates.brief.missing', { id: brief.id })}</p>
  if (read.isError) return <LoadFailed message={t('gates.brief.failed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />
  return (
    <DocumentSurface adapter={gateBriefAdapter(brief.id)} variant={variant} title={briefFileName(brief.path, brief.id)}
      headingLevel={headingLevel} meta={<BriefMeta packs={read.data?.packs ?? brief.packs} />} stored={read.data} mode="read"
      compare={null} comments={null} onSaved={neverSaved} fullPath={variant === 'panel' ? gateBriefPath(brief.id) : null}
      footer={null} onClose={null} page={null}>
      {null}
    </DocumentSurface>
  )
}

/** The brief behind a disclosure ("The owner's brief · python-ts.md · 45 KB"), then the panel once opened. */
export function GateBriefPanel({ brief, headingLevel = 3 }: Readonly<{ brief: GateBrief; headingLevel?: 1 | 2 | 3 }>) {
  const { t, i18n } = useTranslation('agents')
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const kb = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 }).format(brief.bytes / 1024)
  const Icon = open ? ChevronDown : ChevronRight
  return (
    <div className="space-y-2">
      <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((was) => !was)}>
        <Icon size={14} aria-hidden="true" />
        {t('gates.brief.toggle', { file: briefFileName(brief.path, brief.id), kb })}
      </button>
      <div id={panelId} hidden={!open} className="rounded-lg border border-border p-3">
        {open && <BriefSurface brief={brief} variant="panel" headingLevel={headingLevel} open />}
      </div>
    </div>
  )
}

/** A brief on a page of its own (`/agents/registry/gates/briefs/<id>`), with Contents, and back to Quality gates. */
export function GateBriefPage({ briefId, search }: Readonly<{ briefId: string; search: string }>) {
  const { t } = useTranslation('agents')
  return (
    <div className="space-y-3">
      <Link to={{ pathname: registryPath({ view: 'gates' }), search }} className="btn btn-ghost btn-sm w-fit">
        <ArrowLeft size={14} aria-hidden="true" /> {t('gates.brief.back')}
      </Link>
      <BriefSurface brief={{ id: briefId, path: `${briefId}.md`, packs: [] }} variant="page" headingLevel={2} open />
    </div>
  )
}
