/**
 * @fileoverview Feature prioritization page for PR/FAQ documents.
 *
 * Features:
 * - Score PR/FAQs on impact, time-to-market, strategic fit, confidence
 * - Weighted priority score calculation
 * - Sortable table with expandable document previews
 * - Unsaved changes warning with navigation blocker
 * - Persist scores to backend
 *
 * @module pages/Prioritization
 */

import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useBlocker } from 'react-router-dom'
import { ArrowUpDown, FileText, Sparkles, ChevronDown, ChevronUp, ExternalLink, Save, RotateCcw } from 'lucide-react'
import { api } from '../../api/client'
import type { Project, ProjectDocument, PrioritizationScore } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { format } from 'date-fns'
import clsx from 'clsx'
import ReactMarkdown from 'react-markdown'
import ConfirmModal from '../../components/ConfirmModal'

interface PRFAQWithProject extends ProjectDocument {
  project_id: string
  project_name: string
}

type SortField = 'priority_score' | 'impact' | 'time_to_market' | 'created_at' | 'title'
type SortDirection = 'asc' | 'desc'

// Priority score calculation: higher impact + faster time to market = higher priority
const calculatePriorityScore = (score: PrioritizationScore): number => {
  // Impact is positive (higher = better), time_to_market is inverted (lower = faster = better)
  // Weight: Impact 40%, Time to Market 30%, Strategic Fit 20%, Confidence 10%
  const timeScore = 6 - score.time_to_market // Invert: 1 becomes 5, 5 becomes 1
  return (score.impact * 0.4) + (timeScore * 0.3) + (score.strategic_fit * 0.2) + (score.confidence * 0.1)
}

const getScoreColor = (score: number, max: number = 5): string => {
  const ratio = score / max
  if (ratio >= 0.8) return 'text-green-600 bg-green-50'
  if (ratio >= 0.6) return 'text-blue-600 bg-blue-50'
  if (ratio >= 0.4) return 'text-yellow-600 bg-yellow-50'
  return 'text-red-600 bg-red-50'
}

const getPriorityLabel = (score: number): { label: string; color: string } => {
  if (score >= 4) return { label: 'High Priority', color: 'bg-green-100 text-green-800' }
  if (score >= 3) return { label: 'Medium Priority', color: 'bg-blue-100 text-blue-800' }
  if (score >= 2) return { label: 'Low Priority', color: 'bg-yellow-100 text-yellow-800' }
  return { label: 'Not Scored', color: 'bg-gray-100 text-gray-600' }
}

function ScoreSlider({ 
  label, 
  value, 
  onChange, 
  description,
  lowLabel = '1',
  highLabel = '5',
  inverted = false
}: { 
  label: string
  value: number
  onChange: (v: number) => void
  description?: string
  lowLabel?: string
  highLabel?: string
  inverted?: boolean
}) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <label className="text-sm font-medium text-gray-700">{label}</label>
        <span className={clsx('text-sm font-bold px-2 py-0.5 rounded', getScoreColor(inverted ? 6 - value : value))}>
          {value}
        </span>
      </div>
      {description && <p className="text-xs text-gray-500">{description}</p>}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400 w-16">{lowLabel}</span>
        <input
          type="range"
          min={1}
          max={5}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
        />
        <span className="text-xs text-gray-400 w-16 text-right">{highLabel}</span>
      </div>
    </div>
  )
}

