/**
 * @fileoverview PDF content component for document export.
 * @module components/DocumentExportMenu/DocumentPDFContent
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CommentThread } from '../../api/documentReviewSchema'
import type { ProjectDocument } from '../../api/types'
import { documentText } from './documentText'
import { PDF_REPORT_LOCALE } from '../PdfParts/pdfParts'
import { formatDate } from '../../utils/dateUtils'

/** The open comment threads printed after the text ("Include comments"), with their translated labels. */
interface PdfComments {
  readonly heading: string
  /** Shown in place of the quote for a thread on the whole document. */
  readonly wholeDocument: string
  readonly threads: readonly CommentThread[]
}

interface DocumentPDFContentProps {
  readonly document: ProjectDocument
  readonly comments?: PdfComments | null
}

interface MarkdownComponentProps { readonly children?: React.ReactNode }

interface LinkProps extends MarkdownComponentProps { readonly href?: string }

const markdownComponents = {
  h1: ({ children }: MarkdownComponentProps) => (
    <h1 style={{
      fontSize: '20px',
      fontWeight: 'bold',
      color: '#19161d',
      marginTop: '16px',
      marginBottom: '8px',
    }}>{children}</h1>
  ),
  h2: ({ children }: MarkdownComponentProps) => (
    <h2 style={{
      fontSize: '17px',
      fontWeight: '600',
      color: '#19161d',
      marginTop: '14px',
      marginBottom: '6px',
    }}>{children}</h2>
  ),
  h3: ({ children }: MarkdownComponentProps) => (
    <h3 style={{
      fontSize: '15px',
      fontWeight: '600',
      color: '#4a464f',
      marginTop: '12px',
      marginBottom: '4px',
    }}>{children}</h3>
  ),
  p: ({ children }: MarkdownComponentProps) => (
    <p style={{
      marginTop: '8px',
      marginBottom: '8px',
      color: '#4a464f',
    }}>{children}</p>
  ),
  ul: ({ children }: MarkdownComponentProps) => (
    <ul style={{
      listStyleType: 'disc',
      paddingLeft: '20px',
      marginTop: '8px',
      marginBottom: '8px',
    }}>{children}</ul>
  ),
  ol: ({ children }: MarkdownComponentProps) => (
    <ol style={{
      listStyleType: 'decimal',
      paddingLeft: '20px',
      marginTop: '8px',
      marginBottom: '8px',
    }}>{children}</ol>
  ),
  li: ({ children }: MarkdownComponentProps) => (
    <li style={{
      marginTop: '4px',
      marginBottom: '4px',
      color: '#4a464f',
    }}>{children}</li>
  ),
  strong: ({ children }: MarkdownComponentProps) => (
    <strong style={{
      fontWeight: '600',
      color: '#19161d',
    }}>{children}</strong>
  ),
  em: ({ children }: MarkdownComponentProps) => (
    <em style={{ fontStyle: 'italic' }}>{children}</em>
  ),
  code: ({ children }: MarkdownComponentProps) => (
    <code style={{
      backgroundColor: '#f5f5f5',
      padding: '2px 6px',
      borderRadius: '4px',
      fontSize: '12px',
      fontFamily: 'monospace',
    }}>{children}</code>
  ),
  pre: ({ children }: MarkdownComponentProps) => (
    <pre style={{
      backgroundColor: '#19161d',
      color: '#f5f5f5',
      padding: '12px',
      borderRadius: '8px',
      overflow: 'auto',
      fontSize: '12px',
      marginTop: '8px',
      marginBottom: '8px',
    }}>{children}</pre>
  ),
  blockquote: ({ children }: MarkdownComponentProps) => (
    <blockquote style={{
      borderLeft: '4px solid #d7bfff',
      paddingLeft: '12px',
      fontStyle: 'italic',
      color: '#4a464f',
      marginTop: '8px',
      marginBottom: '8px',
    }}>{children}</blockquote>
  ),
  table: ({ children }: MarkdownComponentProps) => (
    <table style={{
      width: '100%',
      borderCollapse: 'collapse',
      marginTop: '8px',
      marginBottom: '8px',
    }}>{children}</table>
  ),
  th: ({ children }: MarkdownComponentProps) => (
    <th style={{
      border: '1px solid #e4e4e7',
      backgroundColor: '#f5f5f5',
      padding: '8px',
      textAlign: 'left',
      fontWeight: '600',
      fontSize: '12px',
    }}>{children}</th>
  ),
  td: ({ children }: MarkdownComponentProps) => (
    <td style={{
      border: '1px solid #e4e4e7',
      padding: '8px',
      fontSize: '12px',
    }}>{children}</td>
  ),
  a: ({
    href, children,
  }: LinkProps) => (
    <a href={href} style={{
      color: '#723acc',
      textDecoration: 'underline',
    }}>{children}</a>
  ),
}

