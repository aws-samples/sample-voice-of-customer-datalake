// Forms v2 seed records for the dev mock (7.55.00): the forms the builder opens, and their responses.
//
// - fv2_old_ui: the pilot's Polish "Powrót do starego interfejsu" (the old_ui template), Live, with an
//   incomplete English translation, three hidden fields, the test link on (Keep), real and test responses, and a
//   drop-off funnel in its results.
// - fv2_nps: an English NPS form (the nps template), Off, with a few responses on every path.
// - fv1_legacy: a v1 form whose language is '' (the visitor's browser): the builder migrates it (D15).
// - fv2_workshop: a workshop's feedback (7.61.00), Live: a matrix of its phases, recall of the `event` hidden field and
//   of an earlier rating, and a `customer` hidden field no link ever filled (the Results' and Share's link check).
// - fv2_event_a, fv2_event_b: two workshops made from the Events template (7.63.00, mock-forms-event-seeds.js), whose
//   Report compares them.
//
// Responses are made by a seeded generator, so every mock start serves the same ones.

import { EVENT_FORMS, eventResponses } from './mock-forms-event-seeds.js';

const DAY_MS = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();
const THEME = { primary_color: '#8e48ff', background_color: '#ffffff', text_color: '#19161d', border_radius: '8px' };

const pl = (text, en) => (en === undefined ? { pl: text } : { pl: text, en });
const en = (text) => ({ en: text });
const options = (pairs) => pairs.map(([code, label]) => ({ code, label }));

const OLD_UI = {
  form_id: 'fv2_old_ui', schema_version: 2, revision: 4, name: 'Powrót do starego interfejsu', enabled: true,
  language: 'pl', languages: ['pl', 'en'],
  welcome: { enabled: false, title: {} },
  questions: [
    {
      id: 'q_why', type: 'multi_select', required: true, display: 'list', shuffle: 'all', min: 1, max: 3,
      headline: pl('Co sprawiło, że wracasz do starego interfejsu?', 'What made you switch back to the old interface?'),
      options: options([
        ['cant_find', pl('Nie mogę znaleźć tego, czego potrzebuję', "I can't find what I need")],
        ['slower_work', pl('Praca zajmuje mi więcej czasu', 'My work takes longer')],
        ['missing_function', pl('Brakuje funkcji, z której korzystam', 'A function I use is missing')],
        ['errors', pl('Coś nie działa lub pojawia się błąd', "Something doesn't work or shows an error")],
        ['slow_loading', pl('Za wolno się ładuje', 'It loads too slowly')],
        ['layout', pl('Układ ekranu jest nieczytelny')],
        ['prefer_known', pl('Wolę znany mi układ i nie mam czasu na naukę')],
      ]),
      other: { enabled: true, label: pl('Coś innego', 'Something else'), placeholder: pl('Napisz, co', 'Tell us what') },
      none: { enabled: false },
      logic: [
        { when: { op: 'includes_any', value: ['missing_function'] }, then: { jump_to: 'q_missing_function' } },
        { when: { op: 'submitted' }, then: { jump_to: 'q_task' } },
      ],
    },
    {
      id: 'q_missing_function', type: 'open_text', required: true, long: false, input_type: 'text', max_chars: 300,
      headline: pl('Której funkcji brakuje?', 'Which function is missing?'),
      subheader: pl('Gdzie korzystasz z niej w starym interfejsie?'),
      placeholder: pl('np. zbiorcze księgowanie faktur w module Sprzedaż'),
    },
    {
      id: 'q_task', type: 'open_text', required: false, long: false, input_type: 'text',
      headline: pl('Jakie zadanie teraz wykonujesz?', 'Which task are you working on right now?'),
      placeholder: pl('np. raport stanów magazynowych', 'e.g. a stock report'),
    },
    {
      id: 'q_return', type: 'single_select', required: true, display: 'list', shuffle: 'none',
      headline: pl('Czy wrócisz jeszcze do nowego interfejsu?', 'Will you try the new interface again?'),
      options: options([
        ['yes_soon', pl('Tak, wkrótce', 'Yes, soon')],
        ['when_fixed', pl('Tak, gdy to, o czym piszę, zostanie poprawione', 'Yes, once what I mentioned is fixed')],
        ['not_sure', pl('Nie wiem', "I'm not sure")],
        ['no', pl('Nie, zostanę przy starym', "No, I'll stay with the old one")],
      ]),
      other: { enabled: false }, none: { enabled: false },
    },
    {
      id: 'q_comment', type: 'open_text', required: false, long: true, input_type: 'text',
      headline: pl('Czy chcesz przekazać zespołowi coś jeszcze?', 'Anything else the team should know?'),
      placeholder: pl('Twój komentarz', 'Your comment'),
    },
  ],
  hidden_fields: [
    { id: 'user_id', label: 'Użytkownik' }, { id: 'app_version', label: 'Wersja aplikacji' },
    { id: 'screen', label: 'Ekran, na którym nastąpił powrót' },
  ],
  endings: [{
    id: 'end_thanks', title: pl('Dziękujemy', 'Thank you'),
    description: pl('Twoje odpowiedzi trafią bezpośrednio do zespołu, który pracuje nad nowym interfejsem.'),
  }],
  settings: { test: { link_enabled: true, record: 'tag' } },
  theme: { ...THEME }, category: 'ux', subcategory: '', project_id: '', document_id: '', custom_fields: [],
  dimension_defaults: {}, tags: ['pilot'], form_type: 'standard',
  test_token: 'tk_mock_old_ui_7f3a', updated_by: 'ana@example.com',
  created_at: daysAgo(20), updated_at: daysAgo(2), funnel: true,
};

