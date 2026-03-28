/**
 * @fileoverview Feature prioritization page for PR/FAQ documents.
 * @module pages/Prioritization
 */

import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import clsx from 'clsx'
import {
  ArrowUpDown, FileText, Sparkles, Save, RotateCcw,
} from 'lucide-react'
import {
  useState, useMemo,
} from 'react'
import {
  useTranslation, Trans,
} from 'react-i18next'
import { useBlocker } from 'react-router-dom'
import { api } from '../../api/client'
import { projectsApi } from '../../api/projectsApi'
import ConfirmModal from '../../components/ConfirmModal'
import { useConfigStore } from '../../store/configStore'
import PRFAQRow from './PRFAQRow'
import {
  calculatePriorityScore, getScore, collectPRFAQs, comparePRFAQs,
} from './prioritizationUtils'
import type {
  PRFAQWithProject, SortField, SortDirection,
} from './prioritizationUtils'
import type {
  Project, PrioritizationScore,
} from '../../api/types'

function StatsCards({
  allPRFAQs, scores,
}: {
  readonly allPRFAQs: PRFAQWithProject[];
  readonly scores: Record<string, PrioritizationScore>
}) {
  const { t } = useTranslation('prioritization')
  const highPriority = allPRFAQs.filter((p) => {
    const s = getScore(scores, p.document_id); return calculatePriorityScore(s) >= 4
  }).length
  const mediumPriority = allPRFAQs.filter((p) => {
    const s = getScore(scores, p.document_id); return calculatePriorityScore(s) >= 3 && calculatePriorityScore(s) < 4
  }).length
  const notScored = allPRFAQs.filter((p) => getScore(scores, p.document_id).impact === 0).length

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
      <div className="bg-white rounded-lg border p-4"><div className="text-2xl font-bold text-gray-900">{allPRFAQs.length}</div><div className="text-sm text-gray-500">{t('stats.totalPrfaqs')}</div></div>
      <div className="bg-white rounded-lg border p-4"><div className="text-2xl font-bold text-green-600">{highPriority}</div><div className="text-sm text-gray-500">{t('stats.highPriority')}</div></div>
      <div className="bg-white rounded-lg border p-4"><div className="text-2xl font-bold text-blue-600">{mediumPriority}</div><div className="text-sm text-gray-500">{t('stats.mediumPriority')}</div></div>
      <div className="bg-white rounded-lg border p-4"><div className="text-2xl font-bold text-gray-400">{notScored}</div><div className="text-sm text-gray-500">{t('stats.notScored')}</div></div>
    </div>
  )
}

function SortControls({
  sortField, sortDirection, onToggleSort,
}: {
  readonly sortField: SortField;
  readonly sortDirection: SortDirection;
  readonly onToggleSort: (f: SortField) => void
}) {
  const { t } = useTranslation('prioritization')
  const options = [
    {
      field: 'priority_score' as const,
      label: t('sort.priority'),
      fullLabel: t('sort.priorityFull'),
    },
    {
      field: 'impact' as const,
      label: t('sort.impact'),
      fullLabel: t('sort.impact'),
    },
    {
      field: 'time_to_market' as const,
      label: t('sort.ttm'),
      fullLabel: t('sort.ttmFull'),
    },
    {
      field: 'created_at' as const,
      label: t('sort.date'),
      fullLabel: t('sort.dateFull'),
    },
  ]
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-gray-500 w-full sm:w-auto">{t('sort.label')}</span>
      {options.map(({
        field, label, fullLabel,
      }) => (
        <button key={field} onClick={() => onToggleSort(field)} className={clsx('px-2 sm:px-3 py-1.5 rounded-lg flex items-center gap-1 text-xs sm:text-sm', sortField === field ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}>
          <span className="sm:hidden">{label}</span>
          <span className="hidden sm:inline">{fullLabel}</span>
          {sortField === field && <ArrowUpDown size={14} className={sortDirection === 'desc' ? 'rotate-180' : ''} />}
        </button>
      ))}
    </div>
  )
}

