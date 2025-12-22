import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Sparkles, Loader2, ChevronDown, Plus, X } from 'lucide-react'
import { api } from '../api'

export default function BuilderPage() {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')
  const [projectType, setProjectType] = useState('react-vite')
  const [style, setStyle] = useState('minimal')
  const [includeMockData, setIncludeMockData] = useState(false)
  const [pages, setPages] = useState([])
  const [newPage, setNewPage] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  
  // Fetch templates
  const { data: templatesData } = useQuery({
    queryKey: ['templates'],
    queryFn: api.getTemplates,
  })
  
  const templates = templatesData?.templates || []
  const styles = templatesData?.styles || []
  
  // Create job mutation
  const createJob = useMutation({
    mutationFn: api.createJob,
    onSuccess: (data) => {
      navigate(`/jobs/${data.job_id}`)
    },
  })
  
  const handleSubmit = (e) => {
    e.preventDefault()
    if (!prompt.trim()) return
    
    createJob.mutate({
      prompt: prompt.trim(),
      project_type: projectType,
      style,
      include_mock_data: includeMockData,
      pages,
    })
  }
  
  const addPage = () => {
    if (newPage.trim() && !pages.includes(newPage.trim())) {
      setPages([...pages, newPage.trim()])
      setNewPage('')
    }
  }
  
  const removePage = (page) => {
    setPages(pages.filter(p => p !== page))
  }
  
  return (
    <div className="max-w-3xl mx-auto">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          Build Your Artifact
        </h1>
        <p className="text-gray-600">
          Describe what you want to build and we'll generate a working prototype
        </p>
      </div>
      
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Main Prompt */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            What do you want to build?
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="A landing page for a SaaS product with pricing table, feature highlights, and a contact form..."
            className="w-full h-40 px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-primary-500 resize-none"
            required
          />
          <p className="mt-1 text-sm text-gray-500">
            Be specific about pages, features, and design preferences
          </p>
        </div>
        
        {/* Quick Options */}
        <div className="grid grid-cols-2 gap-4">
          {/* Project Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Project Type
            </label>
            <select
              value={projectType}
              onChange={(e) => setProjectType(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white"
            >
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          
          {/* Style */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Style
            </label>
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white"
            >
              {styles.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </div>
        
        {/* Mock Data Toggle */}
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={includeMockData}
            onChange={(e) => setIncludeMockData(e.target.checked)}
            className="w-5 h-5 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
          />
          <span className="text-sm text-gray-700">Include realistic mock data</span>
        </label>
        
        {/* Advanced Options */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
          >
            <ChevronDown className={`w-4 h-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            Advanced Options
          </button>
          
          {showAdvanced && (
            <div className="mt-4 p-4 bg-gray-50 rounded-xl space-y-4">
              {/* Pages */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Specific Pages (optional)
                </label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={newPage}
                    onChange={(e) => setNewPage(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addPage())}
                    placeholder="e.g., About, Pricing, Contact"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                  <button
                    type="button"
                    onClick={addPage}
                    className="px-3 py-2 bg-gray-200 hover:bg-gray-300 rounded-lg"
                  >
                    <Plus className="w-5 h-5" />
                  </button>
                </div>
                {pages.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {pages.map(page => (
                      <span
                        key={page}
                        className="inline-flex items-center gap-1 px-3 py-1 bg-primary-100 text-primary-700 rounded-full text-sm"
                      >
                        {page}
                        <button
                          type="button"
                          onClick={() => removePage(page)}
                          className="hover:text-primary-900"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        
        {/* Submit Button */}
        <button
          type="submit"
          disabled={!prompt.trim() || createJob.isPending}
          className="w-full py-4 bg-gradient-to-r from-primary-600 to-primary-700 hover:from-primary-700 hover:to-primary-800 text-white font-semibold rounded-xl shadow-lg shadow-primary-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
        >
          {createJob.isPending ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              <Sparkles className="w-5 h-5" />
              Generate Artifact
            </>
          )}
        </button>
        
        {createJob.isError && (
          <p className="text-red-600 text-sm text-center">
            {createJob.error.message}
          </p>
        )}
      </form>
    </div>
  )
}
