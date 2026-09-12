#!/usr/bin/env node
/**
 * `archon-publish` — start, observe, resume and cancel a hosted publication
 * (AHU-006, contract block C5).
 *
 * This file owns argument parsing, output and exit codes and nothing else. The
 * protocol, the request-state file and every validation rule live in
 * `publish.ts`, so a library caller gets typed results without a console write
 * appearing in the middle of them.
 *
 * Two output rules hold everywhere below and are worth stating once:
 *
 *  1. **stdout is one machine-readable JSON object, or nothing.** Progress,
 *     warnings and the human-facing instructions go to stderr. A caller can
 *     therefore pipe stdout into a parser without filtering, and an agent that
 *     reads only stdout can never mistake a progress line for a result.
 *  2. **The operation bearer never appears.** Not in stdout, not in stderr,
 *     and not in `process.argv` — which is why `status`, `resume` and `cancel`
 *     take a request *file* rather than a token. `ps` is readable by other
 *     processes on most machines this will run on.
 *
 * And one exit-code rule, because it is the thing a caller most easily gets
 * wrong: **exit 10 is success**. It means the command did what it was asked
 * and the publication is not finished yet — a human has not approved it, or
 * the poll window ran out. Treating it as a failure and starting again is how
 * one document becomes two.
 */

import { writeSync } from "node:fs";
import { basename } from "node:path";

import {
  cancelPublication,
  checkPublicationUrl,
  defaultDeps,
  defaultStateDir,
  EXIT,
  observeStatus,
  PUBLISH_CONTRACT,
  PublishError,
  readRequestState,
  resumePublication,
  safeText,
  selectServiceOrigin,
  stripControls,
  startPublication,
  STATE_DIR_ENV,
  SERVICE_ORIGIN_ENV,
  validateTimeoutSeconds,
  type PublicationState,
  type Receipt,
  type RequestState,
  type StatusEnvelope,
} from "./publish.js";

const COMMANDS = ["start", "status", "resume", "cancel"] as const;
type Command = (typeof COMMANDS)[number];

const HELP = `archon-publish — publish a built document to a hosted service with
browser approval by a human.

    archon-publish start  --file <html> --title <text> --service <https-origin> [--json]
    archon-publish status --request <file> [--json]
    archon-publish resume --request <file> [--timeout-seconds <n>] [--json]
    archon-publish cancel --request <file> [--json]

start        Validate the file locally, start a publication, write private
             request state and print the browser link and pairing code.
status       Observe the publication once. Never uploads.
resume       Poll within a bounded timeout and upload once a human approves.
cancel       Cancel a pending or approved publication.

Options
  --file <path>            The self-contained HTML file to publish.
  --title <text>           The title the approving human reads. 1-${PUBLISH_CONTRACT.TITLE_MAX_SCALARS} characters.
  --service <origin>       The hosted service origin, e.g. https://docs.example.com.
                           Defaults to ${SERVICE_ORIGIN_ENV} when set.
  --request <path>         The request-state file printed by start.
  --timeout-seconds <n>    resume only. Default ${PUBLISH_CONTRACT.RESUME_TIMEOUT_DEFAULT_SECONDS}, maximum ${PUBLISH_CONTRACT.RESUME_TIMEOUT_MAX_SECONDS}.
  --state-dir <path>       start only. Where private request state lives.
                           Must be an absolute path.
                           Defaults to ${STATE_DIR_ENV}, then \$XDG_STATE_HOME,
                           then ~/.local/state/archon-publish.
  --local-test             start only. Allow a plain-http loopback service
                           origin. Testing only.
  --json                   Print one machine-readable JSON object on stdout.
  -h, --help               Print this help.

Exit codes
  0   Complete. The server returned a durable receipt with the document URL.
  10  Checkpoint, and NOT a failure: the publication is pending or approved and
      the command finished normally. Read nextAction and call again later.
  20  Denied by the human, or cancelled. Terminal.
  21  The authorization window or the completion receipt expired.
  22  Local input, request-state or protocol error. Nothing was published.
  23  A retryable service or network condition. Try the same command again.

A human approves the publication in a browser. This command never signs in,
never sees a GitHub credential or a browser cookie, and never stores an account
login — only a capability for the single publication it started.
`;

/**
 * What a usage error still knows about the invocation that produced it.
 *
 * A usage error can happen before `parse` has returned an `Options`, so the
 * two facts the error envelope needs are recorded as they become known rather
 * than read back off a value that may not exist yet.
 */
const invocation: { json: boolean; command: string } = { json: false, command: "unknown" };

