/**
 * Behavioural guards for the TypeScript persona reader, and for the roundtable
 * prompt that consumes it.
 *
 * The lockstep test on the Python side greps this file's field paths; that proves
 * the two runtimes agree, not that either one works. These are the assertions
 * that fail if the readers or the label-omission logic are reverted.
 *
 * Fixtures are the shapes of live rows. `pain_points` and `goals_motivations`
 * arrive as OPAQUE records from `projectItemSchema` on purpose — naming their
 * leaves would let one malformed persona throw and take down the whole
 * chat-context build — so the null and wrong-type cases below are the contract,
 * not defensive padding.
 */
import { describe, expect, it } from 'vitest';
import {
  bulletList,
  personaFrustrations,
  personaGoals,
  personaNeeds,
  personaVoice,
} from './persona-fields.js';
import { buildSinglePersonaPrompt } from './persona-prompt.js';
import type { ProjectItem } from './project-context.js';

const asPersona = (raw: Record<string, unknown>): ProjectItem =>
  raw as unknown as ProjectItem;

const GENERATED = asPersona({
  sk: 'PERSONA#p1',
  persona_id: 'p1',
  name: 'Priya Shah',
  tagline: 'The Habitual Skimmer',
  quotes: [{ text: 'I just want the headlines.', context: 'onboarding' }],
  goals_motivations: {
    primary_goal: 'Stay informed in ten minutes',
    secondary_goals: ['Follow local council news', 'Avoid clickbait'],
    underlying_motivations: ['Feel like a competent citizen'],
  },
  pain_points: {
    current_challenges: ['Alerts bury the real news'],
    blockers: ['Cannot mute a topic'],
    workarounds: ['Curated her notification categories'],
  },
});

// An imported row: inner keys this module never chose, no canonical sections.
const IMPORTED = asPersona({
  sk: 'PERSONA#p2',
  persona_id: 'p2',
  name: 'Priya Raman',
  tagline: 'Ops lead under audit pressure',
  quotes: [{ text: 'I cannot prove what changed.' }],
  goals_motivations: { primary_goal: 'Close the audit', motivations: ['Avoid fines'] },
  pain_points: { primary_frustration: 'No audit trail' },
});

describe('personaGoals', () => {
  it('returns the primary goal first, then the secondary goals', () => {
    expect(personaGoals(GENERATED)).toStrictEqual([
      'Stay informed in ten minutes',
      'Follow local council news',
      'Avoid clickbait',
    ]);
  });

  it('returns nothing for the phantom flat key, which no writer produces', () => {
    expect(personaGoals(asPersona({ goals: ['Save money'] }))).toStrictEqual([]);
  });

  it('respects the cap', () => {
    expect(personaGoals(GENERATED, 2)).toHaveLength(2);
  });
});

describe('personaFrustrations', () => {
  it('leads with current challenges and tops up with blockers', () => {
    expect(personaFrustrations(GENERATED)).toStrictEqual([
      'Alerts bury the real news',
      'Cannot mute a topic',
    ]);
  });

  it('does not top up past the cap', () => {
    expect(personaFrustrations(GENERATED, 1)).toStrictEqual(['Alerts bury the real news']);
  });

  it('returns nothing for the phantom flat key', () => {
    expect(personaFrustrations(asPersona({ frustrations: ['Hidden fees'] }))).toStrictEqual([]);
  });
});

describe('personaNeeds', () => {
  it('maps the absent `needs` concept onto motivations then workarounds', () => {
    expect(personaNeeds(GENERATED)).toStrictEqual([
      'Feel like a competent citizen',
      'Curated her notification categories',
    ]);
  });

  it('returns nothing for the phantom flat key', () => {
    expect(personaNeeds(asPersona({ needs: ['Transparent pricing'] }))).toStrictEqual([]);
  });
});

describe('personaVoice', () => {
  it('reads the quotes list', () => {
    expect(personaVoice(GENERATED)).toBe('I just want the headlines.');
  });

  it('tolerates a bare string entry, as the Python reader does', () => {
    expect(personaVoice(asPersona({ quotes: ['Straight to the point.'] })))
      .toBe('Straight to the point.');
  });

  it('returns nothing for the phantom singular `quote`', () => {
    expect(personaVoice(asPersona({ quote: 'I should not be read' }))).toBe('');
  });

  it('skips an entry whose text is null and takes the next usable one', () => {
    expect(personaVoice(asPersona({ quotes: [{ text: null }, { text: 'Second.' }] })))
      .toBe('Second.');
  });
});

