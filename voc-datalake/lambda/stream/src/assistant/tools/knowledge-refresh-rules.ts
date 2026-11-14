/**
 * The rules of "refresh the knowledge pack" (`propose_knowledge_refresh`, the `agents` pack, administrators only),
 * shared by the stream's tool and the web app's approval card (`@stream/assistant/tools/knowledge-refresh-rules`):
 * the arguments the model may propose and the estimate the card shows.
 *
 * The model only proposes: its call is a card naming the action, the repository connection, the commit and the
 * estimate. Nothing starts until an administrator presses Approve, and then the web app starts the Understand flow
 * with `POST /agents/engineering/runs` in that administrator's own session, where `require_admin_caller` checks them
 * (docs/autonomous-engineering.md "From the assistant").
 *
 * The estimate is an estimate, stated with its assumptions: the stored Understand flow's map step maps at most its
 * `shard_cap` shards in a run, each one cheap model call (assumed {@link SECONDS_PER_SHARD} seconds), then the reduce
 * and the drafting (assumed {@link DRAFT_MINUTES} minutes); the run's coordinator and each agent step's session, all
 * of the standard size, each cost what AgentCore's published rates make it for the whole run (runtime/caps.py
 * DEFAULT_RATES and STANDARD_SIZE, held to them by a test).
 * Model tokens are not in it, as the spend ledger leaves them out until they are priced; the run's cost and token
 * caps (the deployment's) bound the run whatever the estimate says.
 */
import { z } from 'zod';

/** A connection's id, as the runtime checks it (engineering/runtime/interface.py check_id, MAX_ID_LENGTH 63). */
const CONNECTION_ID = /^[A-Za-z0-9-]{1,63}$/;
/** A full commit id (agents_handler.py _RUN_COMMIT, lower case after the card lower-cases it). */
export const FULL_COMMIT = /^[0-9a-fA-F]{40}$/;
/** The languages with an agent image (lib/stacks/engineering-agentcore.ts IMAGE_LANGUAGES). */
export const REFRESH_LANGUAGES = ['java', 'node', 'python', 'rust'] as const;

export const knowledgeRefreshArgsSchema = z.object({
  connection: z.string().trim().regex(CONNECTION_ID, 'is a connection id: 1 to 63 letters, digits or hyphens'),
  commit: z.string().trim().regex(FULL_COMMIT, 'is a full commit id: 40 hexadecimal characters').optional(),
  language: z.enum(REFRESH_LANGUAGES).optional(),
}).strict();
export type KnowledgeRefreshArgs = z.infer<typeof knowledgeRefreshArgsSchema>;

/** The run's goal, the server's words (on one line, under agents_handler.py MAX_RUN_GOAL). */
export const refreshGoal = (connection: string): string =>
  `Refresh the knowledge pack of repository connection ${connection}`;

// ── The estimate ──

/** Assumed: one shard's map call (one cheap model call on at most 48 KB of the repository). */
export const SECONDS_PER_SHARD = 20;
/** Assumed: the reduce and the drafting of the pack, the tenets and the review guide. */
export const DRAFT_MINUTES = 10;
/** A map step's most shards in a run, its default when a flow sets none (shared/workflow_engineering.py MAX_SHARD_CAP). */
export const MAX_SHARD_CAP = 200;
/** AgentCore Runtime V2's published rates (runtime/caps.py DEFAULT_RATES), USD per hour. */
export const AGENTCORE_RATES = { vcpuHour: 0.1276, gbHour: 0.0169 } as const;
/** Every agent's session by default (runtime/caps.py STANDARD_SIZE). */
export const STANDARD_SESSION = { vcpus: 2, gb: 8 } as const;

interface RefreshEstimate {
  /** Whole minutes, rounded up. */
  minutes: number;
  /** The agent sessions counted: the run's coordinator and one for each agent step of the flow. */
  sessions: number;
  /** One standard session's dollars an hour at AgentCore's published rates. */
  sessionUsdPerHour: number;
  /** Every counted session living for all of `minutes`, in dollars (an upper reading: they do not all live so long). */
  sessionUsd: number;
}

/**
 * The estimate for a run that maps `shardCap` shards (the stored flow's map step's cap) with that many agent steps:
 * the coordinator every run starts (runtime: `coordinator-1`) and one session per agent step, each counted for the
 * whole run.
 */
export function refreshEstimate(shardCap: number, agentSteps: number): RefreshEstimate {
  const shards = Number.isInteger(shardCap) && shardCap >= 1 && shardCap <= MAX_SHARD_CAP ? shardCap : MAX_SHARD_CAP;
  const minutes = Math.ceil((shards * SECONDS_PER_SHARD) / 60 + DRAFT_MINUTES);
  const sessions = 1 + (Number.isInteger(agentSteps) && agentSteps > 0 ? agentSteps : 0);
  const sessionUsdPerHour = STANDARD_SESSION.vcpus * AGENTCORE_RATES.vcpuHour + STANDARD_SESSION.gb * AGENTCORE_RATES.gbHour;
  return { minutes, sessions, sessionUsdPerHour, sessionUsd: (sessions * sessionUsdPerHour * minutes) / 60 };
}
