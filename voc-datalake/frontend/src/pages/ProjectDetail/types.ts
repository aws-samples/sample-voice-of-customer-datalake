/**
 * Shared types for ProjectDetail components
 */
import type { ProjectPersona, Project } from '../../api/client'

export type Tab = 'overview' | 'personas' | 'documents' | 'chat' | 'mcp'

export type NoteItem = string | { note_id?: string; text: string; created_at?: string }

export interface PersonaToolConfig {
  personaCount: number
  customInstructions: string
}

export interface ResearchToolConfig {
  question: string
  title: string
}

export interface DocToolConfig {
  docType: 'prd' | 'prfaq'
  title: string
  featureIdea: string
  customerQuestions: string[]
}

export interface MergeToolConfig {
  outputType: 'prd' | 'prfaq' | 'custom'
  title: string
  instructions: string
}

export interface PersonaAvatarProps {
  readonly persona: ProjectPersona
  readonly size?: 'sm' | 'md' | 'lg'
}

export interface PersonaSectionProps {
  readonly title: string
  readonly icon: string
  readonly color: 'purple' | 'green' | 'red' | 'blue' | 'amber' | 'indigo' | 'teal' | 'gray' | 'emerald'
  readonly children: React.ReactNode
}

export interface ResearchNotesProps {
  readonly persona: ProjectPersona
  readonly onSave: (notes: NoteItem[]) => void
  readonly isSaving: boolean
}

export interface KiroExportSettingsProps {
  readonly project: Project
  readonly onSave: (prompt: string) => void
}

export type SectionColor = 'purple' | 'green' | 'red' | 'blue' | 'amber' | 'indigo' | 'teal' | 'gray' | 'emerald'

export const SECTION_COLOR_CLASSES: Record<SectionColor, { border: string; title: string }> = {
  purple: { border: 'border-purple-200 bg-purple-50/50', title: 'text-purple-700' },
  green: { border: 'border-green-200 bg-green-50/50', title: 'text-green-700' },
  red: { border: 'border-red-200 bg-red-50/50', title: 'text-red-700' },
  blue: { border: 'border-blue-200 bg-blue-50/50', title: 'text-blue-700' },
  amber: { border: 'border-amber-200 bg-amber-50/50', title: 'text-amber-700' },
  indigo: { border: 'border-indigo-200 bg-indigo-50/50', title: 'text-indigo-700' },
  teal: { border: 'border-teal-200 bg-teal-50/50', title: 'text-teal-700' },
  gray: { border: 'border-gray-200 bg-gray-50/50', title: 'text-gray-700' },
  emerald: { border: 'border-emerald-200 bg-emerald-50/50', title: 'text-emerald-700' },
}

export const SIZE_CLASSES = {
  sm: 'w-10 h-10 min-w-[40px] min-h-[40px] text-sm',
  md: 'w-12 h-12 min-w-[48px] min-h-[48px] text-base',
  lg: 'w-24 h-24 min-w-[96px] min-h-[96px] max-w-[128px] max-h-[128px] text-2xl'
} as const
