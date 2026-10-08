/**
 * Shared types for ProjectDetail components
 */
// DocType (what POST /projects/{id}/document accepts) is declared in api/types.ts, which
// owns that wire contract (issue #381). Import it from there; do not respell 'prd' | 'prfaq'.
import type {
  DocType,
} from '../../api/types'
import type {
  ProjectPersona,
} from '../../api/projectTypes'
import type { Tone } from '../../theme/tones'
import type { LucideIcon } from 'lucide-react'

export type Tab = 'overview' | 'personas' | 'product' | 'documents'

const TAB_IDS: readonly Tab[] = ['overview', 'personas', 'product', 'documents']

/**
 * `?tab=` → a known tab. Unknown values fall back to overview, including the
 * removed `chat` and `mcp` (Export / MCP moved to the global Connect page).
 */
export function parseTab(value: string | null): Tab {
  return TAB_IDS.find((tab) => tab === value) ?? 'overview'
}

export type NoteItem = string | {
  note_id?: string;
  text: string;
  created_at?: string
}

export interface PersonaToolConfig {
  personaCount: number
  customInstructions: string
}

export interface ResearchToolConfig {
  question: string
  title: string
  // Opt-in public web search grounding (only offered when the deployment
  // has the AgentCore web search gateway).
  useWebSearch: boolean
}

export interface DocToolConfig {
  // Which documents to generate. Both can be selected to generate PRD + PR-FAQ
  // in one go (each runs as its own async job).
  docTypes: DocType[]
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
  /** A lucide icon (KiroCrew rule: lucide only, never an emoji glyph). */
  readonly icon: LucideIcon
  readonly color: SectionColor
  readonly children: React.ReactNode
}

export interface ResearchNotesProps {
  readonly persona: ProjectPersona
  /** False for a viewer: the notes are listed but cannot be added to or removed. */
  readonly canEdit: boolean
  readonly onSave: (notes: NoteItem[]) => void
  readonly isSaving: boolean
}

type SectionColor = Tone

export const SECTION_COLOR_CLASSES: Record<SectionColor, {
  border: string;
  title: string
}> = {
  aim: {
    border: 'border-aim/30 bg-aim-subtle',
    title: 'text-aim',
  },
  ok: {
    border: 'border-ok/30 bg-ok-subtle',
    title: 'text-ok',
  },
  danger: {
    border: 'border-danger/30 bg-danger-subtle',
    title: 'text-danger',
  },
  info: {
    border: 'border-info/30 bg-info-subtle',
    title: 'text-info',
  },
  warn: {
    border: 'border-warn/30 bg-warn-subtle',
    title: 'text-warn',
  },
  accent: {
    border: 'border-accent/30 bg-accent-subtle',
    title: 'text-accent-text',
  },
  muted: {
    border: 'border-border bg-bg-accent/50',
    title: 'text-text',
  },
}

export const SIZE_CLASSES = {
  sm: 'w-10 h-10 min-w-[40px] min-h-[40px] text-sm',
  md: 'w-12 h-12 min-w-[48px] min-h-[48px] text-base',
  lg: 'w-24 h-24 min-w-[96px] min-h-[96px] max-w-[128px] max-h-[128px] text-2xl',
} as const
