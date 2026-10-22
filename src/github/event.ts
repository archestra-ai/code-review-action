import { z } from "zod";
import type { Mode } from "../inputs";
import { isBotUser } from "../util";
import { parseCommand } from "./commands";
import { newlyCheckedActions, parseMarker } from "./sticky";

export interface Sender {
  login: string;
  id: number;
  type: string;
}

/** Where the trigger came from, so the action can answer at the same place. */
export type TriggerSource =
  | { type: "issue-comment"; commentId: number }
  | { type: "review-comment"; commentId: number; inReplyTo: number | null }
  | { type: "checkbox"; commentId: number }
  | { type: "dispatch" };

export type FindingSelection = number[] | "all" | { inlineReplyTo: number };

export type Trigger =
  | { kind: "skip"; reason: string }
  | { kind: "review"; prNumber: number }
  | {
      kind: "fix";
      prNumber: number;
      sender: Sender;
      source: TriggerSource;
      findings: FindingSelection;
      note: string;
    }
  | { kind: "fix-ci"; prNumber: number; sender: Sender; source: TriggerSource }
  | {
      kind: "fix-ci-main";
      prNumber: number;
      sender: Sender;
      source: TriggerSource;
      /** Index into the sticky's triage list, or all pre-existing failures. */
      target: number | "all";
    };

const UserSchema = z.object({ login: z.string(), id: z.number(), type: z.string().default("User") });

const PullRequestEventSchema = z.object({
  action: z.string().optional(),
  pull_request: z.object({ number: z.number() }),
  sender: UserSchema,
});

const IssueCommentEventSchema = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number(),
    pull_request: z.object({ url: z.string().optional() }).nullish(),
  }),
  comment: z.object({ id: z.number(), body: z.string().nullish(), user: UserSchema }),
  changes: z.object({ body: z.object({ from: z.string() }).optional() }).nullish(),
  sender: UserSchema,
});

const ReviewCommentEventSchema = z.object({
  action: z.string(),
  pull_request: z.object({ number: z.number() }),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    in_reply_to_id: z.number().nullish(),
    user: UserSchema,
  }),
  sender: UserSchema,
});

const AnyEventSchema = z.object({
  pull_request: z.object({ number: z.number() }).nullish(),
  issue: z.object({ number: z.number() }).nullish(),
  sender: UserSchema.nullish(),
});

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "ready_for_review", "reopened"]);

/**
 * Decides what to do from the workflow event. Nothing runs without a human
 * trigger, except the review on pull_request events.
 */
export function detectTrigger(
  eventName: string,
  payload: unknown,
  options: { command: string; mode: Mode | "auto"; prNumber: number | null },
): Trigger {
  if (options.mode !== "auto") return forcedTrigger(eventName, payload, options);

  switch (eventName) {
    case "pull_request":
    case "pull_request_target": {
      const event = PullRequestEventSchema.safeParse(payload);
      if (!event.success) return { kind: "skip", reason: "the event payload has no pull request" };
      if (event.data.action && !REVIEW_ACTIONS.has(event.data.action)) {
        return { kind: "skip", reason: `pull request action "${event.data.action}" does not start a review` };
      }
      return { kind: "review", prNumber: event.data.pull_request.number };
    }
    case "issue_comment":
      return issueCommentTrigger(payload, options.command);
    case "pull_request_review_comment":
      return reviewCommentTrigger(payload, options.command);
    default:
      return { kind: "skip", reason: `event "${eventName}" is not supported without the "mode" input` };
  }
}

