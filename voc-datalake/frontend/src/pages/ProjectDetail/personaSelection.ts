/**
 * @fileoverview Which personas a project-chat message addresses.
 *
 * Extracted from ChatTab so the `@all` expansion and its clamp are directly
 * testable: inside a useCallback this logic could only be reached by rendering
 * the whole tab, which is why the clamp arrived untested.
 *
 * @module pages/ProjectDetail/personaSelection
 */
import { MAX_SELECTED_PERSONAS } from '../../api/streamLimits'

/** `@all` as a standalone word, case-insensitive. */
const AT_ALL = /(?:^|\s)@all(?:\s|$)/i

/** Roundtable needs at least two voices to be a round table. */
const MIN_ROUNDTABLE_PERSONAS = 2

export interface PersonaSelection {
  readonly isRoundtable: boolean
  readonly selectedPersonaIds: string[]
  /**
   * Total persona count when `@all` matched more personas than the request may
   * carry, otherwise undefined. Not yet surfaced in the UI — see the note in
   * ChatTab — but returned so that it can be, without re-deriving the condition.
   */
  readonly clampedFrom?: number
}

/**
 * Resolve the addressed personas.
 *
 * `@all` is expanded here and **clamped** to what the stream Lambda accepts.
 * It is a one-keystroke shorthand over a list the user does not control: persona
 * import appends without replacing, so a project can hold more personas than the
 * request may carry, and an unclamped expansion would come back as an opaque 400.
 * An explicit selection is deliberately NOT clamped — silently dropping personas
 * someone picked by hand is worse than telling them — so that path can still
 * exceed the cap and is left as known residue.
 */
export function resolvePersonaSelection(
  input: string,
  personaIds: readonly string[],
  mentionedPersonaIds: readonly string[],
  mentionsRoundtable: boolean,
): PersonaSelection {
  const isRoundtable = mentionsRoundtable
    || (AT_ALL.test(input) && personaIds.length >= MIN_ROUNDTABLE_PERSONAS)

  if (!isRoundtable || mentionedPersonaIds.length > 0) {
    return {
      isRoundtable, selectedPersonaIds: [...mentionedPersonaIds],
    }
  }

  return {
    isRoundtable,
    selectedPersonaIds: personaIds.slice(0, MAX_SELECTED_PERSONAS),
    clampedFrom: personaIds.length > MAX_SELECTED_PERSONAS ? personaIds.length : undefined,
  }
}
