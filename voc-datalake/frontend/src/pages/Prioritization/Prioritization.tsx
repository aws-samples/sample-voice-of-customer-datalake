/**
 * @fileoverview Feature prioritization page for PR/FAQ documents.
 * @module pages/Prioritization
 */

import { useState, useMemo, type ReactElement } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useBlocker } from 'react-router-dom'
import { ArrowUpDown, FileText, Sparkles, ChevronDown, ChevronUp, ExternalLink, Save, RotateCcw } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
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

const calculatePriorityScore = (score: PrioritizationScore): number => {
  return (score.impact * 0.4) + (score.time_to_market * 0.3) + (score.strategic_fit * 0.2) + (score.confidence * 0.1)
}

const getScoreColor = (score: number, max: number = 5): string => {
  const ratio = score / max
  if (ratio >= 0.8) return 'text-green-600 bg-green-50'
  if (ratio >= 0.6) return 'text-blue-600 bg-blue-50'
  if (ratio >= 0.4) return 'text-yellow-600 bg-yellow-50'
  return 'text-red-600 bg-red-50'
}

const getPriorityLabel = (score: number, t: (key: string) => string): { label: string; color: string } => {
  if (score >= 4) return { label: t('priority.high'), color: 'bg-green-100 text-green-800' }
  if (score >= 3) return { label: t('priority.medium'), color: 'bg-blue-100 text-blue-800' }
  if (score >= 2) return { label: t('priority.low'), color: 'bg-yellow-100 text-yellow-800' }
  return { label: t('priority.none'), color: 'bg-gray-100 text-gray-600' }
}

interface ScoreSliderProps {
  readonly label: string
  readonly value: number
  readonly onChange: (v: number) => void
  readonly description?: string
  readonly lowLabel?: string
  readonly highLabel?: string
  readonly inverted?: boolean
}

function ScoreSlider({ label, value, onChange, description, lowLabel = '1', highLabel = '5', inverted = false }: ScoreSliderProps) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <label className="text-sm font-medium text-gray-700">{label}</label>
        <span className={clsx('text-sm font-bold px-2 py-0.5 rounded', getScoreColor(inverted ? 6 - value : value))}>{value}</span>
      </div>
      {description && <p className="text-xs text-gray-500">{description}</p>}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400 w-16">{lowLabel}</span>
        <input type="range" min={1} max={5} value={value} onChange={(e) => onChange(Number(e.target.value))} className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600" />
        <span className="text-xs text-gray-400 w-16 text-right">{highLabel}</span>
      </div>
    </div>
  )
}

const DEFAULT_SCORE: PrioritizationScore = { document_id: '', impact: 0, time_to_market: 3, confidence: 0, strategic_fit: 0, notes: '' }

function getScore(scores: Record<string, PrioritizationScore>, docId: string): PrioritizationScore {
  return scores[docId] ?? { ...DEFAULT_SCORE, document_id: docId }
}

function collectPRFAQs(allProjectDetails: Array<{ documents?: ProjectDocument[] }> | undefined, projects: Project[] | undefined): PRFAQWithProject[] {
  if (!allProjectDetails || !projects) return []
  
  const result: PRFAQWithProject[] = []
  allProjectDetails.forEach((detail, index) => {
    if (!detail?.documents) return
    const project = projects[index]
    detail.documents
      .filter((doc: ProjectDocument) => doc.document_type === 'prfaq')
      .forEach((doc: ProjectDocument) => {
        result.push({ ...doc, project_id: project.project_id, project_name: project.name })
      })
  })
  return result
}

function comparePRFAQs(a: PRFAQWithProject, b: PRFAQWithProject, scores: Record<string, PrioritizationScore>, sortField: SortField): number {
  const scoreA = getScore(scores, a.document_id)
  const scoreB = getScore(scores, b.document_id)
  
  switch (sortField) {
    case 'priority_score': return calculatePriorityScore(scoreA) - calculatePriorityScore(scoreB)
    case 'impact': return scoreA.impact - scoreB.impact
    case 'time_to_market': return scoreA.time_to_market - scoreB.time_to_market
    case 'created_at': return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    case 'title': return a.title.localeCompare(b.title)
  }
}

