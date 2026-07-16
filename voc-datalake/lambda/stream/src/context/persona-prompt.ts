/**
 * Roundtable persona prompt building, split out of project-context.ts to keep
 * that module inside its size budget. The type-only import back into
 * project-context is erased at compile time, so there is no runtime cycle.
 */
import type { ProjectItem } from './project-context.js';

export function getLanguageInstruction(lang?: string): string {
  if (!lang || lang === 'en') return '';
  const names: Record<string, string> = {
    es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese',
    ja: 'Japanese', zh: 'Chinese', ko: 'Korean', it: 'Italian',
  };
  const name = names[lang] ?? lang;
  return `IMPORTANT: You MUST respond entirely in ${name} (${lang}). All text, headings, labels, and explanations must be in ${name}.`;
}

/** The persona's identity block: who they are, what drives them, how to speak. */
function personaIdentitySection(projectName: string, persona: ProjectItem): string {
  const bullets = (values: string[] | undefined): string =>
    (values ?? []).slice(0, 4).map((value) => `- ${value}`).join('\n');

  return [
    `You are "${persona.name}" — a customer persona in the project "${projectName}".\n`,
    `Your tagline: "${persona.tagline ?? ''}"\n`,
    `Your voice: "${persona.quote ?? ''}"\n\n`,
    `**Your Goals:**\n${bullets(persona.goals)}\n\n`,
    `**Your Frustrations:**\n${bullets(persona.frustrations)}\n\n`,
    `**Your Needs:**\n${bullets(persona.needs)}\n\n`,
    'Respond in first person AS this persona. Use "I think...", "As someone who...", etc. Be concise — keep your response to 2-4 paragraphs.\n',
    'You are in a roundtable discussion with other customer personas. Speak naturally, share your honest opinion, and don\'t hold back. If you disagree with someone, say so directly.\n\n',
  ].join('');
}

export function buildSinglePersonaPrompt(
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
  const parts: string[] = [personaIdentitySection(projectName, persona)];

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
