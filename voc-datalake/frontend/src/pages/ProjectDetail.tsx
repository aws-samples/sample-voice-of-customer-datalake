import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Users, FileText, MessageSquare, Search, Sparkles, Send, User, Bot, Loader2, X, Trash2, Pencil, Clock, CheckCircle, XCircle } from 'lucide-react'
import { api } from '../api/client'
import type { ProjectPersona, ProjectDocument, ProjectJob } from '../api/client'
import { useConfigStore } from '../store/configStore'
import { format } from 'date-fns'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import clsx from 'clsx'
import DocumentExportMenu from '../components/DocumentExportMenu'
import DataSourceWizard, { ContextSummary, defaultContextConfig, type ContextConfig } from '../components/DataSourceWizard'

type Tab = 'overview' | 'personas' | 'documents' | 'chat'

// Tool-specific configs (extend shared context)
interface PersonaToolConfig { personaCount: number; customInstructions: string }
interface ResearchToolConfig { question: string }
interface DocToolConfig { docType: 'prd' | 'prfaq'; title: string; featureIdea: string; customerQuestions: string[] }

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { config } = useConfigStore()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [generating, setGenerating] = useState<string | null>(null)
  const [selectedDoc, setSelectedDoc] = useState<ProjectDocument | null>(null)
  // Unified wizard state
  const [activeWizard, setActiveWizard] = useState<'persona' | 'research' | 'doc' | null>(null)
  const [contextConfig, setContextConfig] = useState<ContextConfig>(defaultContextConfig)
  
  // Tool-specific state
  const [personaConfig, setPersonaConfig] = useState<PersonaToolConfig>({ personaCount: 3, customInstructions: '' })
  const [researchConfig, setResearchConfig] = useState<ResearchToolConfig>({ question: '' })
  const [docConfig, setDocConfig] = useState<DocToolConfig>({ docType: 'prd', title: '', featureIdea: '', customerQuestions: ['', '', '', '', ''] })
  const [showDocModal, setShowDocModal] = useState(false)
  const [editingDoc, setEditingDoc] = useState<ProjectDocument | null>(null)
  const [newDocTitle, setNewDocTitle] = useState('')
  const [newDocContent, setNewDocContent] = useState('')
  
  // Persona editing state
  const [selectedPersona, setSelectedPersona] = useState<ProjectPersona | null>(null)
  const [editingPersona, setEditingPersona] = useState<ProjectPersona | null>(null)
  
  // Mention autocomplete state
  const [showMentionMenu, setShowMentionMenu] = useState(false)
  const [mentionType, setMentionType] = useState<'persona' | 'document' | null>(null)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  
  // Selected pills for context
  const [selectedPersonaIds, setSelectedPersonaIds] = useState<string[]>([])
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([])

  const { data, isLoading } = useQuery({ queryKey: ['project', id], queryFn: () => api.getProject(id!), enabled: !!config.apiEndpoint && !!id })
  
  // Fetch jobs for this project
  const { data: jobsData } = useQuery({ 
    queryKey: ['project-jobs', id], 
    queryFn: () => api.getJobs(id!), 
    enabled: !!config.apiEndpoint && !!id,
    refetchInterval: (query) => {
      // Auto-refresh every 3s if there are running jobs
      const jobs = query.state.data?.jobs || []
      const hasRunning = jobs.some((j: ProjectJob) => j.status === 'running' || j.status === 'pending')
      return hasRunning ? 3000 : false
    }
  })
  
  // When a job completes, refresh project data
  useEffect(() => {
    const jobs = jobsData?.jobs || []
    const completedRecently = jobs.some((j: ProjectJob) => 
      j.status === 'completed' && j.completed_at && 
      new Date(j.completed_at).getTime() > Date.now() - 10000
    )
    if (completedRecently) {
      queryClient.invalidateQueries({ queryKey: ['project', id] })
    }
  }, [jobsData, id, queryClient])
  // Helper to reset wizard state
  const resetWizard = () => {
    setActiveWizard(null)
    setContextConfig(defaultContextConfig)
    setPersonaConfig({ personaCount: 3, customInstructions: '' })
    setResearchConfig({ question: '' })
    setDocConfig({ docType: 'prd', title: '', featureIdea: '', customerQuestions: ['', '', '', '', ''] })
    setGenerating(null)
  }

  const personaMut = useMutation({
    mutationFn: () => api.generatePersonas(id!, { 
      sources: contextConfig.sources, 
      categories: contextConfig.categories, 
      sentiments: contextConfig.sentiments, 
      persona_count: personaConfig.personaCount, 
      custom_instructions: personaConfig.customInstructions, 
      days: contextConfig.days 
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['project', id] }); resetWizard() },
    onError: () => setGenerating(null),
  })
  
  const docMut = useMutation({ 
    mutationFn: () => api.generateDocument(id!, {
      doc_type: docConfig.docType,
      title: docConfig.title,
      feature_idea: docConfig.featureIdea,
      data_sources: { 
        feedback: contextConfig.useFeedback, 
        personas: contextConfig.usePersonas, 
        documents: contextConfig.useDocuments, 
        research: contextConfig.useResearch 
      },
      selected_persona_ids: contextConfig.selectedPersonaIds,
      selected_document_ids: [...contextConfig.selectedDocumentIds, ...contextConfig.selectedResearchIds],
      feedback_sources: contextConfig.sources,
      feedback_categories: contextConfig.categories,
      days: contextConfig.days,
      customer_questions: docConfig.customerQuestions.filter(q => q.trim())
    }), 
    onSuccess: () => { 
      queryClient.invalidateQueries({ queryKey: ['project-jobs', id] })
      resetWizard()
    }, 
    onError: () => setGenerating(null) 
  })
  
  const dismissJobMut = useMutation({ mutationFn: (jobId: string) => api.dismissJob(id!, jobId), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project-jobs', id] }) })
  
  const resMut = useMutation({ 
    mutationFn: () => api.runResearch(id!, { 
      question: researchConfig.question, 
      sources: contextConfig.sources, 
      categories: contextConfig.categories, 
      sentiments: contextConfig.sentiments, 
      days: contextConfig.days,
      selected_persona_ids: contextConfig.selectedPersonaIds,
      selected_document_ids: [...contextConfig.selectedDocumentIds, ...contextConfig.selectedResearchIds]
    }), 
    onError: () => setGenerating(null) 
  })
  const chatMut = useMutation({ 
    mutationFn: (params: { message: string; personas: string[]; documents: string[] }) => 
      api.projectChatStream(id!, params.message, params.personas, params.documents), 
    onSuccess: (r) => { if (r.success) setChatMessages(p => [...p, { role: 'assistant', content: r.response }]) } 
  })
  const createDocMut = useMutation({
    mutationFn: (data: { title: string; content: string }) => api.createDocument(id!, { ...data, document_type: 'custom' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['project', id] }); setShowDocModal(false); setNewDocTitle(''); setNewDocContent('') }
  })
  const deleteDocMut = useMutation({
    mutationFn: (docId: string) => api.deleteDocument(id!, docId),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['project', id] }); setSelectedDoc(null) }
  })
  const updateDocMut = useMutation({
    mutationFn: (data: { docId: string; title: string; content: string }) => api.updateDocument(id!, data.docId, { title: data.title, content: data.content }),
    onSuccess: (_result, variables) => { 
      queryClient.invalidateQueries({ queryKey: ['project', id] })
      if (selectedDoc && selectedDoc.document_id === variables.docId) {
        setSelectedDoc({ ...selectedDoc, title: variables.title, content: variables.content })
      }
      setEditingDoc(null); setNewDocTitle(''); setNewDocContent('') 
    }
  })
  
  // Persona CRUD mutations
  const updatePersonaMut = useMutation({
    mutationFn: (data: { personaId: string; updates: Partial<ProjectPersona> }) => api.updatePersona(id!, data.personaId, data.updates),
    onSuccess: () => { 
      queryClient.invalidateQueries({ queryKey: ['project', id] })
      setEditingPersona(null)
      setSelectedPersona(null)
    }
  })
  const deletePersonaMut = useMutation({
    mutationFn: (personaId: string) => api.deletePersona(id!, personaId),
    onSuccess: () => { 
      queryClient.invalidateQueries({ queryKey: ['project', id] })
      setSelectedPersona(null)
    }
  })
  const sendChat = () => { 
    if (!chatInput.trim() || chatMut.isPending) return
    
    // The mentions are already inline in chatInput (e.g., "@Marcus Chen what do you think about #Research")
    setChatMessages(p => [...p, { role: 'user', content: chatInput }])
    chatMut.mutate({ message: chatInput, personas: selectedPersonaIds, documents: selectedDocumentIds })
    setChatInput('')
    setShowMentionMenu(false)
    // Clear tracked IDs after sending
    setSelectedPersonaIds([])
    setSelectedDocumentIds([])
  }

  // Handle chat input changes for mention detection
  const handleChatInputChange = (value: string) => {
    setChatInput(value)
    
    // Check for @ or # trigger
    const lastAtIndex = value.lastIndexOf('@')
    const lastHashIndex = value.lastIndexOf('#')
    
    // Check if @ is more recent and not followed by space
    if (lastAtIndex > lastHashIndex && lastAtIndex >= 0) {
      const textAfterAt = value.slice(lastAtIndex + 1)
      if (!textAfterAt.includes(' ')) {
        setMentionType('persona')
        setMentionFilter(textAfterAt.toLowerCase())
        setShowMentionMenu(true)
        setMentionIndex(0)
        return
      }
    }
    
    // Check if # is more recent and not followed by space
    if (lastHashIndex > lastAtIndex && lastHashIndex >= 0) {
      const textAfterHash = value.slice(lastHashIndex + 1)
      if (!textAfterHash.includes(' ')) {
        setMentionType('document')
        setMentionFilter(textAfterHash.toLowerCase())
        setShowMentionMenu(true)
        setMentionIndex(0)
        return
      }
    }
    
    setShowMentionMenu(false)
    setMentionType(null)
  }

  // Get filtered items for mention menu
  const getMentionItems = () => {
    if (!data) return []
    if (mentionType === 'persona') {
      return data.personas.filter((p: ProjectPersona) => 
        p.name.toLowerCase().includes(mentionFilter)
      ).slice(0, 6)
    }
    if (mentionType === 'document') {
      return data.documents.filter((d: ProjectDocument) => 
        d.title.toLowerCase().includes(mentionFilter)
      ).slice(0, 6)
    }
    return []
  }

  // Insert mention inline in the text
  const insertMention = (item: ProjectPersona | ProjectDocument) => {
    const trigger = mentionType === 'persona' ? '@' : '#'
    const name = mentionType === 'persona' 
      ? (item as ProjectPersona).name 
      : (item as ProjectDocument).title
    
    // Add to selected IDs for context
    if (mentionType === 'persona') {
      const persona = item as ProjectPersona
      if (!selectedPersonaIds.includes(persona.persona_id)) {
        setSelectedPersonaIds(prev => [...prev, persona.persona_id])
      }
    } else if (mentionType === 'document') {
      const doc = item as ProjectDocument
      if (!selectedDocumentIds.includes(doc.document_id)) {
        setSelectedDocumentIds(prev => [...prev, doc.document_id])
      }
    }
    
    // Replace the trigger + filter with the full mention inline
    const triggerIndex = mentionType === 'persona' 
      ? chatInput.lastIndexOf('@')
      : chatInput.lastIndexOf('#')
    
    // Keep text before trigger, add mention, keep cursor ready for more text
    const textBefore = chatInput.slice(0, triggerIndex)
    const newValue = textBefore + trigger + name + ' '
    setChatInput(newValue)
    setShowMentionMenu(false)
    setMentionType(null)
  }
  


  // Handle keyboard navigation in mention menu
  const handleChatKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showMentionMenu) {
      const items = getMentionItems()
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex(i => Math.min(i + 1, items.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex(i => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (items.length > 0) {
          e.preventDefault()
          insertMention(items[mentionIndex])
        }
      } else if (e.key === 'Escape') {
        setShowMentionMenu(false)
      }
    } else if (e.key === 'Enter') {
      sendChat()
    }
  }

  if (isLoading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin text-blue-600" size={32} /></div>
  if (!data?.project) return <div className="text-center py-12"><p className="text-gray-500">Project not found</p><button onClick={() => navigate('/projects')} className="mt-4 text-blue-600 hover:underline">Back to Projects</button></div>
  const { project, personas, documents } = data
  const tabs = [{ id: 'overview' as Tab, label: 'Overview', icon: Sparkles }, { id: 'personas' as Tab, label: `Personas (${personas.length})`, icon: Users }, { id: 'documents' as Tab, label: `Documents (${documents.length})`, icon: FileText }, { id: 'chat' as Tab, label: 'AI Chat', icon: MessageSquare }]


  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <button onClick={() => navigate('/projects')} className="p-2 hover:bg-gray-100 rounded-lg"><ArrowLeft size={20} /></button>
        <div><h1 className="text-2xl font-bold text-gray-900">{project.name}</h1>{project.description && <p className="text-gray-500">{project.description}</p>}</div>
      </div>
      <div className="border-b border-gray-200"><nav className="flex gap-6">{tabs.map(t => <button key={t.id} onClick={() => setActiveTab(t.id)} className={clsx('flex items-center gap-2 py-3 border-b-2 text-sm font-medium', activeTab === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700')}><t.icon size={16} />{t.label}</button>)}</nav></div>

      {/* Persona Wizard */}
      {activeWizard === 'persona' && (
        <DataSourceWizard
          title="Generate Personas"
          accentColor="purple"
          icon={<div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center"><Users size={20} className="text-purple-600" /></div>}
          personas={personas}
          documents={documents}
          contextConfig={contextConfig}
          onContextChange={setContextConfig}
          renderFinalStep={() => (
            <div className="space-y-6">
              <div>
                <h3 className="font-medium mb-3">Number of Personas: {personaConfig.personaCount}</h3>
                <input type="range" min={1} max={7} value={personaConfig.personaCount} onChange={e => setPersonaConfig(c => ({ ...c, personaCount: +e.target.value }))} className="w-full" />
              </div>
              <div>
                <h3 className="font-medium mb-3">Custom Instructions (Optional)</h3>
                <textarea value={personaConfig.customInstructions} onChange={e => setPersonaConfig(c => ({ ...c, customInstructions: e.target.value }))} placeholder="e.g., Focus on business travelers, exclude one-time buyers..." rows={4} className="w-full px-3 py-2 border rounded-lg" />
              </div>
              <ContextSummary config={contextConfig} personas={personas} documents={documents} />
            </div>
          )}
          finalStepValid={true}
          onClose={resetWizard}
          onSubmit={() => { setGenerating('personas'); personaMut.mutate() }}
          isSubmitting={generating === 'personas'}
          submitLabel={<><Sparkles size={16} />Generate Personas</>}
        />
      )}

      {/* Research Wizard */}
      {activeWizard === 'research' && (
        <DataSourceWizard
          title="Run Research"
          accentColor="amber"
          icon={<div className="w-10 h-10 bg-amber-100 rounded-lg flex items-center justify-center"><Search size={20} className="text-amber-600" /></div>}
          personas={personas}
          documents={documents}
          contextConfig={contextConfig}
          onContextChange={setContextConfig}
          renderFinalStep={() => (
            <div className="space-y-6">
              <div>
                <h3 className="font-medium mb-3">Research Question</h3>
                <textarea value={researchConfig.question} onChange={e => setResearchConfig(c => ({ ...c, question: e.target.value }))} placeholder="e.g., What are the main pain points customers experience with delivery delays? What improvements do they suggest?" rows={4} className="w-full px-3 py-2 border rounded-lg" />
              </div>
              <ContextSummary config={contextConfig} personas={personas} documents={documents} />
            </div>
          )}
          finalStepValid={!!researchConfig.question.trim()}
          onClose={resetWizard}
          onSubmit={() => { setGenerating('research'); resMut.mutate() }}
          isSubmitting={generating === 'research'}
          submitLabel={<><Search size={16} />Run Research</>}
        />
      )}

      {/* Document Wizard (PRD / PR-FAQ) */}
      {activeWizard === 'doc' && (
        <DataSourceWizard
          title={`Generate ${docConfig.docType === 'prd' ? 'PRD' : 'PR-FAQ'}`}
          accentColor="blue"
          icon={<div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center"><FileText size={20} className="text-blue-600" /></div>}
          personas={personas}
          documents={documents}
          contextConfig={contextConfig}
          onContextChange={setContextConfig}
          renderFinalStep={() => (
            <div className="space-y-6">
              {/* Document Type Selection */}
              <div>
                <h3 className="font-medium mb-3">Document Type</h3>
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={() => setDocConfig(c => ({ ...c, docType: 'prd' }))} className={clsx('p-4 rounded-lg border text-left', docConfig.docType === 'prd' ? 'bg-blue-50 border-blue-300' : 'bg-white border-gray-200 hover:border-blue-200')}>
                    <div className="font-medium">PRD</div>
                    <div className="text-sm text-gray-500">Product Requirements Document</div>
                  </button>
                  <button onClick={() => setDocConfig(c => ({ ...c, docType: 'prfaq' }))} className={clsx('p-4 rounded-lg border text-left', docConfig.docType === 'prfaq' ? 'bg-green-50 border-green-300' : 'bg-white border-gray-200 hover:border-green-200')}>
                    <div className="font-medium">PR-FAQ</div>
                    <div className="text-sm text-gray-500">Amazon-style Press Release & FAQ</div>
                  </button>
                </div>
              </div>
              
              {/* Title & Description */}
              <div>
                <h3 className="font-medium mb-3">Feature/Product Title</h3>
                <input type="text" value={docConfig.title} onChange={e => setDocConfig(c => ({ ...c, title: e.target.value }))} placeholder="e.g., Real-time Delivery Tracking" className="w-full px-3 py-2 border rounded-lg" />
              </div>
              <div>
                <h3 className="font-medium mb-3">Feature Description</h3>
                <textarea value={docConfig.featureIdea} onChange={e => setDocConfig(c => ({ ...c, featureIdea: e.target.value }))} placeholder="Describe the feature or product idea..." rows={3} className="w-full px-3 py-2 border rounded-lg" />
              </div>
              
              {/* PR-FAQ Customer Questions */}
              {docConfig.docType === 'prfaq' && (
                <div>
                  <h3 className="font-medium mb-2">Amazon's 5 Customer Questions</h3>
                  <p className="text-sm text-gray-500 mb-4">Answer these questions to shape your PR-FAQ</p>
                  {[
                    { label: '1. Who is the customer?', hint: 'Describe their wants, needs, and motivations' },
                    { label: '2. What is the customer problem or opportunity?', hint: 'Current frustrations or new experiences that might delight them' },
                    { label: '3. What is the most important customer benefit?', hint: 'Prioritize the best solution - must-haves vs nice-to-haves' },
                    { label: '4. How do you know what customers need or want?', hint: 'Validate assumptions with data or customer feedback' },
                    { label: '5. What does the customer experience look like?', hint: 'How they discover, use, and feel about the solution' }
                  ].map((q, i) => (
                    <div key={i} className="mb-4">
                      <label className="text-sm font-medium text-gray-700 mb-1 block">{q.label}</label>
                      <p className="text-xs text-gray-400 mb-1">{q.hint}</p>
                      <textarea value={docConfig.customerQuestions[i]} onChange={e => { const qs = [...docConfig.customerQuestions]; qs[i] = e.target.value; setDocConfig(c => ({ ...c, customerQuestions: qs })) }} rows={2} className="w-full px-3 py-2 border rounded-lg text-sm" />
                    </div>
                  ))}
                </div>
              )}
              
              <ContextSummary config={contextConfig} personas={personas} documents={documents} />
            </div>
          )}
          finalStepValid={!!docConfig.title.trim() && !!docConfig.featureIdea.trim()}
          onClose={resetWizard}
          onSubmit={() => { setGenerating('doc'); docMut.mutate() }}
          isSubmitting={generating === 'doc'}
          submitLabel={<><FileText size={16} />Generate {docConfig.docType === 'prd' ? 'PRD' : 'PR-FAQ'}</>}
        />
      )}

      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Running Jobs Section */}
          {jobsData?.jobs && jobsData.jobs.length > 0 && (
            <div className="bg-white rounded-xl p-6 border">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                  <Clock size={20} className="text-gray-600" />
                </div>
                <div>
                  <h3 className="font-semibold">Background Jobs</h3>
                  <p className="text-sm text-gray-500">Long-running tasks for this project</p>
                </div>
              </div>
              <div className="space-y-3">
                {jobsData.jobs.slice(0, 5).map((job: ProjectJob) => {
                  // Check if job is stale (running but not updated in 10+ minutes)
                  const isStale = (job.status === 'running' || job.status === 'pending') && 
                    job.updated_at && 
                    new Date(job.updated_at).getTime() < Date.now() - 10 * 60 * 1000
                  
                  return (
                  <div key={job.job_id} className={clsx(
                    "flex items-center gap-4 p-3 rounded-lg",
                    isStale ? "bg-amber-50 border border-amber-200" : "bg-gray-50"
                  )}>
                    {isStale ? (
                      <Clock size={20} className="text-amber-600 flex-shrink-0" />
                    ) : job.status === 'running' || job.status === 'pending' ? (
                      <Loader2 size={20} className="text-blue-600 animate-spin flex-shrink-0" />
                    ) : job.status === 'completed' ? (
                      <CheckCircle size={20} className="text-green-600 flex-shrink-0" />
                    ) : (
                      <XCircle size={20} className="text-red-600 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">
                          {job.job_type === 'research' ? 'Research' : 'Persona Generation'}
                        </span>
                        <span className={clsx(
                          'text-xs px-2 py-0.5 rounded',
                          isStale ? 'bg-amber-100 text-amber-700' :
                          job.status === 'running' ? 'bg-blue-100 text-blue-700' :
                          job.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                          job.status === 'completed' ? 'bg-green-100 text-green-700' :
                          'bg-red-100 text-red-700'
                        )}>
                          {isStale ? 'may have failed' : job.status}
                        </span>
                      </div>
                      {isStale && (
                        <p className="text-xs text-amber-600 mt-1">
                          No updates for 10+ minutes. Will auto-clear soon.
                        </p>
                      )}
                      {!isStale && (job.status === 'running' || job.status === 'pending') && (
                        <div className="mt-2">
                          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                            <span>{job.current_step?.replace(/_/g, ' ') || 'Starting...'}</span>
                            <span>{job.progress}%</span>
                          </div>
                          <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                            <div 
                              className="h-full bg-blue-600 transition-all duration-500" 
                              style={{ width: `${job.progress}%` }} 
                            />
                          </div>
                        </div>
                      )}
                      {job.status === 'completed' && job.result?.document_id && (
                        <p className="text-xs text-gray-500 mt-1">
                          Created: {job.result.title || job.result.document_id}
                        </p>
                      )}
                      {job.status === 'failed' && job.error && (
                        <p className="text-xs text-red-600 mt-1 truncate">{job.error}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-xs text-gray-400">
                        {format(new Date(job.created_at), 'HH:mm')}
                      </span>
                      {(job.status === 'completed' || job.status === 'failed' || isStale) && (
                        <button 
                          onClick={() => dismissJobMut.mutate(job.job_id)}
                          className="p-1 hover:bg-gray-200 rounded text-gray-400 hover:text-gray-600"
                          title="Dismiss"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                )})}
              </div>
            </div>
          )}
          
          {/* Action Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-xl p-6 border"><div className="flex items-center gap-3 mb-4"><div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center"><Users size={20} className="text-purple-600" /></div><div><h3 className="font-semibold">Generate Personas</h3><p className="text-sm text-gray-500">Create user personas from feedback</p></div></div><button onClick={() => setActiveWizard('persona')} className="w-full py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 flex items-center justify-center gap-2"><Sparkles size={16} />Configure & Generate</button></div>
            <div className="bg-white rounded-xl p-6 border"><div className="flex items-center gap-3 mb-4"><div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center"><FileText size={20} className="text-blue-600" /></div><div><h3 className="font-semibold">Generate PRD / PR-FAQ</h3><p className="text-sm text-gray-500">Create product documents from feedback</p></div></div><button onClick={() => setActiveWizard('doc')} className="w-full py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center justify-center gap-2"><FileText size={16} />Configure & Generate</button></div>
            <div className="bg-white rounded-xl p-6 border lg:col-span-2"><div className="flex items-center gap-3 mb-4"><div className="w-10 h-10 bg-amber-100 rounded-lg flex items-center justify-center"><Search size={20} className="text-amber-600" /></div><div><h3 className="font-semibold">Run Research</h3><p className="text-sm text-gray-500">Deep dive into feedback with filters</p></div></div><button onClick={() => setActiveWizard('research')} className="w-full py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 flex items-center justify-center gap-2"><Search size={16} />Configure & Run Research</button></div>
          </div>
        </div>
      )}

      {activeTab === 'personas' && (
        <div className="space-y-4">
          <div className="flex justify-end"><button onClick={() => setActiveWizard('persona')} className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"><Sparkles size={16} />Generate Personas</button></div>
          {personas.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-xl border"><Users size={48} className="mx-auto text-gray-300 mb-4" /><h3 className="text-lg font-medium mb-2">No personas yet</h3><p className="text-gray-500 mb-4">Generate personas from feedback</p><button onClick={() => setActiveWizard('persona')} className="px-4 py-2 bg-purple-600 text-white rounded-lg"><Sparkles size={16} className="inline mr-2" />Generate</button></div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Persona List */}
              <div className="space-y-3">
                {personas.map((p: ProjectPersona) => (
                  <button 
                    key={p.persona_id} 
                    onClick={() => setSelectedPersona(p)}
                    className={clsx('w-full text-left p-4 rounded-lg border transition-colors', selectedPersona?.persona_id === p.persona_id ? 'bg-purple-50 border-purple-300' : 'bg-white hover:border-purple-200')}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-white font-bold">{p.name.charAt(0)}</div>
                      <div className="flex-1 min-w-0">
                        <h4 className="font-medium truncate">@{p.name}</h4>
                        <p className="text-xs text-gray-500 truncate">{p.tagline}</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              
              {/* Persona Detail */}
              <div className="lg:col-span-2 bg-white rounded-xl border p-6 min-h-[500px]">
                {selectedPersona ? (
                  <div>
                    <div className="flex items-start justify-between mb-6">
                      <div className="flex items-center gap-4">
                        <div className="w-16 h-16 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-white font-bold text-2xl">{selectedPersona.name.charAt(0)}</div>
                        <div>
                          <h2 className="text-xl font-bold">@{selectedPersona.name}</h2>
                          <p className="text-gray-500">{selectedPersona.tagline}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => setEditingPersona(selectedPersona)} className="p-2 text-purple-500 hover:bg-purple-50 rounded-lg" title="Edit"><Pencil size={18} /></button>
                        <button onClick={() => { if (confirm('Delete this persona?')) deletePersonaMut.mutate(selectedPersona.persona_id) }} disabled={deletePersonaMut.isPending} className="p-2 text-red-500 hover:bg-red-50 rounded-lg" title="Delete">
                          {deletePersonaMut.isPending ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                        </button>
                      </div>
                    </div>
                    
                    {selectedPersona.quote && <blockquote className="border-l-4 border-purple-300 pl-4 italic text-gray-600 mb-6">"{selectedPersona.quote}"</blockquote>}
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {selectedPersona.goals?.length > 0 && (
                        <div><h4 className="font-medium text-purple-700 mb-2">Goals</h4><ul className="list-disc list-inside text-gray-600 text-sm space-y-1">{selectedPersona.goals.map((g, i) => <li key={i}>{g}</li>)}</ul></div>
                      )}
                      {selectedPersona.frustrations?.length > 0 && (
                        <div><h4 className="font-medium text-red-700 mb-2">Frustrations</h4><ul className="list-disc list-inside text-gray-600 text-sm space-y-1">{selectedPersona.frustrations.map((f, i) => <li key={i}>{f}</li>)}</ul></div>
                      )}
                      {selectedPersona.behaviors?.length > 0 && (
                        <div><h4 className="font-medium text-blue-700 mb-2">Behaviors</h4><ul className="list-disc list-inside text-gray-600 text-sm space-y-1">{selectedPersona.behaviors.map((b, i) => <li key={i}>{b}</li>)}</ul></div>
                      )}
                      {selectedPersona.needs?.length > 0 && (
                        <div><h4 className="font-medium text-green-700 mb-2">Needs</h4><ul className="list-disc list-inside text-gray-600 text-sm space-y-1">{selectedPersona.needs.map((n, i) => <li key={i}>{n}</li>)}</ul></div>
                      )}
                    </div>
                    
                    {selectedPersona.scenario && (
                      <div className="mt-6 p-4 bg-gray-50 rounded-lg">
                        <h4 className="font-medium mb-2">Scenario</h4>
                        <p className="text-gray-600 text-sm">{selectedPersona.scenario}</p>
                      </div>
                    )}
                    
                    {selectedPersona.demographics && Object.keys(selectedPersona.demographics).length > 0 && (
                      <div className="mt-6 flex flex-wrap gap-2">
                        {Object.entries(selectedPersona.demographics).map(([key, value]) => value && (
                          <span key={key} className="px-2 py-1 bg-gray-100 rounded text-xs text-gray-600">{key}: {value}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full text-gray-400">Select a persona to view details</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      
      {/* Persona Edit Modal */}
      {editingPersona && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">Edit Persona</h2>
              <button onClick={() => setEditingPersona(null)} className="p-2 hover:bg-gray-100 rounded-lg"><X size={20} /></button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto max-h-[60vh]">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-sm font-medium mb-1">Name</label><input type="text" value={editingPersona.name} onChange={e => setEditingPersona({ ...editingPersona, name: e.target.value })} className="w-full px-3 py-2 border rounded-lg" /></div>
                <div><label className="block text-sm font-medium mb-1">Tagline</label><input type="text" value={editingPersona.tagline} onChange={e => setEditingPersona({ ...editingPersona, tagline: e.target.value })} className="w-full px-3 py-2 border rounded-lg" /></div>
              </div>
              <div><label className="block text-sm font-medium mb-1">Quote</label><textarea value={editingPersona.quote} onChange={e => setEditingPersona({ ...editingPersona, quote: e.target.value })} rows={2} className="w-full px-3 py-2 border rounded-lg" /></div>
              <div><label className="block text-sm font-medium mb-1">Goals (one per line)</label><textarea value={editingPersona.goals?.join('\n') || ''} onChange={e => setEditingPersona({ ...editingPersona, goals: e.target.value.split('\n').filter(g => g.trim()) })} rows={3} className="w-full px-3 py-2 border rounded-lg font-mono text-sm" /></div>
              <div><label className="block text-sm font-medium mb-1">Frustrations (one per line)</label><textarea value={editingPersona.frustrations?.join('\n') || ''} onChange={e => setEditingPersona({ ...editingPersona, frustrations: e.target.value.split('\n').filter(f => f.trim()) })} rows={3} className="w-full px-3 py-2 border rounded-lg font-mono text-sm" /></div>
              <div><label className="block text-sm font-medium mb-1">Behaviors (one per line)</label><textarea value={editingPersona.behaviors?.join('\n') || ''} onChange={e => setEditingPersona({ ...editingPersona, behaviors: e.target.value.split('\n').filter(b => b.trim()) })} rows={3} className="w-full px-3 py-2 border rounded-lg font-mono text-sm" /></div>
              <div><label className="block text-sm font-medium mb-1">Needs (one per line)</label><textarea value={editingPersona.needs?.join('\n') || ''} onChange={e => setEditingPersona({ ...editingPersona, needs: e.target.value.split('\n').filter(n => n.trim()) })} rows={3} className="w-full px-3 py-2 border rounded-lg font-mono text-sm" /></div>
              <div><label className="block text-sm font-medium mb-1">Scenario</label><textarea value={editingPersona.scenario} onChange={e => setEditingPersona({ ...editingPersona, scenario: e.target.value })} rows={3} className="w-full px-3 py-2 border rounded-lg" /></div>
            </div>
            <div className="flex justify-end gap-3 p-4 border-t bg-gray-50">
              <button onClick={() => setEditingPersona(null)} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
              <button onClick={() => updatePersonaMut.mutate({ personaId: editingPersona.persona_id, updates: editingPersona })} disabled={updatePersonaMut.isPending} className="flex items-center gap-2 px-6 py-2 bg-purple-600 text-white rounded-lg disabled:opacity-50">
                {updatePersonaMut.isPending ? <><Loader2 size={16} className="animate-spin" />Saving...</> : <><Pencil size={16} />Save Changes</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'documents' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button onClick={() => setShowDocModal(true)} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <FileText size={16} />New Document
            </button>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="space-y-3">{documents.length === 0 ? <div className="text-center py-8 bg-white rounded-xl border"><FileText size={32} className="mx-auto text-gray-300 mb-2" /><p className="text-gray-500">No documents</p></div> : documents.map((d: ProjectDocument) => <button key={d.document_id} onClick={() => setSelectedDoc(d)} className={clsx('w-full text-left p-4 rounded-lg border', selectedDoc?.document_id === d.document_id ? 'bg-blue-50 border-blue-300' : 'bg-white hover:border-blue-200')}><div className="flex items-center gap-2 mb-1"><span className={clsx('text-xs font-medium px-2 py-0.5 rounded', d.document_type === 'prd' ? 'bg-blue-100 text-blue-700' : d.document_type === 'prfaq' ? 'bg-green-100 text-green-700' : d.document_type === 'custom' ? 'bg-purple-100 text-purple-700' : 'bg-amber-100 text-amber-700')}>{d.document_type.toUpperCase()}</span><span className="text-xs text-gray-400">{format(new Date(d.created_at), 'MMM d')}</span></div><h4 className="font-medium line-clamp-2">{d.title}</h4></button>)}</div>
            <div className="lg:col-span-2 bg-white rounded-xl border p-6 min-h-[500px] overflow-hidden">
              {selectedDoc ? (
                <div className="h-full flex flex-col">
                  <div className="flex items-start justify-between mb-4">
                    <h2 className="text-xl font-bold">{selectedDoc.title}</h2>
                    <div className="flex items-center gap-2">
                      <DocumentExportMenu document={selectedDoc} />
                      <button 
                        onClick={() => { setEditingDoc(selectedDoc); setNewDocTitle(selectedDoc.title); setNewDocContent(selectedDoc.content) }}
                        className="p-2 text-blue-500 hover:bg-blue-50 rounded-lg"
                        title="Edit document"
                      >
                        <Pencil size={18} />
                      </button>
                      <button 
                        onClick={() => { if (confirm('Delete this document?')) deleteDocMut.mutate(selectedDoc.document_id) }}
                        disabled={deleteDocMut.isPending}
                        className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                        title="Delete document"
                      >
                        {deleteDocMut.isPending ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                      </button>
                    </div>
                  </div>
                  <div className="prose prose-sm max-w-none overflow-y-auto flex-1" style={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedDoc.content}</ReactMarkdown>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-gray-400">Select a document</div>
              )}
            </div>
          </div>
        </div>
      )}

      {(showDocModal || editingDoc) && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl w-full max-w-3xl max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">{editingDoc ? 'Edit Document' : 'Create Document'}</h2>
              <button onClick={() => { setShowDocModal(false); setEditingDoc(null); setNewDocTitle(''); setNewDocContent('') }} className="p-2 hover:bg-gray-100 rounded-lg"><X size={20} /></button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto max-h-[60vh]">
              <div>
                <label className="block text-sm font-medium mb-1">Title</label>
                <input type="text" value={newDocTitle} onChange={e => setNewDocTitle(e.target.value)} placeholder="Document title..." className="w-full px-3 py-2 border rounded-lg" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Content (Markdown)</label>
                <textarea value={newDocContent} onChange={e => setNewDocContent(e.target.value)} placeholder="Write your document in Markdown..." rows={12} className="w-full px-3 py-2 border rounded-lg font-mono text-sm" />
              </div>
              {newDocContent && (
                <div>
                  <label className="block text-sm font-medium mb-1">Preview</label>
                  <div className="border rounded-lg p-4 prose prose-sm max-w-none bg-gray-50 max-h-48 overflow-y-auto">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{newDocContent}</ReactMarkdown>
                  </div>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 p-4 border-t bg-gray-50">
              <button onClick={() => { setShowDocModal(false); setEditingDoc(null); setNewDocTitle(''); setNewDocContent('') }} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
              {editingDoc ? (
                <button onClick={() => updateDocMut.mutate({ docId: editingDoc.document_id, title: newDocTitle, content: newDocContent })} disabled={!newDocTitle.trim() || !newDocContent.trim() || updateDocMut.isPending} className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50">
                  {updateDocMut.isPending ? <><Loader2 size={16} className="animate-spin" />Saving...</> : <><Pencil size={16} />Save Changes</>}
                </button>
              ) : (
                <button onClick={() => createDocMut.mutate({ title: newDocTitle, content: newDocContent })} disabled={!newDocTitle.trim() || !newDocContent.trim() || createDocMut.isPending} className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50">
                  {createDocMut.isPending ? <><Loader2 size={16} className="animate-spin" />Creating...</> : <><FileText size={16} />Create</>}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'chat' && (
        <div className="bg-white rounded-xl border h-[600px] flex flex-col">
          <div className="p-4 border-b">
            <h3 className="font-semibold">Project AI Chat</h3>
            <p className="text-sm text-gray-500">
              Type <span className="font-mono bg-purple-100 text-purple-700 px-1 rounded">@</span> for personas or <span className="font-mono bg-blue-100 text-blue-700 px-1 rounded">#</span> for documents
            </p>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {chatMessages.length === 0 && (
              <div className="text-center text-gray-400 py-8">
                <MessageSquare size={32} className="mx-auto mb-2 opacity-50" />
                <p>Start a conversation</p>
                <p className="text-sm mt-2">Try: "What would @{personas[0]?.name || 'PersonaName'} think about this?"</p>
              </div>
            )}
            {chatMessages.map((m, i) => (
              <div key={i} className={clsx('flex gap-3', m.role === 'user' ? 'justify-end' : '')}>
                {m.role === 'assistant' && <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0"><Bot size={16} className="text-blue-600" /></div>}
                <div className={clsx('max-w-[75%] rounded-lg p-3 group relative', m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-100')}>
                  {m.role === 'assistant' ? (
                    <>
                      <div className="prose prose-sm max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
                      {/* Save as Document button */}
                      <button
                        onClick={() => { setNewDocTitle(`Chat Response - ${new Date().toLocaleDateString()}`); setNewDocContent(m.content); setShowDocModal(true) }}
                        className="absolute -bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white border shadow-sm rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 flex items-center gap-1"
                        title="Save as document"
                      >
                        <FileText size={12} />
                        Save as Doc
                      </button>
                    </>
                  ) : (
                    <p>{m.content}</p>
                  )}
                </div>
                {m.role === 'user' && <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center flex-shrink-0"><User size={16} className="text-gray-600" /></div>}
              </div>
            ))}
            {chatMut.isPending && (
              <div className="flex gap-3">
                <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center"><Loader2 size={16} className="text-blue-600 animate-spin" /></div>
                <div className="bg-gray-100 rounded-lg p-3 text-gray-500">Thinking...</div>
              </div>
            )}
          </div>
          
          {/* Chat Input with Inline Pills */}
          <div className="p-4 border-t relative">
            {/* Mention Dropdown */}
            {showMentionMenu && getMentionItems().length > 0 && (
              <div className="absolute bottom-full left-4 right-4 mb-2 bg-white border rounded-lg shadow-lg max-h-64 overflow-y-auto z-10">
                <div className="p-2 border-b bg-gray-50 text-xs text-gray-500 font-medium">
                  {mentionType === 'persona' ? '👤 Personas' : '📄 Documents'}
                </div>
                {getMentionItems().map((item, idx) => {
                  const isPersona = mentionType === 'persona'
                  const persona = item as ProjectPersona
                  const doc = item as ProjectDocument
                  return (
                    <button
                      key={isPersona ? persona.persona_id : doc.document_id}
                      onClick={() => insertMention(item)}
                      className={clsx(
                        'w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-gray-50 transition-colors',
                        idx === mentionIndex && 'bg-blue-50'
                      )}
                    >
                      {isPersona ? (
                        <>
                          <div className="w-8 h-8 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-white font-bold text-sm">
                            {persona.name.charAt(0)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-gray-900 truncate">@{persona.name}</p>
                            <p className="text-xs text-gray-500 truncate">{persona.tagline}</p>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className={clsx(
                            'w-8 h-8 rounded-lg flex items-center justify-center',
                            doc.document_type === 'prd' ? 'bg-blue-100' : 
                            doc.document_type === 'prfaq' ? 'bg-green-100' : 
                            doc.document_type === 'custom' ? 'bg-purple-100' : 'bg-amber-100'
                          )}>
                            <FileText size={16} className={clsx(
                              doc.document_type === 'prd' ? 'text-blue-600' : 
                              doc.document_type === 'prfaq' ? 'text-green-600' : 
                              doc.document_type === 'custom' ? 'text-purple-600' : 'text-amber-600'
                            )} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-gray-900 truncate">#{doc.title}</p>
                            <p className="text-xs text-gray-500">{doc.document_type.toUpperCase()}</p>
                          </div>
                        </>
                      )}
                    </button>
                  )
                })}
                <div className="p-2 border-t bg-gray-50 text-xs text-gray-400">
                  ↑↓ to navigate • Enter to select • Esc to close
                </div>
              </div>
            )}
            
            {/* Context indicator for selected items */}
            {(selectedPersonaIds.length > 0 || selectedDocumentIds.length > 0) && (
              <div className="flex flex-wrap gap-1 mb-2 text-xs text-gray-500">
                <span>Context:</span>
                {selectedPersonaIds.map(pid => {
                  const persona = personas.find((p: ProjectPersona) => p.persona_id === pid)
                  return persona ? (
                    <span key={pid} className="px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded">@{persona.name}</span>
                  ) : null
                })}
                {selectedDocumentIds.map(did => {
                  const doc = documents.find((d: ProjectDocument) => d.document_id === did)
                  return doc ? (
                    <span key={did} className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">#{doc.title.slice(0, 20)}</span>
                  ) : null
                })}
              </div>
            )}
            
            {/* Simple text input */}
            <div className="flex gap-3">
              <input 
                type="text" 
                value={chatInput} 
                onChange={e => handleChatInputChange(e.target.value)} 
                onKeyDown={handleChatKeyDown}
                placeholder="Type @ for personas, # for docs..."
                className="flex-1 px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500" 
              />
              <button onClick={sendChat} disabled={!chatInput.trim() || chatMut.isPending} className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50 hover:bg-blue-700 flex-shrink-0">
                <Send size={18} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
