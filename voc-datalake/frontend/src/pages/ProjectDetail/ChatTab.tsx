/**
 * ChatTab - Project-scoped AI chat with streaming + mentions + attachments
 */
import { useState, useCallback, useRef, useEffect } from 'react'
import { MessageSquare, Send, X, Paperclip, Trash2 } from 'lucide-react'
import { useStreamChat } from '../../hooks/useStreamChat'
import type { ToolStep } from '../../hooks/useStreamChat'
import { useProjectChatStore } from '../../store/projectChatStore'
import type { ProjectPersona, ProjectDocument } from '../../api/client'
import type { ChatMessage, ChatAttachment, DocumentChangeInfo, ActivePersonaInfo } from './ChatBubbles'
import {
  ChatMessageBubble,
  StreamingBubble,
  AttachmentThumbnail,
  MentionMenu,
} from './ChatBubbles'

interface ChatTabProps {
  readonly projectId: string
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly onSaveAsDocument: (content: string) => void
  readonly onDocumentChanged?: () => void
}

// ── Mention detection ──

interface MentionState {
  show: boolean
  type: 'persona' | 'document' | null
  filter: string
  index: number
}

const emptyMentionState: MentionState = { show: false, type: null, filter: '', index: 0 }

function detectMention(value: string): MentionState {
  const lastAtIndex = value.lastIndexOf('@')
  const lastHashIndex = value.lastIndexOf('#')

  if (lastAtIndex > lastHashIndex && lastAtIndex >= 0) {
    const textAfterAt = value.slice(lastAtIndex + 1)
    if (!textAfterAt.includes(' ')) {
      return { show: true, type: 'persona', filter: textAfterAt.toLowerCase(), index: 0 }
    }
  }

  if (lastHashIndex > lastAtIndex && lastHashIndex >= 0) {
    const textAfterHash = value.slice(lastHashIndex + 1)
    if (!textAfterHash.includes(' ')) {
      return { show: true, type: 'document', filter: textAfterHash.toLowerCase(), index: 0 }
    }
  }

  return emptyMentionState
}

// ── Mentions hook ──

/** Sentinel ID used when the user picks @all in the mention menu. */
const ALL_PERSONAS_ID = '__all__'

function useMentions(
  personas: ProjectPersona[],
  documents: ProjectDocument[],
  chatInput: string,
  setChatInput: (v: string) => void,
) {
  const [mentionState, setMentionState] = useState<MentionState>(emptyMentionState)
  const [selectedPersonaIds, setSelectedPersonaIds] = useState<string[]>([])
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([])
  const [isRoundtable, setIsRoundtable] = useState(false)

  const handleInputChange = useCallback((value: string) => {
    setChatInput(value)
    setMentionState(detectMention(value))
  }, [setChatInput])

  const getMentionItems = useCallback(() => {
    if (mentionState.type === 'persona') {
      const filtered = personas.filter((p) => p.name.toLowerCase().includes(mentionState.filter)).slice(0, 6)
      // Prepend @all option when filter matches and there are 2+ personas
      if (personas.length >= 2 && 'all'.includes(mentionState.filter)) {
        const allItem: ProjectPersona = {
          persona_id: ALL_PERSONAS_ID,
          name: 'all',
          tagline: `Roundtable — all ${personas.length} personas respond`,
          created_at: '',
        }
        return [allItem, ...filtered]
      }
      return filtered
    }
    if (mentionState.type === 'document') {
      return documents.filter((d) => d.title.toLowerCase().includes(mentionState.filter)).slice(0, 6)
    }
    return []
  }, [mentionState.type, mentionState.filter, personas, documents])

  const insertMention = useCallback(
    (item: ProjectPersona | ProjectDocument) => {
      const isPersona = mentionState.type === 'persona'
      const itemIsPersona = 'persona_id' in item

      if (itemIsPersona && item.persona_id === ALL_PERSONAS_ID) {
        // @all — select all persona IDs and enable roundtable
        setSelectedPersonaIds(personas.map((p) => p.persona_id))
        setIsRoundtable(true)
        const triggerIndex = chatInput.lastIndexOf('@')
        setChatInput(chatInput.slice(0, triggerIndex) + '@all ')
        setMentionState(emptyMentionState)
        return
      }

      const name = itemIsPersona ? item.name : item.title

      if (itemIsPersona && !selectedPersonaIds.includes(item.persona_id)) {
        setSelectedPersonaIds((prev) => [...prev, item.persona_id])
      }
      if (!itemIsPersona && !selectedDocumentIds.includes(item.document_id)) {
        setSelectedDocumentIds((prev) => [...prev, item.document_id])
      }

      const triggerIndex = isPersona ? chatInput.lastIndexOf('@') : chatInput.lastIndexOf('#')
      const trigger = isPersona ? '@' : '#'
      setChatInput(chatInput.slice(0, triggerIndex) + trigger + name + ' ')
      setMentionState(emptyMentionState)
    },
    [mentionState.type, chatInput, selectedPersonaIds, selectedDocumentIds, setChatInput, personas],
  )

  const reset = useCallback(() => {
    setMentionState(emptyMentionState)
    setSelectedPersonaIds([])
    setSelectedDocumentIds([])
    setIsRoundtable(false)
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, onEnter: () => void) => {
      if (!mentionState.show) {
        if (e.key === 'Enter') onEnter()
        return
      }
      const items = getMentionItems()
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionState((s) => ({ ...s, index: Math.min(s.index + 1, items.length - 1) }))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionState((s) => ({ ...s, index: Math.max(s.index - 1, 0) }))
      } else if ((e.key === 'Enter' || e.key === 'Tab') && items.length > 0) {
        e.preventDefault()
        insertMention(items[mentionState.index])
      } else if (e.key === 'Escape') {
        setMentionState(emptyMentionState)
      }
    },
    [mentionState.show, mentionState.index, getMentionItems, insertMention],
  )

  return {
    mentionState, setMentionState, selectedPersonaIds, selectedDocumentIds, isRoundtable,
    handleInputChange, getMentionItems, insertMention, handleKeyDown, reset,
  }
}

