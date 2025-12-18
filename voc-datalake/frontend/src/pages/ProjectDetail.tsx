import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Users, FileText, MessageSquare, Search, Sparkles, Send, User, Bot, Loader2, X, Trash2, Pencil, Clock, CheckCircle, XCircle, Settings, Check, Upload, Image, FileUp, Shuffle } from 'lucide-react'
import { api } from '../api/client'
import type { ProjectPersona, ProjectDocument, ProjectJob, Project } from '../api/client'
import { useConfigStore } from '../store/configStore'
import { format } from 'date-fns'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import clsx from 'clsx'
import DocumentExportMenu from '../components/DocumentExportMenu'
import PersonaExportMenu from '../components/PersonaExportMenu'
import DataSourceWizard, { ContextSummary, defaultContextConfig, type ContextConfig } from '../components/DataSourceWizard'
import ConfirmModal from '../components/ConfirmModal'

type Tab = 'overview' | 'personas' | 'documents' | 'chat'

// Tool-specific configs (extend shared context)
interface MergeToolConfig { 
  outputType: 'prd' | 'prfaq' | 'custom'
  title: string
  instructions: string
}

// Persona Avatar Component - shows AI-generated image or fallback
// Circular avatar with max 128px for large size to fit nicely in persona header
function PersonaAvatar({ persona, size = 'md' }: { persona: ProjectPersona; size?: 'sm' | 'md' | 'lg' }) {
  const [imageError, setImageError] = useState(false)
  
  // Size classes: sm=40px, md=48px, lg=96px (was 80px, now smaller to fit header better)
  const sizeClasses = {
    sm: 'w-10 h-10 min-w-[40px] min-h-[40px] text-sm',
    md: 'w-12 h-12 min-w-[48px] min-h-[48px] text-base',
    lg: 'w-24 h-24 min-w-[96px] min-h-[96px] max-w-[128px] max-h-[128px] text-2xl'
  }
  
  // Check for avatar URL (CloudFront CDN URL)
  const avatarUrl = persona.avatar_url
  
  // Fallback gradient avatar with initials
  const FallbackAvatar = () => (
    <div className={clsx(sizeClasses[size], 'bg-gradient-to-br from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0')}>
      {persona.name.charAt(0)}
    </div>
  )
  
  if (avatarUrl && !imageError) {
    return (
      <div className="relative flex-shrink-0">
        <img 
          src={avatarUrl} 
          alt={persona.name}
          className={clsx(sizeClasses[size], 'rounded-full object-cover border-2 border-purple-200 flex-shrink-0')}
          onError={() => setImageError(true)}
        />
      </div>
    )
  }
  
  return <FallbackAvatar />
}

// Section wrapper for persona details
function PersonaSection({ title, icon, color, children }: { 
  title: string
  icon: string
  color: 'purple' | 'green' | 'red' | 'blue' | 'amber' | 'indigo' | 'teal' | 'gray' | 'emerald'
  children: React.ReactNode 
}) {
  const colorClasses = {
    purple: 'border-purple-200 bg-purple-50/50',
    green: 'border-green-200 bg-green-50/50',
    red: 'border-red-200 bg-red-50/50',
    blue: 'border-blue-200 bg-blue-50/50',
    amber: 'border-amber-200 bg-amber-50/50',
    indigo: 'border-indigo-200 bg-indigo-50/50',
    teal: 'border-teal-200 bg-teal-50/50',
    gray: 'border-gray-200 bg-gray-50/50',
    emerald: 'border-emerald-200 bg-emerald-50/50',
  }
  const titleColors = {
    purple: 'text-purple-700',
    green: 'text-green-700',
    red: 'text-red-700',
    blue: 'text-blue-700',
    amber: 'text-amber-700',
    indigo: 'text-indigo-700',
    teal: 'text-teal-700',
    gray: 'text-gray-700',
    emerald: 'text-emerald-700',
  }
  
  return (
    <div className={clsx('rounded-lg border p-4', colorClasses[color])}>
      <h4 className={clsx('font-medium mb-3 flex items-center gap-2', titleColors[color])}>
        <span>{icon}</span> {title}
      </h4>
      {children}
    </div>
  )
}

// Research Notes Component with edit capability - prominent UX researcher notes section
type NoteItem = string | { note_id?: string; text: string; created_at?: string }

