/**
 * @fileoverview A model choice and an agent's model in words (7.58.00): "Opus 5.5", "Auto", another id as it is; an
 * agent's model, the one its launch asked for, by its short name with its harness ("Opus 5.5 · Kiro").
 *
 * @module pages/Agents/modelChoiceText
 */
import { useTranslation } from 'react-i18next'
import { modelShortName } from '../../components/WorkflowEditor/nodes/nodeText'
import { BEDROCK_MODELS, isNamedChoice } from './modelChoice'

/** What the run page knows of an agent's model (the overview's agent). */
export interface AgentModel {
  readonly model: string | null
  readonly harness: 'native' | 'kiro'
}

export function useModelChoiceText() {
  const { t } = useTranslation('agents')
  const choice = (value: string): string => {
    if (!isNamedChoice(value)) return value
    return value === 'auto' ? t('modelChoice.auto') : modelShortName(BEDROCK_MODELS[value])
  }
  const model = (id: string): string => (id === 'auto' ? t('modelChoice.auto') : modelShortName(id))
  /** The agent's model and harness in words; null when its launch named none. */
  const agent = (used: AgentModel): string | null => {
    if (used.model === null || used.model === '') return null
    return t('modelChoice.onHarness', { model: model(used.model), harness: t(`modelChoice.harness.${used.harness}`) })
  }
  return { choice, model, agent }
}