// ── Resolve active persona for avatar display ──

function resolveActivePersona(
  personas: ProjectPersona[],
  selectedPersonaIds: string[],
): ActivePersonaInfo | undefined {
  if (selectedPersonaIds.length === 0) return undefined
  const persona = personas.find((p) => p.persona_id === selectedPersonaIds[0])
  if (!persona) return undefined
  return { name: persona.name, avatar_url: persona.avatar_url }
}

// ── Stream finalize hook ──

interface CompletedTurn {
  persona: { persona_id: string; name: string; avatar_url?: string }
  content: string
  thinking?: string
}

interface StreamSnapshot {
  text: string
  thinking: string
  error: string | null
  changes: DocumentChangeInfo[]
  toolSteps: ToolStep[]
  persona: ActivePersonaInfo | undefined
  turns: CompletedTurn[]
  curPersona: { persona_id: string; name: string; avatar_url?: string } | null
}

function buildRoundtableMessages(snapshot: StreamSnapshot): ChatMessage[] {
  const { text, turns, curPersona } = snapshot
  const newMessages: ChatMessage[] = turns.map((turn) => ({
    role: 'assistant' as const,
    content: turn.content,
    activePersona: { name: turn.persona.name, avatar_url: turn.persona.avatar_url },
  }))
  if (text && curPersona) {
    newMessages.push({
      role: 'assistant',
      content: text,
      activePersona: { name: curPersona.name, avatar_url: curPersona.avatar_url },
    })
  }
  return newMessages
}

function buildFinalizedMessages(snapshot: StreamSnapshot): ChatMessage[] {
  const { text, error, changes, toolSteps, persona, turns, curPersona } = snapshot
  const isRoundtable = turns.length > 0 || curPersona !== null

  if (isRoundtable) {
    return buildRoundtableMessages(snapshot)
  }
  if (text) {
    return [{
      role: 'assistant',
      content: text,
      documentChanges: changes.length > 0 ? changes : undefined,
      toolSteps: toolSteps.length > 0 ? toolSteps : undefined,
      activePersona: persona,
    }]
  }
  if (error) {
    return [{ role: 'assistant', content: `Error: ${error}` }]
  }
  return []
}

