/**
 * Project Chat context builder.
 * Ported from Python shared/project_chat.py build_chat_context().
 */
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { ConfigurationError, NotFoundError } from '../lib/errors.js';

// ── Avatar URL helpers ──

const AVATARS_CDN_URL = process.env.AVATARS_CDN_URL ?? '';

/** Convert an S3 URI (s3://bucket/avatars/file.png) to a CloudFront CDN URL. */
function resolveAvatarUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (!url.startsWith('s3://')) return url; // already a CDN URL
  if (!AVATARS_CDN_URL) return undefined;
  const parts = url.split('/');
  const filename = parts[parts.length - 1];
  if (!filename) return undefined;
  return `${AVATARS_CDN_URL.replace(/\/+$/, '')}/${filename}`;
}

interface ProjectChatContext {
  systemPrompt: string;
  userMessage: string;
  metadata: Record<string, unknown>;
}

const projectItemSchema = z.object({
  sk: z.string().default(''),
  project_id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  persona_count: z.number().optional(),
  document_count: z.number().optional(),
  filters: z.record(z.unknown()).optional(),
  persona_id: z.string().optional(),
  tagline: z.string().optional(),
  quote: z.string().optional(),
  goals: z.array(z.string()).optional(),
  frustrations: z.array(z.string()).optional(),
  needs: z.array(z.string()).optional(),
  behaviors: z.union([
    z.object({
      current_solutions: z.array(z.string()).optional(),
      tools_used: z.array(z.string()).optional(),
      activity_frequency: z.string().optional(),
      tech_savviness: z.string().optional(),
      decision_style: z.string().optional(),
    }).passthrough(),
    z.array(z.string()),
  ]).optional(),
  scenario: z.union([
    z.object({
      title: z.string().optional(),
      narrative: z.string().optional(),
      trigger: z.string().optional(),
      outcome: z.string().optional(),
    }).passthrough(),
    z.string(),
  ]).optional(),
  demographics: z.record(z.unknown()).optional(),
  avatar_url: z.string().optional(),
  document_id: z.string().optional(),
  document_type: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  feature_idea: z.string().optional(),
  question: z.string().optional(),
  created_at: z.string().optional(),
}).passthrough();

type ProjectItem = z.infer<typeof projectItemSchema>;

function getLanguageInstruction(lang?: string): string {
  if (!lang || lang === 'en') return '';
  const names: Record<string, string> = {
    es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese',
    ja: 'Japanese', zh: 'Chinese', ko: 'Korean', it: 'Italian',
  };
  const name = names[lang] ?? lang;
  return `IMPORTANT: You MUST respond entirely in ${name} (${lang}). All text, headings, labels, and explanations must be in ${name}.`;
}

// ── Item classification ──

interface ClassifiedItems {
  project: ProjectItem | null;
  personas: ProjectItem[];
  documents: ProjectItem[];
}

function classifyItems(items: ProjectItem[]): ClassifiedItems {
  const result: ClassifiedItems = { project: null, personas: [], documents: [] };
  for (const item of items) {
    const sk = item.sk;
    if (sk === 'META') result.project = item;
    else if (sk.startsWith('PERSONA#')) result.personas.push(item);
    else if (sk.startsWith('DOC#') || sk.startsWith('RESEARCH#') || sk.startsWith('PRD#') || sk.startsWith('PRFAQ#'))
      result.documents.push(item);
  }
  return result;
}

// ── Persona resolution ──

function resolveActivePersonas(
  personas: ProjectItem[],
  selectedPersonaIds: string[],
  message: string,
): ProjectItem[] {
  const personaMap = new Map(personas.map((p) => [(p.name ?? '').toLowerCase(), p]));
  const selected = personas.filter((p) => selectedPersonaIds.includes(p.persona_id ?? ''));

  const mentionPattern = /@(\w+)/g;
  const mentions: string[] = [];
  for (const m of message.matchAll(mentionPattern)) {
    mentions.push(m[1].toLowerCase());
  }

  const mentioned: ProjectItem[] = [];
  for (const mention of mentions) {
    for (const [name, persona] of personaMap) {
      if (name.includes(mention) && !mentioned.includes(persona)) {
        mentioned.push(persona);
      }
    }
  }

  // Deduplicate
  const activeMap = new Map<string, ProjectItem>();
  for (const p of [...selected, ...mentioned]) {
    activeMap.set(p.persona_id ?? '', p);
  }
  return [...activeMap.values()];
}

// ── Prompt building helpers ──

