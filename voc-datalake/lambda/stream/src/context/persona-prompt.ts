/**
 * Roundtable persona prompt building, split out of project-context.ts to keep
 * that module inside its size budget. The type-only import back into
 * project-context is erased at compile time, so there is no runtime cycle.
 *
 * `getLanguageInstruction` lives in ./language.js; consumers import it from there
 * directly rather than through a re-export here.
 */
import type { ProjectItem } from './project-context.js';
import {
  bulletList,
  personaFrustrations,
  personaGoals,
  personaNeeds,
  personaVoice,
} from './persona-fields.js';
import { getLanguageInstruction } from './language.js';
import type { SupportedLanguage } from './language.js';

/** The persona's identity block: who they are, what drives them, how to speak.
 *
 * 🔴 This was the worst instance of the phantom-key defect: it reads
 * `persona.goals` / `.frustrations` / `.needs` / `.quote`, none of which any
 * writer produces, so the model was instructed to BE a persona and then handed an
 * empty identity — "**Your Goals:**" with nothing under it. It answered anyway,
 * inventing a character. Field paths now come from persona-fields.js.
 */
function personaIdentitySection(projectName: string, persona: ProjectItem): string {
  const parts = [
    `You are "${persona.name}" — a customer persona in the project "${projectName}".\n`,
  ];
  if (persona.tagline) parts.push(`Your tagline: "${persona.tagline}"\n`);

  // Each block is omitted when empty rather than rendered as a bare header: an
  // empty "**Your Goals:**" tells the persona it wants nothing, which is worse
  // than saying nothing about goals at all.
  const voice = personaVoice(persona);
  if (voice) parts.push(`Your voice: "${voice}"\n`);

  const goals = personaGoals(persona);
  if (goals.length) parts.push(`\n**Your Goals:**\n${bulletList(goals)}\n`);

  const frustrations = personaFrustrations(persona);
  if (frustrations.length) parts.push(`\n**Your Frustrations:**\n${bulletList(frustrations)}\n`);

  const needs = personaNeeds(persona);
  if (needs.length) parts.push(`\n**What You Need:**\n${bulletList(needs)}\n`);

  parts.push(
    '\nRespond in first person AS this persona. Use "I think...", "As someone who...", etc. Be concise — keep your response to 2-4 paragraphs.\n',
    'You are in a roundtable discussion with other customer personas. Speak naturally, share your honest opinion, and don\'t hold back. If you disagree with someone, say so directly.\n\n',
  );
  return parts.join('');
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
  responseLanguage?: SupportedLanguage,
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
