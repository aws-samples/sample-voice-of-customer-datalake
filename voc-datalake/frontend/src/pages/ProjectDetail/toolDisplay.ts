import {
  FileText, Search, Wrench,
} from 'lucide-react'

export interface ToolDisplayInfo {
  label: string
  activeLabel: string
  icon: typeof FileText
  colorClass: string
  bgClass: string
}

const TOOL_DISPLAY_MAP = new Map<string, ToolDisplayInfo>([
  ['update_document', {
    label: 'Document updated',
    activeLabel: 'Editing document',
    icon: FileText,
    colorClass: 'text-blue-600',
    bgClass: 'bg-blue-50',
  }],
  ['create_document', {
    label: 'Document created',
    activeLabel: 'Creating document',
    icon: FileText,
    colorClass: 'text-green-600',
    bgClass: 'bg-green-50',
  }],
  ['search_feedback', {
    label: 'Search complete',
    activeLabel: 'Searching feedback',
    icon: Search,
    colorClass: 'text-purple-600',
    bgClass: 'bg-purple-50',
  }],
])

export function getToolDisplay(toolName: string): ToolDisplayInfo {
  return TOOL_DISPLAY_MAP.get(toolName) ?? {
    label: toolName.replaceAll('_', ' '),
    activeLabel: toolName.replaceAll('_', ' '),
    icon: Wrench,
    colorClass: 'text-gray-600',
    bgClass: 'bg-gray-50',
  }
}
