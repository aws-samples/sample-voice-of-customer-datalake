/**
 * @fileoverview The read-only company-context strip above a project's Product
 * tab (todofeatures §6.1). The Product tab is that project's own context; the
 * company vision, objectives and design system it inherits (and that feed the
 * product report and the autonomous agents) are edited in Knowledge → Company,
 * so this only shows a summary and links there.
 *
 * Quiet on failure: a missing company context must never get in the way of a
 * project's own product work.
 *
 * @module pages/ProjectDetail/CompanyContextStrip
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ArrowRight, Compass } from 'lucide-react'
import { companyContextApi, companyContextKey } from '../../api/companyContextApi'
import { designSystemApi, designSystemKey, isPaintableColor } from '../../api/designSystemApi'

const MAX_OBJECTIVES_SHOWN = 3
const MAX_SWATCHES = 6
const VISION_PREVIEW_CHARS = 180

/** The vision's first non-heading line, without markdown emphasis. */
function visionPreview(vision: string): string {
  const line = vision.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#')) ?? ''
  const plain = line.replaceAll(/[*_`>]/g, '')
  return plain.length > VISION_PREVIEW_CHARS ? `${plain.slice(0, VISION_PREVIEW_CHARS - 1)}…` : plain
}

export default function CompanyContextStrip() {
  const { t } = useTranslation('projectDetail')
  const company = useQuery({ queryKey: companyContextKey(), queryFn: companyContextApi.getCompanyContext })
  const design = useQuery({ queryKey: designSystemKey(), queryFn: designSystemApi.get })
  const vision = visionPreview(company.data?.vision ?? '')
  const objectives = company.data?.objectives ?? []
  // Only values the editor would paint (the same guard as its swatches).
  const colors = (design.data?.tokens.colors ?? []).filter((c) => isPaintableColor(c.value))

  return (
    <section aria-label={t('companyStrip.label')} className="card flex flex-col sm:flex-row sm:items-start gap-3 py-3">
      <Compass size={18} className="text-accent-text flex-shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1 text-sm">
        <p className="font-medium text-text-strong">{t('companyStrip.title')}</p>
        <p className="text-muted">{vision === '' ? t('companyStrip.noVision') : vision}</p>
        {objectives.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {objectives.slice(0, MAX_OBJECTIVES_SHOWN).map((o) => <li key={o.id} className="badge badge-muted">{o.title}</li>)}
            {objectives.length > MAX_OBJECTIVES_SHOWN && (
              <li className="text-[12px] text-muted">{t('companyStrip.more', { n: objectives.length - MAX_OBJECTIVES_SHOWN })}</li>
            )}
          </ul>
        )}
        {colors.length > 0 && (
          <p className="flex items-center gap-1.5 text-[12px] text-muted">
            {t('companyStrip.designSystem')}
            {colors.slice(0, MAX_SWATCHES).map((c) => (
              <span key={c.name} title={`${c.name} ${c.value}`} className="inline-block h-3.5 w-3.5 rounded-sm ring-1 ring-border" style={{ background: c.value }} />
            ))}
          </p>
        )}
      </div>
      <Link to="/company" className="btn btn-secondary btn-sm self-start whitespace-nowrap">
        {t('companyStrip.open')} <ArrowRight size={14} aria-hidden="true" />
      </Link>
    </section>
  )
}
