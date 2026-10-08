/**
 * @fileoverview The write-tool registry: one {@link WriteToolDefinition} per
 * `CLIENT_TOOLS` entry in the contract. `registry.test.ts` iterates the
 * contract, so a client tool added there without an entry here fails a test.
 *
 * Definitions are written against their own typed args and ERASED to
 * `WriteToolDefinition<unknown>` by {@link defineWriteTool}: every erased
 * entry point (title, preview, execute) re-parses with the tool's schema, so
 * no caller can reach a typed function with unvalidated args.
 *
 * @module assistant/approvals/registry
 */
import { createElement } from 'react'
import { ADMIN_ONLY_CLIENT_TOOLS, DESTRUCTIVE_CLIENT_TOOLS } from '../contract'
import { executors } from './executors'
import * as s from './schemas'
import * as m from './memorySchemas'
import * as ag from './agentSchemas'
import * as c from './companySchemas'
import * as memory from './memoryExecutors'
import * as agents from './agentExecutors'
import * as company from './companyExecutors'
import { AgentActionPreview, AgentChangesPreview } from './previews/AgentPreviews'
import { CompanyContextPreview, DesignSystemPreview, MyContextPreview } from './previews/CompanyPreviews'
import { CompanyMemoryChangePreview, RememberPreview } from './previews/MemoryPreviews'
import { WorkflowCreatePreview, WorkflowDiffPreview } from './previews/WorkflowDiffPreview'
import { BrandSettingsPreview } from './previews/BrandSettingsPreview'
import { DocumentDiffPreview } from './previews/DocumentDiffPreview'
import { FeedbackCategoryPreview } from './previews/FeedbackCategoryPreview'
import { PersonaChangesPreview, ProductContextPreview } from './previews/FieldChangesPreview'
import { JobPreview } from './previews/JobPreview'
import type { ComponentType } from 'react'
import type { z } from 'zod'
import type { ClientToolName, PageContext } from '../contract'
import type { WriteToolDefinition } from '../types'

type Translate = (key: string, options?: Record<string, unknown>) => string

interface ToolSpec<A> {
  name: ClientToolName
  argsSchema: z.ZodType<A>
  title: (args: A, t: Translate) => string
  Preview?: ComponentType<{ args: A; page: PageContext }>
  execute: WriteToolDefinition<A>['execute']
}

/** Translation key of a tool's static title (also the fallback for invalid args). */
export const toolTitleKey = (name: string) => `assistantTools:tools.${name}.title`

function defineWriteTool<A>(spec: ToolSpec<A>): WriteToolDefinition {
  const { Preview } = spec
  const ErasedPreview: ComponentType<{ args: unknown; page: PageContext }> | undefined = Preview === undefined
    ? undefined
    : function ErasedToolPreview({ args, page }) {
      const parsed = spec.argsSchema.safeParse(args)
      return parsed.success ? createElement(Preview, { args: parsed.data, page }) : null
    }
  return {
    name: spec.name,
    argsSchema: spec.argsSchema,
    risk: DESTRUCTIVE_CLIENT_TOOLS.includes(spec.name) ? 'destructive' : 'write',
    adminOnly: ADMIN_ONLY_CLIENT_TOOLS.includes(spec.name),
    title: (args, t) => {
      const parsed = spec.argsSchema.safeParse(args)
      return parsed.success ? spec.title(parsed.data, t) : t(toolTitleKey(spec.name))
    },
    Preview: ErasedPreview,
    // async so invalid args reject the promise rather than throw synchronously.
    execute: async (args, ctx) => spec.execute(spec.argsSchema.parse(args), ctx),
  }
}

