/**
 * ResearchNotes - Editable research notes section for personas
 */
import {
  FileText, X, Loader2, Lightbulb,
} from 'lucide-react'
import {
  useState, useMemo,
} from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ResearchNotesProps, NoteItem,
} from './types'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'

function getNoteText(note: NoteItem): string {
  return typeof note === 'string' ? note : note.text
}

export default function ResearchNotes({
  persona, canEdit, onSave, isSaving,
}: Readonly<ResearchNotesProps>) {
  const { t } = useTranslation('projectDetail')
  // Use useMemo to derive initial state from props instead of useEffect + setState
  const initialNotes = useMemo(() => persona.research_notes ?? [], [persona.research_notes])

  const [notes, setNotes] = useState<NoteItem[]>(initialNotes)
  const [newNote, setNewNote] = useState('')
  const [isExpanded, setIsExpanded] = useState(true)

  // Sync notes when persona changes - use key prop on parent instead of useEffect
  // This is handled by the parent component re-mounting with key={persona.persona_id}

  const addNote = () => {
    if (newNote.trim() === '') return
    const updated = [...notes, newNote.trim()]
    setNotes(updated)
    setNewNote('')
    onSave(updated)
  }

  const removeNote = (index: number) => {
    const updated = notes.filter((_, i) => i !== index)
    setNotes(updated)
    onSave(updated)
  }

  const getNotesLabel = () => {
    if (notes.length === 0) return t('personas.noNotesYet')
    return t('personas.notesCount', { count: notes.length })
  }

  return (
    <div className="space-y-4">
      {/* Header with count badge */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">
            {getNotesLabel()}
          </span>
          {notes.length > 0 && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-xs link"
            >
              {isExpanded ? t('personas.collapse') : t('personas.expand')}
            </button>
          )}
        </div>
      </div>

      {/* Empty state with call to action */}
      {notes.length === 0 && canEdit && (
        <div className="text-center py-6 bg-card rounded-lg border-2 border-dashed border-border">
          <div className="w-12 h-12 mx-auto mb-3 bg-aim-subtle rounded-full flex items-center justify-center">
            <FileText size={24} className="text-aim" />
          </div>
          <p className="text-text font-medium mb-1">{t('personas.addResearchNotes')}</p>
          <p className="text-muted text-sm mb-4">{t('personas.addResearchNotesDesc')}</p>
        </div>
      )}

      {/* Notes list */}
      {notes.length > 0 && isExpanded ? <ul className="space-y-2">
        {notes.map((note, i) => (
          <li key={getNoteText(note)} className="group flex items-start gap-3 text-sm text-text bg-card p-3 rounded-lg border border-border hover:border-accent/30 transition-colors">
            <div className="w-6 h-6 bg-aim-subtle rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-xs text-aim font-medium font-mono">{i + 1}</span>
            </div>
            <span className="flex-1 leading-relaxed">{getNoteText(note)}</span>
            {canEdit ? (
              <button
                type="button"
                onClick={() => removeNote(i)}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted hover:text-danger p-1 transition-opacity"
                disabled={isSaving}
                title={t('personas.removeNote')}
                aria-label={t('personas.removeNote')}
              >
                <X size={16} aria-hidden />
              </button>
            ) : null}
          </li>
        ))}
      </ul> : null}

      {/* Add note input — for anyone who may edit. Stacks on phones, where the
          input was squeezed to a few characters beside the button and hint. */}
      {canEdit ? <StickyActionBar variant="inline" className="flex flex-col sm:flex-row gap-2 py-2">
        <div className="flex-1 relative min-w-0">
          <input
            type="text"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            // Not while an IME is composing: in ja/ko/zh, Enter confirms the
            // candidate, and would otherwise submit a half-typed note.
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && addNote()}
            placeholder={t('personas.notePlaceholder')}
            aria-label={t('personas.notePlaceholder')}
            className="input sm:pr-24"
          />
          <span className="hidden sm:block absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted pointer-events-none" aria-hidden>
            {t('personas.pressEnter')}
          </span>
        </div>
        <button
          type="button"
          onClick={addNote}
          disabled={newNote.trim() === '' || isSaving}
          className="btn btn-primary w-full sm:w-auto"
        >
          {isSaving ? <Loader2 size={16} className="animate-spin" aria-hidden /> : (
            <>
              <FileText size={16} aria-hidden />
              {t('personas.addNote')}
            </>
          )}
        </button>
      </StickyActionBar> : null}

      {/* Helper text explains the input above, so it goes with it. */}
      {canEdit ? <p className="text-xs text-muted flex items-start gap-1.5">
        <Lightbulb size={12} aria-hidden="true" className="flex-shrink-0 mt-0.5" />
        {t('personas.notesTip')}
      </p> : null}
    </div>
  )
}
