/**
 * Zod request validation schemas for the streaming chat Lambda.
 */
import { z } from 'zod';

const ALLOWED_MEDIA_TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf',
] as const;

export const attachmentSchema = z.object({
  name: z.string().min(1, 'Attachment name is required'),
  media_type: z.enum(ALLOWED_MEDIA_TYPES, {
    errorMap: () => ({ message: `Unsupported file type. Allowed: ${ALLOWED_MEDIA_TYPES.join(', ')}` }),
  }),
  data: z.string().min(1, 'Attachment data is required'),
});

export type Attachment = z.infer<typeof attachmentSchema>;

export const historyMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

export type HistoryMessage = z.infer<typeof historyMessageSchema>;

export const chatRequestSchema = z.object({
  message: z.string().min(1, 'Message is required'),
  // VoC chat fields
  context: z.string().optional(),
  days: z.number().int().min(1).max(365).optional(),
  response_language: z.string().optional(),
  // Project chat fields
  project_id: z.string().optional(),
  selected_personas: z.array(z.string()).optional(),
  selected_documents: z.array(z.string()).optional(),
  // Roundtable mode: each selected persona responds in turn
  roundtable: z.boolean().optional(),
  // Attachments (images, PDFs)
  attachments: z.array(attachmentSchema).max(5).optional(),
  // Conversation history for multi-turn context
  history: z.array(historyMessageSchema).max(50).optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
