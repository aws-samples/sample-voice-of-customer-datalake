/**
 * WizardSection - Renders the active wizard based on wizard state
 */
import type { ProjectPersona, ProjectDocument } from '../../api/client'
import type { ContextConfig } from '../../components/DataSourceWizard/exports'
import type { PersonaToolConfig, ResearchToolConfig, DocToolConfig, MergeToolConfig } from './types'
import { PersonaWizard, ResearchWizard, DocWizard, MergeWizard } from './Wizards'

type WizardType = 'persona' | 'research' | 'doc' | 'merge' | null

interface WizardSectionProps {
  readonly activeWizard: WizardType
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly contextConfig: ContextConfig
  readonly personaConfig: PersonaToolConfig
  readonly researchConfig: ResearchToolConfig
  readonly docConfig: DocToolConfig
  readonly mergeConfig: MergeToolConfig
  readonly generating: string | null
  readonly onContextChange: (c: ContextConfig) => void
  readonly onPersonaConfigChange: (c: PersonaToolConfig) => void
  readonly onResearchConfigChange: (c: ResearchToolConfig) => void
  readonly onDocConfigChange: (c: DocToolConfig) => void
  readonly onMergeConfigChange: (c: MergeToolConfig) => void
  readonly onClose: () => void
  readonly onSubmitPersona: () => void
  readonly onSubmitResearch: () => void
  readonly onSubmitDoc: () => void
  readonly onSubmitMerge: () => void
}

export default function WizardSection({
  activeWizard,
  personas,
  documents,
  contextConfig,
  personaConfig,
  researchConfig,
  docConfig,
  mergeConfig,
  generating,
  onContextChange,
  onPersonaConfigChange,
  onResearchConfigChange,
  onDocConfigChange,
  onMergeConfigChange,
  onClose,
  onSubmitPersona,
  onSubmitResearch,
  onSubmitDoc,
  onSubmitMerge,
}: WizardSectionProps) {
  if (activeWizard === 'persona') {
    return (
      <PersonaWizard
        personas={personas}
        documents={documents}
        contextConfig={contextConfig}
        personaConfig={personaConfig}
        generating={generating}
        onContextChange={onContextChange}
        onPersonaConfigChange={onPersonaConfigChange}
        onClose={onClose}
        onSubmit={onSubmitPersona}
      />
    )
  }

  if (activeWizard === 'research') {
    return (
      <ResearchWizard
        personas={personas}
        documents={documents}
        contextConfig={contextConfig}
        researchConfig={researchConfig}
        generating={generating}
        onContextChange={onContextChange}
        onResearchConfigChange={onResearchConfigChange}
        onClose={onClose}
        onSubmit={onSubmitResearch}
      />
    )
  }

  if (activeWizard === 'doc') {
    return (
      <DocWizard
        personas={personas}
        documents={documents}
        contextConfig={contextConfig}
        docConfig={docConfig}
        generating={generating}
        onContextChange={onContextChange}
        onDocConfigChange={onDocConfigChange}
        onClose={onClose}
        onSubmit={onSubmitDoc}
      />
    )
  }

  if (activeWizard === 'merge') {
    return (
      <MergeWizard
        personas={personas}
        documents={documents}
        contextConfig={contextConfig}
        mergeConfig={mergeConfig}
        generating={generating}
        onContextChange={onContextChange}
        onMergeConfigChange={onMergeConfigChange}
        onClose={onClose}
        onSubmit={onSubmitMerge}
      />
    )
  }

  return null
}
