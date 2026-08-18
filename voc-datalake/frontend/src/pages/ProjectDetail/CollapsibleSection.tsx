/**
 * CollapsibleSection - Reusable collapsible card used across the MCP Access tab.
 * Provides a consistent collapsed/expanded toggle with chevron and label.
 */
import {
  ChevronDown, ChevronRight,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'

interface CollapsibleSectionProps {
  readonly title: string
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly children: ReactNode
}

export default function CollapsibleSection({
  title, expanded, onToggle, children,
}: CollapsibleSectionProps) {
  const { t } = useTranslation('projectDetail')

  return (
    <div className="bg-white border rounded-lg">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 rounded-lg text-left"
      >
        <h4 className="font-medium text-sm text-gray-700 flex items-center gap-2">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {title}
        </h4>
        <span className="text-xs text-gray-400">
          {expanded ? t('mcp.collapseLabel') : t('mcp.expandLabel')}
        </span>
      </button>
      {expanded ? (
        <div className="border-t px-4 pb-4 pt-3">
          {children}
        </div>
      ) : null}
    </div>
  )
}