/**
 * Write help and leave, with 0 only when help is what was asked for.
 *
 * `writeSync` rather than `process.stdout.write`, because `process.exit` on the
 * next line does not wait for an asynchronous write to drain and stdout is a
 * pipe whenever this is called from a script — the exact case where the help
 * text would be truncated.
 *
 * A `--json` caller gets the same single error object every other failure
 * gives it. Help is for a person and stays on stderr; an agent that asked for
 * machine-readable output must not have to parse it — being handed a wall of
 * prose and a bare exit code is how a caller ends up guessing at what went
 * wrong, which is exactly what `--json` exists to prevent.
 */
function usage(message?: string): never {
  if (message === undefined) {
    writeSync(1, HELP);
    process.exit(0);
  }
  const text = safeText(message);
  if (invocation.json) {
    writeSync(
      1,
      `${JSON.stringify({
        v: 1,
        command: invocation.command,
        state: "error",
        code: "invalid_input",
        message: text,
      })}\n`,
    );
  }
  writeSync(2, `error: ${text}\n\n${HELP}`);
  process.exit(EXIT.LOCAL);
}

interface Options {
  readonly command: Command;
  readonly flags: ReadonlyMap<string, string>;
  readonly json: boolean;
  readonly localTest: boolean;
}

const VALUE_FLAGS = new Set([
  "--file",
  "--title",
  "--service",
  "--request",
  "--timeout-seconds",
  "--state-dir",
]);

/**
 * Parse `argv` strictly.
 *
 * Unknown flags are refused rather than ignored, and a repeated flag is an
 * error rather than a last-one-wins: `--service a --service b` is a person or
 * a script that believes something untrue about where this is publishing to,
 * and quietly picking one of the two is the worst available answer.
 */
function parse(argv: readonly string[]): Options {
  /* Read before anything can fail, so a usage error raised while parsing still
     answers in the shape the caller asked for. `--json` is positional-free and
     takes no value, so its presence is unambiguous without parsing. */
  invocation.json = argv.includes("--json");
  if (argv.length === 0) usage("missing command");
  if (argv.includes("-h") || argv.includes("--help")) {
    if (argv.length === 1) usage();
    usage("--help takes no other arguments");
  }

  const command = argv[0];
  if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) {
    usage(`unknown command: ${command ?? ""}`);
  }
  invocation.command = command;

  const flags = new Map<string, string>();
  let json = false;
  let localTest = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (arg === "--json") {
      if (json) usage("--json given twice");
      json = true;
    } else if (arg === "--local-test") {
      if (localTest) usage("--local-test given twice");
      localTest = true;
    } else if (VALUE_FLAGS.has(arg)) {
      if (flags.has(arg)) usage(`${arg} given twice`);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) usage(`${arg} needs a value`);
      flags.set(arg, value);
      index += 1;
    } else {
      usage(`unknown option: ${arg}`);
    }
  }
  return { command: command as Command, flags, json, localTest };
}

function required(options: Options, flag: string): string {
  const value = options.flags.get(flag);
  if (value === undefined || value === "") usage(`${options.command} needs ${flag}`);
  return value;
}

