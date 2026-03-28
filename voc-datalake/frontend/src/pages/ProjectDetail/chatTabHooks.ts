/**
 * Hooks and helpers extracted from ChatTab to keep file under max-lines limit.
 */
import {
  useState, useCallback, useRef, useEffect,
} from 'react'
import type {
  ChatMessage, ChatAttachment, DocumentChangeInfo, ActivePersonaInfo,
} from './ChatBubbles'
import type {
  ProjectPersona, ProjectDocument,
} from '../../api/types'
import type { ToolStep } from '../../hooks/useStreamChat'

// ── Mention detection ──

interface MentionState {
  show: boolean
  type: 'persona' | 'document' | null
  filter: string
  index: number
}

const emptyMentionState: MentionState = {
  show: false,
  type: null,
  filter: '',
  index: 0,
}

function detectMention(value: string): MentionState {
  const lastAtIndex = value.lastIndexOf('@')
  const lastHashIndex = value.lastIndexOf('#')

  if (lastAtIndex > lastHashIndex && lastAtIndex >= 0) {
    const textAfterAt = value.slice(lastAtIndex + 1)
    if (!textAfterAt.includes(' ')) {
      return {
        show: true,
        type: 'persona',
        filter: textAfterAt.toLowerCase(),
        index: 0,
      }
    }
  }

  if (lastHashIndex > lastAtIndex && lastHashIndex >= 0) {
    const textAfterHash = value.slice(lastHashIndex + 1)
    if (!textAfterHash.includes(' ')) {
      return {
        show: true,
        type: 'document',
        filter: textAfterHash.toLowerCase(),
        index: 0,
      }
    }
  }

  return emptyMentionState
}

// ── Mentions hook ──

/** Sentinel ID used when the user picks @all in the mention menu. */
const ALL_PERSONAS_ID = '__all__'

export function useMentions(
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
        setMentionState((s) => ({
          ...s,
          index: Math.min(s.index + 1, items.length - 1),
        }))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionState((s) => ({
          ...s,
          index: Math.max(s.index - 1, 0),
        }))
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
    mentionState,
    setMentionState,
    selectedPersonaIds,
    selectedDocumentIds,
    isRoundtable,
    handleInputChange,
    getMentionItems,
    insertMention,
    handleKeyDown,
    reset,
  }
}

// ── Resolve active persona for avatar display ──

export function resolveActivePersona(
  personas: ProjectPersona[],
  selectedPersonaIds: string[],
): ActivePersonaInfo | undefined {
  if (selectedPersonaIds.length === 0) return undefined
  const persona = personas.find((p) => p.persona_id === selectedPersonaIds[0])
  if (!persona) return undefined
  return {
    name: persona.name,
    avatar_url: persona.avatar_url,
  }
}

// ── Stream finalize hook ──

interface CompletedTurn {
  persona: {
    persona_id: string;
    name: string;
    avatar_url?: string
  }
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
  curPersona: {
    persona_id: string;
    name: string;
    avatar_url?: string
  } | null
}

function buildRoundtableMessages(snapshot: StreamSnapshot): ChatMessage[] {
  const {
    text, turns, curPersona,
  } = snapshot
  const newMessages: ChatMessage[] = turns.map((turn) => ({
    role: 'assistant' as const,
    content: turn.content,
    activePersona: {
      name: turn.persona.name,
      avatar_url: turn.persona.avatar_url,
    },
  }))
  if (text !== '' && curPersona) {
    newMessages.push({
      role: 'assistant',
      content: text,
      activePersona: {
        name: curPersona.name,
        avatar_url: curPersona.avatar_url,
      },
    })
  }
  return newMessages
}

function buildFinalizedMessages(snapshot: StreamSnapshot): ChatMessage[] {
  const {
    text, error, changes, toolSteps, persona, turns, curPersona,
  } = snapshot
  const isRoundtable = turns.length > 0 || curPersona !== null

  if (isRoundtable) return buildRoundtableMessages(snapshot)
  if (text !== '') {
    return [{
      role: 'assistant',
      content: text,
      documentChanges: changes.length > 0 ? changes : undefined,
      toolSteps: toolSteps.length > 0 ? toolSteps : undefined,
      activePersona: persona,
    }]
  }
  if (error != null && error !== '') return [{
    role: 'assistant',
    content: `Error: ${error}`,
  }]
  return []
}

