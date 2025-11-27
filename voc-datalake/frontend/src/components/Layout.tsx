import { useState } from 'react'
import { Outlet, NavLink } from 'react-router-dom'
import { LayoutDashboard, MessageSquare, FolderOpen, Settings, Bot, AlertTriangle, GitBranch, Globe, PanelLeftClose, PanelLeft, Briefcase, SearchX } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api, getDaysFromRange } from '../api/client'
import { useConfigStore } from '../store/configStore'
import TimeRangeSelector from './TimeRangeSelector'
import Breadcrumbs from './Breadcrumbs'
import clsx from 'clsx'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/feedback', icon: MessageSquare, label: 'Feedback' },
  { to: '/categories', icon: FolderOpen, label: 'Categories' },
  { to: '/problems', icon: SearchX, label: 'Problem Analysis' },
  { to: '/chat', icon: Bot, label: 'AI Chat' },
  { to: '/projects', icon: Briefcase, label: 'Projects' },
  { to: '/pipelines', icon: GitBranch, label: 'Pipelines' },
  { to: '/scrapers', icon: Globe, label: 'Scrapers' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export default function Layout() {
  const { timeRange, config } = useConfigStore()
  const days = getDaysFromRange(timeRange)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  
  const { data: urgentData } = useQuery({
    queryKey: ['urgent', days],
    queryFn: () => api.getUrgentFeedback({ days, limit: 10 }),
    enabled: !!config.apiEndpoint,
  })

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className={clsx(
        'bg-gray-900 text-white flex flex-col flex-shrink-0 transition-[width] duration-200',
        sidebarCollapsed ? 'w-16' : 'w-64'
      )}>
        <div className={clsx('p-4 flex items-center', sidebarCollapsed ? 'justify-center' : 'justify-between')}>
          {!sidebarCollapsed && (
            <div>
              <h1 className="text-lg font-bold">VoC Analytics</h1>
              <p className="text-gray-400 text-xs mt-0.5">{config.brandName || 'Configure brand'}</p>
            </div>
          )}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        
        <nav className={clsx('flex-1', sidebarCollapsed ? 'px-2' : 'px-4')}>
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              title={sidebarCollapsed ? label : undefined}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 py-2.5 rounded-lg mb-1 transition-colors',
                  sidebarCollapsed ? 'justify-center px-2' : 'px-4',
                  isActive ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800'
                )
              }
            >
              <Icon size={20} />
              {!sidebarCollapsed && (
                <>
                  <span>{label}</span>
                  {to === '/feedback' && urgentData && urgentData.count > 0 && (
                    <span className="ml-auto bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">
                      {urgentData.count}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        
        {/* Urgent alerts */}
        {!sidebarCollapsed && urgentData && urgentData.count > 0 && (
          <div className="p-4 border-t border-gray-800">
            <div className="flex items-center gap-2 text-orange-400 mb-2">
              <AlertTriangle size={16} />
              <span className="text-sm font-medium">Urgent Issues</span>
            </div>
            <p className="text-gray-400 text-xs">
              {urgentData.count} items need attention
            </p>
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <header className="bg-white border-b border-gray-200 px-6 py-4 flex-shrink-0">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Voice of the Customer</h2>
              <p className="text-sm text-gray-500 mt-0.5">Unified customer feedback intelligence platform</p>
            </div>
            <TimeRangeSelector />
          </div>
          <Breadcrumbs />
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-auto p-6">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
