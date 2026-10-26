import { type ActionContext, type ActionResult, makeResult } from "./context";
import { detectTrigger } from "./github/event";
import { runFix } from "./modes/fix";
import { runFixCi } from "./modes/fix-ci";
import { runFixCiMain } from "./modes/fix-ci-main";
import { refuseAccess, runReview } from "./modes/review";

/** Detects the mode from the event (or the "mode" input) and runs it. */
export async function run(ctx: ActionContext): Promise<ActionResult> {
  const trigger = detectTrigger(ctx.eventName, ctx.payload, {
    command: ctx.inputs.fixCommand,
    mode: ctx.inputs.mode,
    prNumber: ctx.inputs.prNumber,
  });
  if (trigger.kind === "skip") {
    ctx.log.info(`Nothing to do: ${trigger.reason}.`);
    return makeResult("none", { status: "skipped", summary: `Nothing to do: ${trigger.reason}.` });
  }
  if (ctx.accessRefusal) return refuseAccess(ctx, trigger, ctx.accessRefusal);
  if (!ctx.inputs.token) {
    // Runs act as the person who caused them; without that person's token
    // there is no one to run as.
    const message =
      'No Archestra token for this actor: "archestra-token" is empty and no "fallback-token" is set. The actor creates a platform token in Archestra (Personal Settings) and stores it as their repository or organization secret.';
    ctx.log.warning(message);
    return makeResult(trigger.kind, { status: "skipped", summary: message });
  }
  if (ctx.inputs.tokenSource === "fallback") {
    ctx.log.warning(
      "The actor has no Archestra token. The runs use the fallback token: they act as its owner, and its owner pays for them.",
    );
  }
  switch (trigger.kind) {
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
