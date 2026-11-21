/**
 * The projects API's voice sessions (7.69.00, only with `-c voicePersonas=true`; docs/voice-personas.md): statements
 * on the existing projects role and its environment, no new resource in VocApiStack (its ceiling,
 * api-engagement-budget.test.ts). The routes are shared/voice_session_routes.py on `/projects/{proxy+}`.
 *
 * - `bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream` on the relay's runtime and its default endpoint: the
 *   projects API signs a browser's 60-second URL with its own credentials (SigV4 query auth), and AgentCore checks
 *   this grant when the browser connects. The browser never holds AWS credentials.
 * - `bedrock-agentcore:StopRuntimeSession` on the same two: End and the API's own stop of a session.
 * - `scratch/voice/*` in the raw bucket (lib/utils/workspace-object-deletes.ts, with the role's other prefixes): the
 *   evidence the relay reads, and the transcript parts it reads and deletes, every version, once the transcript is a
 *   document. The month's usage, the day's count and the live set are voc-aggregates rows the role already writes.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

import { VOICE_SCRATCH_PREFIX, voiceApiEnvironment, voicePersonasEnabled, voiceSettings } from '../utils/voice-personas';
import type { ApiStackContext } from './api-context';

export interface VoiceSessionGrants {
  /** The voice settings' env (lambda/shared/voice_sessions.py); empty without the flag. */
  readonly environment: Record<string, string>;
  /** The raw bucket's key globs the role's object grant adds; none without the flag. */
  readonly objectGlobs: readonly string[];
}

export function grantVoiceSessions(ctx: ApiStackContext, role: iam.Role): VoiceSessionGrants {
  const settings = voiceSettings(ctx.stack);
  if (settings === undefined) return { environment: {}, objectGlobs: [] };
  const runtimeArn = ctx.props.voiceRuntimeArn;
  if (runtimeArn === undefined) {
    throw new Error('-c voicePersonas=true: VocApiStack needs VocProcessingStack\'s relay runtime (voiceRuntimeArn).');
  }
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'VoiceSessions',
    actions: ['bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream', 'bedrock-agentcore:StopRuntimeSession'],
    resources: [runtimeArn, `${runtimeArn}/runtime-endpoint/DEFAULT`],
  }));
  return { environment: voiceApiEnvironment(ctx.stack, settings, runtimeArn), objectGlobs: [`${VOICE_SCRATCH_PREFIX}*`] };
}

/** config.json's `features.voice`: the SPA offers Talk on a persona only with it (frontend/src/runtimeConfig.ts). */
export function voiceFeature(stack: cdk.Stack): { voice: boolean } {
  return { voice: voicePersonasEnabled(stack) };
}

/** `VoiceAvailable`, only with the flag, so the default template gains no output (frontend/scripts/deploy.sh reads a
 *  missing one as `features.voice: false`). */
export function addVoiceAvailableOutput(stack: cdk.Stack): void {
  if (!voicePersonasEnabled(stack)) return;
  new cdk.CfnOutput(stack, 'VoiceAvailable', {
    value: 'true',
    description: 'The personas can be talked to by voice (drives the frontend features.voice flag)',
  });
}
