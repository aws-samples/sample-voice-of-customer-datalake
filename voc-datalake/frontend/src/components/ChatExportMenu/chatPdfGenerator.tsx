/**
 * @fileoverview PDF generation for chat export.
 * @module components/ChatExportMenu/chatPdfGenerator
 */

import { createPdfGenerator } from '../../utils/printUtils'
import ChatPDFContent from './ChatPDFContent'
import type { Conversation } from '../../store/chatStore'

export const generateChatPDF = createPdfGenerator<Conversation>(
  (conversation) => conversation.title,
  (conversation) => <ChatPDFContent conversation={conversation} />,
)