function buildPersonasContext(personas: ProjectItem[]): string {
  const sections = personas.map((p) => {
    const goals = (p.goals ?? []).slice(0, 4).map((g) => `- ${g}`).join('\n');
    const frustrations = (p.frustrations ?? []).slice(0, 4).map((f) => `- ${f}`).join('\n');
    const needs = (p.needs ?? []).slice(0, 4).map((n) => `- ${n}`).join('\n');
    return `
### ${p.name} - ${p.tagline ?? ''}

**Their voice:** "${p.quote ?? ''}"

**Goals:**
${goals}

**Frustrations:**
${frustrations}

**Needs:**
${needs}

---`;
  });
  return `\n## 👤 ACTIVE PERSONAS (Respond from their perspective)\n${sections.join('\n')}`;
}

function buildDocumentsContext(
  documents: ProjectItem[],
  selectedDocumentIds: string[],
): { selectedContent: string; otherDocsList: string[] } {
  const selectedParts: string[] = [];
  const otherDocsList: string[] = [];
  for (const doc of documents) {
    const docId = doc.document_id ?? '';
    const docType = (doc.document_type ?? 'doc').toUpperCase();
    const docTitle = doc.title ?? 'Untitled';
    if (selectedDocumentIds.includes(docId)) {
      selectedParts.push(`\n## 📄 DOCUMENT: ${docTitle} (${docType}) [ID: ${docId}]\n\n${doc.content ?? ''}\n\n---\n`);
    } else {
      otherDocsList.push(`- ${docType}: ${docTitle} [ID: ${docId}]`);
    }
  }
  return { selectedContent: selectedParts.join(''), otherDocsList };
}

// ── Feedback fetching ──

interface FeedbackSummary {
  count: number;
  promptSection: string;
}

const feedbackItemSchema = z.object({
  source_platform: z.string().optional(),
  sentiment_label: z.string().optional(),
  category: z.string().optional(),
  original_text: z.string().optional(),
}).passthrough();

async function fetchRecentFeedback(
  docClient: DynamoDBDocumentClient,
  feedbackTable: string,
): Promise<FeedbackSummary> {
  try {
    const resp = await docClient.send(
      new QueryCommand({
        TableName: feedbackTable,
        IndexName: 'gsi1-by-date',
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': 'DATE' },
        ScanIndexForward: false,
        Limit: 30,
      }),
    );
    const rawItems = resp.Items ?? [];
    if (rawItems.length === 0) return { count: 0, promptSection: '' };

    const lines = rawItems.slice(0, 15).map((raw) => {
      const item = feedbackItemSchema.parse(raw);
      const src = item.source_platform ?? 'unknown';
      const sent = item.sentiment_label ?? 'unknown';
      const cat = item.category ?? 'unknown';
      const text = (item.original_text ?? '').slice(0, 300);
      return `[${src}|${sent}|${cat}] ${text}`;
    });
    return { count: rawItems.length, promptSection: `## Recent Customer Feedback\n${lines.join('\n\n')}\n\n` };
  } catch {
    return { count: 0, promptSection: '' };
  }
}

// ── System prompt assembly ──

function assembleSystemPrompt(
  projectName: string,
  selectedContent: string,
  activePersonas: ProjectItem[],
  allPersonas: ProjectItem[],
  otherDocsList: string[],
  feedbackSection: string,
  selectedDocumentIds: string[],
  documents: ProjectItem[],
  responseLanguage?: string,
): string {
  const parts: string[] = [
    `You are an AI product research assistant working on the project "${projectName}".\n\n`,
  ];

  if (selectedContent) {
    parts.push(`## REFERENCED DOCUMENTS (Use this content to answer the question)\n${selectedContent}\n`);
  }

  if (activePersonas.length > 0) {
    parts.push(buildPersonasContext(activePersonas));
    const names = activePersonas.map((p) => p.name);
    parts.push(`\n🎯 PERSONA MODE ACTIVE: ${names.join(', ')}\n`);
    parts.push('Respond AS IF you are this persona - use first person ("I think...", "As someone who..."), channel their specific frustrations, goals, and needs.\n\n');
  }

  if (feedbackSection) parts.push(feedbackSection);

  if (otherDocsList.length > 0) {
    parts.push(`## Other Available Documents (not currently referenced)\n${otherDocsList.slice(0, 5).join('\n')}\n\n`);
  }

  if (allPersonas.length > 0 && activePersonas.length === 0) {
    const pNames = allPersonas.slice(0, 5).map((p) => `@${p.name}`);
    parts.push(`## Available Personas (mention with @ to activate)\n${pNames.join(', ')}\n\n`);
  }

  if (selectedDocumentIds.length > 0) {
    const docTitles = documents.filter((d) => selectedDocumentIds.includes(d.document_id ?? '')).map((d) => d.title);
    parts.push(`📄 IMPORTANT: The user has tagged the document(s): ${docTitles.join(', ')}\n`);
    parts.push('You MUST use the document content provided above to answer their question.\n\n');
  }

  // Always tell the AI about document tools — it should be able to edit any project document
  if (documents.length > 0) {
    const allDocEntries = documents.map((d) => `- ${(d.document_type ?? 'doc').toUpperCase()}: ${d.title ?? 'Untitled'} [ID: ${d.document_id ?? ''}]`);
    parts.push(`## 🛠️ Document Tools\n`);
    parts.push(`You have access to the **update_document** tool to edit any project document and the **create_document** tool to create new ones.\n`);
    parts.push(`When the user asks you to edit, modify, add to, or rewrite a document, use update_document with the document ID.\n`);
    parts.push(`All project documents:\n${allDocEntries.join('\n')}\n\n`);
  } else {
    parts.push('You have access to the create_document tool to create new documents when the user asks.\n\n');
  }

  parts.push('You also have access to the search_feedback tool to look up customer feedback when relevant.\n\n');

  parts.push('Be specific, accurate, and base your response on the provided context.');

  const langInstruction = getLanguageInstruction(responseLanguage);
  if (langInstruction) parts.push(`\n\n${langInstruction}`);

  return parts.join('');
}

