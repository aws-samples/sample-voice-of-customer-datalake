import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Feedback from './pages/Feedback'
import FeedbackDetail from './pages/FeedbackDetail'
import Categories from './pages/Categories'
import Settings from './pages/Settings'
import Pipelines from './pages/Pipelines'
import Scrapers from './pages/Scrapers'
import Chat from './pages/Chat'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="feedback" element={<Feedback />} />
        <Route path="feedback/:id" element={<FeedbackDetail />} />
        <Route path="categories" element={<Categories />} />
        <Route path="chat" element={<Chat />} />
        <Route path="projects" element={<Projects />} />
        <Route path="projects/:id" element={<ProjectDetail />} />
        <Route path="pipelines" element={<Pipelines />} />
        <Route path="scrapers" element={<Scrapers />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