const NPS = {
  form_id: 'fv2_nps', schema_version: 2, revision: 1, name: 'Mobile app NPS', enabled: false,
  language: 'en', languages: ['en'],
  welcome: { enabled: false, title: {} },
  questions: [
    {
      id: 'q_nps', type: 'nps', required: true, headline: en('How likely are you to recommend us to a friend or colleague?'),
      lower_label: en('Not at all likely'), upper_label: en('Extremely likely'),
      logic: [
        { when: { op: 'lte', value: 6 }, then: { jump_to: 'q_detractor_reason' } },
        { when: { op: 'gte', value: 9 }, then: { jump_to: 'q_promoter_value' } },
      ],
    },
    {
      id: 'q_passive_improve', type: 'open_text', required: false, long: true, input_type: 'text',
      headline: en('What would make you more likely to recommend us?'), placeholder: en('Your answer'),
      logic: [
        { when: { op: 'submitted' }, then: { jump_to: 'q_follow_up_ok' } },
        { when: { op: 'skipped' }, then: { jump_to: 'q_follow_up_ok' } },
      ],
    },
    {
      id: 'q_detractor_reason', type: 'single_select', required: true, display: 'list', shuffle: 'all',
      headline: en("What's the main reason for your score?"),
      options: options([
        ['price', en("It's too expensive")], ['missing_features', en("It's missing features I need")],
        ['hard_to_use', en("It's hard to use")], ['reliability', en('It has bugs or downtime')],
        ['support', en("Support didn't solve my problem")],
      ]),
      other: { enabled: true, label: en('Something else'), placeholder: en('Tell us what') }, none: { enabled: false },
    },
    {
      id: 'q_detractor_fix', type: 'open_text', required: false, long: true, input_type: 'text',
      headline: en('What should we fix first?'), placeholder: en('Your answer'),
      logic: [
        { when: { op: 'submitted' }, then: { jump_to: 'q_follow_up_ok' } },
        { when: { op: 'skipped' }, then: { jump_to: 'q_follow_up_ok' } },
      ],
    },
    {
      id: 'q_promoter_value', type: 'multi_select', required: true, display: 'list', shuffle: 'none', max: 2,
      headline: en('What do you value most?'),
      options: options([
        ['ease', en("It's easy to use")], ['features', en('The features')], ['reliability', en("It's reliable")],
        ['support', en('The support team')], ['value', en('Good value for money')],
      ]),
      other: { enabled: true, label: en('Something else') }, none: { enabled: false },
    },
    {
      id: 'q_follow_up_ok', type: 'consent', required: false, headline: en('Can we follow up on your answers?'),
      label: en('Yes, you may contact me about my feedback.'),
      logic: [{ when: { op: 'equals', value: false }, then: { jump_to: 'end_thanks' } }],
    },
    {
      id: 'q_contact', type: 'contact_info', required: true, headline: en('Where can we reach you?'),
      fields: { name: { show: true, required: false }, email: { show: true, required: true }, phone: { show: false, required: false }, company: { show: false, required: false } },
      logic: [{ when: { op: 'submitted' }, then: { jump_to: 'end_contact' } }],
    },
  ],
  hidden_fields: [{ id: 'user_id' }, { id: 'plan' }],
  endings: [
    { id: 'end_thanks', title: en('Thank you!'), description: en('Your feedback helps us decide what to improve next.') },
    { id: 'end_contact', title: en('Thank you, we may be in touch'), description: en('If we have questions about your answers, someone from our team will email you.') },
  ],
  settings: { test: { link_enabled: false, record: 'tag' } },
  theme: { ...THEME }, category: '', subcategory: '', project_id: '', document_id: '', custom_fields: [],
  dimension_defaults: {}, tags: [], form_type: 'standard',
  test_token: 'tk_mock_nps_19c2', updated_by: 'admin@example.com', created_at: daysAgo(9), updated_at: daysAgo(9),
};

