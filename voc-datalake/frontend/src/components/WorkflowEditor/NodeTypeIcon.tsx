/**
 * @fileoverview The lucide icon of each workflow node type (palette, canvas,
 * side panel, run log).
 *
 * @module components/WorkflowEditor/NodeTypeIcon
 */
import {
  Bot, Brain, Combine, Copy, Database, FilePen, FileText, Flag, FolderKanban, GitPullRequest, Globe, GraduationCap,
  Hammer, KanbanSquare, Layers, MapPin, MessagesSquare, Newspaper, Play, Send, ShieldCheck, Sparkles, Split,
  UserPlus, Users, Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { WorkflowNodeType } from '../../api/workflowsApi'

const ICONS: Readonly<Record<WorkflowNodeType, LucideIcon>> = {
  start: Play,
  aggregate_reviews: Layers,
  select_or_create_project: FolderKanban,
  select_personas: Users,
  generate_personas: UserPlus,
  deep_research: Globe,
  write_prfaq: Newspaper,
  write_prd: FileText,
  persona_review: MessagesSquare,
  revise_document: FilePen,
  build_prototype: Hammer,
  collect_prototype_feedback: MapPin,
  revise_prototype: Wrench,
  final_review: ShieldCheck,
  duplicate_document: Copy,
  handoff: Send,
  custom_llm: Sparkles,
  agent: Bot,
  map: Split,
  reduce: Combine,
  board: KanbanSquare,
  quality_gate: ShieldCheck,
  learning_loop: GraduationCap,
  self_improvement: Brain,
  memory: Database,
  stop_at_pr: GitPullRequest,
  end: Flag,
}

export function NodeTypeIcon({ type, size = 14, className }: Readonly<{ type: WorkflowNodeType; size?: number; className?: string }>) {
  const Icon = ICONS[type]
  return <Icon size={size} className={className} aria-hidden="true" />
}
