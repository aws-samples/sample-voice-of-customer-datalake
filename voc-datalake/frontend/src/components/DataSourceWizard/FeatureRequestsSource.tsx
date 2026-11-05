/**
 * @fileoverview The Data Sources step's "Feature requests" card (off by default): requests from the
 * feedback boards as their own evidence, and — once ticked — which boards to read (none picked = every
 * board this person may use; archived boards are never offered).
 *
 * @module components/DataSourceWizard/FeatureRequestsSource
 */
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useEvidenceBoards } from './featureRequestEvidence'
import { FilterChip } from './FilterChip'
import { toggleArrayItem } from './filterChipState'
import { MAX_EVIDENCE_BOARDS } from './types'
import type { ContextConfig } from './types'

function BoardPicker({ selected, onChange }: Readonly<{ selected: readonly string[]; onChange: (ids: string[]) => void }>) {
  const { t } = useTranslation('components')
  const { boards, isLoading, isError } = useEvidenceBoards(true)
  if (isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('dataSourceWizard.featureRequests.loadingBoards')}
      </p>
    )
  }
  if (isError) return <p className="text-sm text-danger">{t('dataSourceWizard.featureRequests.boardsFailed')}</p>
  if (boards.length === 0) return <p className="text-sm text-muted">{t('dataSourceWizard.featureRequests.noBoards')}</p>
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">{t('dataSourceWizard.featureRequests.boardsHint')}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('dataSourceWizard.featureRequests.boards')}>
        {boards.map((board) => (
          <FilterChip key={board.board_id} pressed={selected.includes(board.board_id)} className="px-3 py-1.5 text-sm break-words text-left"
            onToggle={() => onChange(toggleArrayItem(selected, board.board_id, MAX_EVIDENCE_BOARDS))}>
            {board.name}
          </FilterChip>
        ))}
      </div>
    </div>
  )
}

export default function FeatureRequestsSource({ contextConfig, onContextChange }: Readonly<{
  contextConfig: ContextConfig
  onContextChange: (config: ContextConfig) => void
}>) {
  const { t } = useTranslation('components')
  return (
    <div className="rounded-lg border" data-testid="feature-requests-source">
      <label className="flex items-center gap-3 p-3 cursor-pointer hover:bg-bg-hover rounded-lg">
        <input type="checkbox" className="w-4 h-4 accent-accent" checked={contextConfig.useFeatureRequests}
          onChange={(e) => onContextChange({
            ...contextConfig, useFeatureRequests: e.target.checked,
            featureRequestBoardIds: e.target.checked ? contextConfig.featureRequestBoardIds : [],
          })} />
        <div>
          <div className="font-medium">{t('dataSourceWizard.featureRequests.title')}</div>
          <div className="text-sm text-muted">{t('dataSourceWizard.featureRequests.description')}</div>
        </div>
      </label>
      {contextConfig.useFeatureRequests ? (
        <div className="px-3 pb-3">
          <BoardPicker selected={contextConfig.featureRequestBoardIds}
            onChange={(ids) => onContextChange({ ...contextConfig, featureRequestBoardIds: ids })} />
        </div>
      ) : null}
    </div>
  )
}
