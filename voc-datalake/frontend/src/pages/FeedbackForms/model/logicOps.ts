/**
 * @fileoverview The logic operators the server takes for each question type, read from
 * `voc-datalake/schemas/form-logic-ops.json` (the copy of `OPS_BY_TYPE` in lambda/shared/forms_v2.py that
 * test_form_logic_ops_lockstep.py pins). A rule with any other op is the server's 400 on Save, so the builder's
 * validator refuses it as an error (ruleProblems.ts), and the ops the Logic section offers stay within these
 * (ruleControls.test.ts); the dev mock refuses by the same file (mock-forms-v2.js).
 *
 * @module pages/FeedbackForms/model/logicOps
 */
import logicOps from '../../../../../schemas/form-logic-ops.json'
import type { QuestionType, RuleOp } from './formsV2'

const SERVER_OPS: Readonly<Record<QuestionType, readonly string[]>> = logicOps.ops_by_type

/** Does the server take a rule with `op` on a question of `type`? */
export const serverTakesOp = (type: QuestionType, op: RuleOp): boolean => SERVER_OPS[type].includes(op)