export default function Prioritization() {
  const { config } = useConfigStore()
  const queryClient = useQueryClient()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sortField, setSortField] = useState<SortField>('priority_score')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [scores, setScores] = useState<Record<string, PrioritizationScore>>({})
  const [hasChanges, setHasChanges] = useState(false)

  // Fetch all projects
  const { data: projectsData, isLoading: loadingProjects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.getProjects(),
    enabled: !!config.apiEndpoint,
  })

  // Fetch all project details to get PR/FAQs
  const projectIds = projectsData?.projects?.map((p: Project) => p.project_id) || []
  
  const { data: allProjectDetails, isLoading: loadingDetails } = useQuery({
    queryKey: ['all-project-details', projectIds],
    queryFn: async () => {
      const details = await Promise.all(
        projectIds.map((id: string) => api.getProject(id))
      )
      return details
    },
    enabled: projectIds.length > 0,
  })

  // Fetch saved prioritization scores
  const { data: savedScores } = useQuery({
    queryKey: ['prioritization-scores'],
    queryFn: () => api.getPrioritizationScores(),
    enabled: !!config.apiEndpoint,
  })

  // Initialize scores from saved data
  const [initialized, setInitialized] = useState(false)
  useMemo(() => {
    if (savedScores?.scores && !initialized) {
      setScores(savedScores.scores)
      setInitialized(true)
    }
  }, [savedScores, initialized])

  // Collect all PR/FAQs across projects
  const allPRFAQs: PRFAQWithProject[] = useMemo(() => {
    if (!allProjectDetails || !projectsData?.projects) return []
    
    const prfaqs: PRFAQWithProject[] = []
    allProjectDetails.forEach((detail, index) => {
      if (!detail?.documents) return
      const project = projectsData.projects[index]
      
      detail.documents
        .filter((doc: ProjectDocument) => doc.document_type === 'prfaq')
        .forEach((doc: ProjectDocument) => {
          prfaqs.push({
            ...doc,
            project_id: project.project_id,
            project_name: project.name,
          })
        })
    })
    return prfaqs
  }, [allProjectDetails, projectsData])

  // Sort PR/FAQs
  const sortedPRFAQs = useMemo(() => {
    return [...allPRFAQs].sort((a, b) => {
      const scoreA = scores[a.document_id] || { impact: 0, time_to_market: 3, confidence: 0, strategic_fit: 0, notes: '' }
      const scoreB = scores[b.document_id] || { impact: 0, time_to_market: 3, confidence: 0, strategic_fit: 0, notes: '' }
      
      let comparison = 0
      switch (sortField) {
        case 'priority_score':
          comparison = calculatePriorityScore(scoreA) - calculatePriorityScore(scoreB)
          break
        case 'impact':
          comparison = scoreA.impact - scoreB.impact
          break
        case 'time_to_market':
          comparison = scoreA.time_to_market - scoreB.time_to_market
          break
        case 'created_at':
          comparison = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          break
        case 'title':
          comparison = a.title.localeCompare(b.title)
          break
      }
      return sortDirection === 'desc' ? -comparison : comparison
    })
  }, [allPRFAQs, scores, sortField, sortDirection])

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: () => api.savePrioritizationScores(scores),
    onSuccess: () => {
      setHasChanges(false)
      queryClient.invalidateQueries({ queryKey: ['prioritization-scores'] })
    },
  })

  // Block navigation when there are unsaved changes
  const blocker = useBlocker(hasChanges)

  const updateScore = (docId: string, field: keyof PrioritizationScore, value: number | string) => {
    setScores(prev => {
      const existing = prev[docId] || {
        document_id: docId,
        impact: 3,
        time_to_market: 3,
        confidence: 3,
        strategic_fit: 3,
        notes: '',
      }
      return {
        ...prev,
        [docId]: {
          ...existing,
          [field]: value,
        }
      }
    })
    setHasChanges(true)
  }

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('desc')
    }
  }

  const isLoading = loadingProjects || loadingDetails

  if (!config.apiEndpoint) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Configure API endpoint in Settings to view prioritization.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">PR/FAQ Prioritization</h1>
          <p className="text-sm sm:text-base text-gray-500 mt-1">
            Score and prioritize PR/FAQs across all projects
          </p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          {hasChanges && (
            <button
              onClick={() => {
                setScores(savedScores?.scores || {})
                setHasChanges(false)
              }}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm"
            >
              <RotateCcw size={16} />
              <span className="hidden sm:inline">Reset</span>
            </button>
          )}
          <button
            onClick={() => saveMutation.mutate()}
            disabled={!hasChanges || saveMutation.isPending}
            className={clsx(
              'flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg font-medium text-sm',
              hasChanges 
                ? 'bg-blue-600 text-white hover:bg-blue-700' 
                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
            )}
          >
            <Save size={16} />
            <span className="hidden sm:inline">{saveMutation.isPending ? 'Saving...' : 'Save Scores'}</span>
            <span className="sm:hidden">{saveMutation.isPending ? '...' : 'Save'}</span>
          </button>
        </div>
      </div>

      {/* Framework Info */}
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-3 sm:p-4 border border-blue-100">
        <div className="flex items-start gap-3">
          <Sparkles className="text-blue-600 mt-0.5 flex-shrink-0" size={20} />
          <div>
            <h3 className="font-medium text-blue-900 text-sm sm:text-base">Prioritization Framework</h3>
            <p className="text-xs sm:text-sm text-blue-700 mt-1">
              Score each PR/FAQ on: <strong>Impact</strong>, <strong>Time to Market</strong>, <strong>Strategic Fit</strong>, and <strong>Confidence</strong>.
            </p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-white rounded-lg border p-4">
          <div className="text-2xl font-bold text-gray-900">{allPRFAQs.length}</div>
          <div className="text-sm text-gray-500">Total PR/FAQs</div>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <div className="text-2xl font-bold text-green-600">
            {allPRFAQs.filter(p => {
              const s = scores[p.document_id]
              return s && calculatePriorityScore(s) >= 4
            }).length}
          </div>
          <div className="text-sm text-gray-500">High Priority</div>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <div className="text-2xl font-bold text-blue-600">
            {allPRFAQs.filter(p => {
              const s = scores[p.document_id]
              return s && calculatePriorityScore(s) >= 3 && calculatePriorityScore(s) < 4
            }).length}
          </div>
          <div className="text-sm text-gray-500">Medium Priority</div>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <div className="text-2xl font-bold text-gray-400">
            {allPRFAQs.filter(p => !scores[p.document_id] || scores[p.document_id].impact === 0).length}
          </div>
          <div className="text-sm text-gray-500">Not Scored</div>
        </div>
      </div>

      {/* Sort Controls */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-gray-500 w-full sm:w-auto">Sort by:</span>
        {[
          { field: 'priority_score' as SortField, label: 'Priority', fullLabel: 'Priority Score' },
          { field: 'impact' as SortField, label: 'Impact', fullLabel: 'Impact' },
          { field: 'time_to_market' as SortField, label: 'TTM', fullLabel: 'Time to Market' },
          { field: 'created_at' as SortField, label: 'Date', fullLabel: 'Date Created' },
        ].map(({ field, label, fullLabel }) => (
          <button
            key={field}
            onClick={() => toggleSort(field)}
            className={clsx(
              'px-2 sm:px-3 py-1.5 rounded-lg flex items-center gap-1 text-xs sm:text-sm',
              sortField === field ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            )}
          >
            <span className="sm:hidden">{label}</span>
            <span className="hidden sm:inline">{fullLabel}</span>
            {sortField === field && (
              <ArrowUpDown size={14} className={sortDirection === 'desc' ? 'rotate-180' : ''} />
            )}
          </button>
        ))}
      </div>

      {/* PR/FAQ List */}
      {isLoading ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
          <p className="text-gray-500 mt-4">Loading PR/FAQs...</p>
        </div>
      ) : allPRFAQs.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border">
          <FileText size={48} className="mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-900">No PR/FAQs Found</h3>
          <p className="text-gray-500 mt-1">Create PR/FAQs in your projects to start prioritizing.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sortedPRFAQs.map((prfaq, index) => {
            const score = scores[prfaq.document_id] || { 
              document_id: prfaq.document_id, 
              impact: 0, 
              time_to_market: 3, 
              confidence: 0, 
              strategic_fit: 0, 
              notes: '' 
            }
            const priorityScore = score.impact > 0 ? calculatePriorityScore(score) : 0
            const priority = getPriorityLabel(priorityScore)
            const isExpanded = expandedId === prfaq.document_id

            return (
              <div key={prfaq.document_id} className="bg-white rounded-lg border shadow-sm">
                {/* Header Row */}
                <div 
                  className="p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 cursor-pointer hover:bg-gray-50"
                  onClick={() => setExpandedId(isExpanded ? null : prfaq.document_id)}
                >
                  <div className="flex items-center gap-3 sm:gap-4 flex-1 min-w-0">
                    <div className="text-gray-400 font-mono text-sm w-6 hidden sm:block">#{index + 1}</div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium text-gray-900 truncate text-sm sm:text-base">{prfaq.title}</h3>
                        <span className={clsx('text-xs px-2 py-0.5 rounded-full whitespace-nowrap', priority.color)}>
                          {priority.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 sm:gap-3 mt-1 text-xs sm:text-sm text-gray-500">
                        <span className="truncate">{prfaq.project_name}</span>
                        <span>•</span>
                        <span className="whitespace-nowrap">{format(new Date(prfaq.created_at), 'MMM d, yyyy')}</span>
                      </div>
                    </div>
                  </div>

                  {/* Quick Scores */}
                  <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-4">
                    <div className="text-center">
                      <div className={clsx('text-base sm:text-lg font-bold', score.impact > 0 ? 'text-blue-600' : 'text-gray-300')}>
                        {score.impact || '-'}
                      </div>
                      <div className="text-xs text-gray-400">Impact</div>
                    </div>
                    <div className="text-center">
                      <div className={clsx('text-base sm:text-lg font-bold', score.time_to_market !== 3 || score.impact > 0 ? 'text-purple-600' : 'text-gray-300')}>
                        {score.impact > 0 ? score.time_to_market : '-'}
                      </div>
                      <div className="text-xs text-gray-400">TTM</div>
                    </div>
                    <div className="text-center px-2 sm:px-3 py-1 bg-gray-50 rounded-lg">
                      <div className={clsx('text-lg sm:text-xl font-bold', priorityScore > 0 ? 'text-green-600' : 'text-gray-300')}>
                        {priorityScore > 0 ? priorityScore.toFixed(1) : '-'}
                      </div>
                      <div className="text-xs text-gray-400">Score</div>
                    </div>
                    <div className="sm:ml-2">
                      {isExpanded ? <ChevronUp size={20} className="text-gray-400" /> : <ChevronDown size={20} className="text-gray-400" />}
                    </div>
                  </div>
                </div>

                {/* Expanded Content */}
                {isExpanded && (
                  <div className="border-t px-3 sm:px-4 py-4 bg-gray-50">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
                      {/* Scoring Panel */}
                      <div className="space-y-4">
                        <h4 className="font-medium text-gray-900">Prioritization Scores</h4>
                        
                        <ScoreSlider
                          label="Impact"
                          value={score.impact || 3}
                          onChange={(v) => updateScore(prfaq.document_id, 'impact', v)}
                          description="Business value and customer benefit"
                          lowLabel="Low"
                          highLabel="High"
                        />
                        
                        <ScoreSlider
                          label="Time to Market"
                          value={score.time_to_market || 3}
                          onChange={(v) => updateScore(prfaq.document_id, 'time_to_market', v)}
                          description="How quickly can this be delivered?"
                          lowLabel="Fast"
                          highLabel="Slow"
                          inverted
                        />
                        
                        <ScoreSlider
                          label="Strategic Fit"
                          value={score.strategic_fit || 3}
                          onChange={(v) => updateScore(prfaq.document_id, 'strategic_fit', v)}
                          description="Alignment with company goals"
                          lowLabel="Low"
                          highLabel="High"
                        />
                        
                        <ScoreSlider
                          label="Confidence"
                          value={score.confidence || 3}
                          onChange={(v) => updateScore(prfaq.document_id, 'confidence', v)}
                          description="Certainty in impact and TTM estimates"
                          lowLabel="Low"
                          highLabel="High"
                        />

                        <div>
                          <label className="text-sm font-medium text-gray-700">Notes</label>
                          <textarea
                            value={score.notes || ''}
                            onChange={(e) => updateScore(prfaq.document_id, 'notes', e.target.value)}
                            placeholder="Add notes about this prioritization decision..."
                            rows={2}
                            className="mt-1 w-full px-3 py-2 border rounded-lg text-sm"
                          />
                        </div>
                      </div>

                      {/* Preview Panel */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h4 className="font-medium text-gray-900">PR/FAQ Preview</h4>
                          <a 
                            href={`/projects/${prfaq.project_id}`}
                            className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                          >
                            <span className="hidden sm:inline">View Full Document</span>
                            <span className="sm:hidden">View</span>
                            <ExternalLink size={14} />
                          </a>
                        </div>
                        <div className="bg-white rounded-lg border p-3 sm:p-4 max-h-48 sm:max-h-64 overflow-y-auto prose prose-sm">
                          <ReactMarkdown>
                            {prfaq.content?.slice(0, 1500) + (prfaq.content?.length > 1500 ? '...' : '')}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Unsaved Changes Modal */}
      <ConfirmModal
        isOpen={blocker.state === 'blocked'}
        title="Unsaved Changes"
        message="You have unsaved prioritization scores. Do you want to discard your changes and leave this page?"
        confirmLabel="Discard Changes"
        cancelLabel="Stay on Page"
        variant="warning"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </div>
  )
}
