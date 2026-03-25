/**
 * ProjectTabs - Tab navigation for project detail page
 */
import { Users, FileText, MessageSquare, Sparkles, Key } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { Tab } from './types'

const TABS: readonly { id: Tab; labelKey: string; icon: typeof Sparkles }[] = [
  { id: 'overview', labelKey: 'tabs.overview', icon: Sparkles },
  { id: 'personas', labelKey: 'tabs.personas', icon: Users },
  { id: 'documents', labelKey: 'tabs.documents', icon: FileText },
  { id: 'chat', labelKey: 'tabs.aiChat', icon: MessageSquare },
  { id: 'mcp', labelKey: 'tabs.mcpAccess', icon: Key },
]

interface ProjectTabsProps {
  readonly activeTab: Tab
  readonly personasCount: number
  readonly documentsCount: number
  readonly onTabChange: (tab: Tab) => void
}

export default function ProjectTabs({ activeTab, personasCount, documentsCount, onTabChange }: ProjectTabsProps) {
  const { t } = useTranslation('projectDetail')

  return (
    <div className="border-b border-gray-200 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto">
      <nav className="flex gap-4 sm:gap-6 min-w-max">
        {TABS.map(tab => (
          <button 
            key={tab.id} 
            onClick={() => onTabChange(tab.id)} 
            className={clsx(
              'flex items-center gap-1.5 sm:gap-2 py-3 border-b-2 text-xs sm:text-sm font-medium whitespace-nowrap', 
              activeTab === tab.id 
                ? 'border-blue-600 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            <tab.icon size={16} />
            {t(tab.labelKey)} {tab.id === 'personas' && `(${personasCount})`}
            {tab.id === 'documents' && `(${documentsCount})`}
          </button>
        ))}
      </nav>
    </div>
  )
}
