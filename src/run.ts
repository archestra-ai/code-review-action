import { type ActionContext, type ActionResult, makeResult } from "./context";
import { detectTrigger } from "./github/event";
import { runFix } from "./modes/fix";
import { runFixCi } from "./modes/fix-ci";
import { runFixCiMain } from "./modes/fix-ci-main";
import { runReview } from "./modes/review";

/** Detects the mode from the event (or the "mode" input) and runs it. */
export async function run(ctx: ActionContext): Promise<ActionResult> {
  const trigger = detectTrigger(ctx.eventName, ctx.payload, {
    command: ctx.inputs.fixCommand,
    mode: ctx.inputs.mode,
    prNumber: ctx.inputs.prNumber,
  });
  switch (trigger.kind) {
    case "skip":
      ctx.log.info(`Nothing to do: ${trigger.reason}.`);
      return makeResult("none", { status: "skipped", summary: `Nothing to do: ${trigger.reason}.` });
    case "review":
      return runReview(ctx, trigger.prNumber);
    case "fix":
      return runFix(ctx, trigger);
    case "fix-ci":
      return runFixCi(ctx, trigger);
    case "fix-ci-main":
      return runFixCiMain(ctx, trigger);
  }
}
