/**
 * @fileoverview Chat conversation export menu component.
 *
 * Export options:
 * - Copy as Markdown
 * - Download as PDF (rendered with html2canvas)
 *
 * @module components/ChatExportMenu
 */

import { useState, useRef, useEffect } from 'react'
import { Download, Share2, FileText, Copy, Check, FileDown, MoreVertical } from 'lucide-react'
import type { Conversation } from '../store/chatStore'
import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createRoot } from 'react-dom/client'

interface ChatExportMenuProps {
  conversation: Conversation | null
}

export default function ChatExportMenu({ conversation }: ChatExportMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [exporting, setExporting] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  if (!conversation || conversation.messages.length === 0) return null

  const formatConversationAsText = () => {
    const lines = [
      `# ${conversation.title}`,
      `Date: ${new Date(conversation.createdAt).toLocaleDateString()}`,
      '',
      '---',
      '',
    ]

    conversation.messages.forEach((msg) => {
      const role = msg.role === 'user' ? 'You' : 'VoC AI'
      const time = new Date(msg.timestamp).toLocaleTimeString()
      lines.push(`**${role}** (${time}):`)
      lines.push(msg.content)
      lines.push('')
      
      // Include sources (customer feedback/reviews)
      if (msg.sources && msg.sources.length > 0) {
        lines.push(`### Referenced Customer Feedback (${msg.sources.length} items)`)
        lines.push('')
        
        msg.sources.forEach((source, idx) => {
          lines.push(`#### ${idx + 1}. ${source.source_platform} - ${new Date(source.source_created_at).toLocaleDateString()}`)
          lines.push(`**Sentiment:** ${source.sentiment_label || 'neutral'} | **Category:** ${source.category || 'uncategorized'}`)
          if (source.rating) lines.push(`**Rating:** ${source.rating}/5`)
          lines.push('')
          lines.push(source.original_text)
          if (source.direct_customer_quote) {
            lines.push('')
            lines.push(`> "${source.direct_customer_quote}"`)
          }
          lines.push('')
          lines.push('---')
          lines.push('')
        })
      }
    })

    return lines.join('\n')
  }

  const copyConversation = async () => {
    const text = formatConversationAsText()
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const downloadAsMarkdown = () => {
    const text = formatConversationAsText()
    const blob = new Blob([text], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${conversation.title.replace(/[^a-z0-9]/gi, '_')}.md`
    a.click()
    URL.revokeObjectURL(url)
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
        sourcesCount: m.sources?.length || 0,
      })),
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${conversation.title.replace(/[^a-z0-9]/gi, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
    setIsOpen(false)
  }

  const downloadAsPDF = async () => {
    setExporting(true)
    try {
      // Create an iframe for complete style isolation (avoids oklch color issues)
      const iframe = document.createElement('iframe')
      iframe.style.position = 'absolute'
      iframe.style.left = '-9999px'
      iframe.style.top = '0'
      iframe.style.width = '800px'
      iframe.style.height = '10000px'
      iframe.style.border = 'none'
      document.body.appendChild(iframe)

      // Wait for iframe to be ready
      await new Promise<void>((resolve) => {
        iframe.onload = () => resolve()
        iframe.src = 'about:blank'
      })

      const iframeDoc = iframe.contentDocument!
      const container = iframeDoc.createElement('div')
      container.style.width = '800px'
      container.style.backgroundColor = '#ffffff'
      container.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif'
      container.style.color = '#000000'
      iframeDoc.body.appendChild(container)
      iframeDoc.body.style.margin = '0'
      iframeDoc.body.style.padding = '0'
      iframeDoc.body.style.backgroundColor = '#ffffff'

      // Create React root and render the content
      const root = createRoot(container)
      
      // Render the PDF content as a React component
      const PDFContent = () => (
        <div style={{ padding: '40px', backgroundColor: 'white' }}>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '8px', color: '#111827' }}>
            {conversation.title}
          </h1>
          <p style={{ color: '#6b7280', fontSize: '12px', marginBottom: '24px' }}>
            Generated: {new Date().toLocaleString()}
          </p>
          <hr style={{ border: 'none', borderTop: '2px solid #e5e7eb', marginBottom: '24px' }} />
          
          {conversation.messages.map((msg, msgIdx) => {
            const role = msg.role === 'user' ? 'You' : 'VoC AI Assistant'
            const time = new Date(msg.timestamp).toLocaleTimeString()
            const roleColor = msg.role === 'user' ? '#2563eb' : '#3b82f6'
            
            return (
              <div key={msgIdx} style={{ marginBottom: '32px' }}>
                <div style={{ fontSize: '14px', fontWeight: 'bold', color: roleColor, marginBottom: '12px' }}>
                  {role} - {time}
                </div>
                <div style={{ fontSize: '13px', lineHeight: '1.7', color: '#1f2937' }}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ children }) => <h1 style={{ fontSize: '20px', fontWeight: 'bold', color: '#111827', marginTop: '16px', marginBottom: '8px' }}>{children}</h1>,
                      h2: ({ children }) => <h2 style={{ fontSize: '17px', fontWeight: '600', color: '#1f2937', marginTop: '14px', marginBottom: '6px' }}>{children}</h2>,
                      h3: ({ children }) => <h3 style={{ fontSize: '15px', fontWeight: '600', color: '#374151', marginTop: '12px', marginBottom: '4px' }}>{children}</h3>,
                      p: ({ children }) => <p style={{ marginTop: '8px', marginBottom: '8px', color: '#374151' }}>{children}</p>,
                      ul: ({ children }) => <ul style={{ listStyleType: 'disc', paddingLeft: '20px', marginTop: '8px', marginBottom: '8px' }}>{children}</ul>,
                      ol: ({ children }) => <ol style={{ listStyleType: 'decimal', paddingLeft: '20px', marginTop: '8px', marginBottom: '8px' }}>{children}</ol>,
                      li: ({ children }) => <li style={{ marginTop: '4px', marginBottom: '4px', color: '#374151' }}>{children}</li>,
                      strong: ({ children }) => <strong style={{ fontWeight: '600', color: '#111827' }}>{children}</strong>,
                      em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
                      code: ({ children }) => <code style={{ backgroundColor: '#f3f4f6', padding: '2px 6px', borderRadius: '4px', fontSize: '12px', fontFamily: 'monospace' }}>{children}</code>,
                      pre: ({ children }) => <pre style={{ backgroundColor: '#1f2937', color: '#f9fafb', padding: '12px', borderRadius: '8px', overflow: 'auto', fontSize: '12px', marginTop: '8px', marginBottom: '8px' }}>{children}</pre>,
                      blockquote: ({ children }) => <blockquote style={{ borderLeft: '4px solid #93c5fd', paddingLeft: '12px', fontStyle: 'italic', color: '#4b5563', marginTop: '8px', marginBottom: '8px' }}>{children}</blockquote>,
                      table: ({ children }) => <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '8px', marginBottom: '8px' }}>{children}</table>,
                      th: ({ children }) => <th style={{ border: '1px solid #e5e7eb', backgroundColor: '#f9fafb', padding: '8px', textAlign: 'left', fontWeight: '600', fontSize: '12px' }}>{children}</th>,
                      td: ({ children }) => <td style={{ border: '1px solid #e5e7eb', padding: '8px', fontSize: '12px' }}>{children}</td>,
                      a: ({ href, children }) => <a href={href} style={{ color: '#2563eb', textDecoration: 'underline' }}>{children}</a>,
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
                
                {msg.sources && msg.sources.length > 0 && (
                  <div style={{ marginTop: '16px', padding: '12px', backgroundColor: '#f9fafb', borderLeft: '3px solid #3b82f6' }}>
                    <h4 style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '12px', color: '#374151' }}>
                      Referenced Customer Feedback ({msg.sources.length} items):
                    </h4>
                    {msg.sources.map((source, idx) => {
                      const sentimentColor = source.sentiment_label === 'positive' ? '#22c55e' : 
                                            source.sentiment_label === 'negative' ? '#ef4444' : '#9ca3af'
                      return (
                        <div key={idx} style={{ marginBottom: '12px', padding: '10px', backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '4px' }}>
                          <div style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '4px', color: '#374151' }}>
                            {idx + 1}. {source.source_platform} - {new Date(source.source_created_at).toLocaleDateString()}
                          </div>
                          <div style={{ fontSize: '11px', marginBottom: '6px' }}>
                            <span style={{ color: sentimentColor, fontWeight: 'bold' }}>[{source.sentiment_label?.toUpperCase() || 'NEUTRAL'}]</span>
                            <span style={{ color: '#6b7280', marginLeft: '8px' }}>Category: {source.category || 'uncategorized'}</span>
                            {source.rating && <span style={{ color: '#6b7280', marginLeft: '8px' }}>Rating: {source.rating}/5</span>}
                          </div>
                          <div style={{ fontSize: '12px', color: '#374151', lineHeight: '1.5' }}>
                            {source.original_text}
                          </div>
                          {source.direct_customer_quote && (
                            <div style={{ marginTop: '6px', padding: '6px', backgroundColor: '#f3f4f6', borderLeft: '3px solid #d1d5db', fontStyle: 'italic', fontSize: '11px', color: '#4b5563' }}>
                              "{source.direct_customer_quote}"
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )

      // Render and wait for it to complete
      await new Promise<void>((resolve) => {
        root.render(<PDFContent />)
        setTimeout(resolve, 200)
      })

      // Capture the rendered content as canvas with lower scale for smaller file size
      const canvas = await html2canvas(container, {
        scale: 1.5, // Reduced from 2 for smaller file size while maintaining quality
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
      })

      // Create PDF from canvas
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
      })

      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const margin = 10
      const contentWidth = pageWidth - (margin * 2)
      const contentHeight = pageHeight - (margin * 2)
      
      // Calculate dimensions
      const imgWidthMM = contentWidth
      const imgHeightMM = (canvas.height * imgWidthMM) / canvas.width
      
      // Calculate how many pages we need
      const totalPages = Math.ceil(imgHeightMM / contentHeight)
      
      // For each page, crop the canvas and add to PDF
      for (let page = 0; page < totalPages; page++) {
        if (page > 0) {
          pdf.addPage()
        }
        
        // Calculate the portion of the canvas to use for this page
        const sourceY = (page * contentHeight / imgHeightMM) * canvas.height
        const sourceHeight = Math.min(
          (contentHeight / imgHeightMM) * canvas.height,
          canvas.height - sourceY
        )
        
        // Create a temporary canvas for this page's content
        const pageCanvas = document.createElement('canvas')
        pageCanvas.width = canvas.width
        pageCanvas.height = sourceHeight
        const ctx = pageCanvas.getContext('2d')!
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
        ctx.drawImage(
          canvas,
          0, sourceY, canvas.width, sourceHeight,
          0, 0, canvas.width, sourceHeight
        )
        
        // Convert to JPEG for smaller file size
        const pageImgData = pageCanvas.toDataURL('image/jpeg', 0.85)
        const pageImgHeightMM = (sourceHeight * imgWidthMM) / canvas.width
        
        pdf.addImage(pageImgData, 'JPEG', margin, margin, imgWidthMM, pageImgHeightMM)
      }

      // Cleanup
      root.unmount()
      document.body.removeChild(iframe)

      pdf.save(`${conversation.title.replace(/[^a-z0-9]/gi, '_')}.pdf`)
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('PDF export failed:', error)
      }
    } finally {
      setExporting(false)
      setIsOpen(false)
    }
  }

  const shareConversation = async () => {
    const text = formatConversationAsText()
    if (navigator.share) {
      try {
        await navigator.share({
          title: conversation.title,
          text: text,
        })
      } catch {
        // User cancelled or share failed
      }
    } else {
      // Fallback to copy
      await copyConversation()
    }
    setIsOpen(false)
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
        title="Export options"
        aria-label="Export options"
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <MoreVertical size={18} />
      </button>

      {isOpen && (
        <div 
          className="absolute right-0 sm:right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 w-48 sm:w-48 py-1 max-w-[calc(100vw-2rem)]"
          role="menu"
          aria-orientation="vertical"
        >
          <button
            onClick={copyConversation}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
            role="menuitem"
          >
            {copied ? <Check size={16} className="text-green-500 flex-shrink-0" /> : <Copy size={16} className="flex-shrink-0" />}
            <span className="truncate">{copied ? 'Copied!' : 'Copy conversation'}</span>
          </button>
          
          <button
            onClick={shareConversation}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
            role="menuitem"
          >
            <Share2 size={16} className="flex-shrink-0" />
            <span className="truncate">Share</span>
          </button>

          <hr className="my-1 border-gray-100" />

          <button
            onClick={downloadAsMarkdown}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
            role="menuitem"
          >
            <FileText size={16} className="flex-shrink-0" />
            <span className="truncate">Download as Markdown</span>
          </button>

          <button
            onClick={downloadAsJSON}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
            role="menuitem"
          >
            <Download size={16} className="flex-shrink-0" />
            <span className="truncate">Download as JSON</span>
          </button>

          <button
            onClick={downloadAsPDF}
            disabled={exporting}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50"
            role="menuitem"
          >
            <FileDown size={16} className="flex-shrink-0" />
            <span className="truncate">{exporting ? 'Generating PDF...' : 'Download as PDF'}</span>
          </button>
        </div>
      )}
    </div>
  )
}
