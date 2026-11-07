/**
 * SigV4-signed JSON POSTs with the Lambda role's credentials (the web-search gateway, the AppSync
 * Events publisher). A node:crypto SHA-256 adapter keeps this free of an extra hashing dependency.
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

/** POST `body` to `url`, signed for `service` in `region`. */
export async function signedPost({ url, body, service, region, headers = {}, timeoutMs }: SignedPost): Promise<Response> {
  const parsed = new URL(url);
  const signer = new SignatureV4({ service, region, credentials: defaultProvider(), sha256: NodeSha256 });
  const request = new HttpRequest({
    method: 'POST',
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    path: parsed.pathname,
    headers: { host: parsed.hostname, 'content-type': 'application/json', ...headers },
    body,
  });
  const signed = await signer.sign(request);
  return fetch(url, { method: 'POST', headers: signed.headers, body, signal: AbortSignal.timeout(timeoutMs) });
}
