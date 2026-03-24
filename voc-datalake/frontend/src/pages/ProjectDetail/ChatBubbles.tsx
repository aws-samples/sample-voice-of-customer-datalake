/**
 * Chat message bubble components for the project AI chat.
 */
import { useState } from 'react'
import { User, Bot, Loader2, FileText, Brain, X, Users, Search, Wrench, CheckCircle2 } from 'lucide-react'
import clsx from 'clsx'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ProjectPersona, ProjectDocument } from '../../api/client'

import type { ToolStep } from '../../hooks/useStreamChat'

export interface DocumentChangeInfo {
  document_id: string
  title: string
  action: 'updated' | 'created'
  summary: string
}

export interface ChatAttachment {
  name: string
  media_type: string
  data: string
  preview_url?: string
}

export interface ActivePersonaInfo {
  name: string
  avatar_url?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  attachments?: ChatAttachment[]
  documentChanges?: DocumentChangeInfo[]
  toolSteps?: ToolStep[]
  activePersona?: ActivePersonaInfo
}

function isImageType(mediaType: string): boolean {
  return mediaType.startsWith('image/')
}

function ThinkingIndicator({ thinking }: Readonly<{ thinking: string }>) {
  const [expanded, setExpanded] = useState(false)
  if (!thinking) return null
  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700"
      >
        <Brain size={14} className="animate-pulse" />
        <span>Reasoning...</span>
      </button>
      {expanded && (
        <div className="text-xs text-gray-400 bg-gray-50 rounded p-2 mt-1 max-h-32 overflow-y-auto">
          {thinking}
        </div>
      )}
    </div>
  )
}

// ── Tool display helpers ──

interface ToolDisplayInfo {
  label: string
  activeLabel: string
  icon: typeof FileText
  colorClass: string
  bgClass: string
}

function getToolDisplay(toolName: string): ToolDisplayInfo {
  if (toolName === 'update_document') {
    return { label: 'Document updated', activeLabel: 'Editing document', icon: FileText, colorClass: 'text-blue-600', bgClass: 'bg-blue-50' }
  }
  if (toolName === 'create_document') {
    return { label: 'Document created', activeLabel: 'Creating document', icon: FileText, colorClass: 'text-green-600', bgClass: 'bg-green-50' }
  }
  if (toolName === 'search_feedback') {
    return { label: 'Search complete', activeLabel: 'Searching feedback', icon: Search, colorClass: 'text-purple-600', bgClass: 'bg-purple-50' }
  }
  return { label: toolName.replace(/_/g, ' '), activeLabel: toolName.replace(/_/g, ' '), icon: Wrench, colorClass: 'text-gray-600', bgClass: 'bg-gray-50' }
}

export function ToolIndicator({ toolName }: Readonly<{ toolName: string }>) {
  const display = getToolDisplay(toolName)
  const Icon = display.icon
  return (
    <div className={clsx('flex items-center gap-2 text-xs rounded-lg px-3 py-1.5 mb-2', display.bgClass, display.colorClass)}>
      <Loader2 size={12} className="animate-spin" />
      <Icon size={12} />
      <span>{display.activeLabel}...</span>
    </div>
  )
}

export function ToolProgressTracker({ steps, documentChanges }: Readonly<{ steps: ToolStep[]; documentChanges: DocumentChangeInfo[] }>) {
  if (steps.length === 0) return null

  // Build a merged timeline: tool steps + document change confirmations

  return (
    <div className="mb-2 space-y-1">
      {steps.map((step, idx) => {
        const display = getToolDisplay(step.name)
        const Icon = display.icon
        const isActive = step.status === 'active'
        const relatedDocChange = documentChanges.find(
          (c) => (step.name === 'update_document' || step.name === 'create_document') && c.document_id,
        )

        return (
          <div key={`${step.name}-${idx}`}>
            <div className={clsx(
              'flex items-center gap-2 text-xs rounded-lg px-3 py-1.5 transition-all',
              isActive ? display.bgClass : 'bg-gray-50',
              isActive ? display.colorClass : 'text-gray-500',
            )}>
              {isActive ? (
                <Loader2 size={12} className="animate-spin flex-shrink-0" />
              ) : (
                <CheckCircle2 size={12} className="text-green-500 flex-shrink-0" />
              )}
              <Icon size={12} className="flex-shrink-0" />
              <span>{isActive ? `${display.activeLabel}...` : display.label}</span>
            </div>
            {/* Show document change detail right after the completed tool step */}
            {!isActive && relatedDocChange && (
              <DocumentChangeIndicator key={relatedDocChange.document_id} change={relatedDocChange} />
            )}
          </div>
        )
      })}
    </div>
  )
}

export function DocumentChangeIndicator({ change }: Readonly<{ change: DocumentChangeInfo }>) {
  const isCreated = change.action === 'created'
  return (
    <div className={clsx(
      'flex items-center gap-2 text-xs rounded-lg px-3 py-2 mb-2',
      isCreated ? 'text-green-700 bg-green-50' : 'text-blue-700 bg-blue-50',
    )}>
      <FileText size={14} />
      <div>
        <span className="font-medium">{isCreated ? 'Created' : 'Updated'} &ldquo;{change.title}&rdquo;</span>
        <span className="text-gray-500 ml-1.5">{change.summary}</span>
      </div>
    </div>
  )
}

