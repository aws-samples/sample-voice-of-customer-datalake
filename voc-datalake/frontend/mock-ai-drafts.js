/**
 * Dev-mock answers for the document wizard's two AI drafts, with the real routes' wire shape
 * (`lambda/shared/draft_intent.py`): the typed title (`title`, ≤ 200), description
 * (`feature_idea`, ≤ 4000) and answers (`answers`, ≤ 5 × ≤ 4000) are validated (400
 * `{success: false, error}`) and kept as the author's intent — improved, never replaced.
 * Empty fields are drafted from canned feedback, as the model does from the project's.
 */

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;
const ANSWER_MAX = 4000;
const ANSWER_COUNT = 5;

const refused = (error) => [400, { success: false, error }];

/** The stripped text, '' for absent/null, or a refusal message. */
function typedText(value, label, cap) {
  if (value === undefined || value === null) return { text: '' };
  if (typeof value !== 'string') return { error: `${label} must be text` };
  if (value.length > cap) return { error: `${label} is too long (at most ${cap} characters)` };
  return { text: value.trim() };
}

function typedBrief(body) {
  const title = typedText(body.title, 'Title', TITLE_MAX);
  if (title.error) return title;
  const description = typedText(body.feature_idea, 'Description', DESCRIPTION_MAX);
  if (description.error) return description;
  if (body.filters !== undefined && body.filters !== null
    && (typeof body.filters !== 'object' || Array.isArray(body.filters))) {
    return { error: 'filters must be an object' };
  }
  return { title: title.text, description: description.text };
}

function typedAnswers(raw) {
  if (raw === undefined || raw === null) return { answers: Array(ANSWER_COUNT).fill('') };
  if (!Array.isArray(raw) || raw.length > ANSWER_COUNT) {
    return { error: `answers must be a list of at most ${ANSWER_COUNT} texts` };
  }
  const answers = [];
  for (const [index, value] of raw.entries()) {
    const answer = typedText(value, `Answer ${index + 1}`, ANSWER_MAX);
    if (answer.error) return answer;
    answers.push(answer.text);
  }
  return { answers: [...answers, ...Array(ANSWER_COUNT - answers.length).fill('')] };
}

const DRAFTED_TITLE = 'Proactive Delay Alerts';
const DRAFTED_DESCRIPTION = 'Notify customers the moment a delivery estimate changes, with the reason and the new date.';
const GROUNDING = 'Feedback shows silent estimate changes drive most negative delivery reviews.';

/** The author's title kept; else one named from their description; else a fresh draft. */
function briefTitle(brief) {
  if (brief.title) return brief.title;
  if (brief.description) return brief.description.split(/[.!?]/)[0].slice(0, 60);
  return DRAFTED_TITLE;
}

/** The author's description expanded; else one written for their title; else a fresh draft. */
function briefDescription(brief, label) {
  if (brief.description) {
    const own = /[.!?]$/.test(brief.description) ? brief.description : `${brief.description}.`;
    return `${own} ${GROUNDING} Customers want to know early, so they can re-plan their day.`;
  }
  const lead = brief.title ? `${brief.title}: ` : '';
  return `${lead}${DRAFTED_DESCRIPTION} ${GROUNDING} Drafted for a ${label}.`;
}

/** POST /projects/{id}/documents/suggest-brief → its job `result` `{title, feature_idea}`. */
export function suggestDocumentBrief(ctx) {
  const brief = typedBrief(ctx.body);
  if (brief.error) return refused(brief.error);
  const label = ctx.body.doc_type === 'prfaq' ? 'PR-FAQ' : 'PRD';
  return [200, { title: briefTitle(brief), feature_idea: briefDescription(brief, label) }];
}

const DRAFTED_ANSWERS = [
  'Frequent online shoppers who plan their day around deliveries.',
  'They learn about delays only after the promised date passes, so they cannot re-plan.',
  'They hear about a change the moment it happens, with an honest new date.',
  'Delivery-related reviews and support contacts repeatedly cite silent estimate changes.',
  'A short notice on their phone names the reason and the new date, and offers a new slot.',
];

/** POST /projects/{id}/prfaq-autofill → its job `result` `{answers}` (five texts). */
export function autofillPrfaq(ctx) {
  const brief = typedBrief(ctx.body);
  if (brief.error) return refused(brief.error);
  const typed = typedAnswers(ctx.body.answers);
  if (typed.error) return refused(typed.error);
  const feature = brief.title || 'this feature';
  const answers = typed.answers.map((own, index) => (own
    ? `${own} (expanded with what the feedback says about ${feature}.)`
    : `${DRAFTED_ANSWERS[index]} With ${feature}, this changes.`));
  return [200, { answers }];
}
