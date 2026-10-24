/**
 * @fileoverview The Problem Analysis tree: one card per category, opening onto its
 * subcategories and their problems. Every number carries its unit ("3 urgent",
 * "12 reviews"), never a bare figure.
 * @module pages/ProblemAnalysis/ProblemTree
 */
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { SubcategoryRow } from './SubcategoryRow'
import { UrgentBadge } from './UrgentBadge'
import type { CategoryGroup } from '../../api/problemsApi'

export interface TreeExpansion {
  readonly categories: ReadonlySet<string>
  readonly subcategories: ReadonlySet<string>
  readonly problems: ReadonlySet<string>
  readonly toggleCategory: (key: string) => void
  readonly toggleSubcategory: (key: string) => void
  readonly toggleProblem: (key: string) => void
}

interface ProblemTreeProps {
  readonly groups: readonly CategoryGroup[]
  readonly expansion: TreeExpansion
  readonly onToggleResolved: (key: string, resolved: boolean) => void
  readonly pendingKeys: ReadonlySet<string>
}

function CategoryCard({ group, expansion, onToggleResolved, pendingKeys }: Readonly<{ group: CategoryGroup } & Omit<ProblemTreeProps, 'groups'>>) {
  const { t } = useTranslation('problemAnalysis')
  const labels = useDisplayLabels()
  const open = expansion.categories.has(group.category)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div className="card p-0 overflow-hidden">
      <button
        type="button"
        onClick={() => expansion.toggleCategory(group.category)}
        aria-expanded={open}
        className="w-full px-3 sm:px-5 py-3 sm:py-4 flex items-center justify-between bg-bg-accent hover:bg-bg-hover active:bg-border transition-colors focus-ring text-left"
      >
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <Chevron size={18} className="text-muted flex-shrink-0 sm:w-5 sm:h-5" aria-hidden="true" />
          <span className="font-semibold tracking-tight text-text-strong text-sm sm:text-base min-w-0 break-words">{labels.category(group.category)}</span>
          <span className="text-xs sm:text-sm text-muted hidden sm:inline whitespace-nowrap">
            {t('tree.sub', { count: group.subcategories.length })} • {t('tree.reviews', { count: group.totalItems })}
          </span>
          <UrgentBadge count={group.urgentCount} />
        </div>
      </button>
      {open && (
        <div className="divide-y divide-border">
          {group.subcategories.map((sub) => {
            const key = `${group.category}:${sub.subcategory}`
            return (
              <SubcategoryRow
                key={key}
                categoryName={group.category}
                subcategoryGroup={sub}
                isExpanded={expansion.subcategories.has(key)}
                onToggle={() => expansion.toggleSubcategory(key)}
                expandedProblems={expansion.problems}
                onToggleProblem={expansion.toggleProblem}
                onToggleResolved={onToggleResolved}
                pendingKeys={pendingKeys}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

export function ProblemTree({ groups, ...rest }: ProblemTreeProps) {
  return (
    <div className="space-y-3 sm:space-y-4">
      {groups.map((group) => <CategoryCard key={group.category} group={group} {...rest} />)}
    </div>
  )
}