function ResearchNotes({ persona, onSave, isSaving }: { 
  persona: ProjectPersona
  onSave: (notes: NoteItem[]) => void
  isSaving: boolean
}) {
  // Handle both string[] and object[] formats from backend
  const rawNotes = persona.research_notes || []
  const normalizeNotes = (notes: NoteItem[]): NoteItem[] => notes
  
  const [notes, setNotes] = useState<NoteItem[]>(normalizeNotes(rawNotes))
  const [newNote, setNewNote] = useState('')
  const [isExpanded, setIsExpanded] = useState(true)
  
  // Sync with persona data when it changes
  useEffect(() => {
    setNotes(normalizeNotes(persona.research_notes || []))
  }, [persona])
  
  const getNoteText = (note: NoteItem): string => {
    return typeof note === 'string' ? note : note.text
  }
  
  const addNote = () => {
    if (!newNote.trim()) return
    const updated = [...notes, newNote.trim()]
    setNotes(updated)
    setNewNote('')
    onSave(updated)
  }
  
  const removeNote = (index: number) => {
    const updated = notes.filter((_, i) => i !== index)
    setNotes(updated)
    onSave(updated)
  }
  
  return (
    <div className="space-y-4">
      {/* Header with count badge */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">
            {notes.length === 0 ? 'No notes yet' : `${notes.length} note${notes.length !== 1 ? 's' : ''}`}
          </span>
          {notes.length > 0 && (
            <button 
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-xs text-purple-600 hover:text-purple-700"
            >
              {isExpanded ? 'Collapse' : 'Expand'}
            </button>
          )}
        </div>
      </div>
      
      {/* Empty state with call to action */}
      {notes.length === 0 && (
        <div className="text-center py-6 bg-white rounded-lg border-2 border-dashed border-gray-200">
          <div className="w-12 h-12 mx-auto mb-3 bg-purple-100 rounded-full flex items-center justify-center">
            <FileText size={24} className="text-purple-500" />
          </div>
          <p className="text-gray-600 font-medium mb-1">Add Your Research Notes</p>
          <p className="text-gray-400 text-sm mb-4">Document your observations, insights, and hypotheses about this persona</p>
        </div>
      )}
      
      {/* Notes list */}
      {notes.length > 0 && isExpanded && (
        <ul className="space-y-2">
          {notes.map((note, i) => (
            <li key={i} className="group flex items-start gap-3 text-sm text-gray-700 bg-white p-3 rounded-lg border hover:border-purple-200 transition-colors">
              <div className="w-6 h-6 bg-purple-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="text-xs text-purple-600 font-medium">{i + 1}</span>
              </div>
              <span className="flex-1 leading-relaxed">{getNoteText(note)}</span>
              <button 
                onClick={() => removeNote(i)} 
                className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 p-1 transition-opacity"
                disabled={isSaving}
                title="Remove note"
              >
                <X size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      
      {/* Add note input - always visible */}
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <input
            type="text"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addNote()}
            placeholder="Type your research observation or insight..."
            className="w-full px-4 py-3 text-sm border rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 pr-24"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
            Press Enter ↵
          </span>
        </div>
        <button
          onClick={addNote}
          disabled={!newNote.trim() || isSaving}
          className="px-4 py-3 bg-purple-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-purple-700 flex items-center gap-2 transition-colors"
        >
          {isSaving ? <Loader2 size={16} className="animate-spin" /> : (
            <>
              <FileText size={16} />
              Add Note
            </>
          )}
        </button>
      </div>
      
      {/* Helper text */}
      <p className="text-xs text-gray-400">
        💡 Tip: Add observations from user interviews, usability tests, or data analysis that relate to this persona.
      </p>
    </div>
  )
}

// Kiro Export Settings Component
function KiroExportSettings({ project, onSave }: { project: Project; onSave: (prompt: string) => void }) {
  const [prompt, setPrompt] = useState(project.kiro_export_prompt || '')
  const [isEditing, setIsEditing] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setPrompt(project.kiro_export_prompt || '')
  }, [project.kiro_export_prompt])

  const handleSave = () => {
    onSave(prompt)
    setIsEditing(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const defaultPrompt = `# Kiro Implementation Context

## Project Overview
Implement the following PRD for [Your Project Name].

## Tech Stack
- Frontend: React + TypeScript + Tailwind CSS
- Backend: [Your backend stack]
- Database: [Your database]

## Coding Standards
- Follow existing code patterns in the codebase
- Use TypeScript strict mode
- Write unit tests for new functionality
- Follow the project's ESLint configuration

## Implementation Notes
- [Add specific implementation guidance here]
- [Reference relevant files or patterns]
- [Note any constraints or requirements]`

  return (
    <div className="bg-white rounded-xl p-6 border">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
            <Sparkles size={20} className="text-purple-600" />
          </div>
          <div>
            <h3 className="font-semibold">Kiro Export Settings</h3>
            <p className="text-sm text-gray-500">Configure context for "Copy to Kiro" exports</p>
          </div>
        </div>
        {!isEditing && (
          <button
            onClick={() => setIsEditing(true)}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-purple-600 hover:bg-purple-50 rounded-lg"
          >
            <Settings size={16} />
            {prompt ? 'Edit' : 'Configure'}
          </button>
        )}
      </div>

      {isEditing ? (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Export Prompt Template
            </label>
            <p className="text-xs text-gray-500 mb-2">
              This context will be prepended to PRD/PR-FAQ documents when using "Copy to Kiro". 
              Include your tech stack, coding standards, and implementation guidance.
            </p>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={defaultPrompt}
              rows={12}
              className="w-full px-3 py-2 border rounded-lg font-mono text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
            />
          </div>
          <div className="flex items-center justify-between">
            <button
              onClick={() => setPrompt(defaultPrompt)}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Use default template
            </button>
            <div className="flex gap-2">
              <button
                onClick={() => { setIsEditing(false); setPrompt(project.kiro_export_prompt || '') }}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
              >
                {saved ? <Check size={16} /> : <Sparkles size={16} />}
                {saved ? 'Saved!' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : prompt ? (
        <div className="bg-gray-50 rounded-lg p-4">
          <pre className="text-sm text-gray-600 whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
            {prompt.slice(0, 300)}{prompt.length > 300 ? '...' : ''}
          </pre>
        </div>
      ) : (
        <div className="text-center py-6 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
          <Sparkles size={24} className="mx-auto text-gray-400 mb-2" />
          <p className="text-gray-500 text-sm">No Kiro export prompt configured</p>
          <p className="text-gray-400 text-xs mt-1">Click "Configure" to add implementation context for PRD exports</p>
        </div>
      )}
    </div>
  )
}

// Tool-specific configs (extend shared context)
interface PersonaToolConfig { personaCount: number; customInstructions: string }
interface ResearchToolConfig { question: string; title: string }
interface DocToolConfig { docType: 'prd' | 'prfaq'; title: string; featureIdea: string; customerQuestions: string[] }
// MergeToolConfig is defined above

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
  const [activeWizard, setActiveWizard] = useState<'persona' | 'research' | 'doc' | 'merge' | null>(null)
  const [contextConfig, setContextConfig] = useState<ContextConfig>(defaultContextConfig)
  
  // Tool-specific state
  const [personaConfig, setPersonaConfig] = useState<PersonaToolConfig>({ personaCount: 3, customInstructions: '' })
  const [researchConfig, setResearchConfig] = useState<ResearchToolConfig>({ question: '', title: '' })
  const [docConfig, setDocConfig] = useState<DocToolConfig>({ docType: 'prd', title: '', featureIdea: '', customerQuestions: ['', '', '', '', ''] })
  const [mergeConfig, setMergeConfig] = useState<MergeToolConfig>({ outputType: 'prfaq', title: '', instructions: '' })
  const [showDocModal, setShowDocModal] = useState(false)
  const [editingDoc, setEditingDoc] = useState<ProjectDocument | null>(null)
  const [newDocTitle, setNewDocTitle] = useState('')
  const [newDocContent, setNewDocContent] = useState('')
  
  // Persona editing state
  const [selectedPersona, setSelectedPersona] = useState<ProjectPersona | null>(null)
  const [editingPersona, setEditingPersona] = useState<ProjectPersona | null>(null)
  
  // Persona import state
  const [showImportModal, setShowImportModal] = useState(false)
  const [importType, setImportType] = useState<'pdf' | 'image' | 'text'>('text')
  const [importContent, setImportContent] = useState('')
  const [importMediaType, setImportMediaType] = useState('')
  const [importFileName, setImportFileName] = useState('')
  
  // Mention autocomplete state
  const [showMentionMenu, setShowMentionMenu] = useState(false)
  const [mentionType, setMentionType] = useState<'persona' | 'document' | null>(null)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  
  // Selected pills for context
  const [selectedPersonaIds, setSelectedPersonaIds] = useState<string[]>([])
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([])
  
  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState<{ type: 'persona' | 'document' | null; id: string | null }>({ type: null, id: null })

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

  // Sync selectedPersona with latest data from query (e.g., after research_notes update)
  useEffect(() => {
    if (selectedPersona && data?.personas) {
      const updatedPersona = data.personas.find((p: ProjectPersona) => p.persona_id === selectedPersona.persona_id)
      if (updatedPersona && JSON.stringify(updatedPersona) !== JSON.stringify(selectedPersona)) {
        setSelectedPersona(updatedPersona)
      }
    }
  }, [data?.personas, selectedPersona])

  // Helper to reset wizard state
  const resetWizard = () => {
    setActiveWizard(null)
    setContextConfig(defaultContextConfig)
    setPersonaConfig({ personaCount: 3, customInstructions: '' })
    setResearchConfig({ question: '', title: '' })
    setDocConfig({ docType: 'prd', title: '', featureIdea: '', customerQuestions: ['', '', '', '', ''] })
    setMergeConfig({ outputType: 'prfaq', title: '', instructions: '' })
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
    onSuccess: () => { 
      queryClient.invalidateQueries({ queryKey: ['project-jobs', id] })
      resetWizard() 
    },
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
  
  const mergeMut = useMutation({
    mutationFn: () => api.mergeDocuments(id!, {
      output_type: mergeConfig.outputType,
      title: mergeConfig.title,
      instructions: mergeConfig.instructions,
      selected_document_ids: [...contextConfig.selectedDocumentIds, ...contextConfig.selectedResearchIds],
      selected_persona_ids: contextConfig.selectedPersonaIds,
      use_feedback: contextConfig.useFeedback,
      feedback_sources: contextConfig.sources,
      feedback_categories: contextConfig.categories,
      days: contextConfig.days,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-jobs', id] })
      resetWizard()
    },
    onError: () => setGenerating(null)
  })
  
  const resMut = useMutation({ 
    mutationFn: () => api.runResearch(id!, { 
      question: researchConfig.question,
      title: researchConfig.title || researchConfig.question.slice(0, 100),
      sources: contextConfig.sources, 
      categories: contextConfig.categories, 
      sentiments: contextConfig.sentiments, 
      days: contextConfig.days,
      selected_persona_ids: contextConfig.selectedPersonaIds,
      selected_document_ids: [...contextConfig.selectedDocumentIds, ...contextConfig.selectedResearchIds]
    }), 
    onSuccess: () => { 
      queryClient.invalidateQueries({ queryKey: ['project-jobs', id] })
      resetWizard() 
    },
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
    onSuccess: (_data, variables) => { 
      queryClient.invalidateQueries({ queryKey: ['project', id] })
      // Only clear selection when editing from modal (full persona edit), not for inline updates like research notes
      if (editingPersona && editingPersona.persona_id === variables.personaId) {
        setEditingPersona(null)
        setSelectedPersona(null)
      }
    }
  })
  const deletePersonaMut = useMutation({
    mutationFn: (personaId: string) => api.deletePersona(id!, personaId),
    onSuccess: () => { 
      queryClient.invalidateQueries({ queryKey: ['project', id] })
      setSelectedPersona(null)
    }
  })
  
  const importPersonaMut = useMutation({
    mutationFn: (data: { input_type: 'pdf' | 'image' | 'text'; content: string; media_type?: string }) => 
      api.importPersona(id!, data),
    onSuccess: () => { 
      // Close modal immediately - job runs in background
      setShowImportModal(false)
      setImportContent('')
      setImportFileName('')
      setImportMediaType('')
      // Refresh jobs list to show the new import job
      queryClient.invalidateQueries({ queryKey: ['project-jobs', id] })
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
                <h3 className="font-medium mb-3">Research Title</h3>
                <input type="text" value={researchConfig.title} onChange={e => setResearchConfig(c => ({ ...c, title: e.target.value }))} placeholder="e.g., Delivery Pain Points Analysis" className="w-full px-3 py-2 border rounded-lg" />
                <p className="text-xs text-gray-500 mt-1">Optional - defaults to the research question if left empty</p>
              </div>
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

      {/* Remix Documents Wizard */}
      {activeWizard === 'merge' && (
        <DataSourceWizard
          title="Remix Documents"
          accentColor="green"
          icon={<div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center"><Shuffle size={20} className="text-green-600" /></div>}
          personas={personas}
          documents={documents}
          contextConfig={contextConfig}
          onContextChange={setContextConfig}
          hideDataSources={['feedback']}
          combineDocuments
          renderFinalStep={() => (
            <div className="space-y-6">
              {/* Output Type Selection */}
              <div>
                <h3 className="font-medium mb-3">Output Document Type</h3>
                <div className="grid grid-cols-3 gap-3">
                  <button onClick={() => setMergeConfig(c => ({ ...c, outputType: 'prfaq' }))} className={clsx('p-4 rounded-lg border text-left', mergeConfig.outputType === 'prfaq' ? 'bg-green-50 border-green-300' : 'bg-white border-gray-200 hover:border-green-200')}>
                    <div className="font-medium">PR-FAQ</div>
                    <div className="text-xs text-gray-500">Press Release & FAQ</div>
                  </button>
                  <button onClick={() => setMergeConfig(c => ({ ...c, outputType: 'prd' }))} className={clsx('p-4 rounded-lg border text-left', mergeConfig.outputType === 'prd' ? 'bg-blue-50 border-blue-300' : 'bg-white border-gray-200 hover:border-blue-200')}>
                    <div className="font-medium">PRD</div>
                    <div className="text-xs text-gray-500">Requirements Doc</div>
                  </button>
                  <button onClick={() => setMergeConfig(c => ({ ...c, outputType: 'custom' }))} className={clsx('p-4 rounded-lg border text-left', mergeConfig.outputType === 'custom' ? 'bg-purple-50 border-purple-300' : 'bg-white border-gray-200 hover:border-purple-200')}>
                    <div className="font-medium">Custom</div>
                    <div className="text-xs text-gray-500">Free-form document</div>
                  </button>
                </div>
              </div>
              
              {/* Title */}
              <div>
                <h3 className="font-medium mb-3">New Document Title</h3>
                <input type="text" value={mergeConfig.title} onChange={e => setMergeConfig(c => ({ ...c, title: e.target.value }))} placeholder="e.g., Virtual Concierge PRD v2" className="w-full px-3 py-2 border rounded-lg" />
              </div>
              
              {/* Instructions */}
              <div>
                <h3 className="font-medium mb-3">Remix Instructions</h3>
                <p className="text-sm text-gray-500 mb-2">Tell the AI how to combine and revise the selected documents</p>
                <textarea 
                  value={mergeConfig.instructions} 
                  onChange={e => setMergeConfig(c => ({ ...c, instructions: e.target.value }))} 
                  placeholder="Describe how to remix the documents..."
                  rows={4} 
                  className="w-full px-3 py-2 border rounded-lg" 
                />
              </div>
              
              <ContextSummary config={contextConfig} personas={personas} documents={documents} />
              
              {/* Validation warning */}
              {(contextConfig.selectedDocumentIds.length + contextConfig.selectedResearchIds.length) < 2 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-700">
                  ⚠️ Select at least 2 documents to remix. Go back to the selection step to choose documents.
                </div>
              )}
            </div>
          )}
          finalStepValid={!!mergeConfig.title.trim() && !!mergeConfig.instructions.trim() && (contextConfig.selectedDocumentIds.length + contextConfig.selectedResearchIds.length) >= 2}
          onClose={resetWizard}
          onSubmit={() => { setGenerating('merge'); mergeMut.mutate() }}
          isSubmitting={generating === 'merge'}
          submitLabel={<><Shuffle size={16} />Remix Documents</>}
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
                          {job.job_type === 'research' ? 'Research' : 
                           job.job_type === 'generate_prd' ? 'PRD Generation' :
                           job.job_type === 'generate_prfaq' ? 'PR-FAQ Generation' :
                           job.job_type === 'generate_personas' ? 'Persona Generation' :
                           job.job_type === 'import_persona' ? 'Persona Import' :
                           'Document Merge'}
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
                      {job.status === 'completed' && (job.result?.document_id || job.result?.persona_id) && (
                        <p className="text-xs text-gray-500 mt-1">
                          Created: {job.result.title || job.result.document_id || job.result.persona_id}
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
            <div className="bg-white rounded-xl p-6 border"><div className="flex items-center gap-3 mb-4"><div className="w-10 h-10 bg-amber-100 rounded-lg flex items-center justify-center"><Search size={20} className="text-amber-600" /></div><div><h3 className="font-semibold">Run Research</h3><p className="text-sm text-gray-500">Deep dive into feedback with filters</p></div></div><button onClick={() => setActiveWizard('research')} className="w-full py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 flex items-center justify-center gap-2"><Search size={16} />Configure & Run Research</button></div>
            <div className="bg-white rounded-xl p-6 border"><div className="flex items-center gap-3 mb-4"><div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center"><Shuffle size={20} className="text-green-600" /></div><div><h3 className="font-semibold">Remix Documents</h3><p className="text-sm text-gray-500">Combine and revise documents into new versions</p></div></div><button onClick={() => { setContextConfig({ ...defaultContextConfig, useFeedback: false, useDocuments: true, useResearch: true }); setMergeConfig(c => ({ ...c, instructions: 'Create an improved version of the document that:\n1. Incorporates insights from the research findings\n2. Addresses any gaps or concerns identified\n3. Strengthens the customer benefit narrative\n4. Maintains consistency with the original vision' })); setActiveWizard('merge') }} disabled={documents.length < 2} className="w-full py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"><Shuffle size={16} />Select & Remix</button>{documents.length < 2 && <p className="text-xs text-gray-400 mt-2 text-center">Need at least 2 documents</p>}</div>
          </div>

          {/* Kiro Export Settings */}
          <KiroExportSettings project={project} onSave={(prompt) => {
            api.updateProject(project.project_id, { kiro_export_prompt: prompt })
              .then(() => queryClient.invalidateQueries({ queryKey: ['project', id] }))
          }} />
        </div>
      )}

      {activeTab === 'personas' && (
        <div className="space-y-4">
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowImportModal(true)} className="flex items-center gap-2 px-4 py-2 border border-purple-300 text-purple-600 rounded-lg hover:bg-purple-50"><Upload size={16} />Import Persona</button>
            <button onClick={() => setActiveWizard('persona')} className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"><Sparkles size={16} />Generate Personas</button>
          </div>
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
                      <PersonaAvatar persona={p} size="sm" />
                      <div className="flex-1 min-w-0">
                        <h4 className="font-medium truncate">@{p.name}</h4>
                        <p className="text-xs text-gray-500 truncate">{p.tagline}</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              
              {/* Persona Detail */}
              <div className="lg:col-span-2 bg-white rounded-xl border overflow-hidden">
                {selectedPersona ? (
                  <div className="h-full overflow-y-auto">
                    {/* Header with Avatar */}
                    <div className="p-6 border-b bg-gradient-to-r from-purple-50 to-pink-50">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-4">
                          <PersonaAvatar persona={selectedPersona} size="lg" />
                          <div>
                            <h2 className="text-xl font-bold text-gray-900">@{selectedPersona.name}</h2>
                            <p className="text-gray-600">{selectedPersona.tagline}</p>
                            {selectedPersona.confidence && (
                              <span className={clsx('inline-block mt-1 px-2 py-0.5 rounded text-xs font-medium',
                                selectedPersona.confidence === 'high' ? 'bg-green-100 text-green-700' :
                                selectedPersona.confidence === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                                'bg-gray-100 text-gray-600'
                              )}>
                                {selectedPersona.confidence} confidence
                                {selectedPersona.feedback_count && ` • ${selectedPersona.feedback_count} reviews`}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <PersonaExportMenu persona={selectedPersona} />
                          <button onClick={() => setEditingPersona(selectedPersona)} className="p-2 text-purple-500 hover:bg-purple-100 rounded-lg" title="Edit"><Pencil size={18} /></button>
                          <button onClick={() => setConfirmModal({ type: 'persona', id: selectedPersona.persona_id })} disabled={deletePersonaMut.isPending} className="p-2 text-red-500 hover:bg-red-100 rounded-lg" title="Delete">
                            {deletePersonaMut.isPending ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                          </button>
                        </div>
                      </div>
                    </div>
                    
                    <div className="p-6 space-y-6">
                      {/* Section 1: Identity & Demographics */}
                      {(selectedPersona.identity || selectedPersona.demographics) && (
                        <PersonaSection title="Identity & Demographics" icon="👤" color="purple">
                          <div className="space-y-3">
                            {(selectedPersona.identity?.bio || selectedPersona.demographics?.bio) && (
                              <p className="text-gray-700 text-sm leading-relaxed">
                                {selectedPersona.identity?.bio || selectedPersona.demographics?.bio}
                              </p>
                            )}
                            <div className="flex flex-wrap gap-2">
                              {Object.entries(selectedPersona.identity || selectedPersona.demographics || {}).map(([key, value]) => 
                                value && key !== 'bio' && (
                                  <span key={key} className="px-2 py-1 bg-purple-50 border border-purple-100 rounded text-xs text-purple-700">
                                    {key.replace(/_/g, ' ')}: {String(value)}
                                  </span>
                                )
                              )}
                            </div>
                          </div>
                        </PersonaSection>
                      )}
                      
                      {/* Section 2: Goals & Motivations */}
                      {(selectedPersona.goals_motivations || selectedPersona.goals?.length > 0) && (
                        <PersonaSection title="Goals & Motivations" icon="🎯" color="green">
                          <div className="space-y-3">
                            {selectedPersona.goals_motivations?.primary_goal && (
                              <div className="p-3 bg-green-50 rounded-lg border border-green-100">
                                <p className="text-xs text-green-600 font-medium mb-1">Primary Goal</p>
                                <p className="text-gray-700 text-sm">{selectedPersona.goals_motivations.primary_goal}</p>
                              </div>
                            )}
                            {(selectedPersona.goals_motivations?.secondary_goals || selectedPersona.goals)?.length > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 font-medium mb-2">Secondary Goals</p>
                                <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
                                  {(selectedPersona.goals_motivations?.secondary_goals || selectedPersona.goals || []).map((g: string, i: number) => <li key={i}>{g}</li>)}
                                </ul>
                              </div>
                            )}
                            {(selectedPersona.goals_motivations?.underlying_motivations?.length ?? 0) > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 font-medium mb-2">Underlying Motivations</p>
                                <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
                                  {selectedPersona.goals_motivations?.underlying_motivations?.map((m: string, i: number) => <li key={i}>{m}</li>)}
                                </ul>
                              </div>
                            )}
                          </div>
                        </PersonaSection>
                      )}
                      
                      {/* Section 3: Pain Points & Frustrations */}
                      {(selectedPersona.pain_points || selectedPersona.frustrations?.length > 0) && (
                        <PersonaSection title="Pain Points & Frustrations" icon="😤" color="red">
                          <div className="space-y-3">
                            {(selectedPersona.pain_points?.current_challenges || selectedPersona.frustrations)?.length > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 font-medium mb-2">Current Challenges</p>
                                <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
                                  {(selectedPersona.pain_points?.current_challenges || selectedPersona.frustrations || []).map((f: string, i: number) => <li key={i}>{f}</li>)}
                                </ul>
                              </div>
                            )}
                            {(selectedPersona.pain_points?.blockers?.length ?? 0) > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 font-medium mb-2">Blockers</p>
                                <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
                                  {selectedPersona.pain_points?.blockers?.map((b: string, i: number) => <li key={i}>{b}</li>)}
                                </ul>
                              </div>
                            )}
                            {(selectedPersona.pain_points?.workarounds?.length ?? 0) > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 font-medium mb-2">Current Workarounds</p>
                                <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
                                  {selectedPersona.pain_points?.workarounds?.map((w: string, i: number) => <li key={i}>{w}</li>)}
                                </ul>
                              </div>
                            )}
                          </div>
                        </PersonaSection>
                      )}
                      
                      {/* Section 4: Behaviors & Habits */}
                      {(selectedPersona.behaviors && typeof selectedPersona.behaviors === 'object' && !Array.isArray(selectedPersona.behaviors)) ? (
                        <PersonaSection title="Behaviors & Habits" icon="🔄" color="blue">
                          <div className="space-y-3">
                            {((selectedPersona.behaviors as { current_solutions?: string[] })?.current_solutions?.length ?? 0) > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 font-medium mb-2">Current Solutions</p>
                                <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
                                  {(selectedPersona.behaviors as { current_solutions?: string[] })?.current_solutions?.map((s: string, i: number) => <li key={i}>{s}</li>)}
                                </ul>
                              </div>
                            )}
                            <div className="flex flex-wrap gap-2">
                              {selectedPersona.behaviors.tech_savviness && (
                                <span className="px-2 py-1 bg-blue-50 border border-blue-100 rounded text-xs text-blue-700">
                                  Tech: {selectedPersona.behaviors.tech_savviness}
                                </span>
                              )}
                              {selectedPersona.behaviors.activity_frequency && (
                                <span className="px-2 py-1 bg-blue-50 border border-blue-100 rounded text-xs text-blue-700">
                                  {selectedPersona.behaviors.activity_frequency}
                                </span>
                              )}
                              {selectedPersona.behaviors.decision_style && (
                                <span className="px-2 py-1 bg-blue-50 border border-blue-100 rounded text-xs text-blue-700">
                                  {selectedPersona.behaviors.decision_style}
                                </span>
                              )}
                            </div>
                            {((selectedPersona.behaviors as { tools_used?: string[] })?.tools_used?.length ?? 0) > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 font-medium mb-2">Tools Used</p>
                                <div className="flex flex-wrap gap-1">
                                  {(selectedPersona.behaviors as { tools_used?: string[] })?.tools_used?.map((t: string, i: number) => (
                                    <span key={i} className="px-2 py-0.5 bg-gray-100 rounded text-xs text-gray-600">{t}</span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </PersonaSection>
                      ) : selectedPersona.behaviors?.length > 0 && (
                        <PersonaSection title="Behaviors" icon="🔄" color="blue">
                          <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
                            {(selectedPersona.behaviors as string[]).map((b: string, i: number) => <li key={i}>{b}</li>)}
                          </ul>
                        </PersonaSection>
                      )}
                      
                      {/* Section 5: Context & Environment */}
                      {selectedPersona.context_environment && (
                        <PersonaSection title="Context & Environment" icon="🌍" color="amber">
                          <div className="space-y-3">
                            {selectedPersona.context_environment.usage_context && (
                              <p className="text-gray-700 text-sm">{selectedPersona.context_environment.usage_context}</p>
                            )}
                            <div className="flex flex-wrap gap-2">
                              {selectedPersona.context_environment.devices?.map((d: string, i: number) => (
                                <span key={i} className="px-2 py-1 bg-amber-50 border border-amber-100 rounded text-xs text-amber-700">{d}</span>
                              ))}
                            </div>
                            {selectedPersona.context_environment.time_constraints && (
                              <p className="text-gray-600 text-sm"><span className="font-medium">Time constraints:</span> {selectedPersona.context_environment.time_constraints}</p>
                            )}
                          </div>
                        </PersonaSection>
                      )}
                      
                      {/* Section 6: Representative Quotes */}
                      {((selectedPersona.quotes?.length ?? 0) > 0 || selectedPersona.quote) && (
                        <PersonaSection title="Representative Quotes" icon="💬" color="indigo">
                          <div className="space-y-3">
                            {(selectedPersona.quotes?.length ?? 0) > 0 ? (
                              selectedPersona.quotes?.map((q: { text: string; context?: string }, i: number) => (
                                <blockquote key={i} className="border-l-4 border-indigo-300 pl-4 py-1">
                                  <p className="text-gray-700 text-sm italic">"{q.text}"</p>
                                  {q.context && <p className="text-gray-400 text-xs mt-1">— {q.context}</p>}
                                </blockquote>
                              ))
                            ) : selectedPersona.quote && (
                              <blockquote className="border-l-4 border-indigo-300 pl-4 py-1">
                                <p className="text-gray-700 text-sm italic">"{selectedPersona.quote}"</p>
                              </blockquote>
                            )}
                          </div>
                        </PersonaSection>
                      )}
                      
                      {/* Section 7: Scenario/User Story */}
                      {selectedPersona.scenario && (
                        <PersonaSection title="Scenario" icon="📖" color="teal">
                          {typeof selectedPersona.scenario === 'string' ? (
                            <p className="text-gray-700 text-sm leading-relaxed">{selectedPersona.scenario}</p>
                          ) : (
                            <div className="space-y-3">
                              {selectedPersona.scenario.title && (
                                <h5 className="font-medium text-gray-900">{selectedPersona.scenario.title}</h5>
                              )}
                              {selectedPersona.scenario.narrative && (
                                <p className="text-gray-700 text-sm leading-relaxed">{selectedPersona.scenario.narrative}</p>
                              )}
                              {(selectedPersona.scenario.trigger || selectedPersona.scenario.outcome) && (
                                <div className="flex gap-4 text-sm">
                                  {selectedPersona.scenario.trigger && (
                                    <div className="flex-1 p-2 bg-teal-50 rounded">
                                      <p className="text-xs text-teal-600 font-medium">Trigger</p>
                                      <p className="text-gray-600">{selectedPersona.scenario.trigger}</p>
                                    </div>
                                  )}
                                  {selectedPersona.scenario.outcome && (
                                    <div className="flex-1 p-2 bg-teal-50 rounded">
                                      <p className="text-xs text-teal-600 font-medium">Desired Outcome</p>
                                      <p className="text-gray-600">{selectedPersona.scenario.outcome}</p>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </PersonaSection>
                      )}
                      
                      {/* Section 8: Research Notes */}
                      <PersonaSection title="Research Notes" icon="📝" color="gray">
                        <ResearchNotes 
                          persona={selectedPersona} 
                          onSave={(notes) => updatePersonaMut.mutate({ 
                            personaId: selectedPersona.persona_id, 
                            updates: { research_notes: notes as ProjectPersona['research_notes'] } 
                          })}
                          isSaving={updatePersonaMut.isPending}
                        />
                      </PersonaSection>
                      
                      {/* Needs (legacy support) */}
                      {selectedPersona.needs?.length > 0 && !selectedPersona.goals_motivations && (
                        <PersonaSection title="Needs" icon="✨" color="emerald">
                          <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
                            {selectedPersona.needs.map((n: string, i: number) => <li key={i}>{n}</li>)}
                          </ul>
                        </PersonaSection>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full min-h-[500px] text-gray-400">Select a persona to view details</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      
      {/* Persona Edit Modal */}
      {editingPersona && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl w-full max-w-3xl max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">Edit Persona</h2>
              <button onClick={() => setEditingPersona(null)} className="p-2 hover:bg-gray-100 rounded-lg"><X size={20} /></button>
            </div>
            <div className="p-6 space-y-6 overflow-y-auto max-h-[65vh]">
              {/* Basic Info */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">👤 Basic Info</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div><label className="block text-sm font-medium mb-1">Name</label><input type="text" value={editingPersona.name} onChange={e => setEditingPersona({ ...editingPersona, name: e.target.value })} className="w-full px-3 py-2 border rounded-lg" /></div>
                  <div><label className="block text-sm font-medium mb-1">Tagline</label><input type="text" value={editingPersona.tagline} onChange={e => setEditingPersona({ ...editingPersona, tagline: e.target.value })} className="w-full px-3 py-2 border rounded-lg" /></div>
                </div>
              </div>
              
              {/* Identity & Demographics */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">🪪 Identity & Demographics</h3>
                <div><label className="block text-sm font-medium mb-1">Bio</label><textarea value={editingPersona.identity?.bio || editingPersona.demographics?.bio || ''} onChange={e => setEditingPersona({ ...editingPersona, identity: { ...editingPersona.identity, bio: e.target.value } })} rows={2} className="w-full px-3 py-2 border rounded-lg" placeholder="Brief background story..." /></div>
                <div className="grid grid-cols-3 gap-3 mt-3">
                  <div><label className="block text-xs font-medium mb-1">Age Range</label><input type="text" value={editingPersona.identity?.age_range || ''} onChange={e => setEditingPersona({ ...editingPersona, identity: { ...editingPersona.identity, age_range: e.target.value } })} className="w-full px-2 py-1.5 border rounded text-sm" placeholder="25-35" /></div>
                  <div><label className="block text-xs font-medium mb-1">Location</label><input type="text" value={editingPersona.identity?.location || ''} onChange={e => setEditingPersona({ ...editingPersona, identity: { ...editingPersona.identity, location: e.target.value } })} className="w-full px-2 py-1.5 border rounded text-sm" placeholder="Urban, US" /></div>
                  <div><label className="block text-xs font-medium mb-1">Occupation</label><input type="text" value={editingPersona.identity?.occupation || ''} onChange={e => setEditingPersona({ ...editingPersona, identity: { ...editingPersona.identity, occupation: e.target.value } })} className="w-full px-2 py-1.5 border rounded text-sm" placeholder="Product Manager" /></div>
                </div>
              </div>
              
              {/* Goals & Motivations */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">🎯 Goals & Motivations</h3>
                <div><label className="block text-sm font-medium mb-1">Primary Goal</label><input type="text" value={editingPersona.goals_motivations?.primary_goal || ''} onChange={e => setEditingPersona({ ...editingPersona, goals_motivations: { ...editingPersona.goals_motivations, primary_goal: e.target.value } })} className="w-full px-3 py-2 border rounded-lg" placeholder="Main objective..." /></div>
                <div className="mt-3"><label className="block text-sm font-medium mb-1">Secondary Goals (one per line)</label><textarea value={(editingPersona.goals_motivations?.secondary_goals || editingPersona.goals || []).join('\n')} onChange={e => setEditingPersona({ ...editingPersona, goals_motivations: { ...editingPersona.goals_motivations, secondary_goals: e.target.value.split('\n').filter(g => g.trim()) }, goals: e.target.value.split('\n').filter(g => g.trim()) })} rows={2} className="w-full px-3 py-2 border rounded-lg font-mono text-sm" /></div>
              </div>
              
              {/* Pain Points */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">😤 Pain Points & Frustrations</h3>
                <div><label className="block text-sm font-medium mb-1">Current Challenges (one per line)</label><textarea value={(editingPersona.pain_points?.current_challenges || editingPersona.frustrations || []).join('\n')} onChange={e => setEditingPersona({ ...editingPersona, pain_points: { ...editingPersona.pain_points, current_challenges: e.target.value.split('\n').filter(f => f.trim()) }, frustrations: e.target.value.split('\n').filter(f => f.trim()) })} rows={3} className="w-full px-3 py-2 border rounded-lg font-mono text-sm" /></div>
                <div className="mt-3"><label className="block text-sm font-medium mb-1">Workarounds (one per line)</label><textarea value={(editingPersona.pain_points?.workarounds || []).join('\n')} onChange={e => setEditingPersona({ ...editingPersona, pain_points: { ...editingPersona.pain_points, workarounds: e.target.value.split('\n').filter(w => w.trim()) } })} rows={2} className="w-full px-3 py-2 border rounded-lg font-mono text-sm" placeholder="How they currently cope..." /></div>
              </div>
              
              {/* Quotes */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">💬 Representative Quote</h3>
                <textarea value={editingPersona.quote || (editingPersona.quotes?.[0]?.text || '')} onChange={e => setEditingPersona({ ...editingPersona, quote: e.target.value })} rows={2} className="w-full px-3 py-2 border rounded-lg" placeholder="A quote that captures their voice..." />
              </div>
              
              {/* Scenario */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">📖 Scenario</h3>
                <div><label className="block text-sm font-medium mb-1">Title</label><input type="text" value={typeof editingPersona.scenario === 'object' ? editingPersona.scenario?.title || '' : ''} onChange={e => setEditingPersona({ ...editingPersona, scenario: { ...(typeof editingPersona.scenario === 'object' ? editingPersona.scenario : {}), title: e.target.value } })} className="w-full px-3 py-2 border rounded-lg" placeholder="Scenario title..." /></div>
                <div className="mt-3"><label className="block text-sm font-medium mb-1">Narrative</label><textarea value={typeof editingPersona.scenario === 'string' ? editingPersona.scenario : editingPersona.scenario?.narrative || ''} onChange={e => setEditingPersona({ ...editingPersona, scenario: typeof editingPersona.scenario === 'string' ? e.target.value : { ...editingPersona.scenario, narrative: e.target.value } })} rows={3} className="w-full px-3 py-2 border rounded-lg" placeholder="A story showing them in action..." /></div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div><label className="block text-xs font-medium mb-1">Trigger</label><input type="text" value={typeof editingPersona.scenario === 'object' ? editingPersona.scenario?.trigger || '' : ''} onChange={e => setEditingPersona({ ...editingPersona, scenario: { ...(typeof editingPersona.scenario === 'object' ? editingPersona.scenario : {}), trigger: e.target.value } })} className="w-full px-2 py-1.5 border rounded text-sm" placeholder="What triggers this scenario" /></div>
                  <div><label className="block text-xs font-medium mb-1">Desired Outcome</label><input type="text" value={typeof editingPersona.scenario === 'object' ? editingPersona.scenario?.outcome || '' : ''} onChange={e => setEditingPersona({ ...editingPersona, scenario: { ...(typeof editingPersona.scenario === 'object' ? editingPersona.scenario : {}), outcome: e.target.value } })} className="w-full px-2 py-1.5 border rounded text-sm" placeholder="What they hope to achieve" /></div>
                </div>
              </div>
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
                      <DocumentExportMenu document={selectedDoc} project={project} />
                      <button 
                        onClick={() => { setEditingDoc(selectedDoc); setNewDocTitle(selectedDoc.title); setNewDocContent(selectedDoc.content) }}
                        className="p-2 text-blue-500 hover:bg-blue-50 rounded-lg"
                        title="Edit document"
                      >
                        <Pencil size={18} />
                      </button>
                      <button 
                        onClick={() => setConfirmModal({ type: 'document', id: selectedDoc.document_id })}
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

      {/* Import Persona Modal */}
      {showImportModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">Import Persona</h2>
              <button onClick={() => { setShowImportModal(false); setImportContent(''); setImportFileName(''); setImportMediaType('') }} className="p-2 hover:bg-gray-100 rounded-lg"><X size={20} /></button>
            </div>
            <div className="p-6 space-y-6">
              {/* Import Type Selection */}
              <div>
                <h3 className="font-medium mb-3">Import From</h3>
                <div className="grid grid-cols-3 gap-3">
                  <button onClick={() => { setImportType('pdf'); setImportContent(''); setImportFileName('') }} className={clsx('p-4 rounded-lg border text-center', importType === 'pdf' ? 'bg-purple-50 border-purple-300' : 'bg-white border-gray-200 hover:border-purple-200')}>
                    <FileUp size={24} className="mx-auto mb-2 text-purple-500" />
                    <div className="font-medium">PDF</div>
                    <div className="text-xs text-gray-500">Upload document</div>
                  </button>
                  <button onClick={() => { setImportType('image'); setImportContent(''); setImportFileName('') }} className={clsx('p-4 rounded-lg border text-center', importType === 'image' ? 'bg-purple-50 border-purple-300' : 'bg-white border-gray-200 hover:border-purple-200')}>
                    <Image size={24} className="mx-auto mb-2 text-purple-500" />
                    <div className="font-medium">Image</div>
                    <div className="text-xs text-gray-500">Screenshot or card</div>
                  </button>
                  <button onClick={() => { setImportType('text'); setImportContent(''); setImportFileName('') }} className={clsx('p-4 rounded-lg border text-center', importType === 'text' ? 'bg-purple-50 border-purple-300' : 'bg-white border-gray-200 hover:border-purple-200')}>
                    <FileText size={24} className="mx-auto mb-2 text-purple-500" />
                    <div className="font-medium">Text</div>
                    <div className="text-xs text-gray-500">Paste content</div>
                  </button>
                </div>
              </div>

              {/* File Upload for PDF/Image */}
              {(importType === 'pdf' || importType === 'image') && (
                <div>
                  <h3 className="font-medium mb-3">Upload {importType === 'pdf' ? 'PDF Document' : 'Image'}</h3>
                  <label className="block">
                    <div className={clsx('border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors', importFileName ? 'border-purple-300 bg-purple-50' : 'border-gray-300 hover:border-purple-300')}>
                      {importFileName ? (
                        <div>
                          <CheckCircle size={32} className="mx-auto mb-2 text-purple-500" />
                          <p className="font-medium text-purple-700">{importFileName}</p>
                          <p className="text-sm text-gray-500 mt-1">Click to change file</p>
                        </div>
                      ) : (
                        <div>
                          <Upload size={32} className="mx-auto mb-2 text-gray-400" />
                          <p className="text-gray-600">Click to upload or drag and drop</p>
                          <p className="text-sm text-gray-400 mt-1">{importType === 'pdf' ? 'PDF files only' : 'PNG, JPG, GIF, WebP'}</p>
                        </div>
                      )}
                    </div>
                    <input
                      type="file"
                      accept={importType === 'pdf' ? '.pdf,application/pdf' : 'image/png,image/jpeg,image/gif,image/webp'}
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) {
                          setImportFileName(file.name)
                          setImportMediaType(file.type)
                          const reader = new FileReader()
                          reader.onload = () => {
                            const base64 = (reader.result as string).split(',')[1]
                            setImportContent(base64)
                          }
                          reader.readAsDataURL(file)
                        }
                      }}
                    />
                  </label>
                </div>
              )}

              {/* Text Input */}
              {importType === 'text' && (
                <div>
                  <h3 className="font-medium mb-3">Paste Persona Content</h3>
                  <textarea
                    value={importContent}
                    onChange={(e) => setImportContent(e.target.value)}
                    placeholder="Paste your persona description, user research notes, or any text describing the persona..."
                    rows={10}
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                  />
                </div>
              )}

              {/* Info */}
              <div className="bg-purple-50 rounded-lg p-4 text-sm">
                <p className="text-purple-700">
                  <strong>AI-Powered Import:</strong> Claude will extract persona information from your {importType === 'pdf' ? 'PDF document' : importType === 'image' ? 'image' : 'text'} and create a structured persona with an AI-generated avatar.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-3 p-4 border-t bg-gray-50">
              <button onClick={() => { setShowImportModal(false); setImportContent(''); setImportFileName(''); setImportMediaType('') }} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
              <button
                onClick={() => importPersonaMut.mutate({ input_type: importType, content: importContent, media_type: importMediaType })}
                disabled={!importContent || importPersonaMut.isPending}
                className="flex items-center gap-2 px-6 py-2 bg-purple-600 text-white rounded-lg disabled:opacity-50 hover:bg-purple-700"
              >
                {importPersonaMut.isPending ? <><Loader2 size={16} className="animate-spin" />Importing...</> : <><Upload size={16} />Import Persona</>}
              </button>
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

      {/* Confirm Delete Modal */}
      <ConfirmModal
        isOpen={confirmModal.type !== null}
        title={confirmModal.type === 'persona' ? 'Delete Persona' : 'Delete Document'}
        message={confirmModal.type === 'persona' 
          ? 'Are you sure you want to delete this persona? This action cannot be undone.'
          : 'Are you sure you want to delete this document? This action cannot be undone.'}
        confirmLabel="Delete"
        variant="danger"
        isLoading={confirmModal.type === 'persona' ? deletePersonaMut.isPending : deleteDocMut.isPending}
        onConfirm={() => {
          if (confirmModal.type === 'persona' && confirmModal.id) {
            deletePersonaMut.mutate(confirmModal.id, { onSettled: () => setConfirmModal({ type: null, id: null }) })
          } else if (confirmModal.type === 'document' && confirmModal.id) {
            deleteDocMut.mutate(confirmModal.id, { onSettled: () => setConfirmModal({ type: null, id: null }) })
          }
        }}
        onCancel={() => setConfirmModal({ type: null, id: null })}
      />
    </div>
  )
}
