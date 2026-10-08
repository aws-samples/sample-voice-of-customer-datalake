/**
 * @fileoverview PDF content component for document export.
 * @module components/DocumentExportMenu/DocumentPDFContent
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ProjectDocument } from '../../api/types'
import { documentText } from './documentText'

interface DocumentPDFContentProps { readonly document: ProjectDocument }

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
        color: '#19161d',
      }}>
        {doc.title}
      </h1>
      <p style={{
        color: '#5e5966',
        fontSize: '12px',
        marginBottom: '24px',
      }}>
        Type: {doc.document_type.toUpperCase()} | Generated: {new Date(doc.created_at).toLocaleDateString()}
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
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {documentText(doc)}
        </ReactMarkdown>
      </div>
    </div>
  )
}
