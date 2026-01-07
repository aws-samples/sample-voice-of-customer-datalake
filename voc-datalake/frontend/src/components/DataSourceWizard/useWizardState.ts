/**
 * @fileoverview Custom hook for DataSourceWizard state management.
 * @module components/DataSourceWizard/useWizardState
 */

import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ProjectPersona, ProjectDocument } from '../../api/client'
import { api } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { SOURCES as DEFAULT_SOURCES, CATEGORIES } from '../../constants/filters'
import type { ContextConfig } from './types'

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
    queryKey: ['categories-config'],
    queryFn: () => api.getCategoriesConfig(),
    enabled: !!config.apiEndpoint,
  })

  const categories = useMemo(() => {
    if (categoriesData?.categories && categoriesData.categories.length > 0) {
      return categoriesData.categories.map(c => ({ id: c.id, name: c.name }))
    }
    return CATEGORIES.map(c => ({ 
      id: c, 
      name: c.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    }))
  }, [categoriesData])

  useEffect(() => {
    if (!config.apiEndpoint) return
    
    api.getSources(30).then(data => {
      if (data.sources && Object.keys(data.sources).length > 0) {
        const apiSources = Object.keys(data.sources).sort((a, b) => data.sources[b] - data.sources[a])
        setSources(apiSources)
      }
    }).catch(() => {
      // Keep default sources on error
    })
  }, [config.apiEndpoint])

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
