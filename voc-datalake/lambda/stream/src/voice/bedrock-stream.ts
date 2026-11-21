/**
 * One Nova Sonic bidirectional stream (`InvokeModelWithBidirectionalStream`, S-15 findings, section 2): the input is
 * an async queue the conversation pushes events into, the output the parsed events read back.
 *
 * - A stream lives at most 8 minutes (the API's limit), so a session may open several, one after another
 *   (voice-session.ts rollover); `index` numbers them for the meter.
 * - Events pushed before the model's connection is up wait in the queue, in order: the microphone never races the
 *   opening events.
 * - `close()` sends the close events and ends the input; pushes after it are dropped.
 * - An exception the stream answers with (throttling, a model or service error) ends the output with a
 *   `SonicStreamError` named as the service names it, so the session can tell "busy" from a failure.
 */
import {
  BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand, type InvokeModelWithBidirectionalStreamInput,
  type InvokeModelWithBidirectionalStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';

import { closingEvents, parseOutput, type SonicEvent, type SonicOutput } from './sonic-events.js';

/** An exception the stream answered with, named as the service names it (e.g. `ThrottlingException`). */
export class SonicStreamError extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}

/** The service's names for "too many streams now" (the account has 20 per region): the session says `busy`. */
const BUSY_ERRORS: ReadonlySet<string> = new Set([
  'ThrottlingException', 'ServiceQuotaExceededException', 'ModelStreamErrorException', 'ServiceUnavailableException',
]);

export function isBusyError(error: unknown): boolean {
  return error instanceof Error && BUSY_ERRORS.has(error.name);
}

/** Opens a stream: the model reads `input` and answers output chunks' bytes. */
export interface SonicTransport {
  open(input: AsyncIterable<Uint8Array>): Promise<AsyncIterable<Uint8Array>>;
}

/** A queue read as an async iterable: pushes wait for the reader, the reader waits for pushes, `end` finishes it. */
export class InputQueue implements AsyncIterable<Uint8Array> {
  private readonly items: Uint8Array[] = [];
  private waiting: ((result: IteratorResult<Uint8Array>) => void) | undefined;
  private ended = false;

  push(item: Uint8Array): void {
    if (this.ended) return;
    const waiting = this.waiting;
    this.waiting = undefined;
    if (waiting === undefined) this.items.push(item);
    else waiting({ value: item, done: false });
  }

  end(): void {
    this.ended = true;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  private next(): Promise<IteratorResult<Uint8Array>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => { this.waiting = resolve; });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return { next: () => this.next() };
  }
}

export class SonicStream {
  private readonly queue = new InputQueue();
  private closed = false;
  private contents = 0;

  constructor(readonly index: number, readonly openedAt: number) {}

  /** Push one input event (dropped once the stream is closed). */
  send(events: SonicEvent | readonly SonicEvent[]): void {
    if (this.closed) return;
    for (const one of Array.isArray(events) ? events : [events]) {
      this.queue.push(new TextEncoder().encode(JSON.stringify(one)));
    }
  }

  /** A fresh content block name (tool results, cross-modal turns). */
  contentName(kind: string): string {
    this.contents += 1;
    return `voc-${kind}-${this.contents}`;
  }

  /** Connect: resolves once the model answered (its response headers), with its parsed output events. */
  async start(transport: SonicTransport): Promise<AsyncIterable<SonicOutput>> {
    const output = await transport.open(this.queue);
    return (async function* parsed() {
      for await (const bytes of output) yield parseOutput(bytes);
    })();
  }

  /** Send the close events and end the input. */
  close(): void {
    if (this.closed) return;
    this.send(closingEvents());
    this.closed = true;
    this.queue.end();
  }
}

/** The stream's exception members, by the error name the service gives them. */
const EXCEPTIONS: ReadonlyArray<[keyof InvokeModelWithBidirectionalStreamOutput, string]> = [
  ['internalServerException', 'InternalServerException'],
  ['modelStreamErrorException', 'ModelStreamErrorException'],
  ['validationException', 'ValidationException'],
  ['throttlingException', 'ThrottlingException'],
  ['modelTimeoutException', 'ModelTimeoutException'],
  ['serviceUnavailableException', 'ServiceUnavailableException'],
];

/** One output member's bytes, or the error its exception member names. */
function chunkBytes(member: InvokeModelWithBidirectionalStreamOutput): Uint8Array | undefined {
  if (member.chunk?.bytes !== undefined) return member.chunk.bytes;
  const failed = EXCEPTIONS.find(([key]) => member[key] !== undefined);
  if (failed !== undefined) throw new SonicStreamError(failed[1]);
  return undefined;
}

/** The real transport: Bedrock Runtime in `region` (its default HTTP/2 handler), the one model the role may invoke. */
export function bedrockTransport(modelId: string, region: string): SonicTransport {
  const client = new BedrockRuntimeClient({ region });
  return {
    async open(input) {
      const body = (async function* chunks(): AsyncIterable<InvokeModelWithBidirectionalStreamInput> {
        for await (const bytes of input) yield { chunk: { bytes } };
      })();
      const response = await client.send(new InvokeModelWithBidirectionalStreamCommand({ modelId, body }));
      const output = response.body;
      if (output === undefined) throw new SonicStreamError('EmptyStream');
      return (async function* bytesOf() {
        for await (const member of output) {
          const bytes = chunkBytes(member);
          if (bytes !== undefined) yield bytes;
        }
      })();
    },
  };
}
