/**
 * @fileoverview The one draft of the form a builder page edits (UX §1 principle 2: one draft, one Save), shared by
 * every tab through {@link FormDraftContext}. Every editor reads `form` and writes through `update` (a pure
 * form → form function, `model/mutations.ts`); nothing is saved until Save, Publish or Update live form.
 *
 * @module pages/FeedbackForms/builder/formDraftContext
 */
import { createContext, useContext } from 'react'
import type { FormV2, StoredFormMeta } from '../model/formsV2'
import type { FormProblem, ProblemLocation } from '../model/validateForm'
import type { DraftNote, FormsFieldError } from '../../../api/feedbackFormsV2Api'

/** What the AI did to this draft, until the first Save (provenance is not stored: UX §12.3). */
export interface AiState {
  /** `draft`: the form is an AI draft; `improve`: "Improve with AI" changed it. */
  readonly kind: 'draft' | 'improve'
  readonly notes: readonly DraftNote[]
  readonly warnings: readonly DraftNote[]
  /** The questions and endings the AI added or changed, marked "AI" until the person opens them. */
  readonly marked: ReadonlySet<string>
  /** The https addresses the AI suggested that the person has not confirmed yet (each an error). */
  readonly unconfirmed: readonly ProblemLocation[]
  /** The form before "Improve with AI" was applied (Undo AI changes); null for a draft. */
  readonly before: FormV2 | null
  /** The description an AI draft was made from (Discard draft returns to the picker with it). */
  readonly description: string
}

export type SaveStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly message: 'saved' | 'firstSave' | 'published' | 'aiSaved' | 'turnedOff' }
  | { readonly kind: 'failed'; readonly reason: string }

/** Another save won (D7): who and when, as the server said. */
export interface ConflictInfo {
  readonly updatedBy: string
  readonly updatedAt: string
}

export interface FormDraft {
  readonly form: FormV2
  /** The form as last saved (null: a new form, never saved). */
  readonly baseline: FormV2 | null
  readonly meta: StoredFormMeta | null
  readonly isNew: boolean
  readonly dirty: boolean
  /** Every problem (errors, warnings, notes), the AI's unconfirmed addresses included. */
  readonly problems: readonly FormProblem[]
  /**
   * The problems that block this draft's save: on a Live form (whose save is Update live form) every error; on an
   * Off or new one every error but an unreadable theme, which blocks only Publish (Save still works).
   */
  readonly errors: readonly FormProblem[]
  /** The problems that block Publish and Update live form: every error. */
  readonly publishErrors: readonly FormProblem[]
  /** The server's own refusals of the last save (a 400), shown under "Other problems". */
  readonly serverErrors: readonly FormsFieldError[]
  /** Codes and ids are locked: the form has a real response (D9). */
  readonly locked: boolean
  readonly update: (change: (form: FormV2) => FormV2) => void
  readonly ai: AiState | null
  readonly setAi: (change: (ai: AiState | null) => AiState | null) => void
  /** The template a new form came from (null: none, or a saved form). */
  readonly templateId: string | null
  /** The texts (translatable keys) filled from a template's catalogue, until edited: "From template". */
  readonly fromTemplate: ReadonlySet<string>
  readonly setFromTemplate: (change: (keys: ReadonlySet<string>) => ReadonlySet<string>) => void
  /** Options created since the last save, as `<questionId>:<code>`: their code still follows the label (UX §4.1). */
  readonly freshCodes: ReadonlySet<string>
  readonly setFreshCodes: (change: (keys: ReadonlySet<string>) => ReadonlySet<string>) => void
  readonly status: SaveStatus
  readonly conflict: ConflictInfo | null
  /** Save; resolves true when saved. A new form is created (Off) and the address takes its id. */
  readonly save: () => Promise<boolean>
  /** Save, then turn the form Live (a new form is created first). */
  readonly publish: () => Promise<boolean>
  readonly turnOff: () => Promise<boolean>
  /** Conflict: read the latest version, dropping this draft's edits. */
  readonly loadTheirs: () => Promise<void>
  /** Conflict: save this draft over the latest version. */
  readonly saveMine: () => Promise<boolean>
  /** Conflict: the latest version, to compare with this draft (read on demand). */
  readonly readTheirs: () => Promise<FormV2>
  /** Throw the edits away (back to the last save; a new form back to how it opened). */
  readonly discard: () => void
}

export const FormDraftContext = createContext<FormDraft | null>(null)

/** The builder's draft; only inside a builder page. */
export function useDraft(): FormDraft {
  const draft = useContext(FormDraftContext)
  if (draft === null) throw new Error('useDraft is used outside a form builder page.')
  return draft
}
