import { useState } from 'react'
import { ChevronDown, ChevronRight, Layers } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { ProblemRow } from './ProblemRow'
import { UrgentBadge } from './UrgentBadge'
import { buildResolutionKey } from './problemResolution'
import type { SubcategoryGroup } from '../../api/problemsApi'

/** Problems a subcategory shows at a time. */
const PROBLEMS_PAGE = 10

interface SubcategoryRowProps {
  readonly categoryName: string
  readonly subcategoryGroup: SubcategoryGroup
  readonly isExpanded: boolean
  readonly onToggle: () => void
  readonly expandedProblems: ReadonlySet<string>
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
  const labels = useDisplayLabels()
  const subcategoryKey = `${categoryName}:${subcategoryGroup.subcategory}`
  // A long subcategory opens on its first problems, with "Show more" for the rest.
  const [shown, setShown] = useState(PROBLEMS_PAGE)
  const problems = subcategoryGroup.problems.slice(0, shown)
  const remaining = subcategoryGroup.problems.length - problems.length

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
          <Layers size={14} className="text-muted flex-shrink-0" aria-hidden="true" />
          <span className="font-medium text-text text-xs sm:text-sm min-w-0 break-words">
            {labels.subcategory(subcategoryGroup.subcategory, categoryName)}
          </span>
          <span className="text-xs text-muted hidden sm:inline whitespace-nowrap">
            {t('tree.problems', { count: subcategoryGroup.problemCount })} • {t('tree.reviews', { count: subcategoryGroup.totalItems })}
          </span>
          <UrgentBadge count={subcategoryGroup.urgentCount} />
        </div>
      </button>

      {isExpanded && (
        <div className="divide-y divide-border">
          {problems.map((problemGroup) => {
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
          {remaining > 0 && (
            <div className="px-3 sm:px-5 py-2 pl-10 sm:pl-16">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShown((n) => n + PROBLEMS_PAGE)}>
                {t('tree.showMoreProblems', { count: Math.min(remaining, PROBLEMS_PAGE), total: remaining })}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
