/**
 * ProjectTabs - Tab navigation for project detail page
 */
import { Users, FileText, MessageSquare, Sparkles } from 'lucide-react'
import clsx from 'clsx'
import type { Tab } from './types'

const TABS: readonly { id: Tab; label: string; icon: typeof Sparkles }[] = [
  { id: 'overview', label: 'Overview', icon: Sparkles },
  { id: 'personas', label: 'Personas', icon: Users },
  { id: 'documents', label: 'Documents', icon: FileText },
  { id: 'chat', label: 'AI Chat', icon: MessageSquare },
]

interface ProjectTabsProps {
  readonly activeTab: Tab
  readonly personasCount: number
  readonly documentsCount: number
  readonly onTabChange: (tab: Tab) => void
}

export default function ProjectTabs({ activeTab, personasCount, documentsCount, onTabChange }: ProjectTabsProps) {
  return (
    <div className="border-b border-gray-200 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto">
      <nav className="flex gap-4 sm:gap-6 min-w-max">
        {TABS.map(t => (
          <button 
            key={t.id} 
            onClick={() => onTabChange(t.id)} 
            className={clsx(
              'flex items-center gap-1.5 sm:gap-2 py-3 border-b-2 text-xs sm:text-sm font-medium whitespace-nowrap', 
              activeTab === t.id 
                ? 'border-blue-600 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            <t.icon size={16} />
            {t.label} {t.id === 'personas' && `(${personasCount})`}
            {t.id === 'documents' && `(${documentsCount})`}
          </button>
        ))}
      </nav>
    </div>
  )
}
