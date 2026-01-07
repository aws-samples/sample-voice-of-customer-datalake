/**
 * DocumentModal - Modal for creating/editing documents
 */
import { X, Loader2, FileText, Pencil } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface DocumentModalProps {
  readonly isEditing: boolean
  readonly title: string
  readonly content: string
  readonly isSaving: boolean
  readonly onTitleChange: (title: string) => void
  readonly onContentChange: (content: string) => void
  readonly onSave: () => void
  readonly onClose: () => void
}

export default function DocumentModal({
  isEditing,
  title,
  content,
  isSaving,
  onTitleChange,
  onContentChange,
  onSave,
  onClose,
}: DocumentModalProps) {
  const isValid = title.trim() && content.trim()

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl w-full max-w-3xl max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">{isEditing ? 'Edit Document' : 'Create Document'}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg"><X size={20} /></button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto max-h-[60vh]">
          <div>
            <label className="block text-sm font-medium mb-1">Title</label>
            <input 
              type="text" 
              value={title} 
              onChange={e => onTitleChange(e.target.value)} 
              placeholder="Document title..." 
              className="w-full px-3 py-2 border rounded-lg" 
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Content (Markdown)</label>
            <textarea 
              value={content} 
              onChange={e => onContentChange(e.target.value)} 
              placeholder="Write your document in Markdown..." 
              rows={12} 
              className="w-full px-3 py-2 border rounded-lg font-mono text-sm" 
            />
          </div>
          {content && (
            <div>
              <label className="block text-sm font-medium mb-1">Preview</label>
              <div className="border rounded-lg p-4 prose prose-sm max-w-none bg-gray-50 max-h-48 overflow-y-auto">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-3 p-4 border-t bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button 
            onClick={onSave} 
            disabled={!isValid || isSaving} 
            className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
          >
            {isSaving ? (
              <><Loader2 size={16} className="animate-spin" />{isEditing ? 'Saving...' : 'Creating...'}</>
            ) : (
              <>{isEditing ? <Pencil size={16} /> : <FileText size={16} />}{isEditing ? 'Save Changes' : 'Create'}</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
