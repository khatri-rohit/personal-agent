/**
 * Done gates: what an answer needs before the run may end, per evidence
 * type. A change needs a check after its last edit; open plan todos need to
 * be finished or updated. Each gate sends the run back once, with a reason,
 * and never blocks a second time (progress beats perfection): after that the
 * answer stands, or the run ends on its plan limit.
 *
 * Research has no gate: "every requested topic covered" needs topics the
 * harness cannot know without asking the model to declare them.
 */

const CLAIMS_SUCCESS = /\b(works|working now|passes|passing|fixed|verified|succeeds|all tests pass)\b/i;
const ADMITS_UNVERIFIED =
  /\b(not verified|unverified|could not verify|couldn't verify|did not verify|didn't verify|not tested|untested)\b/i;

/**
 * Change gate: an Agent run with edits not followed by a check, that claims
 * success without saying it is unverified, goes back once to verify.
 */
export function changeGate(input: {
  enabled: boolean;
  alreadySent: boolean;
  posture: string;
  unchecked: boolean;
  canRunChecks: boolean;
  answer: string;
}): boolean {
  return (
    input.enabled &&
    !input.alreadySent &&
    input.posture === 'agent' &&
    input.unchecked &&
    input.canRunChecks &&
    CLAIMS_SUCCESS.test(input.answer) &&
    !ADMITS_UNVERIFIED.test(input.answer)
  );
}

/**
 * The answer says the code still fails, so it is not claiming more than the
 * check showed. Present tense only: "the tests failed before, now fixed"
 * describes the past and must not let a red check pass.
 */
const ADMITS_FAILURE =
  /\b(still fail(s|ing)?|(is|are) (still )?failing|fails? (on|in|because)|pre-?existing (failure|fail)|unrelated (failure|fail))\b/i;

/**
 * Failed-check gate: an Agent run whose last check after its edits
 * failed, and whose answer claims success without admitting it is
 * unverified or still failing, goes back once. Without it a red check
 * satisfied the change gate (a check had run) and "fixed" ended the run.
 */
export function failedCheckGate(input: {
  enabled: boolean;
  alreadySent: boolean;
  posture: string;
  failedCheck: boolean;
  answer: string;
}): boolean {
  return (
    input.enabled &&
    !input.alreadySent &&
    input.posture === 'agent' &&
    input.failedCheck &&
    CLAIMS_SUCCESS.test(input.answer) &&
    !ADMITS_UNVERIFIED.test(input.answer) &&
    !ADMITS_FAILURE.test(input.answer)
  );
}

/**
 * Plan gate: open todos send an Agent run back once. With a scope recorded
 * (what the user's request covers) the open todos are the scope's, and a
 * run still leaving them after the nudge ends on its plan limit. Without a
 * scope the harness cannot know which todos the user asked for ("is phase
 * 1 done?" must not end incomplete because phases 2–10 are open), so after
 * the one nudge the answer stands. A read-only run (Plan, Ask) passes: it
 * cannot work on the todos.
 */
export function planGate(input: {
  openPlanWork: boolean;
  nudges: number;
  posture: string;
  /** A scope is recorded on the plan. */
  scoped: boolean;
}): 'pass' | 'nudge' | 'stop' {
  if (input.posture !== 'agent' || !input.openPlanWork) return 'pass';
  if (input.nudges < 1) return 'nudge';
  return input.scoped ? 'stop' : 'pass';
}
