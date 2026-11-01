/**
 * A response body read with a byte cap enforced while it streams in (never buffered whole), for the
 * outbound store reads (`app-store-search.ts`, `store-app-lookup.ts`).
 */
import { ServiceError } from '../lib/errors.js';

/** Read the stream chunk by chunk; cancel it and refuse as soon as it passes `cap` bytes. */
async function readCapped(
  reader: ReadableStreamDefaultReader<Uint8Array>, cap: number, tooLarge: string,
  chunks: readonly Uint8Array[] = [], total = 0,
): Promise<readonly Uint8Array[]> {
  const { done, value } = await reader.read();
  if (done) return chunks;
  const next = total + value.byteLength;
  if (next > cap) {
    // A failed cancel changes nothing: the refusal below is the answer either way.
    await reader.cancel().then(() => true, () => false);
    throw new ServiceError(tooLarge);
  }
  return readCapped(reader, cap, tooLarge, [...chunks, value], next);
}

/**
 * The response body as text. Past `cap` bytes (declared, or counted while it streams) it refuses with a
 * ServiceError carrying `tooLarge`, the caller's own wording.
 */
export async function cappedText(response: Response, cap: number, tooLarge: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > cap) throw new ServiceError(tooLarge);
  if (response.body === null) return '';
  const chunks = await readCapped(response.body.getReader(), cap, tooLarge);
  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}
