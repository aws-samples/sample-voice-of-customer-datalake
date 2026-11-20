// The AI draft routes for the dev mock (7.55.00), as the settings API answers them: POST /settings/form-drafts
// {description, language, channel, base_form?, instruction?, retired_ids?} → 202 {success, job_id, status: 'pending'}, and
// GET /settings/form-drafts/{job_id} → {success, job_id, job_type, status, …, error, result} (shared/assist_jobs.py
// `view`), whose result is {success: true, form, notes, warnings} or a refusal {success: false, code: 'invalid_draft'
// | 'no_model', error, errors?} (contract "Describe it, and the AI builds the form"). It never saves. A mock job ends
// at once (the first poll finds it completed). A marker in the description or the instruction answers one of the
// refusals the builder words (UX §12.4):
//   at the start:  #rate → 429 rate_limited, retry_after 120   #role → 403   #spend → 429 spend_cap
//                  #aimode → 403 ai_mode (neither of these two is sent by today's API: no workspace spend cap,
//                  and D12 keeps the way of working from gating a draft; the builder still words them)
//   in the job:    #422 → invalid_draft with the validator's errors   #nomodel → no_model   #500 → the job failed
//   #slow: the job stays running for SLOW_DRAFT_MS before it completes, so Stop meets a draft still being written
//   (e2e/tests/feedback-forms-v2.spec.ts)
// Without a base form it drafts a small reasons form with an https ending button (so the address confirm shows);
// with one ("Improve with AI") it adds a follow-up question, routes the first option to it and adds a button.

import { randomBytes } from 'node:crypto';

const LANGUAGES = ['en', 'es', 'fr', 'de', 'pt', 'ja', 'zh', 'ko', 'pl'];
const CHANNELS = ['link', 'embed', 'in_app'];
const DESCRIPTION_MAX = 2000;
const fail = (status, error, extra = {}) => [status, { success: false, error, ...extra }];

const START_REFUSALS = [
  ['#rate', () => fail(429, 'At most 20 AI drafts an hour: try again later', { code: 'rate_limited', retry_after: 120 })],
  ['#spend', () => fail(429, "This workspace's AI budget for the month is used up.", { code: 'spend_cap' })],
  ['#aimode', () => fail(403, 'Your way of working keeps AI from writing forms.', { code: 'ai_mode' })],
  ['#role', () => fail(403, 'Managing feedback forms needs the editor or admin role in this workspace', { code: 'role' })],
];
const JOB_REFUSALS = [
  ['#422', () => ({ result: { success: false, code: 'invalid_draft', error: "The AI couldn't turn this into a valid form.",
    errors: ['questions[3].options must hold 1 to 50 options', 'questions[0].logic[1].then.jump_to names q_missing, which does not exist'] } })],
  ['#nomodel', () => ({ result: { success: false, code: 'no_model', error: 'No AI model is available to this deployment.' } })],
  ['#500', () => ({ failed: 'The form draft could not be made; try again.' })],
];
const JOB_TYPE = 'assist_form_draft';
/** The mock's draft jobs, by id (a job is read by its starter only in the real API; the mock has one user). */
const jobs = new Map();
/** How long a `#slow` draft stays running. */
const SLOW_DRAFT_MS = 20_000;

// The draft's words in Polish and English; other languages get the English text under their own key.
const WORDS = {
  pl: {
    name: 'Formularz z opisu', why: 'Co sprawiło, że wracasz do starego interfejsu?', other: 'Coś innego',
    reasons: ['Nie mogę znaleźć tego, czego potrzebuję', 'Praca zajmuje mi więcej czasu', 'Brakuje funkcji, z której korzystam', 'Coś nie działa'],
    which: 'Której funkcji brakuje?', comment: 'Czy chcesz przekazać zespołowi coś jeszcze?', thanks: 'Dziękujemy', help: 'Pomoc',
    followUp: 'Jaka cena byłaby dla Ciebie uczciwa?',
  },
  en: {
    name: 'Form from a description', why: 'What made you switch back to the old interface?', other: 'Something else',
    reasons: ["I can't find what I need", 'My work takes longer', 'A function I use is missing', "Something doesn't work"],
    which: 'Which function is missing?', comment: 'Anything else the team should know?', thanks: 'Thank you', help: 'Help centre',
    followUp: 'What price would feel fair to you?',
  },
};
const CODES = ['cant_find', 'slower_work', 'missing_function', 'errors'];

