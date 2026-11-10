/**
 * A response body read with a byte cap enforced while it streams in (never buffered whole), for the
 * outbound store reads (`app-store-search.ts`, `store-app-lookup.ts`).
 */
import { ServiceError } from '../lib/errors.js';

interface Collected {
  readonly decoder: InstanceType<typeof TextDecoder>;
  readonly parts: string[];
  bytes: number;
}

/**
 * Read the stream chunk by chunk into `into` (decoded as it arrives, linear in the body size); cancel it and
 * refuse as soon as it passes `cap` bytes.
 */
async function readCapped(reader: ReadableStreamDefaultReader<Uint8Array>, cap: number, tooLarge: string, into: Collected): Promise<void> {
  const { done, value } = await reader.read();
  if (done) return;
  into.bytes += value.byteLength;
  if (into.bytes > cap) {
    // A failed cancel changes nothing: the refusal below is the answer either way.
    await reader.cancel().then(() => true, () => false);
    throw new ServiceError(tooLarge);
  }
  into.parts.push(into.decoder.decode(value, { stream: true }));
  await readCapped(reader, cap, tooLarge, into);
}

/**
 * The response body as text. Past `cap` bytes (declared, or counted while it streams) it refuses with a
 * ServiceError carrying `tooLarge`, the caller's own wording.
 */
export async function cappedText(response: Response, cap: number, tooLarge: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > cap) throw new ServiceError(tooLarge);
  if (response.body === null) return '';
  const collected: Collected = { decoder: new TextDecoder(), parts: [], bytes: 0 };
  await readCapped(response.body.getReader(), cap, tooLarge, collected);
  return collected.parts.join('') + collected.decoder.decode();
}
