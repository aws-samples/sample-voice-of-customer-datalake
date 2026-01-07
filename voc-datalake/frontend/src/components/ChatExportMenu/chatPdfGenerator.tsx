/**
 * @fileoverview PDF generation utilities for chat export.
 * @module components/ChatExportMenu/chatPdfGenerator
 */

import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import { createRoot } from 'react-dom/client'
import type { Conversation } from '../../store/chatStore'
import ChatPDFContent from './ChatPDFContent'

function createIframe(): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  iframe.style.position = 'absolute'
  iframe.style.left = '-9999px'
  iframe.style.top = '0'
  iframe.style.width = '800px'
  iframe.style.height = '10000px'
  iframe.style.border = 'none'
  return iframe
}

function waitForIframeLoad(iframe: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve) => {
    iframe.onload = () => resolve()
    iframe.src = 'about:blank'
  })
}

function setupContainer(iframeDoc: Document): HTMLDivElement {
  const container = iframeDoc.createElement('div')
  container.style.width = '800px'
  container.style.backgroundColor = '#ffffff'
  container.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif'
  container.style.color = '#000000'
  iframeDoc.body.appendChild(container)
  iframeDoc.body.style.margin = '0'
  iframeDoc.body.style.padding = '0'
  iframeDoc.body.style.backgroundColor = '#ffffff'
  return container
}

function createPageCanvas(
  sourceCanvas: HTMLCanvasElement,
  sourceY: number,
  sourceHeight: number
): HTMLCanvasElement {
  const pageCanvas = document.createElement('canvas')
  pageCanvas.width = sourceCanvas.width
  pageCanvas.height = sourceHeight
  const ctx = pageCanvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
    ctx.drawImage(sourceCanvas, 0, sourceY, sourceCanvas.width, sourceHeight, 0, 0, sourceCanvas.width, sourceHeight)
  }
  return pageCanvas
}

function renderPdfPages(
  canvas: HTMLCanvasElement,
  pdf: jsPDF,
  margin: number,
  contentWidth: number,
  contentHeight: number
): void {
  const imgWidthMM = contentWidth
  const imgHeightMM = (canvas.height * imgWidthMM) / canvas.width
  const totalPages = Math.ceil(imgHeightMM / contentHeight)

  const renderPage = (page: number): void => {
    if (page >= totalPages) return

    if (page > 0) pdf.addPage()

    const sourceY = (page * contentHeight / imgHeightMM) * canvas.height
    const sourceHeight = Math.min(
      (contentHeight / imgHeightMM) * canvas.height,
      canvas.height - sourceY
    )

    const pageCanvas = createPageCanvas(canvas, sourceY, sourceHeight)
    const pageImgData = pageCanvas.toDataURL('image/jpeg', 0.85)
    const pageImgHeightMM = (sourceHeight * imgWidthMM) / canvas.width

    pdf.addImage(pageImgData, 'JPEG', margin, margin, imgWidthMM, pageImgHeightMM)

    renderPage(page + 1)
  }

  renderPage(0)
}

export async function generateChatPDF(conversation: Conversation, filename: string): Promise<void> {
  const iframe = createIframe()
  document.body.appendChild(iframe)

  await waitForIframeLoad(iframe)

  const iframeDoc = iframe.contentDocument
  if (!iframeDoc) throw new Error('Failed to access iframe document')

  const container = setupContainer(iframeDoc)
  const root = createRoot(container)

  await new Promise<void>((resolve) => {
    root.render(<ChatPDFContent conversation={conversation} />)
    setTimeout(resolve, 200)
  })

  const canvas = await html2canvas(container, {
    scale: 1.5,
    useCORS: true,
    logging: false,
    backgroundColor: '#ffffff',
  })

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 10
  const contentWidth = pageWidth - (margin * 2)
  const contentHeight = pageHeight - (margin * 2)

  renderPdfPages(canvas, pdf, margin, contentWidth, contentHeight)

  root.unmount()
  document.body.removeChild(iframe)
  pdf.save(filename)
}
