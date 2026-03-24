import { ChevronDown, ChevronRight, Layers } from 'lucide-react'
import { ProblemRow } from './ProblemRow'
import { generateProblemId } from './problemUtils'
import type { FeedbackItem } from '../../api/client'

interface ProblemGroup {
  problem: string
  similarProblems: string[]
  rootCause: string | null
  items: FeedbackItem[]
  avgSentiment: number
  urgentCount: number
}

interface SubcategoryGroup {
  subcategory: string
  problems: ProblemGroup[]
  totalItems: number
  urgentCount: number
}

interface SubcategoryRowProps {
  readonly categoryName: string
  readonly subcategoryGroup: SubcategoryGroup
  readonly isExpanded: boolean
  readonly onToggle: () => void
  readonly expandedProblems: Set<string>
  readonly onToggleProblem: (key: string) => void
  readonly resolvedProblemIds?: Set<string>
  readonly resolvingProblemId?: string | null
  readonly onResolveProblem?: (problemKey: string, category: string, subcategory: string, problemText: string) => void
  readonly onUnresolveProblem?: (problemKey: string) => void
}

export function SubcategoryRow({
  categoryName,
  subcategoryGroup,
  isExpanded,
  onToggle,
  expandedProblems,
  onToggleProblem,
  resolvedProblemIds,
  resolvingProblemId,
  onResolveProblem,
  onUnresolveProblem,
}: SubcategoryRowProps) {
  const subcategoryKey = `${categoryName}:${subcategoryGroup.subcategory}`

  return (
    <div key={subcategoryKey} className="bg-white">
      <button
        onClick={onToggle}
        className="w-full px-3 sm:px-6 py-2.5 sm:py-3 pl-6 sm:pl-10 flex items-center justify-between hover:bg-gray-50 active:bg-gray-100 transition-colors"
      >
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          {isExpanded ? (
            <ChevronDown size={16} className="text-gray-400 flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
          ) : (
            <ChevronRight size={16} className="text-gray-400 flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
          )}
          <Layers size={12} className="text-blue-500 flex-shrink-0 sm:w-[14px] sm:h-[14px]" />
          <span className="font-medium text-gray-700 capitalize text-xs sm:text-sm truncate">
            {subcategoryGroup.subcategory.replace(/_/g, ' ')}
          </span>
          <span className="text-xs text-gray-500 hidden xs:inline whitespace-nowrap">
            {subcategoryGroup.problems.length} problems • {subcategoryGroup.totalItems} reviews
          </span>
          {subcategoryGroup.urgentCount > 0 && (
            <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded-full flex-shrink-0">
              {subcategoryGroup.urgentCount}
            </span>
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="divide-y divide-gray-50">
          {subcategoryGroup.problems.map((problemGroup) => {
            const problemKey = `${categoryName}:${subcategoryGroup.subcategory}:${problemGroup.problem}`
            const problemId = generateProblemId(categoryName, subcategoryGroup.subcategory, problemGroup.problem)
            return (
              <ProblemRow
                key={problemKey}
                problemGroup={problemGroup}
                problemKey={problemKey}
                isExpanded={expandedProblems.has(problemKey)}
                onToggle={() => onToggleProblem(problemKey)}
                isResolved={resolvedProblemIds?.has(problemId)}
                isResolving={resolvingProblemId === problemId}
                onResolve={() => onResolveProblem?.(problemId, categoryName, subcategoryGroup.subcategory, problemGroup.problem)}
                onUnresolve={() => onUnresolveProblem?.(problemId)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
