/**
 * @fileoverview Chat message component for AI conversations.
 *
 * Renders a single chat message with:
 * - User/assistant avatar and styling
 * - Markdown content rendering
 * - Copy to clipboard functionality
 * - Feedback source carousel for assistant messages
 *
 * @module components/ChatMessage
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bot, User, Copy, Check } from 'lucide-react'
import { useState } from 'react'
import type { ChatMessage as ChatMessageType } from '../store/chatStore'
import FeedbackCarousel from './FeedbackCarousel'
import clsx from 'clsx'

interface ChatMessageProps {
  message: ChatMessageType
}

export default function ChatMessage({ message }: ChatMessageProps) {
  const [copied, setCopied] = useState(false)

  const copyToClipboard = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const formatTime = (date: Date) => {
    const d = new Date(date)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className={clsx('flex gap-2 sm:gap-3 w-full max-w-full', message.role === 'user' ? 'justify-end' : '')}>
      {message.role === 'assistant' && (
        <div className="flex-shrink-0 w-7 h-7 sm:w-8 sm:h-8 bg-blue-100 rounded-full flex items-center justify-center">
          <Bot size={16} className="text-blue-600 sm:w-[18px] sm:h-[18px]" />
        </div>
      )}
      
      <div className={clsx('max-w-[85%] sm:max-w-[75%] min-w-0 overflow-hidden', message.role === 'user' ? 'order-first' : '')}>
        <div
          className={clsx(
            'rounded-lg p-3 sm:p-4 group relative overflow-hidden break-words',
            message.role === 'user'
              ? 'bg-blue-600 text-white'
              : 'bg-white border border-gray-200'
          )}
        >
          {message.role === 'assistant' ? (
            <div className="prose prose-sm max-w-none prose-headings:mt-3 prose-headings:mb-2 prose-p:my-2 prose-ul:my-2 prose-li:my-0.5 overflow-x-auto overflow-y-hidden break-words [&>*]:max-w-full text-sm sm:text-base">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ children }) => <h1 className="text-lg font-bold text-gray-900">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-base font-semibold text-gray-800">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-sm font-semibold text-gray-700">{children}</h3>,
                  p: ({ children }) => <p className="text-gray-700">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc pl-4 text-gray-700">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal pl-4 text-gray-700">{children}</ol>,
                  li: ({ children }) => <li className="text-gray-700">{children}</li>,
                  strong: ({ children }) => <strong className="font-semibold text-gray-900">{children}</strong>,
                  em: ({ children }) => <em className="italic">{children}</em>,
                  code: ({ className, children }) => {
                    const isInline = !className
                    return isInline ? (
                      <code className="bg-gray-100 px-1 py-0.5 rounded text-sm font-mono text-gray-800 break-words">{children}</code>
                    ) : (
                      <code className="block bg-gray-900 text-gray-100 p-3 rounded-lg text-sm font-mono overflow-x-auto whitespace-pre-wrap break-words">{children}</code>
                    )
                  },
                  pre: ({ children }) => <pre className="bg-gray-900 rounded-lg overflow-x-auto max-w-full">{children}</pre>,
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-4 border-blue-300 pl-3 italic text-gray-600">{children}</blockquote>
                  ),
                  table: ({ children }) => (
                    <div className="overflow-x-auto">
                      <table className="min-w-full border-collapse border border-gray-200">{children}</table>
                    </div>
                  ),
                  th: ({ children }) => (
                    <th className="border border-gray-200 bg-gray-50 px-3 py-2 text-left text-sm font-semibold">{children}</th>
                  ),
                  td: ({ children }) => (
                    <td className="border border-gray-200 px-3 py-2 text-sm">{children}</td>
                  ),
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                      {children}
                    </a>
                  ),
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm sm:text-base">{message.content}</p>
          )}

          {/* Copy button */}
          <button
            onClick={copyToClipboard}
            className={clsx(
              'absolute top-2 right-2 p-1.5 rounded opacity-0 group-hover:opacity-100 transition-opacity',
              message.role === 'user' 
                ? 'hover:bg-blue-500 text-blue-100' 
                : 'hover:bg-gray-100 text-gray-400'
            )}
            title="Copy message"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>

        {/* Source feedback carousel - constrained to parent width */}
        {message.sources && message.sources.length > 0 && (
          <div className="w-full max-w-full overflow-hidden">
            <FeedbackCarousel items={message.sources} title="Related feedback:" />
          </div>
        )}

        <p className="text-xs text-gray-400 mt-1">
          {formatTime(message.timestamp)}
        </p>
      </div>

      {message.role === 'user' && (
        <div className="flex-shrink-0 w-7 h-7 sm:w-8 sm:h-8 bg-gray-200 rounded-full flex items-center justify-center">
          <User size={16} className="text-gray-600 sm:w-[18px] sm:h-[18px]" />
        </div>
      )}
    </div>
  )
}