function refuse(options: Options, flags: readonly string[]): void {
  for (const flag of flags) {
    if (options.flags.has(flag)) usage(`${options.command} does not take ${flag}`);
  }
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

/** Progress and human instructions. Never a result, never a secret. */
function note(line: string): void {
  writeSync(2, `${line}\n`);
}

/**
 * stdout is one machine-readable JSON object, or it is empty.
 *
 * The human summary goes to stderr with everything else that is not a result.
 * That reads oddly for a command run by hand — nothing on stdout — and it is
 * the point: a caller can redirect stdout into a parser without knowing which
 * mode the command ran in, and a progress line can never be mistaken for a
 * result. `--json` is what asks for the result on stdout.
 */
function emit(options: Options, payload: Record<string, unknown>, human: readonly string[]): void {
  if (options.json) {
    writeSync(1, `${JSON.stringify(payload)}\n`);
    return;
  }
  for (const line of human) note(line);
}

/**
 * What the caller should do next, in words an agent can act on and a person
 * can read.
 *
 * Written from the state rather than from which command produced it, so
 * `status` and `resume` cannot disagree about what a pending publication needs.
 */
function nextActionFor(state: PublicationState, requestPath: string, verificationUrl: string): string {
  const request = stripControls(requestPath);
  switch (state) {
    case "pending":
      return `Ask the human to open ${verificationUrl}, sign in and approve, then run: archon-publish resume --request ${request}`;
    case "approved":
      return `Approved. Upload the artifact with: archon-publish resume --request ${request}`;
    case "complete":
      return "Nothing further. The document is published and the URL below is the server's receipt.";
    case "denied":
      return "The human declined this publication. Do not retry it; start a new one only if they ask.";
    case "cancelled":
      return "This publication was cancelled. Start a new one if it is still wanted.";
    case "expired":
      return "The authorization window closed. Start a new publication with: archon-publish start";
  }
}

function receiptLines(result: Receipt): string[] {
  return [
    `published ${result.url}`,
    `  documentId    ${result.documentId}`,
    `  owner         ${result.ownerAccountId}`,
    `  contentBytes  ${result.contentBytes}`,
    `  contentSha256 ${result.contentSha256}`,
  ];
}

const exitForState: Readonly<Record<PublicationState, number>> = Object.freeze({
  pending: EXIT.CHECKPOINT,
  approved: EXIT.CHECKPOINT,
  complete: EXIT.COMPLETE,
  denied: EXIT.REFUSED,
  cancelled: EXIT.REFUSED,
  expired: EXIT.EXPIRED,
});

/** Report a status/upload/cancel envelope and return the exit code it implies. */
function reportEnvelope(
  options: Options,
  state: RequestState,
  requestFile: string,
  envelope: StatusEnvelope,
  extra: { timedOut?: boolean; windowClosed?: boolean; timeoutSeconds?: number } = {},
): number {
  const nextAction = nextActionFor(envelope.state, requestFile, state.verificationUrl);
  const payload: Record<string, unknown> = {
    v: 1,
    command: options.command,
    state: envelope.state,
    publicationId: state.publicationId,
    requestFile,
    serviceOrigin: state.serviceOrigin,
    nextAction,
  };
  if (envelope.result !== undefined) payload["result"] = envelope.result;

  const human = [`state ${envelope.state}`];
  if (envelope.result !== undefined) human.push(...receiptLines(envelope.result));
  human.push(`next: ${nextAction}`);

  if (extra.timedOut === true) {
    /* Name the bound and what it was waiting for. "Timed out" on its own does
       not tell a caller whether to call again or to go and find the human. */
    note(
      `timed out after ${extra.timeoutSeconds ?? PUBLISH_CONTRACT.RESUME_TIMEOUT_DEFAULT_SECONDS}s waiting for a human to approve this publication at ${state.serviceOrigin}; nothing was uploaded`,
    );
  }
  if (extra.windowClosed === true) {
    note("the server's authorization window has closed; a later status call will say expired");
  }
  note(`service ${state.serviceOrigin}`);
  emit(options, payload, human);
  return exitForState[envelope.state];
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function runStart(options: Options): Promise<number> {
  refuse(options, ["--request", "--timeout-seconds"]);
  const file = required(options, "--file");
  const title = required(options, "--title");
  const serviceOrigin = selectServiceOrigin(
    options.flags.get("--service"),
    process.env,
    options.localTest,
  );
  const stateDir = options.flags.get("--state-dir") ?? defaultStateDir(process.env);

  note(`publishing ${stripControls(basename(file))} to ${serviceOrigin}`);
  const { state, requestFile } = await startPublication(
    { file, title, serviceOrigin, localTest: options.localTest, stateDir },
    defaultDeps(),
  );

  const nextAction = `Ask the human to open ${state.verificationUrl}, confirm the pairing code ${state.userCode}, sign in and approve. Then run: archon-publish resume --request ${stripControls(requestFile)}`;
  /* Exactly the seven fields C5 fixes for this command, and no others. The
     agent secret is in the request file and stays there. */
  emit(
    options,
    {
      v: 1,
      state: "pending",
      requestFile,
      verificationUrl: state.verificationUrl,
      userCode: state.userCode,
      nextAction,
      serviceOrigin: state.serviceOrigin,
    },
    [
      `state pending`,
      `open ${state.verificationUrl}`,
      `pairing code ${state.userCode}`,
      `request ${requestFile}`,
      `next: ${nextAction}`,
    ],
  );
  note(`waiting for a human to approve this publication at ${serviceOrigin}`);
  return EXIT.CHECKPOINT;
}

interface LoadedRequest {
  readonly state: RequestState;
  readonly path: string;
}

function loadRequest(options: Options): LoadedRequest {
  /* `--state-dir` and `--local-test` are start-only. Both are already answered
     by the request file — it *is* the state, and it pins whether this was a
     local test — so accepting them here would be accepting a flag that cannot
     do what the person typing it believes it does. */
  refuse(options, ["--file", "--title", "--service", "--state-dir"]);
  if (options.localTest) usage(`${options.command} does not take --local-test`);
  return readRequestState(required(options, "--request"));
}

async function runStatus(options: Options, { state, path }: LoadedRequest): Promise<number> {
  refuse(options, ["--timeout-seconds"]);
  const envelope = await observeStatus(state, defaultDeps());
  return reportEnvelope(options, state, path, envelope);
}

async function runResume(options: Options, { state, path }: LoadedRequest): Promise<number> {
  const raw = options.flags.get("--timeout-seconds");
  const timeoutSeconds =
    raw === undefined
      ? PUBLISH_CONTRACT.RESUME_TIMEOUT_DEFAULT_SECONDS
      : validateTimeoutSeconds(raw);

  note(`polling ${state.serviceOrigin} for up to ${timeoutSeconds}s`);
  const outcome = await resumePublication(state, defaultDeps(), timeoutSeconds);
  return reportEnvelope(options, state, path, outcome.envelope, {
    timedOut: outcome.timedOut,
    windowClosed: outcome.windowClosed,
    timeoutSeconds,
  });
}

async function runCancel(options: Options, { state, path }: LoadedRequest): Promise<number> {
  refuse(options, ["--timeout-seconds"]);
  const envelope = await cancelPublication(state, defaultDeps());
  if (envelope.state === "complete") {
    note("this publication had already completed; cancel returned its unchanged receipt");
  }
  return reportEnvelope(options, state, path, envelope);
}

/* ------------------------------------------------------------------ */
/* Failure                                                             */
/* ------------------------------------------------------------------ */

/**
 * Report a failure without ever claiming more than is known.
 *
 * `receipt_expired` is the case this function exists for. The 24-hour recovery
 * window has passed, so the client cannot obtain the receipt — but the
 * document may well exist, owned by the person who approved it. So the exit
 * status stays 21 and the output carries a `checkPublicationUrl` built only
 * from the pinned origin and the saved publication ID, labelled "Check
 * publication". It is a place to sign in and look, not a receipt: only owner
 * authentication in a browser settles whether the document is there. Nothing
 * here starts a replacement publication.
 */
function reportFailure(options: Options | null, error: unknown, state: RequestState | null): number {
  const failure =
    error instanceof PublishError
      ? error
      : new PublishError("local", "unexpected_error", (error as Error)?.message ?? String(error));

  const payload: Record<string, unknown> = {
    v: 1,
    command: options?.command ?? invocation.command,
    state: "error",
    code: failure.code,
    message: failure.message,
    /* The two fields an agent needs to decide what to do next without parsing
       prose or memorising this command's exit table. `retryable` is the whole
       question — a service that says no is not a service to come back to — and
       `exitCode` lets a wrapper check that the status it observed is the one
       this object describes. */
    retryable: failure.retryable,
    exitCode: failure.exitCode,
  };
  if (state !== null) {
    payload["publicationId"] = state.publicationId;
    payload["serviceOrigin"] = state.serviceOrigin;
  }
  if (failure.code === "receipt_expired" && state !== null) {
    const url = checkPublicationUrl(state.serviceOrigin, state.publicationId);
    payload["checkPublicationUrl"] = url;
    payload["nextAction"] =
      `Check publication: sign in at ${url} to see whether this document exists. This link is not a receipt, and no replacement publication was started.`;
    note(`Check publication: ${url}`);
    note("this is a sign-in destination, not proof the document exists");
  }

  note(`error: ${failure.message}`);
  note(`code ${failure.code}; retryable ${failure.retryable ? "yes" : "no"}; exit ${failure.exitCode}`);
  /* `writeSync`, for the reason `usage` gives: `process.exitCode` is set on the
     next statement and the process can reach its exit before an asynchronous
     stdout write to a pipe has drained. A `--json` caller that gets an empty
     stdout and a bare non-zero status is in exactly the position `--json`
     exists to prevent, so the one object it was promised is written
     synchronously or not at all. */
  if (options?.json === true || (options === null && invocation.json)) {
    writeSync(1, `${JSON.stringify(payload)}\n`);
  }
  return failure.exitCode;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const options = parse(process.argv.slice(2));

  /* Interruption must not destroy anything. C5 requires request state and the
     source HTML to survive it, so the handler writes nothing and removes
     nothing — it reports the same checkpoint a timeout would. */
  process.on("SIGINT", () => {
    note("interrupted; request state and the source file are unchanged");
    process.exit(EXIT.CHECKPOINT);
  });

  /* Resolved once so a failure after the request file is known can still name
     the publication it belongs to — `receipt_expired` needs exactly that. */
  let state: RequestState | null = null;
  try {
    if (options.command === "start") return await runStart(options);
    const loaded = loadRequest(options);
    state = loaded.state;
    if (options.command === "status") return await runStatus(options, loaded);
    if (options.command === "resume") return await runResume(options, loaded);
    return await runCancel(options, loaded);
  } catch (error) {
    return reportFailure(options, error, state);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.exitCode = reportFailure(null, error, null);
  },
);