function issueCommentTrigger(payload: unknown, command: string): Trigger {
  const parsed = IssueCommentEventSchema.safeParse(payload);
  if (!parsed.success) return { kind: "skip", reason: "the comment event payload is not valid" };
  const event = parsed.data;
  if (!event.issue.pull_request) return { kind: "skip", reason: "the comment is not on a pull request" };
  if (isBotUser(event.sender)) return { kind: "skip", reason: `the sender ${event.sender.login} is a bot` };
  const prNumber = event.issue.number;
  const sender = event.sender;
  const body = event.comment.body ?? "";

  if (event.action === "created") {
    const parsedCommand = parseCommand(body, command);
    if (!parsedCommand) return { kind: "skip", reason: "the comment has no command" };
    const source: TriggerSource = { type: "issue-comment", commentId: event.comment.id };
    return fromCommand(parsedCommand, prNumber, sender, source);
  }

  if (event.action === "edited") {
    // Ticking a task-list box edits the comment. Only the sticky comment
    // (a bot comment with the marker) counts.
    const marker = parseMarker(body);
    if (!marker || marker.pr !== prNumber || !isBotUser(event.comment.user)) {
      return { kind: "skip", reason: "the edited comment is not the review comment" };
    }
    const before = event.changes?.body?.from;
    if (before === undefined) return { kind: "skip", reason: "the edit did not change the comment body" };
    const ticked = newlyCheckedActions(before, body);
    const source: TriggerSource = { type: "checkbox", commentId: event.comment.id };
    // One action for each edit. Fixes of the PR first, then CI.
    if (ticked.includes("fix")) {
      return { kind: "fix", prNumber, sender, source, findings: "all", note: "" };
    }
    if (ticked.includes("fix-ci")) return { kind: "fix-ci", prNumber, sender, source };
    const mainFix = ticked.find((id) => id.startsWith("fix-ci-main:"));
    if (mainFix) {
      const target = mainFix.slice("fix-ci-main:".length);
      return {
        kind: "fix-ci-main",
        prNumber,
        sender,
        source,
        target: target === "all" ? "all" : Number(target),
      };
    }
    return { kind: "skip", reason: "no box was ticked" };
  }
  return { kind: "skip", reason: `comment action "${event.action}" is not supported` };
}

function reviewCommentTrigger(payload: unknown, command: string): Trigger {
  const parsed = ReviewCommentEventSchema.safeParse(payload);
  if (!parsed.success) return { kind: "skip", reason: "the review comment event payload is not valid" };
  const event = parsed.data;
  if (event.action !== "created") return { kind: "skip", reason: "only new review comments are commands" };
  if (isBotUser(event.sender)) return { kind: "skip", reason: `the sender ${event.sender.login} is a bot` };
  const parsedCommand = parseCommand(event.comment.body, command);
  if (!parsedCommand) return { kind: "skip", reason: "the review comment has no command" };
  const inReplyTo = event.comment.in_reply_to_id ?? null;
  const source: TriggerSource = { type: "review-comment", commentId: event.comment.id, inReplyTo };
  const trigger = fromCommand(parsedCommand, event.pull_request.number, event.sender, source);
  // A bare "fix" reply under an inline finding selects that finding.
  if (trigger.kind === "fix" && inReplyTo !== null && trigger.findings === "all") {
    return { ...trigger, findings: { inlineReplyTo: inReplyTo } };
  }
  return trigger;
}

function fromCommand(
  command: NonNullable<ReturnType<typeof parseCommand>>,
  prNumber: number,
  sender: Sender,
  source: TriggerSource,
): Trigger {
  switch (command.kind) {
    case "fix":
      return { kind: "fix", prNumber, sender, source, findings: command.findings, note: command.note };
    case "fix-ci":
      return { kind: "fix-ci", prNumber, sender, source };
    case "fix-ci-main":
      // People count from 1; the sticky's triage list counts from 0.
      return {
        kind: "fix-ci-main",
        prNumber,
        sender,
        source,
        target: command.target === "all" ? "all" : command.target - 1,
      };
  }
}

/** The "mode" input is set: run that mode for the PR of the event or the pr-number input. */
function forcedTrigger(
  eventName: string,
  payload: unknown,
  options: { mode: Mode | "auto"; prNumber: number | null },
): Trigger {
  const parsed = AnyEventSchema.safeParse(payload);
  const event: z.infer<typeof AnyEventSchema> = parsed.success ? parsed.data : {};
  const prNumber = options.prNumber ?? event.pull_request?.number ?? event.issue?.number ?? null;
  if (prNumber === null) {
    return { kind: "skip", reason: `event "${eventName}" has no pull request; set the "pr-number" input` };
  }
  if (options.mode === "review") return { kind: "review", prNumber };
  const sender = event.sender;
  if (!sender) return { kind: "skip", reason: "the event has no sender" };
  if (isBotUser(sender)) return { kind: "skip", reason: `the sender ${sender.login} is a bot` };
  const source: TriggerSource = { type: "dispatch" };
  switch (options.mode) {
    case "fix":
      return { kind: "fix", prNumber, sender, source, findings: "all", note: "" };
    case "fix-ci":
      return { kind: "fix-ci", prNumber, sender, source };
    default:
      return { kind: "fix-ci-main", prNumber, sender, source, target: "all" };
  }
}
