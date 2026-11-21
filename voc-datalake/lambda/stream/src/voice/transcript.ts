/**
 * The conversation's text as it happens: the turns the transcript document is made of (lambda/shared/
 * voice_transcripts.py reads them at finalize), the captions' text, and the history a rollover replays.
 *
 * - A turn is the person's words (the model's ASR of them) or the persona's answer. The persona's text comes twice:
 *   SPECULATIVE before it is spoken, FINAL for what was actually said (it follows playback). The turn's text is the
 *   FINAL text, else the SPECULATIVE text (a turn cut short by barge-in may never get its FINAL): `interrupted` says so.
 * - Citations: the ids the persona's `cite` named, kept only when the evidence pack holds them (the focus groups'
 *   rule: an answer can only cite a review the pack held). A `[fb:<id>]` the model writes in its text anyway is moved
 *   to the turn's citations the same way and removed from the text (`keepCitations`), so no id is read aloud or shown.
 * - Parts: every turn but the latest is settled once a newer one starts (and every turn at the end); settled turns
 *   are taken once each, for one write-once part.
 * - No audio is ever kept: only this text.
 */
import { citedIds, keepCitations } from '../assistant/runtime/focus-group-prompts.js';
import { clip } from '../assistant/tools/format.js';
import { MAX_CAPTION_CHARS, MAX_CITED_IDS } from './protocol.js';
import type { HistoryEntry } from './sonic-events.js';

type Role = 'user' | 'assistant';

/** One turn as a transcript part stores it. */
export interface TranscriptTurn {
  role: Role;
  text: string;
  at: string;
  interrupted: boolean;
  feedback_ids: string[];
}

interface Turn {
  readonly turn: number;
  readonly role: Role;
  readonly at: string;
  final: string[];
  speculative: string[];
  interrupted: boolean;
  feedbackIds: string[];
}

/** A session's turns at most (a 15-minute interview has far fewer); later ones are captioned, not kept. */
const MAX_TURNS = 400;
/** The cited ids one turn keeps at most (several `cite` calls in one answer). */
const MAX_TURN_CITATIONS = 20;
/** Nova Sonic's chat history: at most 200 KB in all and 50 KB per text block (S-15 findings, section 2). */
const MAX_HISTORY_BYTES = 200 * 1024;
const MAX_HISTORY_ENTRY_BYTES = 50 * 1024;

function joined(words: readonly string[]): string {
  return clip(words.join(' ').replaceAll(/\s+/gu, ' ').trim(), MAX_CAPTION_CHARS);
}

function textOf(turn: Turn): string {
  return joined(turn.final.length > 0 ? turn.final : turn.speculative);
}

export class Transcript {
  private readonly turns: Turn[] = [];
  private taken = 0;

  constructor(private readonly packIds: ReadonlySet<string>, private readonly now: () => string) {}

  /** The turn `role` is speaking in: the current one, or a new one when the other side spoke last. */
  private turnFor(role: Role): Turn | undefined {
    const last = this.turns.at(-1);
    if (last?.role === role) return last;
    if (this.turns.length >= MAX_TURNS) return undefined;
    const turn: Turn = {
      turn: this.turns.length + 1, role, at: this.now(), final: [], speculative: [], interrupted: false, feedbackIds: [],
    };
    this.turns.push(turn);
    return turn;
  }

  /** The person's words; the turn number and its text so far (undefined past MAX_TURNS). */
  userText(text: string): { turn: number; text: string } | undefined {
    const turn = this.turnFor('user');
    if (turn === undefined) return undefined;
    turn.final.push(text);
    return { turn: turn.turn, text: textOf(turn) };
  }

  /** The persona's words at a stage, any citation markers moved to its citations; its turn and text at that stage. */
  assistantText(text: string, stage: 'speculative' | 'final'): { turn: number; text: string; cited: string[] } | undefined {
    const turn = this.turnFor('assistant');
    if (turn === undefined) return undefined;
    const cited = this.addCitations(turn, citedIds(text));
    const spoken = keepCitations(text, new Set());
    if (stage === 'final') turn.final.push(spoken);
    else turn.speculative.push(spoken);
    return { turn: turn.turn, text: joined(stage === 'final' ? turn.final : turn.speculative), cited };
  }

  /** A `cite` call's ids: the pack's ones, on the persona's current turn (a new one when it cites before speaking). */
  cite(ids: readonly string[]): { turn: number; cited: string[] } | undefined {
    const turn = this.turnFor('assistant');
    if (turn === undefined) return undefined;
    return { turn: turn.turn, cited: this.addCitations(turn, ids.slice(0, MAX_CITED_IDS)) };
  }

  /** The ids of `ids` the pack holds and the turn did not cite yet, now cited. */
  private addCitations(turn: Turn, ids: readonly string[]): string[] {
    const added = [...new Set(ids)].filter((id) => this.packIds.has(id) && !turn.feedbackIds.includes(id))
      .slice(0, MAX_TURN_CITATIONS - turn.feedbackIds.length);
    turn.feedbackIds = [...turn.feedbackIds, ...added];
    return added;
  }

  /** The number of the latest turn, if any. */
  lastTurn(): number | undefined {
    return this.turns.at(-1)?.turn;
  }

  /** Barge-in: the persona's current turn was cut short. */
  interrupt(): void {
    const last = this.turns.at(-1);
    if (last?.role === 'assistant') last.interrupted = true;
  }

  /** The turns settled since the last call (every one when `all`), each taken once, as a part stores them. */
  take(all: boolean): TranscriptTurn[] {
    const until = all ? this.turns.length : Math.max(this.taken, this.turns.length - 1);
    const settled = this.turns.slice(this.taken, until);
    this.taken = until;
    return settled.map((turn) => ({
      role: turn.role, text: textOf(turn), at: turn.at, interrupted: turn.interrupted, feedback_ids: turn.feedbackIds,
    })).filter((turn) => turn.text !== '' || turn.feedback_ids.length > 0);
  }

  /** The conversation so far as a new stream's chat history: newest kept within Nova Sonic's limits, starting with
   *  the person (the oldest turns are dropped first). */
  history(): HistoryEntry[] {
    const entries = this.turns.map((turn): HistoryEntry => ({
      role: turn.role === 'user' ? 'USER' : 'ASSISTANT',
      text: Buffer.from(textOf(turn)).subarray(0, MAX_HISTORY_ENTRY_BYTES).toString('utf8'),
    })).filter((entry) => entry.text !== '');
    const kept = entries.reduceRight<{ entries: HistoryEntry[]; bytes: number }>((acc, entry) => {
      const bytes = acc.bytes + Buffer.byteLength(entry.text);
      return bytes > MAX_HISTORY_BYTES || acc.bytes < 0 ? { entries: acc.entries, bytes: -1 } : { entries: [entry, ...acc.entries], bytes };
    }, { entries: [], bytes: 0 }).entries;
    const firstUser = kept.findIndex((entry) => entry.role === 'USER');
    return firstUser < 0 ? [] : kept.slice(firstUser);
  }
}
