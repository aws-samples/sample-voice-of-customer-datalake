import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { z } from 'zod'
import { versionedPersist } from './persistVersion'

export interface ParsedReview {
  text: string
  rating: number | null
  author: string | null
  date: string | null
  /** The parse found no date, so `date` is the import date; cleared once the user sets one. */
  date_defaulted?: boolean
  title: string | null
}

/** The most text one paste may hold (the parse route's own bound). */
export const MANUAL_IMPORT_MAX_CHARACTERS = 10000

interface ManualImportState {
  // Draft persistence
  sourceUrl: string
  rawText: string
  parsedReviews: ParsedReview[]
  unparsedSections: string[]
  jobId: string | null
  sourceOrigin: string | null
  lastUpdated: string | null
  
  // UI state (not persisted)
  isModalOpen: boolean
  /** Opening found a stored draft over the limit and cleared it (it could never be parsed). */
  draftDropped: boolean
  processingError: string | null
  step: 'input' | 'processing' | 'preview'
  
  // Actions
  setSourceUrl: (url: string) => void
  setRawText: (text: string) => void
  setParsedReviews: (reviews: ParsedReview[]) => void
  setUnparsedSections: (sections: string[]) => void
  setJobId: (id: string | null) => void
  setSourceOrigin: (origin: string | null) => void
  setIsModalOpen: (open: boolean) => void
  setProcessingError: (error: string | null) => void
  setStep: (step: 'input' | 'processing' | 'preview') => void
  
  // Review editing
  updateReview: (index: number, review: Partial<ParsedReview>) => void
  deleteReview: (index: number) => void
  addEmptyReview: () => void
  
  // Clear state
  clearDraft: () => void
  resetModal: () => void
}

const initialState = {
  sourceUrl: '',
  rawText: '',
  parsedReviews: [],
  unparsedSections: [],
  jobId: null,
  sourceOrigin: null,
  lastUpdated: null,
  isModalOpen: false,
  draftDropped: false,
  processingError: null,
  step: 'input' as const,
}

/** The persisted draft fields, emptied. */
const EMPTY_DRAFT = {
  sourceUrl: '',
  rawText: '',
  parsedReviews: [],
  unparsedSections: [],
  jobId: null,
  sourceOrigin: null,
  lastUpdated: null,
}

/** The persisted draft ('voc-manual-import'), validated on rehydrate. */
const PersistedDraftSchema = z.object({
  sourceUrl: z.string(),
  rawText: z.string(),
  parsedReviews: z.array(z.object({
    text: z.string(),
    rating: z.number().nullable(),
    author: z.string().nullable(),
    date: z.string().nullable(),
    date_defaulted: z.boolean().optional(),
    title: z.string().nullable(),
  })),
  unparsedSections: z.array(z.string()),
  jobId: z.string().nullable(),
  sourceOrigin: z.string().nullable(),
  lastUpdated: z.string().nullable(),
}).partial()

/** A stored draft as the store takes it: validated, and without a text over the limit (and its URL). */
function withoutOverLimitText(persisted: unknown): z.infer<typeof PersistedDraftSchema> {
  const parsed = PersistedDraftSchema.safeParse(persisted)
  const draft = parsed.success ? parsed.data : {}
  const overLimit = (draft.rawText?.length ?? 0) > MANUAL_IMPORT_MAX_CHARACTERS
  return overLimit ? { ...draft, rawText: '', sourceUrl: '' } : draft
}

export const useManualImportStore = create<ManualImportState>()(
  persist(
    (set) => ({
      ...initialState,
      
      setSourceUrl: (url) => set({ sourceUrl: url, lastUpdated: new Date().toISOString() }),
      setRawText: (text) => set({ rawText: text, lastUpdated: new Date().toISOString() }),
      setParsedReviews: (reviews) => set({ parsedReviews: reviews, lastUpdated: new Date().toISOString() }),
      setUnparsedSections: (sections) => set({ unparsedSections: sections }),
      setJobId: (id) => set({ jobId: id }),
      setSourceOrigin: (origin) => set({ sourceOrigin: origin }),
      // Live finding: a stale draft over the limit reopened on every visit, already
      // refused. Opening drops it (and says so); closing forgets the notice.
      setIsModalOpen: (open) => set((state) => {
        if (!open) return { isModalOpen: false, draftDropped: false }
        const overLimit = state.rawText.length > MANUAL_IMPORT_MAX_CHARACTERS
        return overLimit ? { ...EMPTY_DRAFT, isModalOpen: true, draftDropped: true, step: 'input' } : { isModalOpen: true }
      }),
      setProcessingError: (error) => set({ processingError: error }),
      setStep: (step) => set({ step }),
      
      updateReview: (index, review) => set((state) => {
        const current = index < 0 ? undefined : state.parsedReviews.at(index)
        // Out-of-range index: no-op rather than inserting a partial review.
        if (current === undefined) return {}
        const reviews = [...state.parsedReviews]
        reviews[index] = { ...current, ...review }
        return { parsedReviews: reviews, lastUpdated: new Date().toISOString() }
      }),
      
      deleteReview: (index) => set((state) => ({
        parsedReviews: state.parsedReviews.filter((_, i) => i !== index),
        lastUpdated: new Date().toISOString()
      })),
      
      addEmptyReview: () => set((state) => ({
        parsedReviews: [
          ...state.parsedReviews,
          { text: '', rating: null, author: null, date: null, title: null }
        ],
        lastUpdated: new Date().toISOString()
      })),
      
      clearDraft: () => set({
        ...EMPTY_DRAFT,
        draftDropped: false,
        processingError: null,
        step: 'input',
      }),
      
      resetModal: () => set({
        isModalOpen: false,
        draftDropped: false,
        processingError: null,
        step: 'input',
      }),
    }),
    {
      name: 'voc-manual-import',
      partialize: (state): z.infer<typeof PersistedDraftSchema> => ({
        // Only persist draft data, not UI state. A text over the limit is never
        // stored: it could never be parsed, and reopening it in a later session
        // showed a stale "draft was cleared" notice (wave 4) for a clear the user
        // never saw happen.
        sourceUrl: state.sourceUrl,
        rawText: state.rawText.length > MANUAL_IMPORT_MAX_CHARACTERS ? '' : state.rawText,
        parsedReviews: state.parsedReviews,
        unparsedSections: state.unparsedSections,
        jobId: state.jobId,
        sourceOrigin: state.sourceOrigin,
        lastUpdated: state.lastUpdated,
      }),
      // A blob written before that rule may still hold one: dropped silently on load.
      merge: (persisted, current) => ({ ...current, ...withoutOverLimitText(persisted) }),
      ...versionedPersist(PersistedDraftSchema),
    }
  )
)