export function AttachmentThumbnail({ attachment, onRemove }: Readonly<{ attachment: ChatAttachment; onRemove?: () => void }>) {
  if (isImageType(attachment.media_type)) {
    return (
      <div className="relative group">
        <img
          src={attachment.preview_url ?? `data:${attachment.media_type};base64,${attachment.data}`}
          alt={attachment.name}
          className="w-16 h-16 object-cover rounded-lg border border-white/20"
        />
        {onRemove && (
          <button
            onClick={onRemove}
            className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label={`Remove ${attachment.name}`}
          >
            <X size={12} />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="relative group flex items-center gap-1.5 bg-white/10 rounded-lg px-2 py-1.5">
      <FileText size={14} />
      <span className="text-xs truncate max-w-[100px]">{attachment.name}</span>
      {onRemove && (
        <button
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label={`Remove ${attachment.name}`}
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}

function AssistantAvatar({ persona }: Readonly<{ persona?: ActivePersonaInfo }>) {
  if (persona?.avatar_url) {
    return (
      <img
        src={persona.avatar_url}
        alt={persona.name}
        title={persona.name}
        className="w-8 h-8 rounded-full object-cover flex-shrink-0"
      />
    )
  }
  if (persona?.name) {
    return (
      <div
        title={persona.name}
        className="w-8 h-8 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold text-sm"
      >
        {persona.name.charAt(0)}
      </div>
    )
  }
  return (
    <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
      <Bot size={16} className="text-blue-600" />
    </div>
  )
}

export function ChatMessageBubble({
  message,
  onSaveAsDocument,
}: Readonly<{ message: ChatMessage; onSaveAsDocument: (content: string) => void }>) {
  if (message.role === 'user') {
    return (
      <div className="flex gap-3 justify-end">
        <div className="max-w-[75%] rounded-lg p-3 bg-blue-600 text-white">
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {message.attachments.map((att) => (
                <AttachmentThumbnail key={att.name} attachment={att} />
              ))}
            </div>
          )}
          <p>{message.content}</p>
        </div>
        <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center flex-shrink-0">
          <User size={16} className="text-gray-600" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-3">
      <AssistantAvatar persona={message.activePersona} />
      <div className="max-w-[75%] rounded-lg p-3 group relative bg-gray-100">
        {message.thinking && <ThinkingIndicator thinking={message.thinking} />}
        {message.toolSteps && message.toolSteps.length > 0 && (
          <ToolProgressTracker steps={message.toolSteps} documentChanges={message.documentChanges ?? []} />
        )}
        {(!message.toolSteps || message.toolSteps.length === 0) && message.documentChanges?.map((change) => (
          <DocumentChangeIndicator key={change.document_id} change={change} />
        ))}
        <div className="prose prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        </div>
        <button
          onClick={() => onSaveAsDocument(message.content)}
          className="absolute -bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white border shadow-sm rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 flex items-center gap-1"
          title="Save as document"
        >
          <FileText size={12} />
          Save as Doc
        </button>
      </div>
    </div>
  )
}

export function StreamingBubble({
  streamingText,
  thinkingText,
  activeTools,
  toolSteps,
  documentChanges,
  activePersona,
}: Readonly<{
  streamingText: string
  thinkingText: string
  activeTools: string[]
  toolSteps: ToolStep[]
  documentChanges: DocumentChangeInfo[]
  activePersona?: ActivePersonaInfo
}>) {
  const hasToolActivity = toolSteps.length > 0

  return (
    <div className="flex gap-3">
      <AssistantAvatar persona={activePersona} />
      <div className="max-w-[75%] bg-gray-100 rounded-lg p-3">
        <ThinkingIndicator thinking={thinkingText} />
        {hasToolActivity ? (
          <ToolProgressTracker steps={toolSteps} documentChanges={documentChanges} />
        ) : (
          documentChanges.map((change) => (
            <DocumentChangeIndicator key={change.document_id} change={change} />
          ))
        )}
        {streamingText ? (
          <div className="prose prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
            <span className="inline-block w-1.5 h-4 bg-blue-500 animate-pulse ml-0.5 rounded-sm" />
          </div>
        ) : (
          !thinkingText &&
          activeTools.length === 0 && !hasToolActivity && <Loader2 size={16} className="text-blue-600 animate-spin" />
        )}
      </div>
    </div>
  )
}

// ── Mention Menu ──

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
  const isAll = persona.persona_id === '__all__'
  return (
    <>
      {isAll ? (
        <div className="w-8 h-8 bg-gradient-to-br from-amber-500 to-orange-500 rounded-full flex items-center justify-center text-white">
          <Users size={16} />
        </div>
      ) : (
        <div className="w-8 h-8 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-white font-bold text-sm">
          {persona.name.charAt(0)}
        </div>
      )}
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

export function MentionMenu({ items, mentionType, selectedIndex, onSelect }: MentionMenuProps) {
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
              idx === selectedIndex && 'bg-blue-50',
            )}
          >
            {isPersona ? <PersonaMentionItem persona={item} /> : <DocumentMentionItem document={item} />}
          </button>
        )
      })}
      <div className="p-2 border-t bg-gray-50 text-xs text-gray-400">
        ↑↓ to navigate • Enter to select • Esc to close
      </div>
    </div>
  )
}
