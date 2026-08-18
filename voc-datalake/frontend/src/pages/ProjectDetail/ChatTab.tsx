/**
 * ChatTab - Project-scoped AI chat with streaming + mentions + attachments
 */
import {
  MessageSquare, Send, X, Paperclip, Trash2,
} from 'lucide-react'
import {
  useState, useCallback, useRef, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useStreamChat } from '../../hooks/useStreamChat'
import { resolvePersonaSelection } from './personaSelection'
import { useProjectChatStore } from '../../store/projectChatStore'
import {
  ChatMessageBubble,
  StreamingBubble,
  AttachmentThumbnail,
  MentionMenu,
} from './ChatBubbles'
import {
  useMentions,
  useStreamFinalize,
  useAttachments,
  resolveActivePersona,
  buildApiAttachments,
  ACCEPTED_TYPES,
} from './chatTabHooks'
import { buildHistory } from '../../constants/chat'
import type {
  ChatMessage, ActivePersonaInfo,
} from './ChatBubbles'
import type {
  ProjectPersona, ProjectDocument,
} from '../../api/types'

interface ChatTabProps {
  readonly projectId: string
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly onSaveAsDocument: (content: string) => void
  readonly onDocumentChanged?: () => void
}

// ── Chat input sub-components ──

function MentionContextBar({ mentions }: Readonly<{ mentions: ReturnType<typeof useMentions> }>) {
  if (mentions.selectedPersonaIds.length === 0 && mentions.selectedDocumentIds.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1 mb-2 text-xs text-gray-500">
      {mentions.isRoundtable
        ? `🎙️ Roundtable: all ${mentions.selectedPersonaIds.length} personas`
        : `Context: ${mentions.selectedPersonaIds.length} personas`}
      {mentions.selectedDocumentIds.length > 0 && `, ${mentions.selectedDocumentIds.length} documents`}
    </div>
  )
}

