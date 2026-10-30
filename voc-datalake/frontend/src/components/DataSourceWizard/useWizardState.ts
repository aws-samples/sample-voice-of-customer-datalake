/**
 * @fileoverview Custom hook for DataSourceWizard state management.
 * @module components/DataSourceWizard/useWizardState
 */

import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ProjectDocument } from '../../api/types'
import type { ProjectPersona } from '../../api/projectTypes'
import { api } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { SOURCES as DEFAULT_SOURCES, CATEGORIES } from '../../constants/filters'
import type { CategoryOption, ContextConfig } from './types'
import { sourceListDays } from './sourceListWindow'
import { categoryLabel } from '../../utils/displayLabels'
import { useViewerScope } from '../ScopeNotice/useViewerScope'
import { categoriesConfigKey } from '../../hooks/useCategories'
import { ignoreRejection } from '../../lib/rejections'
import { noCleanup } from '../../hooks/noCleanup'

interface UseWizardStateProps {
  readonly personas: ReadonlyArray<ProjectPersona>
  readonly documents: ReadonlyArray<ProjectDocument>
  readonly contextConfig: ContextConfig
  readonly combineDocuments: boolean
  readonly hideDataSources: ReadonlyArray<'feedback' | 'personas' | 'documents' | 'research'>
}

function calculateTotalSteps(needsFeedbackFilters: boolean, needsItemSelection: boolean): number {
  return 1 + (needsFeedbackFilters ? 1 : 0) + (needsItemSelection ? 1 : 0) + 1
}

function calculateItemSelectionStep(needsFeedbackFilters: boolean, needsItemSelection: boolean): number {
  if (!needsItemSelection) return -1
  return needsFeedbackFilters ? 3 : 2
}

function getStepContent(
  step: number,
  needsFeedbackFilters: boolean,
  needsItemSelection: boolean
): string {
  if (step === 1) return 'dataSources'
  
  const feedbackFilterStep = needsFeedbackFilters ? 2 : -1
  const itemSelectionStep = calculateItemSelectionStep(needsFeedbackFilters, needsItemSelection)
  
  if (step === feedbackFilterStep) return 'feedbackFilters'
  if (step === itemSelectionStep) return 'itemSelection'
  
  return 'final'
}

function checkNeedsItemSelection(
  contextConfig: ContextConfig,
  personas: ReadonlyArray<ProjectPersona>,
  documents: ReadonlyArray<ProjectDocument>,
  otherDocs: ReadonlyArray<ProjectDocument>,
  researchDocs: ReadonlyArray<ProjectDocument>,
  combineDocuments: boolean
): boolean {
  if (checkPersonasNeeded(contextConfig, personas)) return true
  if (checkCombinedDocsNeeded(contextConfig, documents, combineDocuments)) return true
  if (checkOtherDocsNeeded(contextConfig, otherDocs, combineDocuments)) return true
  if (checkResearchDocsNeeded(contextConfig, researchDocs, combineDocuments)) return true
  return false
}

function checkPersonasNeeded(contextConfig: ContextConfig, personas: ReadonlyArray<ProjectPersona>): boolean {
  return contextConfig.usePersonas && personas.length > 0
}

function checkCombinedDocsNeeded(
  contextConfig: ContextConfig,
  documents: ReadonlyArray<ProjectDocument>,
  combineDocuments: boolean
): boolean {
  return combineDocuments && (contextConfig.useDocuments || contextConfig.useResearch) && documents.length > 0
}

function checkOtherDocsNeeded(
  contextConfig: ContextConfig,
  otherDocs: ReadonlyArray<ProjectDocument>,
  combineDocuments: boolean
): boolean {
  return !combineDocuments && contextConfig.useDocuments && otherDocs.length > 0
}

function checkResearchDocsNeeded(
  contextConfig: ContextConfig,
  researchDocs: ReadonlyArray<ProjectDocument>,
  combineDocuments: boolean
): boolean {
  return !combineDocuments && contextConfig.useResearch && researchDocs.length > 0
}

export function useWizardState({
  personas,
  documents,
  contextConfig,
  combineDocuments,
  hideDataSources,
}: UseWizardStateProps) {
  const [step, setStep] = useState(1)
  const [sources, setSources] = useState<string[]>(DEFAULT_SOURCES)
  const { config } = useConfigStore()

  const { data: categoriesData, isLoading: loadingCategories } = useQuery({
    queryKey: categoriesConfigKey(),
    queryFn: () => api.getCategoriesConfig(),
    enabled: !!config.apiEndpoint,
  })
  const { scope } = useViewerScope()
  // The built-in names stand in for an install with no category config — but
  // only for someone known to see every category. For a restricted viewer an
  // empty (scoped) config means "none of yours", and the built-in list would
  // name categories outside their access (owner rule 2026-10-21).
  const builtInFallback = scope?.kind === 'all'

  // `value` is what the backend filters on: the category NAME, which is what a
  // review stores in `category` (shared/feedback.py). A configured category's
  // `id` is an editor key (`cat_<uuid>` for one added on the Categories page)
  // and matches no review, so it never reaches the request.
  const categories = useMemo<ReadonlyArray<CategoryOption>>(() => {
    const configured = categoriesData?.categories ?? []
    if (configured.length > 0) {
      return configured.map(c => ({ value: c.name, label: categoryLabel(c.name, configured) }))
    }
    return builtInFallback ? CATEGORIES.map(c => ({ value: c, label: categoryLabel(c) })) : []
  }, [categoriesData, builtInFallback])

  const listDays = sourceListDays(contextConfig.days)
  useEffect(() => {
    if (!config.apiEndpoint) return noCleanup
    // The window changes with the selection, so an older, slower response must
    // not overwrite the list for the window now selected.
    const stale = new AbortController()
    
    api.getSources({ days: listDays }).then(data => {
      // Busiest source first. A response without `sources` throws here and
      // lands in the catch below, which keeps the defaults.
      const apiSources = Object.entries(data.sources)
        .sort(([, a], [, b]) => b - a)
        .map(([source]) => source)
      if (!stale.signal.aborted && apiSources.length > 0) setSources(apiSources)
      // Keep the default sources on an error (or a malformed response).
    }).catch(ignoreRejection)
    return () => { stale.abort() }
  }, [config.apiEndpoint, listDays])

  const researchDocs = useMemo(() => documents.filter(d => d.document_type === 'research'), [documents])
  const otherDocs = useMemo(() => documents.filter(d => d.document_type !== 'research'), [documents])

  const needsFeedbackFilters = contextConfig.useFeedback
  const needsItemSelection = checkNeedsItemSelection(
    contextConfig, personas, documents, otherDocs, researchDocs, combineDocuments
  )
  
  const totalSteps = calculateTotalSteps(needsFeedbackFilters, needsItemSelection)
  const stepContent = getStepContent(step, needsFeedbackFilters, needsItemSelection)
  
  const showFeedback = !hideDataSources.includes('feedback')
  const showPersonas = !hideDataSources.includes('personas') && personas.length > 0
  const showDocuments = !hideDataSources.includes('documents') && otherDocs.length > 0
  const showResearch = !hideDataSources.includes('research') && researchDocs.length > 0

  const handleBack = () => setStep(s => Math.max(1, s - 1))
  const handleNext = () => setStep(s => s + 1)

  return {
    step,
    totalSteps,
    stepContent,
    sources,
    categories,
    loadingCategories,
    researchDocs,
    otherDocs,
    showFeedback,
    showPersonas,
    showDocuments,
    showResearch,
    handleBack,
    handleNext,
  }
}
