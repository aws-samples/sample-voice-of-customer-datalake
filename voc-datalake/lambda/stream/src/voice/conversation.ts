/**
 * What the persona's stream says, turned into what the browser shows and the transcript keeps (S-15 findings,
 * section 2 "Output events", and 6.1 "Barge-in" and "Transcript source"):
 *
 * - the person's words (USER text, the model's ASR) and the persona's (ASSISTANT text, SPECULATIVE then FINAL, the
 *   stage named by the block's `contentStart`) become captions: each caption carries the turn's whole text at that
 *   stage, so the browser replaces rather than appends;
 * - the persona's audio goes to the browser as it comes (faster than real time: the browser queues it), except what
 *   a block that was interrupted still sends;
 * - barge-in: a `contentEnd` with `stopReason` INTERRUPTED (or Nova Sonic v1's `{"interrupted": true}` text) marks
 *   the persona's turn cut short and tells the browser to stop playback and drop its queue;
 * - the end of the persona's spoken turn (its AUDIO block's END_TURN) is the turn boundary a rollover and a wrap-up
 *   wait for;
 * - `cite`: the pack's ids only, recorded on the turn and shown as citations; the tool is always answered at once
 *   (asynchronous tools: the model keeps talking).
 */
import { z } from 'zod';

import { CITE_TOOL } from './prompt.js';
import type { RelayMessage } from './protocol.js';
import type { SonicOutput } from './sonic-events.js';
import type { Transcript } from './transcript.js';

export interface ConversationSink {
  send(message: RelayMessage): void;
  audio(pcm: Buffer): void;
  toolResult(toolUseId: string, result: Record<string, unknown>): void;
  /** The persona finished speaking a turn (not interrupted). */
  assistantTurnEnded(): void;
}

interface Block {
  role: string;
  type: string;
  stage: 'speculative' | 'final';
}

const citeInput = z.object({ feedback_ids: z.array(z.string()).catch([]) });
const interruptedMarker = z.object({ interrupted: z.literal(true) });

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Nova Sonic v1 signalled barge-in with a text block of `{"interrupted": true}` (2 still may: handle both). */
function isInterruptedMarker(text: string): boolean {
  return text.trimStart().startsWith('{') && interruptedMarker.safeParse(jsonOf(text)).success;
}

export class Conversation {
  private readonly blocks = new Map<string, Block>();
  private readonly interrupted = new Set<string>();

  constructor(private readonly transcript: Transcript, private readonly sink: ConversationSink) {}

  handle(output: SonicOutput): void {
    switch (output.kind) {
      case 'contentStart':
        this.blocks.set(output.contentId, { role: output.role, type: output.type, stage: output.stage });
        break;
      case 'text':
        this.text(output.contentId, output.role, output.content);
        break;
      case 'audio':
        if (!this.interrupted.has(output.contentId)) this.sink.audio(Buffer.from(output.content, 'base64'));
        break;
      case 'contentEnd':
        this.contentEnd(output.contentId, output.stopReason);
        break;
      case 'toolUse':
        this.toolUse(output.toolName, output.toolUseId, output.content);
        break;
      case 'completionStart':
      case 'usage':
      case 'other':
        break;
    }
  }

  private text(contentId: string, role: string, content: string): void {
    if (isInterruptedMarker(content)) {
      this.interrupt(contentId);
      return;
    }
    const speaker = role === '' ? this.blocks.get(contentId)?.role : role;
    if (speaker === 'USER') {
      const said = this.transcript.userText(content);
      if (said !== undefined) this.sink.send({ type: 'caption', role: 'user', stage: 'final', text: said.text, turn: said.turn });
      return;
    }
    if (speaker !== 'ASSISTANT') return;
    const stage = this.blocks.get(contentId)?.stage ?? 'final';
    const said = this.transcript.assistantText(content, stage);
    if (said === undefined) return;
    this.sink.send({ type: 'caption', role: 'assistant', stage, text: said.text, turn: said.turn });
    if (said.cited.length > 0) this.sink.send({ type: 'citation', turn: said.turn, feedback_ids: said.cited });
  }

  private interrupt(contentId: string): void {
    this.interrupted.add(contentId);
    this.transcript.interrupt();
    this.sink.send({ type: 'interrupted' });
  }

  private contentEnd(contentId: string, stopReason: string): void {
    if (stopReason === 'INTERRUPTED') {
      this.interrupt(contentId);
      return;
    }
    const block = this.blocks.get(contentId);
    this.blocks.delete(contentId);
    if (stopReason !== 'END_TURN' || block === undefined) return;
    const turn = this.transcript.lastTurn();
    if (block.role === 'ASSISTANT' && block.type === 'AUDIO') {
      if (turn !== undefined) this.sink.send({ type: 'turn_end', role: 'assistant', turn });
      this.sink.assistantTurnEnded();
    } else if (block.role === 'USER' && turn !== undefined) {
      this.sink.send({ type: 'turn_end', role: 'user', turn });
    }
  }

  private toolUse(toolName: string, toolUseId: string, content: string): void {
    if (toolName !== CITE_TOOL) {
      this.sink.toolResult(toolUseId, { ok: false, error: 'unknown tool' });
      return;
    }
    const ids = citeInput.safeParse(jsonOf(content));
    const cited = this.transcript.cite(ids.success ? ids.data.feedback_ids : []);
    this.sink.toolResult(toolUseId, { ok: true });
    if (cited !== undefined && cited.cited.length > 0) {
      this.sink.send({ type: 'citation', turn: cited.turn, feedback_ids: cited.cited });
    }
  }
}
