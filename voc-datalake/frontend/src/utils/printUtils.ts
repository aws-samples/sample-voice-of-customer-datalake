/**
 * @fileoverview Browser-based print utilities for PDF export.
 * Uses native browser print dialog instead of jsPDF for better quality and smaller bundle.
 * @module utils/printUtils
 */

import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'

/**
 * Print styles applied to the print window.
 * Includes page break controls and print-optimized typography.
 */
const PRINT_STYLES = `
  @media print {
    @page {
      size: A4;
      margin: 15mm;
    }
    
    body {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    
    /* Prevent page breaks inside these elements */
    [data-pdf-section],
    blockquote,
    pre,
    table,
    img {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    
    /* Add some space before sections that start a new page */
    h1, h2, h3 {
      break-after: avoid;
      page-break-after: avoid;
    }
    
    /* Hide print button when printing */
    .no-print {
      display: none !important;
    }
  }
  
  @media screen {
    .no-print {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 1000;
    }
    
    .print-button {
      padding: 10px 20px;
      background: #2563eb;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    
    .print-button:hover {
      background: #1d4ed8;
    }
  }
  
  * {
    box-sizing: border-box;
  }
  
  body {
    margin: 0;
    padding: 20px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: white;
    color: #1f2937;
    line-height: 1.6;
  }
`

interface PrintOptions {
  /** Document title shown in browser tab and print dialog */
  title: string
  /** React component to render as print content */
  content: ReactElement
  /** Optional callback when print window is closed */
  onClose?: () => void
}

/**
 * Opens a new browser window with print-optimized content and triggers the print dialog.
 * Users can save as PDF or print directly from the browser's native dialog.
 * 
 * @param options - Print configuration options
 * @returns The opened window reference, or null if blocked by popup blocker
 */
export function openPrintWindow(options: PrintOptions): Window | null {
  const { title, content, onClose } = options
  
  // Must be called from a user action to avoid popup blockers
  const printWindow = window.open('', '_blank')
  
  if (!printWindow) {
    // Popup was blocked
    return null
  }
  
  // Render React content to static HTML
  const contentHtml = renderToStaticMarkup(content)
  
  // Build the full HTML document (no inline event handlers to avoid CSP/browser blocking)
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>${PRINT_STYLES}</style>
</head>
<body>
  <div class="no-print">
    <button class="print-button" id="print-btn">
      Print / Save as PDF
    </button>
  </div>
  ${contentHtml}
</body>
</html>
`
  
  // Using document.write is the standard way to populate a new window's document
  // eslint-disable-next-line sonarjs/deprecation
  printWindow.document.write(html)
  printWindow.document.close()
  
  // Attach print button handler programmatically (inline onclick can be blocked by browsers)
  const printBtn = printWindow.document.getElementById('print-btn')
  if (printBtn) {
    printBtn.addEventListener('click', () => {
      printWindow.print()
    })
  }
  
  // Set up close handler if provided
  if (onClose) {
    printWindow.onbeforeunload = onClose
  }
  
  // Auto-trigger print dialog after content loads
  printWindow.onload = () => {
    // Small delay to ensure styles are applied
    setTimeout(() => {
      printWindow.print()
    }, 100)
  }
  
  return printWindow
}

/**
 * Escapes HTML special characters to prevent XSS.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
