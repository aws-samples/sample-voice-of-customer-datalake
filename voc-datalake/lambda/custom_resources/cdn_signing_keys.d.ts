/**
 * Types for cdn_signing_keys.js.
 *
 * The handler itself must stay plain CommonJS JavaScript: core-stack.ts inlines
 * it with `lambda.Code.fromInline`, and inline Lambda code is neither bundled
 * nor ESM. This declaration file exists so the CDK project's tests can import
 * it with real types instead of an `any`.
 */

export interface CdnSigningKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface CdnSigningSecretsClient {
  get(secretId: string): Promise<string | undefined>;
  put(secretId: string, secretString: string): Promise<void>;
}

export interface CdnSigningKeysDeps {
  secrets?: CdnSigningSecretsClient;
  generateKeyPair?: () => CdnSigningKeyPair;
}

export interface CdnSigningKeysResponse {
  PhysicalResourceId: string;
  Data?: { PublicKeyPem: string };
}

export declare function handler(
  event: {
    RequestType?: string;
    ResourceProperties?: { SecretId?: string };
  },
  context?: unknown,
  deps?: CdnSigningKeysDeps,
): Promise<CdnSigningKeysResponse>;

export declare function generateKeyPair(): CdnSigningKeyPair;

/** Returns null when the secret holds no usable keypair. */
export declare function readKeyMaterial(secretString?: string): CdnSigningKeyPair | null;

export declare const PHYSICAL_RESOURCE_ID: string;
