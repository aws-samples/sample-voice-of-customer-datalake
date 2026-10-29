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

export type Tab = 'overview' | 'personas' | 'product' | 'documents' | 'decisions' | 'participants'

const TAB_IDS: readonly Tab[] = ['overview', 'personas', 'product', 'documents', 'decisions', 'participants']

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
  // Which documents to generate. Both can be selected to generate PRD + PR/FAQ
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
  /** A STATE tone only (`danger` = negative sentiment, `muted` = quiet); omitted = neutral card. */
  readonly color?: SectionColor
  readonly children: React.ReactNode
}

export interface ResearchNotesProps {
  readonly persona: ProjectPersona
  /** False for a viewer: the notes are listed but cannot be added to or removed. */
  readonly canEdit: boolean
  readonly onSave: (notes: NoteItem[]) => void
  readonly isSaving: boolean
}

/**
 * A persona detail section is a neutral card by default; its lucide icon and title say
 * which one it is (labels vs status, rule 15). The two tones left are STATES:
 * `danger` for the pain-points section (negative sentiment) and `muted` for the quiet
 * research-notes panel. Until 3.14.02 every `Tone` was here and each section had its
 * own — identity painted as six states.
 */
type SectionColor = Extract<Tone, 'danger' | 'muted'>

interface SectionClasses {
  readonly border: string
  readonly title: string
}

const SECTION_COLOR_CLASSES: Record<SectionColor, SectionClasses> = {
  danger: {
    border: 'border-danger/30 bg-danger-subtle',
    title: 'text-danger',
  },
  muted: {
    border: 'border-border bg-bg-accent/50',
    title: 'text-text-strong',
  },
}

/** The default section: a plain card, heading in the strong text colour. */
const NEUTRAL_SECTION_CLASSES: SectionClasses = {
  border: 'border-border bg-card',
  title: 'text-text-strong',
}

export function sectionClasses(color: SectionColor | undefined): SectionClasses {
  return color === undefined ? NEUTRAL_SECTION_CLASSES : SECTION_COLOR_CLASSES[color]
}

export const SIZE_CLASSES = {
  sm: 'w-10 h-10 min-w-[40px] min-h-[40px] text-sm',
  md: 'w-12 h-12 min-w-[48px] min-h-[48px] text-base',
  lg: 'w-24 h-24 min-w-[96px] min-h-[96px] max-w-[128px] max-h-[128px] text-2xl',
} as const
