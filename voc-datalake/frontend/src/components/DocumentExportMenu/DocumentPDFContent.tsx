/**
 * @fileoverview PDF content component for document export.
 * @module components/DocumentExportMenu/DocumentPDFContent
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ProjectDocument } from '../../api/types'

interface DocumentPDFContentProps { readonly document: ProjectDocument }

interface MarkdownComponentProps { readonly children?: React.ReactNode }

interface LinkProps extends MarkdownComponentProps { readonly href?: string }

const markdownComponents = {
  h1: ({ children }: MarkdownComponentProps) => (
    <h1 style={{
      fontSize: '20px',
      fontWeight: 'bold',
      color: '#111827',
      marginTop: '16px',
      marginBottom: '8px',
    }}>{children}</h1>
  ),
  h2: ({ children }: MarkdownComponentProps) => (
    <h2 style={{
      fontSize: '17px',
      fontWeight: '600',
      color: '#1f2937',
      marginTop: '14px',
      marginBottom: '6px',
    }}>{children}</h2>
  ),
  h3: ({ children }: MarkdownComponentProps) => (
    <h3 style={{
      fontSize: '15px',
      fontWeight: '600',
      color: '#374151',
      marginTop: '12px',
      marginBottom: '4px',
    }}>{children}</h3>
  ),
  p: ({ children }: MarkdownComponentProps) => (
    <p style={{
      marginTop: '8px',
      marginBottom: '8px',
      color: '#374151',
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
      color: '#374151',
    }}>{children}</li>
  ),
  strong: ({ children }: MarkdownComponentProps) => (
    <strong style={{
      fontWeight: '600',
      color: '#111827',
    }}>{children}</strong>
  ),
  em: ({ children }: MarkdownComponentProps) => (
    <em style={{ fontStyle: 'italic' }}>{children}</em>
  ),
  code: ({ children }: MarkdownComponentProps) => (
    <code style={{
      backgroundColor: '#f3f4f6',
      padding: '2px 6px',
      borderRadius: '4px',
      fontSize: '12px',
      fontFamily: 'monospace',
    }}>{children}</code>
  ),
  pre: ({ children }: MarkdownComponentProps) => (
    <pre style={{
      backgroundColor: '#1f2937',
      color: '#f9fafb',
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
      borderLeft: '4px solid #93c5fd',
      paddingLeft: '12px',
      fontStyle: 'italic',
      color: '#4b5563',
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
      border: '1px solid #e5e7eb',
      backgroundColor: '#f9fafb',
      padding: '8px',
      textAlign: 'left',
      fontWeight: '600',
      fontSize: '12px',
    }}>{children}</th>
  ),
  td: ({ children }: MarkdownComponentProps) => (
    <td style={{
      border: '1px solid #e5e7eb',
      padding: '8px',
      fontSize: '12px',
    }}>{children}</td>
  ),
  a: ({
    href, children,
  }: LinkProps) => (
    <a href={href} style={{
      color: '#2563eb',
      textDecoration: 'underline',
    }}>{children}</a>
  ),
}

export default function DocumentPDFContent({ document: doc }: DocumentPDFContentProps) {
  return (
    <div style={{
      padding: '40px',
      backgroundColor: 'white',
    }}>
      <h1 style={{
        fontSize: '24px',
        fontWeight: 'bold',
        marginBottom: '8px',
        color: '#111827',
      }}>
        {doc.title}
      </h1>
      <p style={{
        color: '#6b7280',
        fontSize: '12px',
        marginBottom: '24px',
      }}>
        Type: {doc.document_type.toUpperCase()} | Generated: {new Date(doc.created_at).toLocaleDateString()}
      </p>
      <hr style={{
        border: 'none',
        borderTop: '2px solid #e5e7eb',
        marginBottom: '24px',
      }} />

      <div style={{
        fontSize: '13px',
        lineHeight: '1.7',
        color: '#1f2937',
      }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {doc.content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