const COMMENT_LINE_STYLE = { marginTop: '4px', marginBottom: '4px', color: '#19161d', fontSize: '12px' } as const

/** One line of a thread: its author (when named) and the text. */
function CommentLine({ name, text, reply = false }: Readonly<{ name: string; text: string; reply?: boolean }>) {
  return (
    <p style={reply ? { ...COMMENT_LINE_STYLE, paddingLeft: '16px', color: '#4a464f' } : COMMENT_LINE_STYLE}>
      {name === '' ? null : <strong style={{ fontWeight: '600' }}>{name}: </strong>}
      {text}
    </p>
  )
}

/** The open threads, each with the passage it is about (its quote), the comment and the replies. */
function PdfCommentsSection({ comments }: Readonly<{ comments: PdfComments }>) {
  if (comments.threads.length === 0) return null
  return (
    <section aria-label={comments.heading} style={{ marginTop: '32px', borderTop: '2px solid #e4e4e7', paddingTop: '16px' }}>
      <h2 style={{ fontSize: '17px', fontWeight: '600', color: '#19161d', marginBottom: '8px' }}>{comments.heading}</h2>
      {comments.threads.map((thread) => (
        <div key={thread.comment_id} data-pdf-section="" style={{ marginBottom: '16px' }}>
          <blockquote style={{ borderLeft: '4px solid #d7bfff', paddingLeft: '12px', color: '#4a464f', margin: '0 0 6px 0', fontSize: '12px' }}>
            {thread.anchor?.exact ?? comments.wholeDocument}
          </blockquote>
          <CommentLine name={thread.author.name} text={thread.text} />
          {thread.replies.map((reply) => <CommentLine key={reply.reply_id} name={reply.author.name} text={reply.text} reply />)}
        </div>
      ))}
    </section>
  )
}

/** The document's text as printed: its Markdown, rendered. */
export function DocumentBody({ document: doc }: Readonly<{ document: Pick<ProjectDocument, 'content'> }>) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {documentText(doc)}
    </ReactMarkdown>
  )
}

export default function DocumentPDFContent({ document: doc, comments = null }: DocumentPDFContentProps) {
  return (
    <div style={{
      padding: '40px',
      backgroundColor: 'white',
    }}>
      <h1 style={{
        fontSize: '24px',
        fontWeight: 'bold',
        marginBottom: '8px',
        color: '#19161d',
      }}>
        {doc.title}
      </h1>
      <p style={{
        color: '#5e5966',
        fontSize: '12px',
        marginBottom: '24px',
      }}>
        Type: {doc.document_type.toUpperCase()} | Generated: {formatDate(doc.created_at, PDF_REPORT_LOCALE)}
      </p>
      <hr style={{
        border: 'none',
        borderTop: '2px solid #e4e4e7',
        marginBottom: '24px',
      }} />

      <div style={{
        fontSize: '13px',
        lineHeight: '1.7',
        color: '#19161d',
      }}>
        <DocumentBody document={doc} />
      </div>
      {comments === null ? null : <PdfCommentsSection comments={comments} />}
    </div>
  )
}