const LEGACY = {
  form_id: 'fv1_legacy', name: 'Feedback po wdrożeniu (v1)', enabled: true,
  title: 'Jak oceniasz wdrożenie?', description: 'Twoja opinia pomoże nam w kolejnych wdrożeniach.',
  question: 'Jak oceniasz wdrożenie?', text_question: '', language: '',
  placeholder: 'Napisz, co działało, a co nie…', rating_enabled: true, rating_type: 'stars', rating_max: 5,
  submit_button_text: 'Wyślij', success_message: 'Dziękujemy za opinię!', theme: { ...THEME },
  collect_email: true, collect_name: false, custom_fields: [], category: '', subcategory: '',
  project_id: '', document_id: '', created_at: daysAgo(60), updated_at: daysAgo(30),
};

const WORKSHOP = {
  form_id: 'fv2_workshop', schema_version: 2, revision: 2, name: 'Workshop feedback', enabled: true,
  language: 'en', languages: ['en'],
  welcome: { enabled: true, title: en('How was {{event|the workshop}}?'), description: en('Four questions, about two minutes.') },
  questions: [
    {
      id: 'q_phases', type: 'matrix', required: true, shuffle_rows: false, display: 'auto',
      headline: en('How effective was each part of {{event|the workshop}}?'),
      rows: options([['intro', en('Introduction')], ['demo', en('Live demo')], ['lab', en('Hands-on lab')], ['qa', en('Questions and answers')]]),
      columns: [
        { code: 'needs_improvement', label: en('Needs improvement'), score: 1 }, { code: 'satisfactory', label: en('Satisfactory'), score: 2 },
        { code: 'very_effective', label: en('Very effective'), score: 3 }, { code: 'exceptional', label: en('Exceptional'), score: 4 },
      ],
    },
    { id: 'q_overall', type: 'rating', required: true, scale: 'star', range: 5, headline: en('Overall, how would you rate it?') },
    {
      id: 'q_change', type: 'open_text', required: false, long: true, input_type: 'text',
      headline: en('You rated it {{q_overall}} of 5. What should we change before the next one?'), placeholder: en('Your answer'),
    },
  ],
  hidden_fields: [{ id: 'event', label: 'Event' }, { id: 'customer', label: 'Customer' }],
  endings: [{ id: 'end_thanks', title: en('Thanks for joining {{event|us}}!'), description: en('We read every answer before the next session.') }],
  settings: { test: { link_enabled: false, record: 'tag' } },
  theme: { ...THEME }, category: '', subcategory: '', project_id: '', document_id: '', custom_fields: [],
  dimension_defaults: {}, tags: ['workshop', 'q4'], form_type: 'standard',
  test_token: 'tk_mock_workshop_51d0', updated_by: 'ana@example.com', created_at: daysAgo(6), updated_at: daysAgo(5),
};