function useStreamFinalize(
  isStreaming: boolean,
  streamingText: string,
  thinkingText: string,
  streamError: string | null,
  documentChanges: DocumentChangeInfo[],
  toolSteps: ToolStep[],
  activePersona: ActivePersonaInfo | undefined,
  completedTurns: CompletedTurn[],
  currentPersona: { persona_id: string; name: string; avatar_url?: string } | null,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  onDocumentChanged?: () => void,
) {
  const latestRef = useRef({ streamingText, thinkingText, streamError, documentChanges, toolSteps, activePersona, completedTurns, currentPersona })
  useEffect(() => {
    latestRef.current = { streamingText, thinkingText, streamError, documentChanges, toolSteps, activePersona, completedTurns, currentPersona }
  })

  const prevStreamingRef = useRef(false)
  useEffect(() => {
    const ref = latestRef.current
    if (prevStreamingRef.current && !isStreaming) {
      const snapshot: StreamSnapshot = {
        text: ref.streamingText,
        thinking: ref.thinkingText,
        error: ref.streamError,
        changes: ref.documentChanges,
        toolSteps: ref.toolSteps,
        persona: ref.activePersona,
        turns: ref.completedTurns,
        curPersona: ref.currentPersona,
      }
      const newMessages = buildFinalizedMessages(snapshot)
      if (newMessages.length > 0) {
        setMessages((prev) => [...prev, ...newMessages])
      }
      // Always refresh documents after a project chat ends — the AI may have
      // edited a document via update_document, and the document_changed SSE
      // event can be lost if the stream is interrupted (ERR_HTTP2_PROTOCOL_ERROR)
      if (onDocumentChanged) {
        onDocumentChanged()
      }
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming, setMessages, onDocumentChanged])
}

// ── Attachments hook ──

const ACCEPTED_TYPES = 'image/png,image/jpeg,image/gif,image/webp,application/pdf'
const MAX_FILE_SIZE = 5 * 1024 * 1024

function extractBase64(result: unknown): string {
  if (typeof result !== 'string') return ''
  return result.split(',')[1] ?? ''
}

function processFile(
  file: File,
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>,
) {
  const reader = new FileReader()
  reader.onload = () => {
    const base64 = extractBase64(reader.result)
    const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
    setAttachments((prev) => [
      ...prev,
      { name: file.name, media_type: file.type, data: base64, preview_url: previewUrl },
    ])
  }
  reader.readAsDataURL(file)
}

function useAttachments() {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const acceptedList = ACCEPTED_TYPES.split(',')

  const addFiles = useCallback((files: FileList | null) => {
    if (!files) return
    setError(null)

    Array.from(files).forEach((file) => {
      if (!acceptedList.includes(file.type)) {
        setError(`Unsupported file type: ${file.name}`)
        return
      }
      if (file.size > MAX_FILE_SIZE) {
        setError(`File too large (max 5MB): ${file.name}`)
        return
      }
      processFile(file, setAttachments)
    })
  }, [acceptedList])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    const imageFiles: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }

    if (imageFiles.length === 0) return

    e.preventDefault()
    setError(null)
    for (const file of imageFiles) {
      if (!acceptedList.includes(file.type)) {
        setError(`Unsupported file type: ${file.type}`)
        continue
      }
      if (file.size > MAX_FILE_SIZE) {
        setError(`File too large (max 5MB): ${file.name}`)
        continue
      }
      processFile(file, setAttachments)
    }
  }, [acceptedList])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => {
      const removed = prev[index]
      if (removed?.preview_url) URL.revokeObjectURL(removed.preview_url)
      return prev.filter((_, i) => i !== index)
    })
  }, [])

  const reset = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach((a) => { if (a.preview_url) URL.revokeObjectURL(a.preview_url) })
      return []
    })
    setError(null)
  }, [])

  return { attachments, error, addFiles, handlePaste, removeAttachment, reset }
}

// ── Attachment API payload builder ──

function buildApiAttachments(
  currentAttachments: ChatAttachment[] | undefined,
): Array<{ name: string; media_type: string; data: string }> | undefined {
  return currentAttachments?.map((att) => ({ name: att.name, media_type: att.media_type, data: att.data }))
}

// ── Chat input section ──