// ── Main export ──

export interface RoundtablePersona {
  persona_id: string;
  name: string;
  avatar_url?: string;
  systemPrompt: string;
}

export interface RoundtableContext {
  personas: RoundtablePersona[];
  userMessage: string;
  metadata: Record<string, unknown>;
  selectedDocumentIds: string[];
  documents: ProjectItem[];
}

export async function buildProjectChatContext(
  docClient: DynamoDBDocumentClient,
  projectsTable: string,
  feedbackTable: string,
  projectId: string,
  message: string,
  selectedPersonaIds: string[] = [],
  selectedDocumentIds: string[] = [],
  responseLanguage?: string,
): Promise<ProjectChatContext> {
  if (!projectsTable) {
    throw new ConfigurationError('Projects table not configured');
  }

  const resp = await docClient.send(
    new QueryCommand({
      TableName: projectsTable,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `PROJECT#${projectId}` },
    }),
  );

  const rawItems = resp.Items ?? [];
  if (rawItems.length === 0) {
    throw new NotFoundError('Project not found');
  }

  const items = rawItems.map((raw) => projectItemSchema.parse(raw));
  const { project, personas, documents } = classifyItems(items);

  if (!project) {
    throw new NotFoundError('Project metadata not found');
  }

  const activePersonas = resolveActivePersonas(personas, selectedPersonaIds, message);
  const { selectedContent, otherDocsList } = buildDocumentsContext(documents, selectedDocumentIds);

  // Only fetch feedback if no documents selected
  const feedback = selectedDocumentIds.length === 0 && feedbackTable
    ? await fetchRecentFeedback(docClient, feedbackTable)
    : { count: 0, promptSection: '' };

  const systemPrompt = assembleSystemPrompt(
    project.name ?? 'Project',
    selectedContent,
    activePersonas,
    personas,
    otherDocsList,
    feedback.promptSection,
    selectedDocumentIds,
    documents,
    responseLanguage,
  );

  const selectedPersonas = personas.filter((p) => selectedPersonaIds.includes(p.persona_id ?? ''));
  const mentionedPersonas = activePersonas.filter((p) => !selectedPersonaIds.includes(p.persona_id ?? ''));

  const metadata = {
    mentioned_personas: mentionedPersonas.map((p) => p.name),
    selected_personas: selectedPersonas.map((p) => p.name),
    referenced_documents: documents.filter((d) => selectedDocumentIds.includes(d.document_id ?? '')).map((d) => d.title),
    context: { feedback_count: feedback.count, persona_count: personas.length, document_count: documents.length },
  };

  return { systemPrompt, userMessage: message, metadata };
}


// ── Roundtable: build a per-persona system prompt for each participant ──

