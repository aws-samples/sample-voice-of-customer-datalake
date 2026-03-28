/**
 * @fileoverview Utility functions extracted from StepItems to avoid
 * react-refresh/only-export-components warnings.
 */

import type { ContextConfig } from './types'
import type { ProjectDocument } from '../../api/types'

export interface ColorConfig {
  bg: string
  bgLight: string
  border: string
  text: string
  hover: string
}

export function getSentimentClass(sentiment: string, isSelected: boolean, colors: ColorConfig): string {
  if (!isSelected) return 'bg-white border-gray-200'
  if (sentiment === 'positive') return 'bg-green-100 border-green-300 text-green-700'
  if (sentiment === 'negative') return 'bg-red-100 border-red-300 text-red-700'
  return `${colors.bgLight} ${colors.border} ${colors.text}`
}

export function toggleArrayItem(arr: string[], item: string): string[] {
  return arr.includes(item) ? arr.filter((x) => x !== item) : [...arr, item]
}

export function buildPersonaToggleConfig(
  contextConfig: ContextConfig,
  personaId: string,
  checked: boolean,
): ContextConfig {
  return {
    ...contextConfig,
    selectedPersonaIds: checked
      ? [...contextConfig.selectedPersonaIds, personaId]
      : contextConfig.selectedPersonaIds.filter((id) => id !== personaId),
  }
}

export function buildDocToggleConfig(
  contextConfig: ContextConfig,
  doc: ProjectDocument,
  checked: boolean,
): ContextConfig {
  if (doc.document_type === 'research') {
    return {
      ...contextConfig,
      selectedResearchIds: checked
        ? [...contextConfig.selectedResearchIds, doc.document_id]
        : contextConfig.selectedResearchIds.filter((id) => id !== doc.document_id),
    }
  }
  return {
    ...contextConfig,
    selectedDocumentIds: checked
      ? [...contextConfig.selectedDocumentIds, doc.document_id]
      : contextConfig.selectedDocumentIds.filter((id) => id !== doc.document_id),
  }
}
