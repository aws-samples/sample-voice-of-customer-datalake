import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { Sparkles, History } from 'lucide-react'
import BuilderPage from './pages/BuilderPage'
import JobsPage from './pages/JobsPage'
import JobDetailPage from './pages/JobDetailPage'

function NavLink({ to, children }) {
  const location = useLocation()
  const isActive = location.pathname === to || (to !== '/' && location.pathname.startsWith(to))
  
  return (
    <Link
      to={to}
      className={`px-4 py-2 rounded-lg font-medium transition-colors ${
        isActive
          ? 'bg-primary-100 text-primary-700'
          : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {children}
    </Link>
  )
}

export default function App() {
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <Link to="/" className="flex items-center gap-2">
              <div className="w-10 h-10 bg-gradient-to-br from-primary-500 to-primary-700 rounded-xl flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-white" />
              </div>
              <span className="text-xl font-bold text-gray-900">Artifact Builder</span>
            </Link>
            
            <nav className="flex items-center gap-2">
              <NavLink to="/">
                <span className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4" />
                  Build
                </span>
              </NavLink>
              <NavLink to="/jobs">
                <span className="flex items-center gap-2">
                  <History className="w-4 h-4" />
                  History
                </span>
              </NavLink>
            </nav>
          </div>
        </div>
      </header>
      
      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        <Routes>
          <Route path="/" element={<BuilderPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:jobId" element={<JobDetailPage />} />
        </Routes>
      </main>
    </div>
  )
}
