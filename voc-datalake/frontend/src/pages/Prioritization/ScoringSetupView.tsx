/**
 * @fileoverview "How scoring works": the read-only view of the workspace scoring setup for
 * everyone who is not an admin — each metric, its share of the priority score and which
 * way is better — plus who last changed it.
 * @module pages/Prioritization/ScoringSetupView
 */
import { useQuery } from '@tanstack/react-query'
import { ArrowDownWideNarrow, ArrowUpWideNarrow } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import DialogClose from '../../components/DialogClose/DialogClose'
import ModalShell from '../../components/ModalShell/ModalShell'
import { SCORING_CONFIG_KEY, prioritizationConfigApi } from '../../api/prioritizationConfigApi'
import type { PrioritizationConfig } from '../../api/prioritizationConfigApi'
import { activeAxes, weightShares } from '../../api/prioritizationAxes'
import type { ScoringAxis } from '../../api/prioritizationAxes'
import { formatDate } from '../../utils/dateUtils'
import { axisText } from './axisText'
import type { ReactElement } from 'react'

/** "Last changed by Ana on Oct 21, 2026", or nothing while the shipped default is in use. */
export function SetupSavedBy({ config }: { readonly config: PrioritizationConfig | undefined }): ReactElement {
  const { t, i18n } = useTranslation('prioritization')
  if (config === undefined) return <span />
  if (config.updatedAt === null) return <p className="text-xs text-muted">{t('setup.neverChanged')}</p>
  return (
    <p className="text-xs text-muted">
      {config.updatedBy === null
        ? t('setup.changedOn', { date: formatDate(config.updatedAt, i18n.language) })
        : t('setup.changedBy', { name: config.updatedBy, date: formatDate(config.updatedAt, i18n.language) })}
    </p>
  )
}

function MetricRow({ axis, share }: { readonly axis: ScoringAxis; readonly share: number }): ReactElement {
  const { t } = useTranslation('prioritization')
  const text = axisText(axis, t)
  const lower = axis.direction === 'lower_better'
  const Icon = lower ? ArrowDownWideNarrow : ArrowUpWideNarrow
  return (
    <li className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-strong break-words">{text.name}</p>
        {text.description === '' ? null : <p className="text-xs text-muted mt-0.5">{text.description}</p>}
        <p className="text-xs text-text mt-1 inline-flex items-center gap-1">
          <Icon size={12} aria-hidden="true" />
          {lower ? t('setup.lowerBetter') : t('setup.higherBetter')}
          <span className="text-muted">· {t('setup.scale', { low: text.lowLabel, high: text.highLabel })}</span>
        </p>
      </div>
      <span className="text-sm font-bold font-mono text-text-strong whitespace-nowrap">{t('setup.share', { share })}</span>
    </li>
  )
}

export default function ScoringSetupView({ onClose }: { readonly onClose: () => void }): ReactElement {
  const { t } = useTranslation('prioritization')
  const titleId = useId()
  const { data, isError } = useQuery({ queryKey: SCORING_CONFIG_KEY, queryFn: () => prioritizationConfigApi.getConfig() })
  const axes = data === undefined ? [] : activeAxes(data.axes)
  const shares = weightShares(axes)
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="max-w-lg max-h-[90vh]">
      <div className="dialog-header justify-between">
        <div className="min-w-0">
          <h2 id={titleId} className="dialog-title">{t('setup.viewTitle')}</h2>
          <p className="dialog-description">{t('setup.viewDescription')}</p>
        </div>
        <DialogClose onClick={onClose} className="flex-shrink-0" />
      </div>
      <div className="dialog-body overflow-y-auto">
        {isError ? <p role="alert" className="text-sm text-danger">{t('setup.loadFailed')}</p> : null}
        {data === undefined && !isError ? (
          <div role="status" aria-label={t('setup.loading')} className="space-y-2">
            {[0, 1, 2].map((n) => <div key={n} className="h-12 rounded-lg bg-bg-hover animate-pulse" />)}
          </div>
        ) : null}
        <ul className="divide-y divide-border">
          {axes.map((axis) => <MetricRow key={axis.id} axis={axis} share={shares[axis.id] ?? 0} />)}
        </ul>
        <p className="text-xs text-muted mt-3">{t('explainer.unscored')}</p>
        <p className="text-xs text-muted mt-1">{t('setup.adminsOnly')}</p>
      </div>
      <div className="dialog-footer justify-between">
        <SetupSavedBy config={data} />
        <button type="button" className="btn btn-secondary" onClick={onClose}>{t('setup.close')}</button>
      </div>
    </ModalShell>
  )
}