describe('tolerance for shapes the boundary no longer validates', () => {
  // `projectItemSchema` declares these sections as opaque records precisely so a
  // malformed row cannot throw. That moves the burden here, so it is asserted here.
  it.each([
    ['a null section', { goals_motivations: null, pain_points: null, quotes: null }],
    ['a nulled leaf', { goals_motivations: { secondary_goals: null }, pain_points: { current_challenges: null } }],
    ['a section that is an array', { goals_motivations: [], pain_points: [] }],
    ['a section that is a string', { goals_motivations: 'nope', pain_points: 'nope' }],
    ['leaves holding objects instead of strings', {
      goals_motivations: { secondary_goals: [{ goal: 'x' }] },
      pain_points: { current_challenges: [{ pain: 'y' }] },
    }],
    ['a scalar where a list is expected', {
      goals_motivations: { secondary_goals: 'just one' },
      pain_points: { current_challenges: 'just one' },
    }],
  ])('does not throw on %s', (_label, raw) => {
    const persona = asPersona({ name: 'Odd', ...raw });
    expect(() => {
      personaGoals(persona);
      personaFrustrations(persona);
      personaNeeds(persona);
      personaVoice(persona);
    }).not.toThrow();
  });

  it('keeps a scalar in a list slot rather than dropping the content', () => {
    const persona = asPersona({ goals_motivations: { secondary_goals: 'just one' } });
    expect(personaGoals(persona)).toStrictEqual(['just one']);
  });

  it('reads a text-ish key off an object entry, matching the Python reader', () => {
    // The twins must agree about whether content survives, or the same persona
    // yields a goal in a PRD and silence in chat.
    const persona = asPersona({ goals_motivations: { secondary_goals: [
      { text: 'via text' }, { description: 'via description' }, 'plain',
    ] } });
    expect(personaGoals(persona)).toStrictEqual(['via text', 'via description', 'plain']);
  });

  it('drops an object entry holding no readable text rather than rendering it', () => {
    // `String({})` is "[object Object]", which is worse in a prompt than silence.
    const persona = asPersona({ goals_motivations: { secondary_goals: [{ weight: 2 }, 'real'] } });
    expect(personaGoals(persona)).toStrictEqual(['real']);
  });
});

describe('bulletList', () => {
  it('returns an empty string for no values, so a caller can omit the label', () => {
    expect(bulletList([])).toBe('');
  });
});

describe('the roundtable identity block', () => {
  // projectName, persona, selectedContent, otherDocsList, feedbackSection,
  // selectedDocumentIds, documents, previousResponses.
  const build = (persona: ProjectItem): string =>
    buildSinglePersonaPrompt('NorthStar', persona, '', [], '', [], [], []);

  it('gives the persona its real goals, frustrations and voice', () => {
    const prompt = build(GENERATED);
    expect(prompt).toContain('Stay informed in ten minutes');
    expect(prompt).toContain('Alerts bury the real news');
    expect(prompt).toContain('I just want the headlines.');
    expect(prompt).toContain('Feel like a competent citizen');
  });

  it('omits a heading it has no content for', () => {
    // The defect: the model was told to BE a persona and handed
    // "**Your Goals:**" with nothing under it, which reads as an assertion that
    // the persona wants nothing. Emitting the heading unconditionally fails this.
    const prompt = build(asPersona({ name: 'Sparse', tagline: 'Knows little' }));
    expect(prompt).toContain('You are "Sparse"');
    expect(prompt).not.toContain('Your Goals');
    expect(prompt).not.toContain('Your Frustrations');
    expect(prompt).not.toContain('What You Need');
    expect(prompt).not.toContain('Your voice');
  });

  it('renders what an imported persona has and stays silent on the rest', () => {
    const prompt = build(IMPORTED);
    expect(prompt).toContain('Close the audit');
    expect(prompt).toContain('I cannot prove what changed.');
    // Its pain points sit under a key this module never chose.
    expect(prompt).not.toContain('Your Frustrations');
  });

  it('does not throw on a persona whose sections are malformed', () => {
    expect(() => build(asPersona({
      name: 'Broken',
      goals_motivations: { secondary_goals: null },
      pain_points: 'nope',
      quotes: [{ text: null }],
    }))).not.toThrow();
  });
});