function ChatInputSection({
  mentions,
  attachState,
  fileInputRef,
  chatInput,
  isStreaming,
  handleKeyDown,
  handleSend,
  cancel,
}: Readonly<{
  mentions: ReturnType<typeof useMentions>
  attachState: ReturnType<typeof useAttachments>
  fileInputRef: React.RefObject<HTMLInputElement | null>
  chatInput: string
  isStreaming: boolean
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  handleSend: () => void
  cancel: () => void
}>) {
  const mentionItems = mentions.getMentionItems()
  const hasInput = chatInput.trim().length > 0 || attachState.attachments.length > 0

  const handleOpenFilePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [fileInputRef])

  return (
    <div className="p-4 border-t relative">
      {mentions.mentionState.show && mentionItems.length > 0 && (
        <MentionMenu
          items={mentionItems}
          mentionType={mentions.mentionState.type}
          selectedIndex={mentions.mentionState.index}
          onSelect={mentions.insertMention}
        />
      )}

      {(mentions.selectedPersonaIds.length > 0 || mentions.selectedDocumentIds.length > 0) && (
        <div className="flex flex-wrap gap-1 mb-2 text-xs text-gray-500">
          {mentions.isRoundtable
            ? `🎙️ Roundtable: all ${mentions.selectedPersonaIds.length} personas`
            : `Context: ${mentions.selectedPersonaIds.length} personas`}
          {mentions.selectedDocumentIds.length > 0 && `, ${mentions.selectedDocumentIds.length} documents`}
        </div>
      )}

      {attachState.error && (
        <div className="mb-2 text-xs text-red-600 bg-red-50 rounded px-2 py-1">{attachState.error}</div>
      )}

      {attachState.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachState.attachments.map((att, idx) => (
            <AttachmentThumbnail key={`${att.name}-${idx}`} attachment={att} onRemove={() => attachState.removeAttachment(idx)} />
          ))}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        multiple
        className="hidden"
        onChange={(e) => { attachState.addFiles(e.target.files); e.target.value = '' }}
      />

      <div className="flex gap-2">
        <button
          onClick={handleOpenFilePicker}
          disabled={isStreaming}
          className="px-2 py-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50 transition-colors"
          title="Attach image or PDF"
          aria-label="Attach file"
        >
          <Paperclip size={18} />
        </button>
        <input
          type="text"
          value={chatInput}
          onChange={(e) => mentions.handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={attachState.handlePaste}
          placeholder="Ask about your project..."
          className="flex-1 px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button onClick={cancel} className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 flex items-center gap-1">
            <X size={16} />
            <span className="hidden sm:inline">Stop</span>
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!hasInput}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50 hover:bg-blue-700"
          >
            <Send size={18} />
          </button>
        )}
      </div>
    </div>
  )
}

// ── Main component ──

const EMPTY_MESSAGES: ChatMessage[] = []

