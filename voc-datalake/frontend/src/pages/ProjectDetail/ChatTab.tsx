/**
 * ChatTab - Project-scoped AI chat with mentions
 */
import { useState, useCallback } from 'react'
import { MessageSquare, User, Bot, Loader2, FileText, Send } from 'lucide-react'
import clsx from 'clsx'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ProjectPersona, ProjectDocument } from '../../api/client'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ChatTabProps {
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly messages: ChatMessage[]
  readonly isPending: boolean
  readonly onSendMessage: (message: string, personaIds: string[], documentIds: string[]) => void
  readonly onSaveAsDocument: (content: string) => void
}

export default function ChatTab({
  personas,
  documents,
  messages,
  isPending,
  onSendMessage,
  onSaveAsDocument,
}: ChatTabProps) {
  const [chatInput, setChatInput] = useState('')
  const [showMentionMenu, setShowMentionMenu] = useState(false)
  const [mentionType, setMentionType] = useState<'persona' | 'document' | null>(null)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const [selectedPersonaIds, setSelectedPersonaIds] = useState<string[]>([])
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([])

  const handleInputChange = useCallback((value: string) => {
    setChatInput(value)
    
    const lastAtIndex = value.lastIndexOf('@')
    const lastHashIndex = value.lastIndexOf('#')
    
    if (lastAtIndex > lastHashIndex && lastAtIndex >= 0) {
      const textAfterAt = value.slice(lastAtIndex + 1)
      if (!textAfterAt.includes(' ')) {
        setMentionType('persona')
        setMentionFilter(textAfterAt.toLowerCase())
        setShowMentionMenu(true)
        setMentionIndex(0)
        return
      }
    }
    
    if (lastHashIndex > lastAtIndex && lastHashIndex >= 0) {
      const textAfterHash = value.slice(lastHashIndex + 1)
      if (!textAfterHash.includes(' ')) {
        setMentionType('document')
        setMentionFilter(textAfterHash.toLowerCase())
        setShowMentionMenu(true)
        setMentionIndex(0)
        return
      }
    }
    
    setShowMentionMenu(false)
    setMentionType(null)
  }, [])

  const getMentionItems = useCallback(() => {
    if (mentionType === 'persona') {
      return personas.filter(p => p.name.toLowerCase().includes(mentionFilter)).slice(0, 6)
    }
    if (mentionType === 'document') {
      return documents.filter(d => d.title.toLowerCase().includes(mentionFilter)).slice(0, 6)
    }
    return []
  }, [mentionType, mentionFilter, personas, documents])

  const handleSend = useCallback(() => {
    if (!chatInput.trim() || isPending) return
    onSendMessage(chatInput, selectedPersonaIds, selectedDocumentIds)
    setChatInput('')
    setShowMentionMenu(false)
    setSelectedPersonaIds([])
    setSelectedDocumentIds([])
  }, [chatInput, isPending, selectedPersonaIds, selectedDocumentIds, onSendMessage])

  const insertMention = useCallback((item: ProjectPersona | ProjectDocument) => {
    const trigger = mentionType === 'persona' ? '@' : '#'
    const isPersona = mentionType === 'persona'
    
    // Type guard: check for persona_id to determine type
    const itemIsPersona = 'persona_id' in item
    const name = itemIsPersona ? item.name : item.title
    
    if (itemIsPersona) {
      if (!selectedPersonaIds.includes(item.persona_id)) {
        setSelectedPersonaIds(prev => [...prev, item.persona_id])
      }
    } else {
      if (!selectedDocumentIds.includes(item.document_id)) {
        setSelectedDocumentIds(prev => [...prev, item.document_id])
      }
    }
    
    const triggerIndex = isPersona 
      ? chatInput.lastIndexOf('@')
      : chatInput.lastIndexOf('#')
    
    const textBefore = chatInput.slice(0, triggerIndex)
    const newValue = textBefore + trigger + name + ' '
    setChatInput(newValue)
    setShowMentionMenu(false)
    setMentionType(null)
  }, [mentionType, chatInput, selectedPersonaIds, selectedDocumentIds])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showMentionMenu) {
      const items = getMentionItems()
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex(i => Math.min(i + 1, items.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex(i => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (items.length > 0) {
          e.preventDefault()
          insertMention(items[mentionIndex])
        }
      } else if (e.key === 'Escape') {
        setShowMentionMenu(false)
      }
    } else if (e.key === 'Enter') {
      handleSend()
    }
  }, [showMentionMenu, getMentionItems, mentionIndex, insertMention, handleSend])

  const mentionItems = getMentionItems()

  return (
    <div className="bg-white rounded-xl border h-[calc(100vh-280px)] sm:h-[600px] flex flex-col">
      <div className="p-3 sm:p-4 border-b">
        <h3 className="font-semibold text-sm sm:text-base">Project AI Chat</h3>
        <p className="text-xs sm:text-sm text-gray-500">
          Type <span className="font-mono bg-purple-100 text-purple-700 px-1 rounded">@</span> for personas or{' '}
          <span className="font-mono bg-blue-100 text-blue-700 px-1 rounded">#</span> for documents
        </p>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 py-8">
            <MessageSquare size={32} className="mx-auto mb-2 opacity-50" />
            <p>Start a conversation</p>
            <p className="text-sm mt-2">
              Try: "What would @{personas[0]?.name ?? 'PersonaName'} think about this?"
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={clsx('flex gap-3', m.role === 'user' ? 'justify-end' : '')}>
            {m.role === 'assistant' && (
              <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                <Bot size={16} className="text-blue-600" />
              </div>
            )}
            <div className={clsx(
              'max-w-[75%] rounded-lg p-3 group relative', 
              m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-100'
            )}>
              {m.role === 'assistant' ? (
                <>
                  <div className="prose prose-sm max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                  <button
                    onClick={() => onSaveAsDocument(m.content)}
                    className="absolute -bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white border shadow-sm rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 flex items-center gap-1"
                    title="Save as document"
                  >
                    <FileText size={12} />
                    Save as Doc
                  </button>
                </>
              ) : (
                <p>{m.content}</p>
              )}
            </div>
            {m.role === 'user' && (
              <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center flex-shrink-0">
                <User size={16} className="text-gray-600" />
              </div>
            )}
          </div>
        ))}
        {isPending && (
          <div className="flex gap-3">
            <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
              <Loader2 size={16} className="text-blue-600 animate-spin" />
            </div>
            <div className="bg-gray-100 rounded-lg p-3 text-gray-500">Thinking...</div>
          </div>
        )}
      </div>
      
      {/* Chat Input */}
      <div className="p-4 border-t relative">
        {/* Mention Dropdown */}
        {showMentionMenu && mentionItems.length > 0 && (
          <MentionMenu
            items={mentionItems}
            mentionType={mentionType}
            selectedIndex={mentionIndex}
            onSelect={insertMention}
          />
        )}
        
        {/* Context indicator */}
        {(selectedPersonaIds.length > 0 || selectedDocumentIds.length > 0) && (
          <div className="flex flex-wrap gap-1 mb-2 text-xs text-gray-500">
            Context: {selectedPersonaIds.length} personas, {selectedDocumentIds.length} documents
          </div>
        )}
        
        <div className="flex gap-2">
          <input
            type="text"
            value={chatInput}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your project..."
            className="flex-1 px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <button
            onClick={handleSend}
            disabled={!chatInput.trim() || isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50 hover:bg-blue-700"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}

interface MentionMenuProps {
  readonly items: (ProjectPersona | ProjectDocument)[]
  readonly mentionType: 'persona' | 'document' | null
  readonly selectedIndex: number
  readonly onSelect: (item: ProjectPersona | ProjectDocument) => void
}

function getDocumentColorClass(documentType: string): string {
  if (documentType === 'prd') return 'bg-blue-100'
  if (documentType === 'prfaq') return 'bg-green-100'
  if (documentType === 'custom') return 'bg-purple-100'
  return 'bg-amber-100'
}

function getDocumentIconClass(documentType: string): string {
  if (documentType === 'prd') return 'text-blue-600'
  if (documentType === 'prfaq') return 'text-green-600'
  if (documentType === 'custom') return 'text-purple-600'
  return 'text-amber-600'
}

function PersonaMentionItem({ persona }: Readonly<{ persona: ProjectPersona }>) {
  return (
    <>
      <div className="w-8 h-8 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-white font-bold text-sm">
        {persona.name.charAt(0)}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-gray-900 truncate">@{persona.name}</p>
        <p className="text-xs text-gray-500 truncate">{persona.tagline}</p>
      </div>
    </>
  )
}

function DocumentMentionItem({ document }: Readonly<{ document: ProjectDocument }>) {
  const bgClass = getDocumentColorClass(document.document_type)
  const iconClass = getDocumentIconClass(document.document_type)
  
  return (
    <>
      <div className={clsx('w-8 h-8 rounded-lg flex items-center justify-center', bgClass)}>
        <FileText size={16} className={iconClass} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-gray-900 truncate">#{document.title}</p>
        <p className="text-xs text-gray-500">{document.document_type.toUpperCase()}</p>
      </div>
    </>
  )
}

function MentionMenu({ items, mentionType, selectedIndex, onSelect }: MentionMenuProps) {
  return (
    <div className="absolute bottom-full left-4 right-4 mb-2 bg-white border rounded-lg shadow-lg max-h-64 overflow-y-auto z-10">
      <div className="p-2 border-b bg-gray-50 text-xs text-gray-500 font-medium">
        {mentionType === 'persona' ? '👤 Personas' : '📄 Documents'}
      </div>
      {items.map((item, idx) => {
        const isPersona = 'persona_id' in item
        return (
          <button
            key={isPersona ? item.persona_id : item.document_id}
            onClick={() => onSelect(item)}
            className={clsx(
              'w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-gray-50 transition-colors',
              idx === selectedIndex && 'bg-blue-50'
            )}
          >
            {isPersona ? (
              <PersonaMentionItem persona={item} />
            ) : (
              <DocumentMentionItem document={item} />
            )}
          </button>
        )
      })}
      <div className="p-2 border-t bg-gray-50 text-xs text-gray-400">
        ↑↓ to navigate • Enter to select • Esc to close
      </div>
    </div>
  )
}