const NAME_WORDS = 6;
const NAME_CHARS = 48;
/** What a cut leaves at the end that a name does not end with. */
const NAME_TRAILING = new Set([',', ';', ':', '–', '-']);

/**
 * A short name from the description, as the model is asked for one: its first sentence, at most six whole words
 * and 48 characters, without the trailing comma or stop (never a word cut in two: "…with predef").
 */
function shortName(description) {
  const sentence = description.trim().split(/\n|[.!?](?:\s|$)/u)[0] ?? '';
  let name = '';
  for (const word of sentence.split(/\s+/u).filter(Boolean).slice(0, NAME_WORDS)) {
    const next = name === '' ? word : `${name} ${word}`;
    if (next.length > NAME_CHARS) break;
    name = next;
  }
  let end = name.length;
  while (end > 0 && NAME_TRAILING.has(name[end - 1])) end -= 1;
  return name.slice(0, end);
}

function draftForm(language, channel, description) {
  const words = WORDS[language] ?? WORDS.en;
  const t = (text) => ({ [language]: text });
  const name = shortName(description) || words.name;
  return {
    schema_version: 2, name, enabled: false, language, languages: [language],
    welcome: channel === 'link' ? { enabled: true, title: t(words.name), button_label: t('OK') } : { enabled: false, title: {} },
    questions: [
      {
        id: 'q_why', type: 'multi_select', required: true, headline: t(words.why), display: 'list', shuffle: 'all', max: 3,
        options: CODES.map((code, index) => ({ code, label: t(words.reasons[index]) })),
        other: { enabled: true, label: t(words.other) }, none: { enabled: false },
        logic: [
          { when: { op: 'includes_any', value: ['missing_function'] }, then: { jump_to: 'q_which' } },
          { when: { op: 'submitted' }, then: { jump_to: 'q_comment' } },
        ],
      },
      { id: 'q_which', type: 'open_text', required: true, long: false, input_type: 'text', headline: t(words.which), max_chars: 300 },
      { id: 'q_comment', type: 'open_text', required: false, long: true, input_type: 'text', headline: t(words.comment) },
    ],
    hidden_fields: channel === 'in_app' ? [{ id: 'user_id' }, { id: 'app_version' }] : [],
    endings: [{ id: 'end_thanks', title: t(words.thanks), button: { label: t(words.help), url: 'https://example.com/help' } }],
    settings: { test: { link_enabled: false, record: 'tag' } },
  };
}

/** The follow-up's id: `q_ai_follow_up`, else the first `_<n>` of it that neither the form nor a removed question has
 * (7.58.01: as the server's id maker reserves the request's `retired_ids`). */
function followUpId(form, retired) {
  const taken = new Set([...(Array.isArray(retired) ? retired : []), ...form.questions.map((question) => question.id)]);
  let id = 'q_ai_follow_up';
  let n = 2;
  while (taken.has(id)) {
    id = `q_ai_follow_up_${n}`;
    n += 1;
  }
  return id;
}

