/**
 * @fileoverview PDF generation utilities for chat export.
 * Uses browser print dialog for PDF generation.
 * @module components/ChatExportMenu/chatPdfGenerator
 */

import type { Conversation } from '../../store/chatStore'
import { openPrintWindow } from '../../utils/printUtils'
import ChatPDFContent from './ChatPDFContent'

/**
 * Opens a print-friendly view of the chat conversation.
 * Users can save as PDF or print directly from the browser's native dialog.
 */
export function generateChatPDF(conversation: Conversation): void {
  const printWindow = openPrintWindow({
    title: conversation.title,
    content: <ChatPDFContent conversation={conversation} />,
  })

  if (!printWindow) {
    throw new Error('Failed to open print window. Please allow popups for this site.')
  }
}
