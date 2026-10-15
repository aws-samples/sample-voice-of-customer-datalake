/**
 * Types for cdn_signing_keys.js.
 *
 * The handler stays plain CommonJS JavaScript because nothing transpiles it:
 * core-stack.ts ships this directory to Lambda as an asset (`Code.fromAsset`),
 * which copies files verbatim. This declaration file exists so the CDK project's
 * tests can import it with real types instead of an `any`.
 *
 * Making the handler TypeScript would need a `NodejsFunction` (esbuild), and
 * would retire both this file and the `.gitignore` negation that keeps it
 * tracked. Deliberately not done: that is more build machinery than a ~150-line
 * custom resource warrants.
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

export interface CdnSigningKeysEvent {
  RequestType?: string;
  ResourceProperties?: { SecretId?: string };
}

/**
 * CloudFormation entry point. Single-parameter BY DESIGN: the Node 24 Lambda
 * runtime treats a 3-arity handler as the removed callback style and refuses to
 * start. Tests should call `onEvent` instead.
 */
export declare function handler(event: CdnSigningKeysEvent): Promise<CdnSigningKeysResponse>;

export declare function onEvent(
  event: CdnSigningKeysEvent,
  deps?: CdnSigningKeysDeps,
): Promise<CdnSigningKeysResponse>;

export declare function generateKeyPair(): CdnSigningKeyPair;

/** Returns null when the secret holds no usable keypair. */
export declare function readKeyMaterial(secretString?: string): CdnSigningKeyPair | null;

export declare const PHYSICAL_RESOURCE_ID: string;