/** "Improve with AI": the base form with a follow-up after its first question, routed from its first option. */
function improvedForm(base, language, retired) {
  const words = WORDS[language] ?? WORDS.en;
  const form = JSON.parse(JSON.stringify(base));
  const [first, ...rest] = Array.isArray(form.questions) ? form.questions : [];
  if (first === undefined) return form;
  const id = followUpId(form, retired);
  const followUp = { id, type: 'open_text', required: false, long: false, input_type: 'text', headline: { [form.language ?? language]: words.followUp } };
  const code = first.options?.[0]?.code;
  const rule = code === undefined ? null : { when: { op: first.type === 'multi_select' ? 'includes_any' : 'equals', value: first.type === 'multi_select' ? [code] : code }, then: { jump_to: id } };
  const routed = rule === null ? first : { ...first, logic: [rule, ...(first.logic ?? [])] };
  form.questions = [routed, followUp, ...rest];
  const [ending, ...endings] = Array.isArray(form.endings) ? form.endings : [];
  if (ending !== undefined) form.endings = [{ ...ending, button: { label: { [form.language ?? language]: words.help }, url: 'https://example.com/help' } }, ...endings];
  return form;
}

/** The draft a job ends with: the form and the model's notes, or a refusal / a failure a marker asks for. */
function draftOutcome(body, description, instruction) {
  const refusal = JOB_REFUSALS.find(([marker]) => description.includes(marker) || instruction.includes(marker));
  if (refusal) return refusal[1]();
  const language = LANGUAGES.includes(body.language) ? body.language : 'en';
  const channel = CHANNELS.includes(body.channel) ? body.channel : 'link';
  const base = body.base_form !== null && typeof body.base_form === 'object' ? body.base_form : null;
  const form = base === null ? draftForm(language, channel, description) : improvedForm(base, language, body.retired_ids);
  return { result: {
    success: true,
    form,
    notes: base === null
      ? ['The reasons are shuffled for each respondent; "Something else" stays last.']
      : [{ message: 'I added a follow-up and routed the first option to it.', target: form.questions?.[1]?.id ?? 'q_ai_follow_up' }],
    warnings: [{ message: 'An ending button pointed to an http:// address and was replaced: only https is allowed.', target: 'end_thanks' }],
  } };
}

/** The answer to POST /settings/form-drafts: [status, payload]; a started job is a 202 with its id. */
export function draftAnswer(body) {
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  const refusal = START_REFUSALS.find(([marker]) => description.includes(marker) || instruction.includes(marker));
  if (refusal) return refusal[1]();
  if (description.length > DESCRIPTION_MAX) return fail(400, `description must be at most ${DESCRIPTION_MAX} characters`);
  if (body.language !== undefined && !LANGUAGES.includes(body.language)) return fail(400, `language must be one of: ${LANGUAGES.join(', ')}`);
  if (body.channel !== undefined && !CHANNELS.includes(body.channel)) return fail(400, `channel must be one of: ${CHANNELS.join(', ')}`);
  if (instruction !== '' && (body.base_form === null || typeof body.base_form !== 'object')) return fail(400, 'an instruction needs the base_form it applies to');
  if (description === '' && instruction === '') return fail(400, 'Describe your form first', { code: 'description_required' });
  const jobId = `job_${randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();
  const outcome = draftOutcome(body, description, instruction);
  jobs.set(jobId, {
    job_id: jobId, job_type: JOB_TYPE, status: outcome.failed ? 'failed' : 'completed', created_at: now, updated_at: now,
    completed_at: now, error: outcome.failed ?? null, result: outcome.result ?? null,
    ...(description.includes('#slow') ? { readyAt: Date.now() + SLOW_DRAFT_MS } : {}),
  });
  return [202, { success: true, job_id: jobId, status: 'pending' }];
}

/** The answer to GET /settings/form-drafts/{job_id}: [status, payload]. */
export function draftJob(jobId) {
  const job = jobs.get(jobId);
  if (job === undefined) return fail(404, 'Job not found');
  const { readyAt, ...view } = job;
  if (readyAt !== undefined && Date.now() < readyAt) {
    return [200, { success: true, ...view, status: 'running', completed_at: null, error: null, result: null }];
  }
  return [200, { success: true, ...view }];
}