const DEFINITIONS: readonly WriteToolDefinition[] = [
  defineWriteTool({
    name: 'create_project', argsSchema: s.createProjectArgs, execute: executors.createProject,
    title: (a, t) => t('assistantTools:tools.create_project.titleWith', { name: a.name }),
  }),
  defineWriteTool({
    name: 'set_problem_resolved', argsSchema: s.setProblemResolvedArgs, execute: executors.setProblemResolved,
    title: (a, t) => t(a.resolved ? 'assistantTools:tools.set_problem_resolved.titleResolve' : 'assistantTools:tools.set_problem_resolved.titleReopen'),
  }),
  defineWriteTool({
    name: 'set_feedback_category', argsSchema: s.setFeedbackCategoryArgs, execute: executors.setFeedbackCategory,
    title: (a, t) => t('assistantTools:tools.set_feedback_category.titleWith', { category: a.category }),
    Preview: FeedbackCategoryPreview,
  }),
  defineWriteTool({
    name: 'update_document', argsSchema: s.updateDocumentArgs, execute: executors.updateDocument,
    title: (_a, t) => t(toolTitleKey('update_document')), Preview: DocumentDiffPreview,
  }),
  defineWriteTool({
    name: 'create_document', argsSchema: s.createDocumentArgs, execute: executors.createDocument,
    title: (a, t) => t('assistantTools:tools.create_document.titleWith', { title: a.title }),
  }),
  defineWriteTool({
    name: 'delete_document', argsSchema: s.deleteDocumentArgs, execute: executors.deleteDocument,
    title: (_a, t) => t(toolTitleKey('delete_document')),
  }),
  defineWriteTool({
    name: 'update_persona', argsSchema: s.updatePersonaArgs, execute: executors.updatePersona,
    title: (_a, t) => t(toolTitleKey('update_persona')), Preview: PersonaChangesPreview,
  }),
  defineWriteTool({
    name: 'add_persona_note', argsSchema: s.addPersonaNoteArgs, execute: executors.addPersonaNote,
    title: (_a, t) => t(toolTitleKey('add_persona_note')),
  }),
  defineWriteTool({
    name: 'update_project', argsSchema: s.updateProjectArgs, execute: executors.updateProject,
    title: (_a, t) => t(toolTitleKey('update_project')),
  }),
  defineWriteTool({
    name: 'update_product_context', argsSchema: s.updateProductContextArgs, execute: executors.updateProductContext,
    title: (_a, t) => t(toolTitleKey('update_product_context')), Preview: ProductContextPreview,
  }),
  defineWriteTool({
    name: 'start_research', argsSchema: s.startResearchArgs, execute: executors.startResearch,
    title: (_a, t) => t(toolTitleKey('start_research')), Preview: JobPreview,
  }),
  defineWriteTool({
    name: 'generate_document', argsSchema: s.generateDocumentArgs, execute: executors.generateDocument,
    title: (a, t) => t(a.doc_type === 'prd' ? 'assistantTools:tools.generate_document.titlePrd' : 'assistantTools:tools.generate_document.titlePrfaq'),
    Preview: JobPreview,
  }),
  defineWriteTool({
    name: 'generate_personas', argsSchema: s.generatePersonasArgs, execute: executors.generatePersonas,
    title: (a, t) => t('assistantTools:tools.generate_personas.titleWith', { n: a.persona_count }), Preview: JobPreview,
  }),
  defineWriteTool({
    name: 'merge_documents', argsSchema: s.mergeDocumentsArgs, execute: executors.mergeDocuments,
    title: (_a, t) => t(toolTitleKey('merge_documents')), Preview: JobPreview,
  }),
  defineWriteTool({
    name: 'update_feedback_form', argsSchema: s.updateFeedbackFormArgs, execute: executors.updateFeedbackForm,
    title: (_a, t) => t(toolTitleKey('update_feedback_form')),
  }),
  defineWriteTool({
    name: 'run_scraper', argsSchema: s.runScraperArgs, execute: executors.runScraper,
    title: (_a, t) => t(toolTitleKey('run_scraper')),
  }),
  defineWriteTool({
    name: 'save_brand_settings', argsSchema: s.saveBrandSettingsArgs, execute: executors.saveBrandSettings,
    title: (_a, t) => t(toolTitleKey('save_brand_settings')), Preview: BrandSettingsPreview,
  }),
  // ── Memory (core + memory pack) ──
  defineWriteTool({
    name: 'remember', argsSchema: m.rememberArgs, execute: memory.remember,
    title: (a, t) => t(a.scope === 'company' ? 'assistantTools:tools.remember.titleCompany' : 'assistantTools:tools.remember.titlePersonal'),
    Preview: RememberPreview,
  }),
  defineWriteTool({
    name: 'update_company_memory', argsSchema: m.updateCompanyMemoryArgs, execute: memory.updateCompanyMemory,
    title: (_a, t) => t(toolTitleKey('update_company_memory')), Preview: CompanyMemoryChangePreview,
  }),
  defineWriteTool({
    name: 'forget_memory', argsSchema: m.forgetMemoryArgs, execute: memory.forgetMemory,
    title: (_a, t) => t(toolTitleKey('forget_memory')),
  }),
  defineWriteTool({
    name: 'confirm_memory', argsSchema: m.confirmMemoryArgs, execute: memory.confirmMemory,
    title: (_a, t) => t(toolTitleKey('confirm_memory')),
  }),
  defineWriteTool({
    name: 'merge_memories', argsSchema: m.mergeMemoriesArgs, execute: memory.mergeMemories,
    title: (a, t) => t('assistantTools:tools.merge_memories.titleWith', { n: a.memory_ids.length }),
  }),
  defineWriteTool({
    name: 'resolve_memory_conflict', argsSchema: m.resolveMemoryConflictArgs, execute: memory.resolveMemoryConflict,
    title: (a, t) => t('assistantTools:tools.resolve_memory_conflict.titleWith', {
      action: t(`assistantTools:preview.memory.resolve.${a.action}`),
    }),
  }),
  // ── Autonomous agents ──
  defineWriteTool({
    name: 'create_agent', argsSchema: ag.createAgentArgs, execute: agents.createAgent,
    title: (a, t) => t('assistantTools:tools.create_agent.titleWith', { name: a.name }),
  }),
  defineWriteTool({
    name: 'update_agent', argsSchema: ag.updateAgentArgs, execute: agents.updateAgent,
    title: (_a, t) => t(toolTitleKey('update_agent')), Preview: AgentChangesPreview,
  }),
  defineWriteTool({
    name: 'enable_agent', argsSchema: ag.agentActionArgs, execute: agents.enableAgent,
    title: (_a, t) => t(toolTitleKey('enable_agent')), Preview: AgentActionPreview,
  }),
  defineWriteTool({
    name: 'disable_agent', argsSchema: ag.agentActionArgs, execute: agents.disableAgent,
    title: (_a, t) => t(toolTitleKey('disable_agent')), Preview: AgentActionPreview,
  }),
  defineWriteTool({
    name: 'run_agent', argsSchema: ag.agentActionArgs, execute: agents.runAgent,
    title: (_a, t) => t(toolTitleKey('run_agent')), Preview: AgentActionPreview,
  }),
  defineWriteTool({
    name: 'cancel_agent_run', argsSchema: ag.cancelAgentRunArgs, execute: agents.cancelAgentRun,
    title: (_a, t) => t(toolTitleKey('cancel_agent_run')), Preview: AgentActionPreview,
  }),
  defineWriteTool({
    name: 'create_workflow', argsSchema: ag.createWorkflowArgs, execute: agents.createWorkflow,
    title: (a, t) => t('assistantTools:tools.create_workflow.titleWith', { name: a.definition.name }),
    Preview: WorkflowCreatePreview,
  }),
  defineWriteTool({
    name: 'update_workflow', argsSchema: ag.updateWorkflowArgs, execute: agents.updateWorkflow,
    title: (_a, t) => t(toolTitleKey('update_workflow')), Preview: WorkflowDiffPreview,
  }),
  defineWriteTool({
    name: 'duplicate_workflow', argsSchema: ag.duplicateWorkflowArgs, execute: agents.duplicateWorkflow,
    title: (_a, t) => t(toolTitleKey('duplicate_workflow')),
  }),
  // ── Company context ──
  defineWriteTool({
    name: 'update_company_context', argsSchema: c.updateCompanyContextArgs, execute: company.updateCompanyContext,
    title: (_a, t) => t(toolTitleKey('update_company_context')), Preview: CompanyContextPreview,
  }),
  defineWriteTool({
    name: 'update_my_context', argsSchema: c.updateMyContextArgs, execute: company.updateMyContext,
    title: (_a, t) => t(toolTitleKey('update_my_context')), Preview: MyContextPreview,
  }),
  defineWriteTool({
    name: 'update_design_system', argsSchema: c.updateDesignSystemArgs, execute: company.updateDesignSystem,
    title: (_a, t) => t(toolTitleKey('update_design_system')), Preview: DesignSystemPreview,
  }),
]

const BY_NAME = new Map<string, WriteToolDefinition>(DEFINITIONS.map((d) => [d.name, d]))

export function getWriteTool(name: string): WriteToolDefinition | undefined {
  return BY_NAME.get(name)
}

/** Every registered definition, in contract order (for tests and tooling). */
export function listWriteTools(): readonly WriteToolDefinition[] {
  return DEFINITIONS
}
