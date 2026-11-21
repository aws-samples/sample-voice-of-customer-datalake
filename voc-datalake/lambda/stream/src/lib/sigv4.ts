/**
 * SigV4-signed requests with the role's credentials (the web-search gateway and the AppSync Events publisher's JSON
 * POSTs, the voice relay's S3 GET and PUT). A node:crypto SHA-256 adapter keeps this free of an extra hashing dependency.
 */
import { createHash, createHmac } from 'node:crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { SourceData } from '@smithy/types';

/** Normalize the SDK's SourceData union into bytes for node:crypto
 * (strings are encoded as UTF-8, matching node's default). */
function toBinary(data: SourceData): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

class NodeSha256 {
  private readonly parts: Uint8Array[] = [];
  private readonly secret?: Uint8Array;

  constructor(secret?: SourceData) {
    this.secret = secret === undefined ? undefined : toBinary(secret);
  }

  update(chunk: SourceData): void {
    this.parts.push(toBinary(chunk));
  }

  digest(): Promise<Uint8Array> {
    const hasher = this.secret === undefined
      ? createHash('sha256')
      : createHmac('sha256', this.secret);
    for (const part of this.parts) hasher.update(part);
    return Promise.resolve(new Uint8Array(hasher.digest()));
  }

  reset(): void {
    this.parts.length = 0;
  }
}

export interface SignedPost {
  url: string;
  body: string;
  /** The signing name of the service (`bedrock-agentcore`, `appsync`). */
  service: string;
  region: string;
  /** Extra headers, signed too (content-type is always JSON). */
  headers?: Record<string, string>;
  timeoutMs: number;
}

export interface SignedRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  body?: string;
  service: string;
  region: string;
  /** Extra headers, signed too. */
  headers?: Record<string, string>;
  timeoutMs: number;
  /** S3 signs the path as sent (`false`); every other service escapes it once more (the SDK's default, `true`). */
  uriEscapePath?: boolean;
}

/** A `method` request to `url`, signed for `service` in `region` (the voice relay's S3 reads and writes: 7.69.00). */
export async function signedRequest({
  method, url, body, service, region, headers = {}, timeoutMs, uriEscapePath = true,
}: SignedRequest): Promise<Response> {
  const parsed = new URL(url);
  const signer = new SignatureV4({ service, region, credentials: defaultProvider(), sha256: NodeSha256, uriEscapePath });
  const request = new HttpRequest({
    method,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    path: parsed.pathname,
    headers: { host: parsed.hostname, ...headers },
    body,
  });
  const signed = await signer.sign(request);
  return fetch(url, { method, headers: signed.headers, body, signal: AbortSignal.timeout(timeoutMs) });
}

/** POST `body` to `url`, signed for `service` in `region`. */
export function signedPost({ url, body, service, region, headers = {}, timeoutMs }: SignedPost): Promise<Response> {
  return signedRequest({
    method: 'POST', url, body, service, region, headers: { 'content-type': 'application/json', ...headers }, timeoutMs,
  });
}