function PRFAQList({
  isLoading, prfaqs, scores, expandedId, onToggleExpand, onUpdateScore,
}: {
  readonly isLoading: boolean
  readonly prfaqs: PRFAQWithProject[]
  readonly scores: Record<string, PrioritizationScore>
  readonly expandedId: string | null
  readonly onToggleExpand: (id: string) => void
  readonly onUpdateScore: (docId: string, field: keyof PrioritizationScore, value: number | string) => void
}) {
  const { t } = useTranslation('prioritization')

  if (isLoading) {
    return <div className="text-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" /><p className="text-gray-500 mt-4">{t('loading')}</p></div>
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

function PrioritizationHeader({
  hasChanges, isPending, onReset, onSave,
}: {
  readonly hasChanges: boolean
  readonly isPending: boolean
  readonly onReset: () => void
  readonly onSave: () => void
}) {
  const { t } = useTranslation('prioritization')
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('title')}</h1>
        <p className="text-sm sm:text-base text-gray-500 mt-1">{t('subtitle')}</p>
      </div>
      <div className="flex items-center gap-2 sm:gap-3">
        {hasChanges ? <button onClick={onReset} className="flex items-center gap-2 px-3 sm:px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm">
          <RotateCcw size={16} /><span className="hidden sm:inline">{t('actions.reset')}</span>
        </button> : null}
        <button onClick={onSave} disabled={!hasChanges || isPending} className={clsx('flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg font-medium text-sm', hasChanges ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed')}>
          <Save size={16} />
          <span className="hidden sm:inline">{isPending ? t('actions.saving') : t('actions.save')}</span>
          <span className="sm:hidden">{isPending ? t('actions.savingMobile') : t('actions.saveMobile')}</span>
        </button>
      </div>
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

  const {
    data: projectsData, isLoading: loadingProjects,
  } = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsApi.getProjects(),
    enabled: config.apiEndpoint.length > 0,
  })

  const projects = projectsData?.projects
  const projectIds = Array.isArray(projects) ? projects.map((p: Project) => p.project_id) : []

  const {
    data: allProjectDetails, isLoading: loadingDetails,
  } = useQuery({
    queryKey: ['all-project-details', projectIds],
    queryFn: () => Promise.all(projectIds.map((id) => projectsApi.getProject(id))),
    enabled: projectIds.length > 0,
  })

  const { data: savedScores } = useQuery({
    queryKey: ['prioritization-scores'],
    queryFn: () => api.getPrioritizationScores(),
    enabled: config.apiEndpoint.length > 0,
  })

  const initialScores = useMemo(() => {
    if (!initialized && savedScores?.scores) {
      return savedScores.scores
    }
    return null
  }, [savedScores, initialized])

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
      for (const docId of changedDocIds) {
        changedScores[docId] = getScore(scores, docId)
      }
      return api.patchPrioritizationScores(changedScores)
    },
    onSuccess: () => {
      setChangedDocIds(new Set())
      void queryClient.invalidateQueries({ queryKey: ['prioritization-scores'] })
    },
  })

  const blocker = useBlocker(hasChanges)

  const updateScore = (docId: string, field: keyof PrioritizationScore, value: number | string) => {
    setScores((prev) => ({
      ...prev,
      [docId]: {
        ...getScore(prev, docId),
        [field]: value,
      },
    }))
    setChangedDocIds((prev) => new Set(prev).add(docId))
  }

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((d) => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('desc')
    }
  }

  const handleReset = () => {
    setScores(savedScores?.scores ?? {})
    setChangedDocIds(new Set())
  }

  if (config.apiEndpoint === '') {
    return <div className="text-center py-12"><p className="text-gray-500">{t('configureApiEndpoint')}</p></div>
  }

  const isLoading = loadingProjects || loadingDetails

  return (
    <div className="space-y-4 sm:space-y-6">
      <PrioritizationHeader hasChanges={hasChanges} isPending={saveMutation.isPending} onReset={handleReset} onSave={() => saveMutation.mutate()} />

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
