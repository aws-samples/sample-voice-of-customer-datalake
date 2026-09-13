import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read a named integer constant out of a Python source file in this repo.
 *
 * Several invariants in this app span a Python constant and a synthesized
 * CloudFormation value — a Bedrock read timeout against the Lambda timeout it has
 * to fit inside, a delegation timeout against the adapter's own — and no single
 * file can keep those honest. The CDK suites therefore read the Python side, and
 * this is that read, in one place: the regex is subtle enough (anchored, optional
 * `Final` annotation, digits only) that three hand-rolled copies would drift.
 *
 * THROWS rather than returning undefined when the constant is absent. A rename or
 * an inlined literal must fail loudly: a regex that quietly stops matching turns
 * every assertion built on it into a vacuous pass, which is worse than no guard at
 * all because it still reads like one.
 */
export function pythonIntConstant(name: string, ...pathSegments: string[]): number {
  const path = join(__dirname, '..', '..', ...pathSegments);
  const source = readFileSync(path, 'utf-8');
  // Matches `NAME = 840`, `NAME: Final = 840` and `NAME: Final[int] = 840`, at the
  // start of a line so a mention inside a comment or an f-string cannot match.
  const pattern = new RegExp(`^${name}(?::\\s*Final(?:\\[int\\])?)?\\s*=\\s*(\\d+)`, 'm');
  const matched = source.match(pattern)?.[1];
  if (matched === undefined) {
    throw new Error(
      `could not read ${name} from ${pathSegments.join('/')} — it was renamed, ` +
        'inlined, or is no longer an integer literal. Any assertion comparing it to a ' +
        'synthesized value is now vacuous; fix the name here rather than deleting it.',
    );
  }
  return Number(matched);
}

/**
 * How much of an invocation must remain after a Bedrock read timeout fires.
 *
 * A budget that merely lands under the caller's ceiling is not enough: the point
 * of the read timeout firing first is that the handler gets to RECORD what
 * happened — `shared/jobs.py` writing the job `failed`, or the extractor marking
 * its record failed — instead of being killed mid-flight and leaving a row stuck
 * on `running`. Without a reserve, a read timeout one second under the ceiling
 * passes an assertion while delivering none of the benefit.
 *
 * Generous on purpose: the work to be done is a single DynamoDB write, so the
 * number is not calibrated to it. It exists so the headroom is a DECISION rather
 * than whatever rounding happened to leave behind, and so raising a read timeout
 * towards its ceiling fails loudly.
 *
 * Shared by the api-stack and core-stack suites because both assert the same
 * property against different functions, and two copies would drift apart in
 * exactly the direction that weakens them.
 */
export const BEDROCK_FAILURE_RECORDING_RESERVE_SECONDS = 30;