function StatsCards({ allPRFAQs, scores }: { readonly allPRFAQs: PRFAQWithProject[]; readonly scores: Record<string, PrioritizationScore> }) {
  const { t } = useTranslation('prioritization')
  const highPriority = allPRFAQs.filter(p => { const s = scores[p.document_id]; return s && calculatePriorityScore(s) >= 4 }).length
  const mediumPriority = allPRFAQs.filter(p => { const s = scores[p.document_id]; return s && calculatePriorityScore(s) >= 3 && calculatePriorityScore(s) < 4 }).length
  const notScored = allPRFAQs.filter(p => !scores[p.document_id] || scores[p.document_id].impact === 0).length

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
      <div className="bg-white rounded-lg border p-4"><div className="text-2xl font-bold text-gray-900">{allPRFAQs.length}</div><div className="text-sm text-gray-500">{t('stats.totalPrfaqs')}</div></div>
      <div className="bg-white rounded-lg border p-4"><div className="text-2xl font-bold text-green-600">{highPriority}</div><div className="text-sm text-gray-500">{t('stats.highPriority')}</div></div>
      <div className="bg-white rounded-lg border p-4"><div className="text-2xl font-bold text-blue-600">{mediumPriority}</div><div className="text-sm text-gray-500">{t('stats.mediumPriority')}</div></div>
      <div className="bg-white rounded-lg border p-4"><div className="text-2xl font-bold text-gray-400">{notScored}</div><div className="text-sm text-gray-500">{t('stats.notScored')}</div></div>
    </div>
  )
}

function SortControls({ sortField, sortDirection, onToggleSort }: { readonly sortField: SortField; readonly sortDirection: SortDirection; readonly onToggleSort: (f: SortField) => void }) {
  const { t } = useTranslation('prioritization')
  const options = [
    { field: 'priority_score' as const, label: t('sort.priority'), fullLabel: t('sort.priorityFull') },
    { field: 'impact' as const, label: t('sort.impact'), fullLabel: t('sort.impact') },
    { field: 'time_to_market' as const, label: t('sort.ttm'), fullLabel: t('sort.ttmFull') },
    { field: 'created_at' as const, label: t('sort.date'), fullLabel: t('sort.dateFull') },
  ]
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-gray-500 w-full sm:w-auto">{t('sort.label')}</span>
      {options.map(({ field, label, fullLabel }) => (
        <button key={field} onClick={() => onToggleSort(field)} className={clsx('px-2 sm:px-3 py-1.5 rounded-lg flex items-center gap-1 text-xs sm:text-sm', sortField === field ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}>
          <span className="sm:hidden">{label}</span>
          <span className="hidden sm:inline">{fullLabel}</span>
          {sortField === field && <ArrowUpDown size={14} className={sortDirection === 'desc' ? 'rotate-180' : ''} />}
        </button>
      ))}
    </div>
  )
}

function QuickScores({ score }: { readonly score: PrioritizationScore }): ReactElement {
  const { t } = useTranslation('prioritization')
  const priorityScore = score.impact > 0 ? calculatePriorityScore(score) : 0
  const showTTM = score.time_to_market !== 3 || score.impact > 0
  return (
    <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-4">
      <div className="text-center">
        <div className={clsx('text-base sm:text-lg font-bold', score.impact > 0 ? 'text-blue-600' : 'text-gray-300')}>{score.impact || '-'}</div>
        <div className="text-xs text-gray-400">{t('scores.impact')}</div>
      </div>
      <div className="text-center">
        <div className={clsx('text-base sm:text-lg font-bold', showTTM ? 'text-purple-600' : 'text-gray-300')}>{score.impact > 0 ? score.time_to_market : '-'}</div>
        <div className="text-xs text-gray-400">{t('sort.ttm')}</div>
      </div>
      <div className="text-center px-2 sm:px-3 py-1 bg-gray-50 rounded-lg">
        <div className={clsx('text-lg sm:text-xl font-bold', priorityScore > 0 ? 'text-green-600' : 'text-gray-300')}>{priorityScore > 0 ? priorityScore.toFixed(1) : '-'}</div>
        <div className="text-xs text-gray-400">{t('scores.score')}</div>
      </div>
    </div>
  )
}

