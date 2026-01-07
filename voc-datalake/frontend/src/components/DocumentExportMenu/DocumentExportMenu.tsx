/**
 * @fileoverview Document export menu component.
 *
 * Export options for PRDs, PR/FAQs, and research documents:
 * - Copy as Markdown
 * - Copy as Kiro prompt (with project context)
 * - Download as PDF
 *
 * @module components/DocumentExportMenu
 */

import { useState, useRef, useEffect } from 'react'
import { Copy, Check, FileDown, MoreVertical, FileText, FileType, Sparkles } from 'lucide-react'
import type { ProjectDocument, Project } from '../../api/client'
import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createRoot } from 'react-dom/client'

interface DocumentExportMenuProps {
  document: ProjectDocument | null
  project?: Project | null
}

export default function DocumentExportMenu({ document: doc, project }: DocumentExportMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedKiro, setCopiedKiro] = useState(false)
  const [exporting, setExporting] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    window.document.addEventListener('mousedown', handleClickOutside)
    return () => window.document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  if (!doc) return null

  const sanitizeFilename = (name: string) => name.replace(/[^a-z0-9]/gi, '_')

  const copyContent = async () => {
    await navigator.clipboard.writeText(doc.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const copyToKiro = async () => {
    // Build the Kiro export content: prompt + PRD
    const kiroPrompt = project?.kiro_export_prompt || ''
    const separator = kiroPrompt ? '\n\n---\n\n' : ''
    const prdSection = `# ${doc.title}\n\n${doc.content}`
    const fullContent = kiroPrompt 
      ? `${kiroPrompt}${separator}## PRD Document\n\n${prdSection}`
      : prdSection
    
    await navigator.clipboard.writeText(fullContent)
    setCopiedKiro(true)
    setTimeout(() => setCopiedKiro(false), 2000)
    setIsOpen(false)
  }

  const downloadAsMarkdown = () => {
    const blob = new Blob([doc.content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = window.document.createElement('a')
    a.href = url
    a.download = `${sanitizeFilename(doc.title)}.md`
    a.click()
    URL.revokeObjectURL(url)
    setIsOpen(false)
  }

  const downloadAsTxt = () => {
    // Strip markdown formatting for plain text
    const plainText = doc.content
      .replace(/#{1,6}\s/g, '') // Remove headers
      .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold
      .replace(/\*([^*]+)\*/g, '$1') // Remove italic
      .replace(/`([^`]+)`/g, '$1') // Remove inline code
      .replace(/```[\s\S]*?```/g, (match: string) => match.replace(/```\w*\n?/g, '')) // Remove code blocks markers
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove links, keep text
      .replace(/^[-*+]\s/gm, '• ') // Convert list markers
      .replace(/^\d+\.\s/gm, '') // Remove numbered list markers
    
    const blob = new Blob([plainText], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = window.document.createElement('a')
    a.href = url
    a.download = `${sanitizeFilename(doc.title)}.txt`
    a.click()
    URL.revokeObjectURL(url)
    setIsOpen(false)
  }


  const downloadAsPDF = async () => {
    setExporting(true)
    try {
      // Create an iframe for complete style isolation
      const iframe = window.document.createElement('iframe')
      iframe.style.position = 'absolute'
      iframe.style.left = '-9999px'
      iframe.style.top = '0'
      iframe.style.width = '800px'
      iframe.style.height = '10000px'
      iframe.style.border = 'none'
      window.document.body.appendChild(iframe)

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

      const root = createRoot(container)
      
      const PDFContent = () => (
        <div style={{ padding: '40px', backgroundColor: 'white' }}>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '8px', color: '#111827' }}>
            {doc.title}
          </h1>
          <p style={{ color: '#6b7280', fontSize: '12px', marginBottom: '24px' }}>
            Type: {doc.document_type.toUpperCase()} | Generated: {new Date(doc.created_at).toLocaleDateString()}
          </p>
          <hr style={{ border: 'none', borderTop: '2px solid #e5e7eb', marginBottom: '24px' }} />
          
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
              {doc.content}
            </ReactMarkdown>
          </div>
        </div>
      )

      await new Promise<void>((resolve) => {
        root.render(<PDFContent />)
        setTimeout(resolve, 200)
      })

      const canvas = await html2canvas(container, {
        scale: 1.5,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
      })

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
      
      const imgWidthMM = contentWidth
      const imgHeightMM = (canvas.height * imgWidthMM) / canvas.width
      const totalPages = Math.ceil(imgHeightMM / contentHeight)
      
      for (let page = 0; page < totalPages; page++) {
        if (page > 0) pdf.addPage()
        
        const sourceY = (page * contentHeight / imgHeightMM) * canvas.height
        const sourceHeight = Math.min(
          (contentHeight / imgHeightMM) * canvas.height,
          canvas.height - sourceY
        )
        
        const pageCanvas = window.document.createElement('canvas')
        pageCanvas.width = canvas.width
        pageCanvas.height = sourceHeight
        const ctx = pageCanvas.getContext('2d')!
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
        ctx.drawImage(canvas, 0, sourceY, canvas.width, sourceHeight, 0, 0, canvas.width, sourceHeight)
        
        const pageImgData = pageCanvas.toDataURL('image/jpeg', 0.85)
        const pageImgHeightMM = (sourceHeight * imgWidthMM) / canvas.width
        
        pdf.addImage(pageImgData, 'JPEG', margin, margin, imgWidthMM, pageImgHeightMM)
      }

      root.unmount()
      window.document.body.removeChild(iframe)
      pdf.save(`${sanitizeFilename(doc.title)}.pdf`)
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('PDF export failed:', error)
      }
    } finally {
      setExporting(false)
      setIsOpen(false)
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
        title="Download options"
        aria-label="Download options"
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <MoreVertical size={18} />
      </button>

      {isOpen && (
        <div 
          className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 w-52 max-w-[calc(100vw-2rem)] py-1"
          role="menu"
          aria-orientation="vertical"
        >
          <button
            onClick={copyContent}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
            role="menuitem"
          >
            {copied ? <Check size={16} className="text-green-500 flex-shrink-0" /> : <Copy size={16} className="flex-shrink-0" />}
            <span className="truncate">{copied ? 'Copied!' : 'Copy'}</span>
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
            onClick={downloadAsPDF}
            disabled={exporting}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50"
            role="menuitem"
          >
            <FileDown size={16} className="flex-shrink-0" />
            <span className="truncate">{exporting ? 'Generating PDF...' : 'Download as PDF'}</span>
          </button>

          <button
            onClick={downloadAsTxt}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
            role="menuitem"
          >
            <FileType size={16} className="flex-shrink-0" />
            <span className="truncate">Download as TXT</span>
          </button>

          {(doc.document_type === 'prd' || doc.document_type === 'prfaq') && (
            <>
              <hr className="my-1 border-gray-100" />
              <button
                onClick={copyToKiro}
                className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-purple-700 hover:bg-purple-50 active:bg-purple-100"
                role="menuitem"
              >
                {copiedKiro ? <Check size={16} className="text-green-500 flex-shrink-0" /> : <Sparkles size={16} className="flex-shrink-0" />}
                <span className="truncate">{copiedKiro ? 'Copied!' : 'Copy to Kiro'}</span>
              </button>
              {!project?.kiro_export_prompt && (
                <p className="px-3 py-1 text-xs text-gray-400">
                  Tip: Configure Kiro prompt in project settings
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