export const SEED_FORMS = [OLD_UI, NPS, LEGACY, WORKSHOP, ...EVENT_FORMS];

/** A small seeded generator (mulberry32), so the responses are the same on every start. */
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MISSING = ['zbiorcze księgowanie faktur', 'eksport do Excela z listy dokumentów', 'filtr po kontrahencie', 'skróty klawiszowe w module Sprzedaż'];
const TASKS = ['raport stanów magazynowych', 'wystawianie faktury', 'zamknięcie miesiąca', ''];
const COMMENTS = ['Nowy wygląd jest ładny, ale wolniejszy.', 'Proszę o tryb kompaktowy.', 'drukowanie etykiet nie działa'];
const SCREENS = ['invoices', 'stock', 'orders'];
const SENTIMENTS = ['negative', 'neutral', 'positive', null];

function oldUiResponse(random, index, isTest) {
  const pickOf = (list) => list[Math.floor(random() * list.length)];
  const codes = [...new Set([pickOf(OLD_UI.questions[0].options).code, ...(random() < 0.5 ? [pickOf(OLD_UI.questions[0].options).code] : [])])];
  const other = random() < 0.12 ? { other: 'drukowanie etykiet' } : {};
  const missing = codes.includes('missing_function');
  const answers = { q_why: { codes, ...other } };
  if (missing) answers.q_missing_function = pickOf(MISSING);
  const task = pickOf(TASKS);
  if (task !== '') answers.q_task = task;
  answers.q_return = { code: pickOf(OLD_UI.questions[3].options).code };
  if (random() < 0.3) answers.q_comment = pickOf(COMMENTS);
  const shown = ['q_why', ...(missing ? ['q_missing_function'] : []), 'q_task', 'q_return', 'q_comment'];
  const screen = isTest && index % 3 === 0 ? '' : pickOf(SCREENS);
  return {
    response_id: `resp_old_${String(index).padStart(3, '0')}`, submitted_at: daysAgo(index * 0.37 + random() * 0.2),
    form_revision: index < 10 ? 4 : 3, language: random() < 0.85 ? 'pl' : 'en', answers,
    hidden: { user_id: isTest ? 'qa-17' : `u_${String(1800 + index)}`, app_version: isTest ? '5.0.3' : pickOf(['5.0.1', '5.0.2', '5.0.3']), screen },
    ending_id: 'end_thanks', is_test: isTest, shown, sentiment: pickOf(SENTIMENTS),
    feedback_id: isTest ? undefined : `fb_old_${String(index)}`,
    // (where it was answered: mostly the in-app script, some by the link, a few in the help centre's iframe)
    channel: ['script', 'script', 'link', 'iframe'][index % 4],
  };
}

function npsPath(score) {
  if (score <= 6) return 'detractor';
  return score >= 9 ? 'promoter' : 'passive';
}