interface UseStreamFinalizeOptions {
  isStreaming: boolean
  streamingText: string
  thinkingText: string
  streamError: string | null
  documentChanges: DocumentChangeInfo[]
  toolSteps: ToolStep[]
  activePersona: ActivePersonaInfo | undefined
  completedTurns: CompletedTurn[]
  currentPersona: {
    persona_id: string;
    name: string;
    avatar_url?: string
  } | null
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  onDocumentChanged?: () => void
}

export function useStreamFinalize(options: UseStreamFinalizeOptions) {
  const {
    isStreaming, streamingText, thinkingText, streamError,
    documentChanges, toolSteps, activePersona,
    completedTurns, currentPersona, setMessages, onDocumentChanged,
  } = options
  const latestRef = useRef({
    streamingText,
    thinkingText,
    streamError,
    documentChanges,
    toolSteps,
    activePersona,
    completedTurns,
    currentPersona,
  })
  useEffect(() => {
    latestRef.current = {
      streamingText,
      thinkingText,
      streamError,
      documentChanges,
      toolSteps,
      activePersona,
      completedTurns,
      currentPersona,
    }
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
      if (newMessages.length > 0) setMessages((prev) => [...prev, ...newMessages])
      if (onDocumentChanged) onDocumentChanged()
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming, setMessages, onDocumentChanged])
}

// ── Attachments hook ──

export const ACCEPTED_TYPES = 'image/png,image/jpeg,image/gif,image/webp,application/pdf'
const MAX_FILE_SIZE = 5 * 1024 * 1024

function extractBase64(result: unknown): string {
  if (typeof result !== 'string') return ''
  return result.split(',')[1] ?? ''
}

function processFile(file: File, setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>) {
  const reader = new FileReader()
  reader.onload = () => {
    const base64 = extractBase64(reader.result)
    const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
    setAttachments((prev) => [...prev, {
      name: file.name,
      media_type: file.type,
      data: base64,
      preview_url: previewUrl,
    }])
  }
  reader.readAsDataURL(file)
}

export function useAttachments() {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const acceptedList = ACCEPTED_TYPES.split(',')

  const addFiles = useCallback((files: FileList | null) => {
    if (!files) return
    setError(null)
    for (const file of Array.from(files)) {
      if (!acceptedList.includes(file.type)) {
        setError(`Unsupported file type: ${file.name}`); continue
      }
      if (file.size > MAX_FILE_SIZE) {
        setError(`File too large (max 5MB): ${file.name}`); continue
      }
      processFile(file, setAttachments)
    }
  }, [acceptedList])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
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
        setError(`Unsupported file type: ${file.type}`); continue
      }
      if (file.size > MAX_FILE_SIZE) {
        setError(`File too large (max 5MB): ${file.name}`); continue
      }
      processFile(file, setAttachments)
    }
  }, [acceptedList])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => {
      const removed = prev[index]
      if (removed.preview_url != null && removed.preview_url !== '') URL.revokeObjectURL(removed.preview_url)
      return prev.filter((_, i) => i !== index)
    })
  }, [])

  const reset = useCallback(() => {
    setAttachments((prev) => {
      for (const a of prev) {
        if (a.preview_url != null && a.preview_url !== '') URL.revokeObjectURL(a.preview_url)
      }
      return []
    })
    setError(null)
  }, [])

  return {
    attachments,
    error,
    addFiles,
    handlePaste,
    removeAttachment,
    reset,
  }
}

// ── Attachment API payload builder ──

export function buildApiAttachments(
  currentAttachments: ChatAttachment[] | undefined,
): Array<{
  name: string;
  media_type: string;
  data: string
}> | undefined {
  return currentAttachments?.map((att) => ({
    name: att.name,
    media_type: att.media_type,
    data: att.data,
  }))
}
