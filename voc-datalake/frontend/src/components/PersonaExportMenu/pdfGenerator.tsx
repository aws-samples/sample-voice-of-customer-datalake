/**
 * @fileoverview PDF generation utilities for persona export.
 * @module components/PersonaExportMenu/pdfGenerator
 */

import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import { createRoot } from 'react-dom/client'
import type { ProjectPersona } from '../../api/client'
import PersonaPDFContent from './PersonaPDFContent'

interface SectionBounds {
  top: number
  bottom: number
}

/**
 * Converts an image URL to a base64 data URL to avoid CORS issues in html2canvas.
 * Returns null if the image cannot be loaded.
 */
async function imageUrlToDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { mode: 'cors' })
    if (!response.ok) return null
    const blob = await response.blob()
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const result = reader.result
        resolve(typeof result === 'string' ? result : null)
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/**
 * Creates a persona object with the avatar URL converted to a data URL.
 * This ensures the image renders correctly in the PDF.
 */
async function preparePersonaForPdf(persona: ProjectPersona): Promise<ProjectPersona> {
  if (!persona.avatar_url) return persona

  const dataUrl = await imageUrlToDataUrl(persona.avatar_url)
  if (!dataUrl) return persona

  return { ...persona, avatar_url: dataUrl }
}

function createIframe(): HTMLIFrameElement {
  const iframe = window.document.createElement('iframe')
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
  container.style.fontFamily = 'system-ui, -apple-system, sans-serif'
  container.style.color = '#000000'
  iframeDoc.body.appendChild(container)
  iframeDoc.body.style.margin = '0'
  iframeDoc.body.style.padding = '0'
  iframeDoc.body.style.backgroundColor = '#ffffff'
  return container
}

function getSectionBounds(container: HTMLDivElement): SectionBounds[] {
  const sections = container.querySelectorAll('[data-pdf-section]')
  const bounds: SectionBounds[] = []
  sections.forEach((section) => {
    if (section instanceof HTMLElement) {
      bounds.push({ top: section.offsetTop, bottom: section.offsetTop + section.offsetHeight })
    }
  })
  return bounds
}

function findSectionTopBreak(
  currentY: number,
  searchStart: number,
  idealEndY: number,
  scaledBounds: SectionBounds[]
): number | null {
  for (const bounds of scaledBounds) {
    if (bounds.top > currentY + 50 && bounds.top >= searchStart && bounds.top <= idealEndY) {
      const wouldCutSection = scaledBounds.some(b =>
        b.top < bounds.top && b.bottom > bounds.top && b.bottom <= idealEndY + 20
      )
      if (!wouldCutSection) return bounds.top
    }
  }
  return null
}

function findSectionEndBreak(currentY: number, idealEndY: number, scaledBounds: SectionBounds[]): number | null {
  for (const bounds of scaledBounds) {
    if (bounds.bottom > currentY + 50 && bounds.bottom <= idealEndY) {
      return bounds.bottom
    }
  }
  return null
}

function findCutSectionBreak(currentY: number, idealEndY: number, scaledBounds: SectionBounds[]): number | null {
  for (const bounds of scaledBounds) {
    if (bounds.top < idealEndY && bounds.bottom > idealEndY && bounds.top > currentY + 50) {
      return bounds.top
    }
  }
  return null
}

function findBestBreakPoint(
  currentY: number,
  idealEndY: number,
  pageHeightPx: number,
  scaledBounds: SectionBounds[]
): number {
  const searchStart = idealEndY - (pageHeightPx * 0.35)

  const topBreak = findSectionTopBreak(currentY, searchStart, idealEndY, scaledBounds)
  if (topBreak !== null) return topBreak

  const endBreak = findSectionEndBreak(currentY, idealEndY, scaledBounds)
  if (endBreak !== null) return endBreak

  const cutBreak = findCutSectionBreak(currentY, idealEndY, scaledBounds)
  if (cutBreak !== null) return cutBreak

  return idealEndY
}

function createPageCanvas(
  sourceCanvas: HTMLCanvasElement,
  currentY: number,
  sourceHeight: number
): HTMLCanvasElement {
  const pageCanvas = window.document.createElement('canvas')
  pageCanvas.width = sourceCanvas.width
  pageCanvas.height = sourceHeight
  const ctx = pageCanvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
    ctx.drawImage(sourceCanvas, 0, currentY, sourceCanvas.width, sourceHeight, 0, 0, sourceCanvas.width, sourceHeight)
  }
  return pageCanvas
}

interface PdfRenderContext {
  readonly canvas: HTMLCanvasElement
  readonly pdf: jsPDF
  readonly margin: number
  readonly imgWidthMM: number
  readonly pxPerMM: number
  readonly pageHeightPx: number
  readonly scaledBounds: SectionBounds[]
}

function renderPdfPages(ctx: PdfRenderContext): void {
  const { canvas, pdf, margin, imgWidthMM, pxPerMM, pageHeightPx, scaledBounds } = ctx
  const maxPages = 50

  const renderPage = (currentY: number, pageNum: number): void => {
    if (currentY >= canvas.height || pageNum >= maxPages) return

    if (pageNum > 0) pdf.addPage()

    const idealEndY = currentY + pageHeightPx
    const endY = idealEndY >= canvas.height
      ? canvas.height
      : findBestBreakPoint(currentY, idealEndY, pageHeightPx, scaledBounds)

    const sourceHeight = endY - currentY
    const pageCanvas = createPageCanvas(canvas, currentY, sourceHeight)
    const pageImgData = pageCanvas.toDataURL('image/jpeg', 0.92)
    const pageImgHeightMM = sourceHeight / pxPerMM

    pdf.addImage(pageImgData, 'JPEG', margin, margin, imgWidthMM, pageImgHeightMM)

    renderPage(endY, pageNum + 1)
  }

  renderPage(0, 0)
}

export async function generatePersonaPDF(persona: ProjectPersona, filename: string): Promise<void> {
  // Convert avatar URL to data URL to avoid CORS issues
  const preparedPersona = await preparePersonaForPdf(persona)
  
  const iframe = createIframe()
  window.document.body.appendChild(iframe)

  await waitForIframeLoad(iframe)

  const iframeDoc = iframe.contentDocument
  if (!iframeDoc) throw new Error('Failed to access iframe document')

  const container = setupContainer(iframeDoc)
  const root = createRoot(container)

  await new Promise<void>((resolve) => {
    root.render(<PersonaPDFContent persona={preparedPersona} />)
    setTimeout(resolve, 200)
  })

  const sectionBounds = getSectionBounds(container)

  const canvas = await html2canvas(container, {
    scale: 2,
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

  const imgWidthMM = contentWidth
  const scale = canvas.width / 800
  const pxPerMM = canvas.width / imgWidthMM
  const pageHeightPx = contentHeight * pxPerMM

  const scaledBounds = sectionBounds.map(b => ({
    top: b.top * scale,
    bottom: b.bottom * scale
  }))

  renderPdfPages({ canvas, pdf, margin, imgWidthMM, pxPerMM, pageHeightPx, scaledBounds })

  root.unmount()
  window.document.body.removeChild(iframe)
  pdf.save(filename)
}