function npsResponse(random, index) {
  const score = Math.floor(random() * 11);
  const path = npsPath(score);
  const answers = { q_nps: score };
  const shown = ['q_nps'];
  if (path === 'detractor') {
    answers.q_detractor_reason = { code: ['price', 'hard_to_use', 'reliability'][index % 3] };
    if (random() < 0.6) answers.q_detractor_fix = 'Make sync faster on mobile.';
    shown.push('q_detractor_reason', 'q_detractor_fix');
  } else if (path === 'promoter') {
    answers.q_promoter_value = { codes: ['ease', 'reliability'].slice(0, 1 + (index % 2)) };
    shown.push('q_promoter_value');
  } else {
    if (random() < 0.5) answers.q_passive_improve = 'Offline mode would help.';
    shown.push('q_passive_improve');
  }
  const accepted = random() < 0.4;
  answers.q_follow_up_ok = accepted;
  shown.push('q_follow_up_ok');
  if (accepted) {
    answers.q_contact = { email: `person${String(index)}@example.com` };
    shown.push('q_contact');
  }
  return {
    response_id: `resp_nps_${String(index).padStart(3, '0')}`, submitted_at: daysAgo(10 - index * 0.6),
    form_revision: 1, language: 'en', answers, hidden: { user_id: `u_${String(4200 + index)}`, plan: index % 2 ? 'pro' : 'free' },
    ending_id: accepted ? 'end_contact' : 'end_thanks', is_test: false, shown, sentiment: null,
    feedback_id: `fb_nps_${String(index)}`,
    channel: index % 3 === 0 ? 'link' : 'script',
  };
}

const PHASES = ['intro', 'demo', 'lab', 'qa'];
const SCALE = ['needs_improvement', 'satisfactory', 'very_effective', 'exceptional'];
const CHANGES = ['More time for the lab, please.', 'Share the slides before the session.', '', 'A shorter introduction.'];

/** A workshop response: every phase rated, the event from the link but for the embedded page's (it drops it). */
function workshopResponse(random, index) {
  const pickOf = (list) => list[Math.floor(random() * list.length)];
  const rows = Object.fromEntries(PHASES.map((phase) => [phase, SCALE[Math.min(3, Math.floor(random() * 3) + (phase === 'lab' ? 1 : 0))]]));
  const answers = { q_phases: { rows }, q_overall: 3 + Math.floor(random() * 3) };
  const change = pickOf(CHANGES);
  if (change !== '') answers.q_change = change;
  const channel = index % 3 === 2 ? 'iframe' : 'link';
  return {
    response_id: `resp_ws_${String(index).padStart(3, '0')}`, submitted_at: daysAgo(5 - index * 0.15), form_revision: 2,
    language: 'en', answers, hidden: channel === 'link' ? { event: index % 2 ? 'Lisbon workshop' : 'Madrid workshop' } : {},
    ending_id: 'end_thanks', is_test: false, shown: ['q_phases', 'q_overall', 'q_change'], sentiment: null,
    feedback_id: `fb_ws_${String(index)}`, channel,
  };
}

/** Every seed form's stored responses, newest first. */
export function seedResponses() {
  const oldRandom = generator(755);
  const npsRandom = generator(9);
  const old = Array.from({ length: 46 }, (_unused, index) => oldUiResponse(oldRandom, index, index % 8 === 1));
  const nps = Array.from({ length: 14 }, (_unused, index) => npsResponse(npsRandom, index));
  const workshopRandom = generator(761);
  const workshop = Array.from({ length: 26 }, (_unused, index) => workshopResponse(workshopRandom, index));
  return new Map([['fv2_old_ui', old], ['fv2_nps', nps], ['fv2_workshop', workshop], ...eventResponses(generator)]);
}

/** The seed forms' list stats (real responses only, as the list's card figures count them). */
export function seedStats() {
  const responses = seedResponses();
  const real = (formId) => (responses.get(formId) ?? []).filter((row) => !row.is_test).length;
  return {
    fv2_old_ui: { total_submissions: real('fv2_old_ui'), avg_rating: null, rating_count: 0 },
    fv2_nps: { total_submissions: real('fv2_nps'), avg_rating: null, rating_count: 0 },
    fv2_workshop: { total_submissions: real('fv2_workshop'), avg_rating: null, rating_count: 0 },
    fv2_event_a: { total_submissions: real('fv2_event_a'), avg_rating: null, rating_count: 0 },
    fv2_event_b: { total_submissions: real('fv2_event_b'), avg_rating: null, rating_count: 0 },
    fv1_legacy: { total_submissions: 12, avg_rating: 4.1, rating_count: 12 },
  };
}
