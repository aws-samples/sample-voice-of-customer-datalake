/**
 * Custom hook for managing wizard state in ProjectDetail
 */
import {
  useState, useCallback,
} from 'react'
import {
  defaultContextConfig, type ContextConfig,
} from '../../components/DataSourceWizard/exports'
import type {
  PersonaToolConfig, ResearchToolConfig, DocToolConfig, MergeToolConfig,
} from './types'

type WizardType = 'persona' | 'research' | 'doc' | 'merge' | null

const DEFAULT_PERSONA_CONFIG: PersonaToolConfig = {
  personaCount: 3,
  customInstructions: '',
}
const DEFAULT_RESEARCH_CONFIG: ResearchToolConfig = {
  question: '',
  title: '',
  useWebSearch: false,
}
const DEFAULT_DOC_CONFIG: DocToolConfig = {
  docTypes: ['prfaq'],
  title: '',
  featureIdea: '',
  customerQuestions: ['', '', '', '', ''],
}
const DEFAULT_MERGE_CONFIG: MergeToolConfig = {
  outputType: 'prfaq',
  title: '',
  instructions: '',
}

export function useProjectWizardState() {
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

  /**
   * Open the research wizard with the project's existing personas already
   * selected.
   *
   * This is what makes the Personas-before-Research ordering pay off. Research is
   * the one generator that can read personas — `research_step_handler` injects
   * each selected persona's name, tagline, goals, frustrations and quote — but
   * the wizard defaults `usePersonas` to false, so persona-grounded research was
   * available only to someone who knew to go looking for it. Pre-selecting makes
   * the grounded run the default and leaves it one click to undo.
   *
   * Callers pass the persona ids rather than the personas, since that is all the
   * context config holds.
   */
  const openResearchWizard = useCallback((personaIds: ReadonlyArray<string>) => {
    setContextConfig({
      ...defaultContextConfig,
      usePersonas: personaIds.length > 0,
      selectedPersonaIds: [...personaIds],
    })
    setActiveWizard('research')
  }, [])

  const openMergeWizard = useCallback(() => {
    setContextConfig({
      ...defaultContextConfig,
      useFeedback: false,
      useDocuments: true,
      useResearch: true,
    })
    setMergeConfig((c) => ({
      ...c,
      instructions: 'Create an improved version...',
    }))
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
    openResearchWizard,
    openMergeWizard,
  }
}
