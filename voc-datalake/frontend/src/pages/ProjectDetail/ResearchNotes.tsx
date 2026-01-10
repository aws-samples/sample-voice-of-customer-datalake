/**
 * ResearchNotes - Editable research notes section for personas
 */
import { useState, useMemo } from 'react'
import { FileText, X, Loader2 } from 'lucide-react'
import type { ResearchNotesProps, NoteItem } from './types'

function getNoteText(note: NoteItem): string {
  return typeof note === 'string' ? note : note.text
}

export default function ResearchNotes({ persona, onSave, isSaving }: Readonly<ResearchNotesProps>) {
  // Use useMemo to derive initial state from props instead of useEffect + setState
  const initialNotes = useMemo(() => persona.research_notes ?? [], [persona.research_notes])
  
  const [notes, setNotes] = useState<NoteItem[]>(initialNotes)
  const [newNote, setNewNote] = useState('')
  const [isExpanded, setIsExpanded] = useState(true)
  
  // Sync notes when persona changes - use key prop on parent instead of useEffect
  // This is handled by the parent component re-mounting with key={persona.persona_id}
  
  const addNote = () => {
    if (!newNote.trim()) return
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
    if (notes.length === 0) return 'No notes yet'
    const plural = notes.length !== 1 ? 's' : ''
    return `${notes.length} note${plural}`
  }
  
  return (
    <div className="space-y-4">
      {/* Header with count badge */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">
            {getNotesLabel()}
          </span>
          {notes.length > 0 && (
            <button 
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-xs text-purple-600 hover:text-purple-700"
            >
              {isExpanded ? 'Collapse' : 'Expand'}
            </button>
          )}
        </div>
      </div>
      
      {/* Empty state with call to action */}
      {notes.length === 0 && (
        <div className="text-center py-6 bg-white rounded-lg border-2 border-dashed border-gray-200">
          <div className="w-12 h-12 mx-auto mb-3 bg-purple-100 rounded-full flex items-center justify-center">
            <FileText size={24} className="text-purple-500" />
          </div>
          <p className="text-gray-600 font-medium mb-1">Add Your Research Notes</p>
          <p className="text-gray-400 text-sm mb-4">Document your observations, insights, and hypotheses about this persona</p>
        </div>
      )}
      
      {/* Notes list */}
      {notes.length > 0 && isExpanded && (
        <ul className="space-y-2">
          {notes.map((note, i) => (
            <li key={i} className="group flex items-start gap-3 text-sm text-gray-700 bg-white p-3 rounded-lg border hover:border-purple-200 transition-colors">
              <div className="w-6 h-6 bg-purple-100 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="text-xs text-purple-600 font-medium">{i + 1}</span>
              </div>
              <span className="flex-1 leading-relaxed">{getNoteText(note)}</span>
              <button 
                onClick={() => removeNote(i)} 
                className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 p-1 transition-opacity"
                disabled={isSaving}
                title="Remove note"
              >
                <X size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      
      {/* Add note input - always visible */}
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <input
            type="text"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addNote()}
            placeholder="Type your research observation or insight..."
            className="w-full px-4 py-3 text-sm border rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 pr-24"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
            Press Enter ↵
          </span>
        </div>
        <button
          onClick={addNote}
          disabled={!newNote.trim() || isSaving}
          className="px-4 py-3 bg-purple-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-purple-700 flex items-center gap-2 transition-colors"
        >
          {isSaving ? <Loader2 size={16} className="animate-spin" /> : (
            <>
              <FileText size={16} />
              Add Note
            </>
          )}
        </button>
      </div>
      
      {/* Helper text */}
      <p className="text-xs text-gray-400">
        💡 Tip: Add observations from user interviews, usability tests, or data analysis that relate to this persona.
      </p>
    </div>
  )
}
