/**
 * @fileoverview Chat conversation export menu component.
 *
 * Export options:
 * - Copy as Markdown
 * - Download as PDF (rendered with html2canvas)
 *
 * @module components/ChatExportMenu
 */

import {
  Download, Share2, FileText, Copy, Check, FileDown, MoreVertical,
} from 'lucide-react'
import {
  useState, useRef, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  downloadFile, sanitizeFilename,
} from '../../utils/file'
import { generateChatPDF } from './chatPdfGenerator'
import type { FeedbackItem } from '../../api/types'
import type { Conversation } from '../../store/chatStore'

interface ChatExportMenuProps { readonly conversation: Conversation | null }

function formatSourceAsText(source: FeedbackItem, idx: number): string[] {
  const lines: string[] = []
  lines.push(`#### ${idx + 1}. ${source.source_platform} - ${new Date(source.source_created_at).toLocaleDateString()}`)
  lines.push(`**Sentiment:** ${source.sentiment_label} | **Category:** ${source.category}`)
  if (source.rating != null) lines.push(`**Rating:** ${source.rating}/5`)
  lines.push('')
  lines.push(source.original_text)
  if (source.direct_customer_quote != null && source.direct_customer_quote !== '') {
    lines.push('')
    lines.push(`> "${source.direct_customer_quote}"`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  return lines
}

function formatConversationAsText(conversation: Conversation): string {
  const lines = [
    `# ${conversation.title}`,
    `Date: ${new Date(conversation.createdAt).toLocaleDateString()}`,
    '',
    '---',
    '',
  ]

  for (const msg of conversation.messages) {
    const role = msg.role === 'user' ? 'You' : 'VoC AI'
    const time = new Date(msg.timestamp).toLocaleTimeString()
    lines.push(`**${role}** (${time}):`)
    lines.push(msg.content)
    lines.push('')

    if (msg.sources && msg.sources.length > 0) {
      lines.push(`### Referenced Customer Feedback (${msg.sources.length} items)`)
      lines.push('')

      for (const [idx, source] of msg.sources.entries()) {
        lines.push(...formatSourceAsText(source, idx))
      }
    }
  }

  return lines.join('\n')
}

export default function ChatExportMenu({ conversation }: ChatExportMenuProps) {
  const { t } = useTranslation('chat')
  const [isOpen, setIsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target
      if (menuRef.current && target instanceof Node && !menuRef.current.contains(target)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  if (!conversation || conversation.messages.length === 0) return null

  const copyConversation = async () => {
    const text = formatConversationAsText(conversation)
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const downloadAsMarkdown = () => {
    const text = formatConversationAsText(conversation)
    downloadFile(text, `${sanitizeFilename(conversation.title)}.md`, 'text/markdown')
    setIsOpen(false)
  }

  const downloadAsJSON = () => {
    const data = {
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      filters: conversation.filters,
      messages: conversation.messages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        sourcesCount: m.sources?.length ?? 0,
      })),
    }
    downloadFile(JSON.stringify(data, null, 2), `${sanitizeFilename(conversation.title)}.json`, 'application/json')
    setIsOpen(false)
  }

  const downloadAsPDF = () => {
    try {
      generateChatPDF(conversation)
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('PDF export failed:', error)
      }
    } finally {
      setIsOpen(false)
    }
  }

  const shareConversation = async () => {
    const text = formatConversationAsText(conversation)
    try {
      await navigator.share({
        title: conversation.title,
        text,
      })
    } catch {
      await copyConversation()
    }
    setIsOpen(false)
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
        title={t('export.exportOptions')}
        aria-label={t('export.exportOptions')}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <MoreVertical size={18} />
      </button>

      {isOpen ? <div
        className="absolute right-0 sm:right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 w-48 sm:w-48 py-1 max-w-[calc(100vw-2rem)]"
        role="menu"
        aria-orientation="vertical"
      >
        <button
          onClick={() => void copyConversation()}
          className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
          role="menuitem"
        >
          {copied ? <Check size={16} className="text-green-500 flex-shrink-0" /> : <Copy size={16} className="flex-shrink-0" />}
          <span className="truncate">{copied ? t('export.copied') : t('export.copyConversation')}</span>
        </button>

        <button
          onClick={() => void shareConversation()}
          className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
          role="menuitem"
        >
          <Share2 size={16} className="flex-shrink-0" />
          <span className="truncate">{t('export.share')}</span>
        </button>

        <hr className="my-1 border-gray-100" />

        <button
          onClick={downloadAsMarkdown}
          className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
          role="menuitem"
        >
          <FileText size={16} className="flex-shrink-0" />
          <span className="truncate">{t('export.downloadMarkdown')}</span>
        </button>

        <button
          onClick={downloadAsJSON}
          className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
          role="menuitem"
        >
          <Download size={16} className="flex-shrink-0" />
          <span className="truncate">{t('export.downloadJson')}</span>
        </button>

        <button
          onClick={downloadAsPDF}
          className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
          role="menuitem"
        >
          <FileDown size={16} className="flex-shrink-0" />
          <span className="truncate">{t('export.downloadPdf')}</span>
        </button>
      </div> : null}
    </div>
  )
}