function AttachmentPreview({ attachState }: Readonly<{ attachState: ReturnType<typeof useAttachments> }>) {
  if (attachState.attachments.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {attachState.attachments.map((att, idx) => (
        <AttachmentThumbnail key={`${att.name}-${att.media_type}`} attachment={att} onRemove={() => attachState.removeAttachment(idx)} />
      ))}
    </div>
  )
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

  const { t } = useTranslation('projectDetail')

  return (
    <div className="p-4 border-t relative">
      {mentions.mentionState.show && mentionItems.length > 0 ? <MentionMenu
        items={mentionItems}
        mentionType={mentions.mentionState.type}
        selectedIndex={mentions.mentionState.index}
        onSelect={mentions.insertMention}
      /> : null}

      <MentionContextBar mentions={mentions} />

      {attachState.error != null && attachState.error !== '' ? <div className="mb-2 text-xs text-red-600 bg-red-50 rounded px-2 py-1">{attachState.error}</div> : null}

      <AttachmentPreview attachState={attachState} />

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        multiple
        className="hidden"
        onChange={(e) => {
          attachState.addFiles(e.target.files); e.target.value = ''
        }}
      />

      <div className="flex gap-2">
        <button
          onClick={handleOpenFilePicker}
          disabled={isStreaming}
          className="px-2 py-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50 transition-colors"
          title={t('chat.attachFile')}
          aria-label={t('chat.attachFile')}
        >
          <Paperclip size={18} />
        </button>
        <input
          type="text"
          value={chatInput}
          onChange={(e) => mentions.handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={attachState.handlePaste}
          placeholder={t('chat.askPlaceholder')}
          className="flex-1 px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button onClick={cancel} className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 flex items-center gap-1">
            <X size={16} />
            <span className="hidden sm:inline">{t('chat.stop')}</span>
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!hasInput}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50 hover:bg-blue-700"
            title={t('chat.send')}
            aria-label={t('chat.send')}
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

/**
 * Turn a stored message into a history entry, keeping persona attribution.
 *
 * Roundtable mode stores one assistant message *per persona*, and
 * `buildHistory` merges that run into the single logical turn it represents.
 * Merging the bodies alone would hand the model one turn in which several
 * personas speak with one voice: a roundtable exists to surface disagreement,
 * so "raise the price" and "keep it flat" merged unattributed reads as a single
 * speaker contradicting itself, and a follow-up like "what did Priya think?"
 * has nothing to work from.
 *
 * The store already holds the name (`buildRoundtableMessages` sets
 * `activePersona`), so prefixing it here makes the merged turn read as a
 * transcript. This is deliberately done at the call site rather than inside
 * `buildHistory`: the builder stays concerned only with *shape*, and knows
 * nothing about personas.
 *
 * Only assistant messages are prefixed — a user turn has no persona. What is
 * left unchanged is a reply with *no* persona: a VOC-style answer, or any stored
 * message from before attribution existed. A reply attributed to a *single*
 * persona IS prefixed, and that is intended — an ordinary `@Priya …` mention
 * takes the non-roundtable branch, where `handleSend` still calls
 * `resolveActivePersona` and `chatFinalize` stores the result, so the name is
 * present and reaches the model on the next send.
 *
 * Known residue, pre-existing and not fixed here: two personas mentioned
 * individually (rather than via `@all`) is still non-roundtable, and
 * `resolveActivePersona` keeps only `selectedPersonaIds[0]`, so both replies end
 * up attributed to the first persona.
 *
 * The prefix costs `name.length + 2` characters against *both* server budgets —
 * the per-turn ceiling (`MAX_HISTORY_CONTENT_LENGTH`, enforced by
 * `truncateEntry`) and the aggregate one (`MAX_HISTORY_TOTAL_LENGTH`), where it
 * can shift which turns survive the walk. It is also NOT idempotent: a second
 * pass yields `Priya, CFO: Priya, CFO: …`. Both are why this must stay a
 * send-time transform on a local copy and must never be written back to the
 * store.
 */
function toHistoryEntry(message: ChatMessage): {
  role: 'user' | 'assistant';
  content: string
} {
  const personaName = message.activePersona?.name
  const attribute = message.role === 'assistant' && personaName != null && personaName !== ''
  return {
    role: message.role,
    content: attribute ? `${personaName}: ${message.content}` : message.content,
  }
}

export default function ChatTab({
  projectId, personas, documents, onSaveAsDocument, onDocumentChanged,
}: ChatTabProps) {
  const [chatInput, setChatInput] = useState('')
  const { t } = useTranslation('projectDetail')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const messages = useProjectChatStore((s) => s.messagesByProject[projectId] ?? EMPTY_MESSAGES)
  const addStoreMessage = useProjectChatStore((s) => s.addMessage)
  const clearStoreMessages = useProjectChatStore((s) => s.clearMessages)

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
  const [currentActivePersona, setCurrentActivePersona] = useState<ActivePersonaInfo | undefined>()

  const {
    isStreaming, streamingText, thinkingText, activeTools, toolSteps,
    documentChanges, error: streamError, completedTurns, currentPersona,
    sendMessage: sendStreamMessage, cancel,
  } = useStreamChat()

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText, thinkingText, completedTurns])

  useStreamFinalize({
    isStreaming,
    streamingText,
    thinkingText,
    streamError,
    documentChanges,
    toolSteps,
    activePersona: currentActivePersona,
    completedTurns,
    currentPersona,
    setMessages,
    onDocumentChanged,
  })

  // The `@all` expansion is clamped to what the stream Lambda accepts — see
  // resolvePersonaSelection. Known residue: when it clamps, the UI does not say
  // so, because MentionContextBar renders nothing for the @all case.
  const resolvePersonaIds = useCallback((input: string) => resolvePersonaSelection(
    input,
    personas.map((p) => p.persona_id),
    mentions.selectedPersonaIds,
    mentions.isRoundtable,
  ), [mentions.isRoundtable, mentions.selectedPersonaIds, personas])

  const handleSend = useCallback(() => {
    if (chatInput.trim() === '' || isStreaming) return

    const {
      isRoundtable, selectedPersonaIds,
    } = resolvePersonaIds(chatInput)

    const currentAttachments = attach.attachments.length > 0 ? [...attach.attachments] : undefined
    const messageAttachments = currentAttachments?.map(
      (att) => ({
        name: att.name,
        media_type: att.media_type,
        data: att.data,
      }),
    )
    addStoreMessage(projectId, {
      role: 'user',
      content: chatInput,
      attachments: messageAttachments,
    })
    setCurrentActivePersona(isRoundtable ? undefined : resolveActivePersona(personas, selectedPersonaIds))

    // buildHistory caps the payload to the server-side window and repairs the
    // shape Bedrock requires.  Roundtable mode stores one assistant message per
    // persona, so the assistant-run merge matters here — and `toHistoryEntry`
    // keeps each persona's name on its contribution so the merged turn reads as
    // a transcript rather than one self-contradicting voice.
    const history = buildHistory(messages.map(toHistoryEntry))
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
  }, [chatInput, isStreaming, resolvePersonaIds, mentions, projectId, sendStreamMessage, attach, messages, personas, addStoreMessage])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      mentions.handleKeyDown(e, handleSend)
    },
    [mentions, handleSend],
  )

  return (
    <div className="bg-white rounded-xl border h-[calc(100vh-280px)] sm:h-[600px] flex flex-col">
      <div className="p-3 sm:p-4 border-b flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-sm sm:text-base">{t('chat.projectAiChat')}</h3>
          <p className="text-xs sm:text-sm text-gray-500">
            {t('chat.mentionHint').replace('<at>', '@').replace('<atAll>', '@all').replace('<hash>', '#')}
          </p>
        </div>
        {messages.length > 0 && !isStreaming && (
          <button
            onClick={() => clearStoreMessages(projectId)}
            className="text-gray-400 hover:text-red-500 transition-colors p-1 rounded"
            title={t('chat.clearHistory')}
            aria-label={t('chat.clearHistory')}
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && !isStreaming && (
          <div className="text-center text-gray-400 py-8">
            <MessageSquare size={32} className="mx-auto mb-2 opacity-50" />
            <p>{t('chat.startConversation')}</p>
            <p className="text-sm mt-2">{t('chat.tryExample')}</p>
          </div>
        )}
        {messages.map((m) => (
          <ChatMessageBubble key={`${m.role}-${m.content.slice(0, 40)}`} message={m} onSaveAsDocument={onSaveAsDocument} />
        ))}
        {isStreaming ? completedTurns.map((turn) => (
          <ChatMessageBubble
            key={`turn-${turn.persona.persona_id}-${turn.content.slice(0, 40)}`}
            message={{
              role: 'assistant',
              content: turn.content,
              thinking: turn.thinking,
              activePersona: {
                name: turn.persona.name,
                avatar_url: turn.persona.avatar_url,
              },
            }}
            onSaveAsDocument={onSaveAsDocument}
          />
        )) : null}
        {isStreaming ? <StreamingBubble
          streamingText={streamingText}
          thinkingText={thinkingText}
          activeTools={activeTools}
          toolSteps={toolSteps}
          documentChanges={documentChanges}
          activePersona={currentPersona
            ? {
              name: currentPersona.name,
              avatar_url: currentPersona.avatar_url,
            }
            : currentActivePersona}
        /> : null}
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