function buildSinglePersonaPrompt(
  projectName: string,
  persona: ProjectItem,
  selectedContent: string,
  otherDocsList: string[],
  feedbackSection: string,
  selectedDocumentIds: string[],
  documents: ProjectItem[],
  previousResponses: Array<{ name: string; response: string }>,
  responseLanguage?: string,
): string {
  const parts: string[] = [
    `You are "${persona.name}" — a customer persona in the project "${projectName}".\n`,
    `Your tagline: "${persona.tagline ?? ''}"\n`,
    `Your voice: "${persona.quote ?? ''}"\n\n`,
  ];

  const goals = (persona.goals ?? []).slice(0, 4).map((g) => `- ${g}`).join('\n');
  const frustrations = (persona.frustrations ?? []).slice(0, 4).map((f) => `- ${f}`).join('\n');
  const needs = (persona.needs ?? []).slice(0, 4).map((n) => `- ${n}`).join('\n');

  parts.push(`**Your Goals:**\n${goals}\n\n`);
  parts.push(`**Your Frustrations:**\n${frustrations}\n\n`);
  parts.push(`**Your Needs:**\n${needs}\n\n`);

  parts.push('Respond in first person AS this persona. Use "I think...", "As someone who...", etc. Be concise — keep your response to 2-4 paragraphs.\n');
  parts.push('You are in a roundtable discussion with other customer personas. Speak naturally, share your honest opinion, and don\'t hold back. If you disagree with someone, say so directly.\n\n');

  if (selectedContent) {
    parts.push(`## REFERENCED DOCUMENTS\n${selectedContent}\n`);
  }

  if (feedbackSection) parts.push(feedbackSection);

  if (previousResponses.length > 0) {
    parts.push('## What other personas have said (you may agree, disagree, or build on their points)\n\n');
    for (const prev of previousResponses) {
      parts.push(`**${prev.name}:** ${prev.response}\n\n`);
    }
  }

  if (otherDocsList.length > 0) {
    parts.push(`## Other Available Documents\n${otherDocsList.slice(0, 5).join('\n')}\n\n`);
  }

  if (selectedDocumentIds.length > 0) {
    const docTitles = documents.filter((d) => selectedDocumentIds.includes(d.document_id ?? '')).map((d) => d.title);
    parts.push(`📄 The user has tagged: ${docTitles.join(', ')}. Use the document content above.\n\n`);
  }

  parts.push('Be specific, accurate, and stay in character.');

  const langInstruction = getLanguageInstruction(responseLanguage);
  if (langInstruction) parts.push(`\n\n${langInstruction}`);

  return parts.join('');
}

export async function buildRoundtableContext(
  docClient: DynamoDBDocumentClient,
  projectsTable: string,
  feedbackTable: string,
  projectId: string,
  message: string,
  selectedPersonaIds: string[] = [],
  selectedDocumentIds: string[] = [],
  responseLanguage?: string,
): Promise<RoundtableContext> {
  if (!projectsTable) {
    throw new ConfigurationError('Projects table not configured');
  }

  const resp = await docClient.send(
    new QueryCommand({
      TableName: projectsTable,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `PROJECT#${projectId}` },
    }),
  );

  const rawItems = resp.Items ?? [];
  if (rawItems.length === 0) throw new NotFoundError('Project not found');

  const items = rawItems.map((raw) => projectItemSchema.parse(raw));
  const { project, personas, documents } = classifyItems(items);
  if (!project) throw new NotFoundError('Project metadata not found');

  // Resolve which personas participate — all selected ones
  const activePersonas = selectedPersonaIds.length > 0
    ? personas.filter((p) => selectedPersonaIds.includes(p.persona_id ?? ''))
    : personas;

  const { selectedContent, otherDocsList } = buildDocumentsContext(documents, selectedDocumentIds);

  const feedback = selectedDocumentIds.length === 0 && feedbackTable
    ? await fetchRecentFeedback(docClient, feedbackTable)
    : { count: 0, promptSection: '' };

  const projectName = project.name ?? 'Project';

  // Build per-persona prompts (initial — no previous responses yet)
  const roundtablePersonas: RoundtablePersona[] = activePersonas.map((p) => ({
    persona_id: p.persona_id ?? '',
    name: p.name ?? 'Unknown',
    avatar_url: resolveAvatarUrl(p.avatar_url),
    systemPrompt: buildSinglePersonaPrompt(
      projectName, p, selectedContent, otherDocsList,
      feedback.promptSection, selectedDocumentIds, documents, [], responseLanguage,
    ),
  }));

  const metadata = {
    roundtable: true,
    persona_count: activePersonas.length,
    referenced_documents: documents.filter((d) => selectedDocumentIds.includes(d.document_id ?? '')).map((d) => d.title),
    context: { feedback_count: feedback.count, persona_count: personas.length, document_count: documents.length },
  };

  return { personas: roundtablePersonas, userMessage: message, metadata, selectedDocumentIds, documents };
}
