/**
 * @fileoverview PDF content component for chat export.
 * @module components/ChatExportMenu/ChatPDFContent
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Conversation, ChatMessage } from '../../store/chatStore'
import type { FeedbackItem } from '../../api/client'

interface ChatPDFContentProps {
  readonly conversation: Conversation
}

interface MarkdownComponentProps {
  readonly children?: React.ReactNode
}

interface LinkProps extends MarkdownComponentProps {
  readonly href?: string
}

const markdownComponents = {
  h1: ({ children }: MarkdownComponentProps) => (
    <h1 style={{ fontSize: '20px', fontWeight: 'bold', color: '#111827', marginTop: '16px', marginBottom: '8px' }}>{children}</h1>
  ),
  h2: ({ children }: MarkdownComponentProps) => (
    <h2 style={{ fontSize: '17px', fontWeight: '600', color: '#1f2937', marginTop: '14px', marginBottom: '6px' }}>{children}</h2>
  ),
  h3: ({ children }: MarkdownComponentProps) => (
    <h3 style={{ fontSize: '15px', fontWeight: '600', color: '#374151', marginTop: '12px', marginBottom: '4px' }}>{children}</h3>
  ),
  p: ({ children }: MarkdownComponentProps) => (
    <p style={{ marginTop: '8px', marginBottom: '8px', color: '#374151' }}>{children}</p>
  ),
  ul: ({ children }: MarkdownComponentProps) => (
    <ul style={{ listStyleType: 'disc', paddingLeft: '20px', marginTop: '8px', marginBottom: '8px' }}>{children}</ul>
  ),
  ol: ({ children }: MarkdownComponentProps) => (
    <ol style={{ listStyleType: 'decimal', paddingLeft: '20px', marginTop: '8px', marginBottom: '8px' }}>{children}</ol>
  ),
  li: ({ children }: MarkdownComponentProps) => (
    <li style={{ marginTop: '4px', marginBottom: '4px', color: '#374151' }}>{children}</li>
  ),
  strong: ({ children }: MarkdownComponentProps) => (
    <strong style={{ fontWeight: '600', color: '#111827' }}>{children}</strong>
  ),
  em: ({ children }: MarkdownComponentProps) => (
    <em style={{ fontStyle: 'italic' }}>{children}</em>
  ),
  code: ({ children }: MarkdownComponentProps) => (
    <code style={{ backgroundColor: '#f3f4f6', padding: '2px 6px', borderRadius: '4px', fontSize: '12px', fontFamily: 'monospace' }}>{children}</code>
  ),
  pre: ({ children }: MarkdownComponentProps) => (
    <pre style={{ backgroundColor: '#1f2937', color: '#f9fafb', padding: '12px', borderRadius: '8px', overflow: 'auto', fontSize: '12px', marginTop: '8px', marginBottom: '8px' }}>{children}</pre>
  ),
  blockquote: ({ children }: MarkdownComponentProps) => (
    <blockquote style={{ borderLeft: '4px solid #93c5fd', paddingLeft: '12px', fontStyle: 'italic', color: '#4b5563', marginTop: '8px', marginBottom: '8px' }}>{children}</blockquote>
  ),
  table: ({ children }: MarkdownComponentProps) => (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '8px', marginBottom: '8px' }}>{children}</table>
  ),
  th: ({ children }: MarkdownComponentProps) => (
    <th style={{ border: '1px solid #e5e7eb', backgroundColor: '#f9fafb', padding: '8px', textAlign: 'left', fontWeight: '600', fontSize: '12px' }}>{children}</th>
  ),
  td: ({ children }: MarkdownComponentProps) => (
    <td style={{ border: '1px solid #e5e7eb', padding: '8px', fontSize: '12px' }}>{children}</td>
  ),
  a: ({ href, children }: LinkProps) => (
    <a href={href} style={{ color: '#2563eb', textDecoration: 'underline' }}>{children}</a>
  ),
}

function getSentimentColor(sentiment: string | undefined): string {
  if (sentiment === 'positive') return '#22c55e'
  if (sentiment === 'negative') return '#ef4444'
  return '#9ca3af'
}

interface SourceCardProps {
  readonly source: FeedbackItem
  readonly index: number
}

function SourceCard({ source, index }: SourceCardProps) {
  const sentimentColor = getSentimentColor(source.sentiment_label)

  return (
    <div style={{ marginBottom: '12px', padding: '10px', backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '4px' }}>
      <div style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '4px', color: '#374151' }}>
        {index + 1}. {source.source_platform} - {new Date(source.source_created_at).toLocaleDateString()}
      </div>
      <div style={{ fontSize: '11px', marginBottom: '6px' }}>
        <span style={{ color: sentimentColor, fontWeight: 'bold' }}>[{source.sentiment_label?.toUpperCase() ?? 'NEUTRAL'}]</span>
        <span style={{ color: '#6b7280', marginLeft: '8px' }}>Category: {source.category ?? 'uncategorized'}</span>
        {source.rating && <span style={{ color: '#6b7280', marginLeft: '8px' }}>Rating: {source.rating}/5</span>}
      </div>
      <div style={{ fontSize: '12px', color: '#374151', lineHeight: '1.5' }}>
        {source.original_text}
      </div>
      {source.direct_customer_quote && (
        <div style={{ marginTop: '6px', padding: '6px', backgroundColor: '#f3f4f6', borderLeft: '3px solid #d1d5db', fontStyle: 'italic', fontSize: '11px', color: '#4b5563' }}>
          &quot;{source.direct_customer_quote}&quot;
        </div>
      )}
    </div>
  )
}

interface MessageBlockProps {
  readonly message: ChatMessage
  readonly index: number
}

function MessageBlock({ message, index }: MessageBlockProps) {
  const role = message.role === 'user' ? 'You' : 'VoC AI Assistant'
  const time = new Date(message.timestamp).toLocaleTimeString()
  const roleColor = message.role === 'user' ? '#2563eb' : '#3b82f6'

  return (
    <div key={index} style={{ marginBottom: '32px' }}>
      <div style={{ fontSize: '14px', fontWeight: 'bold', color: roleColor, marginBottom: '12px' }}>
        {role} - {time}
      </div>
      <div style={{ fontSize: '13px', lineHeight: '1.7', color: '#1f2937' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {message.content}
        </ReactMarkdown>
      </div>

      {message.sources && message.sources.length > 0 && (
        <div style={{ marginTop: '16px', padding: '12px', backgroundColor: '#f9fafb', borderLeft: '3px solid #3b82f6' }}>
          <h4 style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '12px', color: '#374151' }}>
            Referenced Customer Feedback ({message.sources.length} items):
          </h4>
          {message.sources.map((source, idx) => (
            <SourceCard key={idx} source={source} index={idx} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function ChatPDFContent({ conversation }: ChatPDFContentProps) {
  return (
    <div style={{ padding: '40px', backgroundColor: 'white' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '8px', color: '#111827' }}>
        {conversation.title}
      </h1>
      <p style={{ color: '#6b7280', fontSize: '12px', marginBottom: '24px' }}>
        Generated: {new Date().toLocaleString()}
      </p>
      <hr style={{ border: 'none', borderTop: '2px solid #e5e7eb', marginBottom: '24px' }} />

      {conversation.messages.map((msg, idx) => (
        <MessageBlock key={idx} message={msg} index={idx} />
      ))}
    </div>
  )
}