function PRFAQRow({ prfaq, index, score, isExpanded, onToggle, onUpdateScore }: {
  readonly prfaq: PRFAQWithProject
  readonly index: number
  readonly score: PrioritizationScore
  readonly isExpanded: boolean
  readonly onToggle: () => void
  readonly onUpdateScore: (field: keyof PrioritizationScore, value: number | string) => void
}) {
  const { t } = useTranslation('prioritization')
  const priorityScore = score.impact > 0 ? calculatePriorityScore(score) : 0
  const priority = getPriorityLabel(priorityScore, t)

  return (
    <div className="bg-white rounded-lg border shadow-sm">
      <div className="p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 cursor-pointer hover:bg-gray-50" onClick={onToggle}>
        <div className="flex items-center gap-3 sm:gap-4 flex-1 min-w-0">
          <div className="text-gray-400 font-mono text-sm w-6 hidden sm:block">#{index + 1}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-medium text-gray-900 truncate text-sm sm:text-base">{prfaq.title}</h3>
              <span className={clsx('text-xs px-2 py-0.5 rounded-full whitespace-nowrap', priority.color)}>{priority.label}</span>
            </div>
            <div className="flex items-center gap-2 sm:gap-3 mt-1 text-xs sm:text-sm text-gray-500">
              <span className="truncate">{prfaq.project_name}</span>
              <span>•</span>
              <span className="whitespace-nowrap">{format(new Date(prfaq.created_at), 'MMM d, yyyy')}</span>
            </div>
          </div>
        </div>
        <QuickScores score={score} />
        <div className="sm:ml-2">{isExpanded ? <ChevronUp size={20} className="text-gray-400" /> : <ChevronDown size={20} className="text-gray-400" />}</div>
      </div>

      {isExpanded && (
        <div className="border-t px-3 sm:px-4 py-4 bg-gray-50">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
            <div className="space-y-4">
              <h4 className="font-medium text-gray-900">{t('scores.title')}</h4>
              <ScoreSlider label={t('scores.impact')} value={score.impact || 3} onChange={(v) => onUpdateScore('impact', v)} description={t('scores.impactDescription')} lowLabel={t('scores.low')} highLabel={t('scores.high')} />
              <ScoreSlider label={t('scores.timeToMarket')} value={score.time_to_market || 3} onChange={(v) => onUpdateScore('time_to_market', v)} description={t('scores.timeToMarketDescription')} lowLabel={t('scores.slow')} highLabel={t('scores.fast')} />
              <ScoreSlider label={t('scores.strategicFit')} value={score.strategic_fit || 3} onChange={(v) => onUpdateScore('strategic_fit', v)} description={t('scores.strategicFitDescription')} lowLabel={t('scores.low')} highLabel={t('scores.high')} />
              <ScoreSlider label={t('scores.confidence')} value={score.confidence || 3} onChange={(v) => onUpdateScore('confidence', v)} description={t('scores.confidenceDescription')} lowLabel={t('scores.low')} highLabel={t('scores.high')} />
              <div>
                <label className="text-sm font-medium text-gray-700">{t('notes.label')}</label>
                <textarea value={score.notes || ''} onChange={(e) => onUpdateScore('notes', e.target.value)} placeholder={t('notes.placeholder')} rows={2} className="mt-1 w-full px-3 py-2 border rounded-lg text-sm" />
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-medium text-gray-900">{t('preview.title')}</h4>
                <a href={`/projects/${prfaq.project_id}`} className="text-sm text-blue-600 hover:underline flex items-center gap-1">
                  <span className="hidden sm:inline">{t('preview.viewFull')}</span>
                  <span className="sm:hidden">{t('preview.viewMobile')}</span>
                  <ExternalLink size={14} />
                </a>
              </div>
              <div className="bg-white rounded-lg border p-3 sm:p-4 max-h-48 sm:max-h-64 overflow-y-auto prose prose-sm">
                <ReactMarkdown>{prfaq.content?.slice(0, 1500) + (prfaq.content && prfaq.content.length > 1500 ? '...' : '')}</ReactMarkdown>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PRFAQList({ isLoading, prfaqs, scores, expandedId, onToggleExpand, onUpdateScore }: {
  readonly isLoading: boolean
  readonly prfaqs: PRFAQWithProject[]
  readonly scores: Record<string, PrioritizationScore>
  readonly expandedId: string | null
  readonly onToggleExpand: (id: string) => void
  readonly onUpdateScore: (docId: string, field: keyof PrioritizationScore, value: number | string) => void
}) {
  const { t } = useTranslation('prioritization')

  if (isLoading) {
    return <div className="text-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div><p className="text-gray-500 mt-4">{t('loading')}</p></div>
  }
  if (prfaqs.length === 0) {
    return <div className="text-center py-12 bg-white rounded-lg border"><FileText size={48} className="mx-auto text-gray-300 mb-4" /><h3 className="text-lg font-medium text-gray-900">{t('empty.title')}</h3><p className="text-gray-500 mt-1">{t('empty.description')}</p></div>
  }
  return (
    <div className="space-y-3">
      {prfaqs.map((prfaq, index) => (
        <PRFAQRow
          key={prfaq.document_id}
          prfaq={prfaq}
          index={index}
          score={getScore(scores, prfaq.document_id)}
          isExpanded={expandedId === prfaq.document_id}
          onToggle={() => onToggleExpand(prfaq.document_id)}
          onUpdateScore={(field, value) => onUpdateScore(prfaq.document_id, field, value)}
        />
      ))}
    </div>
  )
}

export default function Prioritization() {
  const { t } = useTranslation('prioritization')
  const { config } = useConfigStore()
  const queryClient = useQueryClient()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sortField, setSortField] = useState<SortField>('priority_score')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [scores, setScores] = useState<Record<string, PrioritizationScore>>({})
  const [changedDocIds, setChangedDocIds] = useState<Set<string>>(new Set())
  const [initialized, setInitialized] = useState(false)

  const hasChanges = changedDocIds.size > 0

  const { data: projectsData, isLoading: loadingProjects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.getProjects(),
    enabled: !!config.apiEndpoint,
  })

  const projects = projectsData?.projects
  const projectIds = Array.isArray(projects) ? projects.map((p: Project) => p.project_id) : []

  const { data: allProjectDetails, isLoading: loadingDetails } = useQuery({
    queryKey: ['all-project-details', projectIds],
    queryFn: () => Promise.all(projectIds.map(id => api.getProject(id))),
    enabled: projectIds.length > 0,
  })

  const { data: savedScores } = useQuery({
    queryKey: ['prioritization-scores'],
    queryFn: () => api.getPrioritizationScores(),
    enabled: !!config.apiEndpoint,
  })

  // Initialize scores from saved data - only on first load
  const initialScores = useMemo(() => {
    if (!initialized && savedScores?.scores) {
      return savedScores.scores
    }
    return null
  }, [savedScores, initialized])

  // Apply initial scores once
  if (initialScores && !initialized) {
    setScores(initialScores)
    setInitialized(true)
  }

  const allPRFAQs = useMemo(() => collectPRFAQs(allProjectDetails, projects), [allProjectDetails, projects])

  const sortedPRFAQs = useMemo(() => {
    const sorted = [...allPRFAQs].sort((a, b) => comparePRFAQs(a, b, scores, sortField))
    return sortDirection === 'desc' ? sorted.reverse() : sorted
  }, [allPRFAQs, scores, sortField, sortDirection])

  const saveMutation = useMutation({
    mutationFn: () => {
      const changedScores: Record<string, PrioritizationScore> = {}
      changedDocIds.forEach(docId => {
        if (scores[docId]) {
          changedScores[docId] = scores[docId]
        }
      })
      return api.patchPrioritizationScores(changedScores)
    },
    onSuccess: () => { 
      setChangedDocIds(new Set())
      queryClient.invalidateQueries({ queryKey: ['prioritization-scores'] }) 
    },
  })

  const blocker = useBlocker(hasChanges)

  const updateScore = (docId: string, field: keyof PrioritizationScore, value: number | string) => {
    setScores(prev => ({
      ...prev,
      [docId]: { ...getScore(prev, docId), [field]: value }
    }))
    setChangedDocIds(prev => new Set(prev).add(docId))
  }

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('desc')
    }
  }

  const handleReset = () => {
    setScores(savedScores?.scores ?? {})
    setChangedDocIds(new Set())
  }

  if (!config.apiEndpoint) {
    return <div className="text-center py-12"><p className="text-gray-500">{t('configureApiEndpoint')}</p></div>
  }

  const isLoading = loadingProjects || loadingDetails

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-sm sm:text-base text-gray-500 mt-1">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          {hasChanges && (
            <button onClick={handleReset} className="flex items-center gap-2 px-3 sm:px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm">
              <RotateCcw size={16} /><span className="hidden sm:inline">{t('actions.reset')}</span>
            </button>
          )}
          <button onClick={() => saveMutation.mutate()} disabled={!hasChanges || saveMutation.isPending} className={clsx('flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg font-medium text-sm', hasChanges ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed')}>
            <Save size={16} />
            <span className="hidden sm:inline">{saveMutation.isPending ? t('actions.saving') : t('actions.save')}</span>
            <span className="sm:hidden">{saveMutation.isPending ? t('actions.savingMobile') : t('actions.saveMobile')}</span>
          </button>
        </div>
      </div>

      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-3 sm:p-4 border border-blue-100">
        <div className="flex items-start gap-3">
          <Sparkles className="text-blue-600 mt-0.5 flex-shrink-0" size={20} />
          <div>
            <h3 className="font-medium text-blue-900 text-sm sm:text-base">{t('framework.title')}</h3>
            <p className="text-xs sm:text-sm text-blue-700 mt-1">
              <Trans i18nKey="framework.description" ns="prioritization">
                Score each PR/FAQ on: <strong>Impact</strong>, <strong>Time to Market</strong>, <strong>Strategic Fit</strong>, and <strong>Confidence</strong>.
              </Trans>
            </p>
          </div>
        </div>
      </div>

      <StatsCards allPRFAQs={allPRFAQs} scores={scores} />
      <SortControls sortField={sortField} sortDirection={sortDirection} onToggleSort={toggleSort} />

      <PRFAQList
        isLoading={isLoading}
        prfaqs={sortedPRFAQs}
        scores={scores}
        expandedId={expandedId}
        onToggleExpand={(id) => setExpandedId(expandedId === id ? null : id)}
        onUpdateScore={updateScore}
      />

      <ConfirmModal
        isOpen={blocker.state === 'blocked'}
        title={t('unsavedChanges.title')}
        message={t('unsavedChanges.message')}
        confirmLabel={t('unsavedChanges.confirm')}
        cancelLabel={t('unsavedChanges.cancel')}
        variant="warning"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </div>
  )
}
