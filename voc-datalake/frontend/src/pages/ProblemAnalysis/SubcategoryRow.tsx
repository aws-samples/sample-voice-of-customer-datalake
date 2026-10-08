import { AlertTriangle, ChevronDown, ChevronRight, Layers } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ProblemRow } from './ProblemRow'
import { buildResolutionKey } from './problemResolution'
import type { SubcategoryGroup } from './problemResolution'

interface SubcategoryRowProps {
  readonly categoryName: string
  readonly subcategoryGroup: SubcategoryGroup
  readonly isExpanded: boolean
  readonly onToggle: () => void
  readonly expandedProblems: Set<string>
  readonly onToggleProblem: (key: string) => void
  readonly onToggleResolved: (key: string, resolved: boolean) => void
  /** Resolution keys with an in-flight toggle — disables only their own
   * button (issue #159: no page-wide lock). */
  readonly pendingKeys?: ReadonlySet<string>
}

export function SubcategoryRow({
  categoryName,
  subcategoryGroup,
  isExpanded,
  onToggle,
  expandedProblems,
  onToggleProblem,
  onToggleResolved,
  pendingKeys,
}: SubcategoryRowProps) {
  const { t } = useTranslation('problemAnalysis')
  const subcategoryKey = `${categoryName}:${subcategoryGroup.subcategory}`

  return (
    <div key={subcategoryKey} className="bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="w-full px-3 sm:px-5 py-2.5 sm:py-3 pl-6 sm:pl-10 flex items-center justify-between hover:bg-bg-hover active:bg-border transition-colors focus-ring text-left"
      >
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          {isExpanded ? (
            <ChevronDown size={16} className="text-muted flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
          ) : (
            <ChevronRight size={16} className="text-muted flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
          )}
          <Layers size={14} className="text-info flex-shrink-0" aria-hidden="true" />
          <span className="font-medium text-text capitalize text-xs sm:text-sm truncate">
            {subcategoryGroup.subcategory.replace(/_/g, ' ')}
          </span>
          <span className="text-xs text-muted hidden sm:inline whitespace-nowrap">
            {t('tree.problems', { count: subcategoryGroup.problems.length })} • {t('tree.reviews', { count: subcategoryGroup.totalItems })}
          </span>
          {subcategoryGroup.urgentCount > 0 && (
            <span className="badge badge-warn font-mono flex-shrink-0" title={t('stats.urgent')}>
              <AlertTriangle size={12} aria-hidden="true" />
              {subcategoryGroup.urgentCount}
            </span>
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="divide-y divide-border">
          {subcategoryGroup.problems.map((problemGroup) => {
            const problemKey = `${categoryName}:${subcategoryGroup.subcategory}:${problemGroup.problem}`
            const resolutionKey = buildResolutionKey(categoryName, subcategoryGroup.subcategory, problemGroup.problem)
            return (
              <ProblemRow
                key={problemKey}
                problemGroup={problemGroup}
                problemKey={problemKey}
                isExpanded={expandedProblems.has(problemKey)}
                onToggle={() => onToggleProblem(problemKey)}
                onToggleResolved={() => onToggleResolved(resolutionKey, !problemGroup.resolved)}
                resolvePending={pendingKeys?.has(resolutionKey) === true}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
