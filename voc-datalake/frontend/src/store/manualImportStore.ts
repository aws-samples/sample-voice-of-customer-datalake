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
  isProcessing: boolean
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
  setIsProcessing: (processing: boolean) => void
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
  isProcessing: false,
  processingError: null,
  step: 'input' as const,
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
      setIsModalOpen: (open) => set({ isModalOpen: open }),
      setIsProcessing: (processing) => set({ isProcessing: processing }),
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
        sourceUrl: '',
        rawText: '',
        parsedReviews: [],
        unparsedSections: [],
        jobId: null,
        sourceOrigin: null,
        lastUpdated: null,
        processingError: null,
        step: 'input',
      }),
      
      resetModal: () => set({
        isModalOpen: false,
        isProcessing: false,
        processingError: null,
        step: 'input',
      }),
    }),
    {
      name: 'voc-manual-import',
      partialize: (state): z.infer<typeof PersistedDraftSchema> => ({
        // Only persist draft data, not UI state
        sourceUrl: state.sourceUrl,
        rawText: state.rawText,
        parsedReviews: state.parsedReviews,
        unparsedSections: state.unparsedSections,
        jobId: state.jobId,
        sourceOrigin: state.sourceOrigin,
        lastUpdated: state.lastUpdated,
      }),
      ...versionedPersist(PersistedDraftSchema),
    }
  )
)