export default function ChatTab({ projectId, personas, documents, onSaveAsDocument, onDocumentChanged }: ChatTabProps) {
  const [chatInput, setChatInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Use persisted store instead of local state so messages survive tab switches
  const storeMessages = useProjectChatStore((s) => s.messagesByProject[projectId])
  const addStoreMessage = useProjectChatStore((s) => s.addMessage)
  const clearStoreMessages = useProjectChatStore((s) => s.clearMessages)

  // Derive ChatMessage[] from store — use stable empty array to avoid infinite re-renders
  const messages: ChatMessage[] = storeMessages ?? EMPTY_MESSAGES
  const setMessages = useCallback(
    (updater: React.SetStateAction<ChatMessage[]>) => {
      const current = useProjectChatStore.getState().messagesByProject[projectId] ?? EMPTY_MESSAGES
      const next = typeof updater === 'function' ? updater(current) : updater
      useProjectChatStore.getState().setMessages(projectId, next)
    },
    [projectId],
  )

  const mentions = useMentions(personas, documents, chatInput, setChatInput)
  const attach = useAttachments()
  const [currentActivePersona, setCurrentActivePersona] = useState<ActivePersonaInfo | undefined>(undefined)

  const {
    isStreaming, streamingText, thinkingText, activeTools, toolSteps,
    documentChanges, error: streamError, completedTurns, currentPersona,
    sendMessage: sendStreamMessage, cancel,
  } = useStreamChat()

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText, thinkingText, completedTurns])

  useStreamFinalize(isStreaming, streamingText, thinkingText, streamError, documentChanges, toolSteps, currentActivePersona, completedTurns, currentPersona, setMessages, onDocumentChanged)

  const handleSend = useCallback(() => {
    if (!chatInput.trim() || isStreaming) return

    // Auto-detect @all typed manually (without selecting from mention menu)
    const hasAtAll = /(?:^|\s)@all(?:\s|$)/i.test(chatInput)
    const isRoundtable = mentions.isRoundtable || (hasAtAll && personas.length >= 2)
    const selectedPersonaIds = isRoundtable && mentions.selectedPersonaIds.length === 0
      ? personas.map((p) => p.persona_id)
      : mentions.selectedPersonaIds

    const currentAttachments = attach.attachments.length > 0 ? [...attach.attachments] : undefined
    // Strip preview_url before storing — blob URLs get revoked after reset
    const messageAttachments = currentAttachments?.map(
      (att) => ({ name: att.name, media_type: att.media_type, data: att.data })
    )
    addStoreMessage(projectId, { role: 'user', content: chatInput, attachments: messageAttachments })

    // Capture the active persona for avatar display on the response
    setCurrentActivePersona(isRoundtable ? undefined : resolveActivePersona(personas, selectedPersonaIds))

    const history = messages.map((m) => ({ role: m.role, content: m.content }))

    void sendStreamMessage(chatInput, {
      projectId,
      selectedPersonas: selectedPersonaIds,
      selectedDocuments: mentions.selectedDocumentIds,
      attachments: buildApiAttachments(currentAttachments),
      history,
      roundtable: isRoundtable || undefined,
    })

    setChatInput('')
    mentions.reset()
    attach.reset()
  }, [chatInput, isStreaming, mentions, projectId, sendStreamMessage, attach, messages, personas, addStoreMessage])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => { mentions.handleKeyDown(e, handleSend) },
    [mentions, handleSend],
  )

  return (
    <div className="bg-white rounded-xl border h-[calc(100vh-280px)] sm:h-[600px] flex flex-col">
      <div className="p-3 sm:p-4 border-b flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-sm sm:text-base">Project AI Chat</h3>
          <p className="text-xs sm:text-sm text-gray-500">
            Type <span className="font-mono bg-purple-100 text-purple-700 px-1 rounded">@</span> for personas,{' '}
            <span className="font-mono bg-purple-100 text-purple-700 px-1 rounded">@all</span> for roundtable, or{' '}
            <span className="font-mono bg-blue-100 text-blue-700 px-1 rounded">#</span> for documents
          </p>
        </div>
        {messages.length > 0 && !isStreaming && (
          <button
            onClick={() => clearStoreMessages(projectId)}
            className="text-gray-400 hover:text-red-500 transition-colors p-1 rounded"
            title="Clear chat history"
            aria-label="Clear chat history"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && !isStreaming && (
          <div className="text-center text-gray-400 py-8">
            <MessageSquare size={32} className="mx-auto mb-2 opacity-50" />
            <p>Start a conversation</p>
            <p className="text-sm mt-2">
              Try: &quot;@all What do you think about our onboarding flow?&quot;
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <ChatMessageBubble key={i} message={m} onSaveAsDocument={onSaveAsDocument} />
        ))}
        {isStreaming && completedTurns.map((turn, i) => (
          <ChatMessageBubble
            key={`turn-${i}`}
            message={{
              role: 'assistant',
              content: turn.content,
              thinking: turn.thinking,
              activePersona: { name: turn.persona.name, avatar_url: turn.persona.avatar_url },
            }}
            onSaveAsDocument={onSaveAsDocument}
          />
        ))}
        {isStreaming && (
          <StreamingBubble
            streamingText={streamingText}
            thinkingText={thinkingText}
            activeTools={activeTools}
            toolSteps={toolSteps}
            documentChanges={documentChanges}
            activePersona={currentPersona
              ? { name: currentPersona.name, avatar_url: currentPersona.avatar_url }
              : currentActivePersona}
          />
        )}
        <div ref={messagesEndRef} />
      </div>

      <ChatInputSection
        mentions={mentions}
        attachState={attach}
        fileInputRef={fileInputRef}
        chatInput={chatInput}
        isStreaming={isStreaming}
        handleKeyDown={handleKeyDown}
        handleSend={handleSend}
        cancel={cancel}
      />
    </div>
  )
}
