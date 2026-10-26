/**
 * @fileoverview "Export conversation (Markdown)": the visible thread as a
 * Markdown document, downloaded client-side.
 *
 * @module assistant/components/exportMarkdown
 */
import { contentToText } from '../thread/reducer'
import type { Message } from '@ag-ui/core'

export function threadToMarkdown(title: string, messages: readonly Message[], labels: { user: string; assistant: string }): string {
  const lines = [`# ${title}`, '']
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = contentToText(message.content).trim()
    if (text === '') continue
    lines.push(`## ${message.role === 'user' ? labels.user : labels.assistant}`, '', text, '')
  }
  return lines.join('\n')
}

export function downloadMarkdown(filename: string, markdown: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
