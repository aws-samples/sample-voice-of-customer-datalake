/**
 * Custom hook for managing wizard state in ProjectDetail
 */
import { useState, useCallback } from 'react'
import { defaultContextConfig, type ContextConfig } from '../../components/DataSourceWizard/exports'
import type { PersonaToolConfig, ResearchToolConfig, DocToolConfig, MergeToolConfig } from './types'

export type WizardType = 'persona' | 'research' | 'doc' | 'merge' | null

const DEFAULT_PERSONA_CONFIG: PersonaToolConfig = { personaCount: 3, customInstructions: '' }
const DEFAULT_RESEARCH_CONFIG: ResearchToolConfig = { question: '', title: '' }
const DEFAULT_DOC_CONFIG: DocToolConfig = { docType: 'prfaq', title: '', featureIdea: '', customerQuestions: ['', '', '', '', ''] }
const DEFAULT_MERGE_CONFIG: MergeToolConfig = { outputType: 'prfaq', title: '', instructions: '' }

export function useWizardState() {
  const [activeWizard, setActiveWizard] = useState<WizardType>(null)
  const [contextConfig, setContextConfig] = useState<ContextConfig>(defaultContextConfig)
  const [personaConfig, setPersonaConfig] = useState<PersonaToolConfig>(DEFAULT_PERSONA_CONFIG)
  const [researchConfig, setResearchConfig] = useState<ResearchToolConfig>(DEFAULT_RESEARCH_CONFIG)
  const [docConfig, setDocConfig] = useState<DocToolConfig>(DEFAULT_DOC_CONFIG)
  const [mergeConfig, setMergeConfig] = useState<MergeToolConfig>(DEFAULT_MERGE_CONFIG)
  const [generating, setGenerating] = useState<string | null>(null)

  const resetWizard = useCallback(() => {
    setActiveWizard(null)
    setContextConfig(defaultContextConfig)
    setPersonaConfig(DEFAULT_PERSONA_CONFIG)
    setResearchConfig(DEFAULT_RESEARCH_CONFIG)
    setDocConfig(DEFAULT_DOC_CONFIG)
    setMergeConfig(DEFAULT_MERGE_CONFIG)
    setGenerating(null)
  }, [])

  const openMergeWizard = useCallback(() => {
    setContextConfig({ ...defaultContextConfig, useFeedback: false, useDocuments: true, useResearch: true })
    setMergeConfig(c => ({ ...c, instructions: 'Create an improved version...' }))
    setActiveWizard('merge')
  }, [])

  return {
    activeWizard,
    setActiveWizard,
    contextConfig,
    setContextConfig,
    personaConfig,
    setPersonaConfig,
    researchConfig,
    setResearchConfig,
    docConfig,
    setDocConfig,
    mergeConfig,
    setMergeConfig,
    generating,
    setGenerating,
    resetWizard,
    openMergeWizard,
  }
}
