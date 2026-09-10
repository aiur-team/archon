/**
 * The hosted publication client (AHU-006, contract blocks C3 and C5).
 *
 * An agent publishes a built document by *asking a human to approve it in a
 * browser*. That handshake is the whole design: the agent holds one operation
 * bearer that can start, observe, upload and cancel exactly one publication,
 * and never holds a GitHub credential, a browser cookie or an account login.
 * The human signs in, reads the title and byte count they are agreeing to, and
 * approves — and only then does the upload become legal.
 *
 * The awkward part is time. An agent tool invocation can end while the person
 * is still finding the browser tab, so this module is built around a request
 * *file* rather than a live process: `start` writes the pinned service origin,
 * the input path, the approved descriptor and the operation bearer to a
 * mode-0600 file and returns; `status`, `resume` and `cancel` pick that file up
 * in a later process. Split start/resume is a capability here, not polish.
 *
 * Everything below is protocol and state. Formatting and exit codes live in
 * `publish-cli.ts`, so a library caller gets typed results and no incidental
 * console output.
 *
 * ## Why the contract shapes are restated here
 *
 * `netlify/lib/hosted/contracts.mjs` is the executable form of the same wire contract,
 * and this file deliberately does not import it. The installed package is a
 * tarball of `templates/docbuild/dist/`: a repo-relative `../../../netlify/` import
 * resolves during development and is simply absent on a user's machine. So the
 * subset C5 needs is restated in package-owned source, narrowed to what a
 * *client* can check — no public-suffix table, because a client validating its
 * own operator-supplied origin does not need to decide whether two hostnames
 * are the same registrable site.
 *
 * The restatement is bounded on purpose. Where the server contract is
 * permissive this file is permissive too: `userCode` is display text and
 * nothing more, because inventing a stricter client rule would reject a code
 * the server is entitled to mint.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";

/* ------------------------------------------------------------------ */
/* C2/C3 bounds and constants                                          */
/* ------------------------------------------------------------------ */

/**
 * The numeric and lexical bounds this client enforces before it sends
 * anything, and the constants it would otherwise hard-code at four call sites.
 *
 * Validating locally is not an optimisation. A descriptor is what a human
 * approves, so a title that renders differently from its bytes, or a length
 * that disagrees with the file, has to be refused before a person is asked to
 * make a decision about it — not after.
 */
export const PUBLISH_CONTRACT = Object.freeze({
  /** C2: the only artifact format v1 accepts. */
  ARTIFACT_FORMAT: "html",
  /** C3: the exact request media type of `PUT .../artifact`. */
  ARTIFACT_MEDIA_TYPE: "text/html; charset=utf-8",
  /** C2: title bounds, counted in Unicode scalar values, not UTF-16 units. */
  TITLE_MIN_SCALARS: 1,
  TITLE_MAX_SCALARS: 160,
  /** C2: raw artifact byte bounds, BOM included. 2 MiB. */
  HTML_MIN_BYTES: 1,
  HTML_MAX_BYTES: 2097152,
  /** Lowercase-hex field widths. */
  SHA256_HEX_LENGTH: 64,
  PUBLICATION_ID_HEX_LENGTH: 32,
  /** C1 v2: `ownerAccountId` is a truncated subject digest behind this prefix. */
  ACCOUNT_ID_PREFIX: "a0_",
  /** C1/C4: the two app paths a contract record may address. */
  AUTHORIZE_PATH: "/publish/authorize",
  DOCUMENT_PATH_PREFIX: "/docs/",
  /** C3: the poll interval the server advertises and a client floors at. */
  POLL_INTERVAL_SECONDS: 5,
  /** C3: error messages are bounded so an error cannot become a data channel. */
  ERROR_MESSAGE_MAX_LENGTH: 200,
  /** Bounds for opaque bearer material carried on the wire. */
  OPAQUE_TOKEN_MIN_LENGTH: 32,
  OPAQUE_TOKEN_MAX_LENGTH: 256,
  /** C2: the user code is display text; this is the only bound C2 implies. */
  USER_CODE_MAX_SCALARS: 40,
  /** C5: `resume --timeout-seconds` bounds. */
  RESUME_TIMEOUT_DEFAULT_SECONDS: 60,
  RESUME_TIMEOUT_MAX_SECONDS: 300,
  /**
   * The deadline on a single request, including reading its body.
   *
   * `resume --timeout-seconds` is a bound on the *poll loop*, which is only
   * consulted between polls — so without this a service that accepts the
   * connection and then says nothing wedges the command forever and the
   * "bounded, tool-friendly timeout" the whole design rests on is not bounded
   * at all. Thirty seconds is far longer than any legal C3 response needs and
   * short enough that a hung service still returns a checkpoint.
   */
  REQUEST_TIMEOUT_SECONDS: 30,
  /** The ceiling backoff grows to between polls. */
  POLL_MAX_INTERVAL_SECONDS: 30,
  /**
   * The most of a response body this client will read before giving up.
   *
   * Every legal body in C3 is a small JSON object. Reading without a bound
   * would let a hostile or broken service hold the agent's memory hostage
   * through a response the client is going to reject anyway.
   */
  RESPONSE_BODY_MAX_BYTES: 65536,
});

/** C2: every state a publication may be in. */
export const PUBLICATION_STATES = Object.freeze([
  "pending",
  "approved",
  "complete",
  "denied",
  "cancelled",
  "expired",
] as const);

export type PublicationState = (typeof PUBLICATION_STATES)[number];

/**
 * C3's error codes with the retryability the contract fixes for each.
 *
 * `retryable` is derived from the code rather than believed: a service that
 * marks `descriptor_mismatch` retryable cannot talk this client into a retry
 * loop against a request that can never start succeeding.
 */
export const WIRE_ERROR_CODES = Object.freeze({
  invalid_request: false,
  invalid_capability: false,
  session_required: false,
  approval_required: false,
  forbidden: false,
  csrf_failed: false,
  not_found: false,
  descriptor_mismatch: false,
  state_conflict: false,
  authorization_expired: false,
  receipt_expired: false,
  artifact_too_large: false,
  unsupported_media_type: false,
  rate_limited: true,
  unavailable: true,
  publishing_disabled: false,
} as const);

export type WireErrorCode = keyof typeof WIRE_ERROR_CODES;

/**
 * C5's exit codes.
 *
 * `CHECKPOINT` is the one that has to be read carefully, and the README and
 * `--help` both say so: 10 means the command did exactly what it was asked to
 * and the publication is not finished. A caller that treats every non-zero
 * status as failure will report a perfectly healthy pending authorization as
 * an error and, worse, may start a second publication for the same document.
 */
export const EXIT = Object.freeze({
  /** A durable completion receipt was returned by the server. */
  COMPLETE: 0,
  /** Pending or approved: read `nextAction` and call again later. */
  CHECKPOINT: 10,
  /** The human denied it, or it was cancelled. Terminal, not a transport failure. */
  REFUSED: 20,
  /** The authorization window or the completion receipt expired. */
  EXPIRED: 21,
  /** Local input, state or protocol failure. Nothing was published. */
  LOCAL: 22,
  /** A retryable service or network condition. */
  RETRYABLE: 23,
});

/**
 * Characters that must never appear in text a human reads to make a decision.
 *
 * `Cf` covers the bidirectional overrides that let a title render in an order
 * its bytes do not have, and the zero-width characters that let a title
 * display as empty while satisfying a one-character minimum. The approval
 * screen is where a person decides whether to publish; text that renders
 * differently from its bytes there is a way to steer that decision, and no
 * legitimate title needs a format character to be readable.
 *
 * Two spellings of one pattern, because a `g` flag makes `test()` stateful and
 * a shared instance would then answer differently on alternate calls.
 */
const UNSAFE_DISPLAY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_DISPLAY_GLOBAL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** C3 timestamps are exactly what `Date#toISOString` produces, milliseconds included. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The sniff that separates an HTML artifact from bytes that are not markup.
 *
 * Markup, not a document element. `docbuild` composes an artifact as a
 * *fragment* — its own `layout.html` begins at `<meta name="doc-id">` and never
 * emits `<html>`, `<head>` or a doctype — because the hosted renderer supplies
 * the document element itself and drops the artifact into a sandboxed `srcdoc`
 * body. Requiring `<html>` here therefore refused every artifact this package
 * can build, which is a refusal no user could act on: the file was correct and
 * the check was wrong. What the check is actually for is catching a person who
 * pointed `--file` at a PDF, a JSON dump or their notes, and the rule below
 * still catches all three.
 *
 * `netlify/lib/hosted/contracts.mjs` applies the same rule to the uploaded body. The
 * two have to agree: a client-side refusal is an actionable local error, and
 * the same bytes refused only by the server would be a failed upload after a
 * person had already approved it.
 *
 * A *closing* tag rather than any start tag, because "looks like a tag" is not
 * a property prose lacks: `a<b and c>d` satisfies a start-tag pattern and is
 * plainly not markup. Requiring `</name>` (or a doctype, or a self-closing
 * element) costs a real document nothing -- an artifact with no closing tag
 * anywhere is not a document -- and refuses the notes file somebody pointed
 * `--file` at by mistake.
 */
const HTML_MARKUP = /<!doctype\s+html|<\/[a-z][a-z0-9-]*\s*>|<[a-z][a-z0-9-]*(\s[^<>]*)?\/>/i;

/** U+0000 and U+FEFF, spelled as escapes so this file holds no control characters. */
const NUL = "\u0000";
const BYTE_ORDER_MARK = "\uFEFF";

/**
 * C1 v2: `a0_` followed by the first 32 lowercase hex characters of SHA-256 of
 * the identity subject. A client validates only the shape - it never sees the
 * subject, so it has nothing to recompute the digest from.
 */
const ACCOUNT_ID = /^a0_[0-9a-f]{32}$/;

/** The only hosts a loopback-only local-test configuration may name. */
export const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Which C5 exit class a failure belongs to. */
export type PublishFailure = "local" | "refused" | "expired" | "retryable";

const FAILURE_EXIT: Readonly<Record<PublishFailure, number>> = Object.freeze({
  local: EXIT.LOCAL,
  refused: EXIT.REFUSED,
  expired: EXIT.EXPIRED,
  retryable: EXIT.RETRYABLE,
});

/**
 * A failure that already knows which exit class it belongs to.
 *
 * Classifying at the throw site rather than at the top of `main` is what keeps
 * "network unavailable" from being reported as a local input error, and it is
 * the reason every `catch` in the CLI is one branch long.
 */
export class PublishError extends Error {
  readonly failure: PublishFailure;
  readonly code: string;
  readonly exitCode: number;
  /** `Retry-After`, when the service asked for a specific wait. */
  readonly retryAfterSeconds: number | null;

  constructor(failure: PublishFailure, code: string, message: string, retryAfterSeconds: number | null = null) {
    super(safeText(message));
    this.name = "PublishError";
    this.failure = failure;
    this.code = code;
    this.exitCode = FAILURE_EXIT[failure];
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Bound and sanitize text that may have come from a service.
 *
 * Applied unconditionally rather than only to remote strings. A hostile
 * responder's `message` reaches a terminal, an agent transcript and often a
 * log; a megabyte-long message, or one carrying control characters, is a way
 * to bury the rest of the output, and there is no message this client needs to
 * emit that a 200-character bound would spoil.
 */
export function safeText(text: unknown): string {
  const cleaned = String(text).replace(UNSAFE_DISPLAY_GLOBAL, " ").replace(/\s+/g, " ").trim();
  if (cleaned === "") return "unspecified error";
  const scalars = [...cleaned];
  if (scalars.length <= PUBLISH_CONTRACT.ERROR_MESSAGE_MAX_LENGTH) return cleaned;
  return `${scalars.slice(0, PUBLISH_CONTRACT.ERROR_MESSAGE_MAX_LENGTH - 1).join("").trim()}…`;
}

/**
 * Make a value safe to print without changing what it says.
 *
 * `safeText` is for messages: it collapses whitespace, which is right for prose
 * and wrong for a filesystem path, where a run of spaces is part of the name
 * and a caller is expected to paste the result back into a command. This keeps
 * the value intact and only removes the characters that could rewrite the
 * terminal line around it — a path is chosen by whoever invoked the command,
 * but on an agent that can be a name a hostile document proposed.
 */
export function stripControls(text: unknown, max = 1024): string {
  const cleaned = String(text).replace(UNSAFE_DISPLAY_GLOBAL, "\uFFFD");
  const scalars = [...cleaned];
  if (scalars.length <= max) return cleaned;
  return `${scalars.slice(0, max - 1).join("")}…`;
}

const localError = (message: string, code = "invalid_input"): PublishError =>
  new PublishError("local", code, message);

/**
 * A response the client cannot interpret.
 *
 * Deliberately exit class 22 rather than 23: unknown JSON is a protocol error,
 * never success and never a thing to retry. The message names the field and
 * the rule and never the offending value, so a hostile body cannot use this
 * client's own stderr as a reflection channel.
 */
export function protocolError(message: string): PublishError {
  return new PublishError("local", "protocol_error", message);
}

/* ------------------------------------------------------------------ */
/* Service origin                                                      */
/* ------------------------------------------------------------------ */

/**
 * The service origin baked into a release.
 *
 * `null` is the honest value today: no hosted deployment exists yet, and a
 * guessed marketing hostname compiled into a published binary is a domain
 * somebody else can register. AHU-013 sets this to the deployed origin as part
 * of the release that makes it true; until then `--service` or
 * `ARCHON_PUBLISH_SERVICE` is required and the command says so.
 */
export const RELEASED_SERVICE_ORIGIN: string | null = null;

/** The environment variable an operator may use instead of `--service`. */
export const SERVICE_ORIGIN_ENV = "ARCHON_PUBLISH_SERVICE";

/**
 * Validate one service origin, returning its canonical serialization.
 *
 * `URL.origin` is the comparison every later check performs, so the accepted
 * spelling is exactly that serialization. One equality does the work of
 * several: `new URL` lowercases the scheme and host, drops a default port,
 * punycodes an IDN and moves *everything else* — a path, a query, a fragment,
 * a `user:password@` — somewhere that is not the origin. Requiring the input to
 * equal its own origin therefore rejects `https://svc.example@evil.example`,
 * `https://svc.example/api?x=1` and `https://svc.example#f` at once, and
 * rejects them rather than quietly publishing to a normalized version of
 * something else.
 *
 * @param value the operator-supplied origin
 * @param localTest the loopback-only test mode, which relaxes the scheme *and
 *   nothing else*: plain HTTP is accepted only for a loopback host, so the
 *   mode can never describe a real deployment.
 */
export function resolveServiceOrigin(value: unknown, localTest = false): string {
  if (typeof value !== "string" || value === "") {
    throw localError("service origin must be a non-empty string", "invalid_service_origin");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw localError(
      "service origin must be an absolute URL such as https://docs.example.com",
      "invalid_service_origin",
    );
  }
  if (url.origin !== value) {
    throw localError(
      "service origin must be exactly a lowercase scheme://host[:port] with no path, query, fragment or credentials",
      "invalid_service_origin",
    );
  }
  /* A fully-qualified trailing dot survives `URL.origin`, resolves to the same
     host and never string-equals the origin the service compares against. */
  if (url.hostname.endsWith(".")) {
    throw localError("service origin must not end with a trailing dot", "invalid_service_origin");
  }
  if (url.protocol === "https:") return url.origin;
  if (url.protocol !== "http:") {
    throw localError("service origin must use https", "invalid_service_origin");
  }
  if (!localTest) {
    throw localError(
      "service origin must use https; plain http requires --local-test and a loopback host",
      "invalid_service_origin",
    );
  }
  if (!LOOPBACK_HOSTS.includes(url.hostname)) {
    throw localError(
      "--local-test accepts plain http only for localhost, 127.0.0.1 or [::1]",
      "invalid_service_origin",
    );
  }
  return url.origin;
}

/**
 * Where the service origin comes from, in the only order that is safe.
 *
 * The list is deliberately short and deliberately does not include the
 * document. A generated HTML artifact, a repository file and a tool result are
 * all content this client *transports*; letting any of them name the
 * destination would mean a document could choose where it is published to and
 * whose browser is asked to approve it. Only a person configuring the command,
 * or the release itself, decides that.
 */
export function selectServiceOrigin(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  localTest: boolean,
): string {
  /* An empty or whitespace-only environment variable is *unset*, not a value.
     `??` alone treats `ARCHON_PUBLISH_SERVICE=` as configured-to-nothing, which
     both contradicts the documented precedence -- flag, then environment, then
     the release -- and turns a stray `export ARCHON_PUBLISH_SERVICE=` in a
     shell profile into an unexplainable exit 22 on a release that knows its own
     origin. */
  const fromEnv = env[SERVICE_ORIGIN_ENV];
  const configured =
    flag ?? (fromEnv === undefined || fromEnv.trim() === "" ? null : fromEnv) ?? RELEASED_SERVICE_ORIGIN;
  if (configured === null || configured === undefined || configured === "") {
    throw localError(
      `no service origin configured: pass --service <https-origin> or set ${SERVICE_ORIGIN_ENV}`,
      "missing_service_origin",
    );
  }
  return resolveServiceOrigin(configured, localTest);
}

/**
 * The login and recovery destination for a saved publication ID.
 *
 * Built only from the pinned origin and the ID this client started, never from
 * a response. It is emphatically **not** a success receipt: the document may
 * not exist, and only signing in as the owner settles that. `publish-cli.ts`
 * labels it "Check publication" for exactly that reason.
 */
export function checkPublicationUrl(serviceOrigin: string, publicationId: string): string {
  return `${serviceOrigin}${PUBLISH_CONTRACT.DOCUMENT_PATH_PREFIX}${publicationId}`;
}

/* ------------------------------------------------------------------ */
/* Local artifact and descriptor                                       */
/* ------------------------------------------------------------------ */

export interface Artifact {
  /** The absolute path the bytes were read from. */
  readonly path: string;
  /** The exact bytes on disk, BOM included. */
  readonly bytes: Buffer;
  readonly contentSha256: string;
  readonly contentBytes: number;
}

export interface Descriptor {
  readonly v: 1;
  readonly title: string;
  readonly contentSha256: string;
  readonly contentBytes: number;
  readonly artifactFormat: "html";
}

const isLowerHex = (value: unknown, length: number): value is string =>
  typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value);

/**
 * Read and validate the artifact, returning a stable byte snapshot.
 *
 * The snapshot is the point. A path is not proof that its contents are
 * unchanged, so every operation that needs the bytes reads them again and
 * compares the digest against the descriptor the human approved — and the
 * bytes that are hashed are the same buffer that is later uploaded, so no
 * second read can slip between the check and the send.
 */
export function readArtifact(inputPath: string): Artifact {
  const path = resolve(inputPath);
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw localError(`cannot read the artifact at ${path}`, "input_unreadable");
  }
  if (info.isSymbolicLink()) {
    throw localError(`the artifact path is a symlink: ${path}`, "input_not_regular_file");
  }
  if (!info.isFile()) {
    throw localError(`the artifact path is not a regular file: ${path}`, "input_not_regular_file");
  }
  if (info.size > PUBLISH_CONTRACT.HTML_MAX_BYTES) {
    throw localError(
      `the artifact is ${info.size} bytes; the limit is ${PUBLISH_CONTRACT.HTML_MAX_BYTES}`,
      "artifact_too_large",
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw localError(`cannot read the artifact at ${path}`, "input_unreadable");
  }
  if (bytes.byteLength < PUBLISH_CONTRACT.HTML_MIN_BYTES) {
    throw localError(`the artifact at ${path} is empty`, "invalid_input");
  }
  /* The size check runs twice on purpose: the `lstat` one is a cheap refusal
     before a huge read, and this one is what actually holds, because the file
     can grow between the two calls. */
  if (bytes.byteLength > PUBLISH_CONTRACT.HTML_MAX_BYTES) {
    throw localError(
      `the artifact is ${bytes.byteLength} bytes; the limit is ${PUBLISH_CONTRACT.HTML_MAX_BYTES}`,
      "artifact_too_large",
    );
  }

  /* `ignoreBOM: true` *keeps* a leading U+FEFF instead of stripping it — the
     option reads backwards — and `fatal: true` is what makes an invalid
     sequence an error rather than a U+FFFD that would change the bytes while
     still producing a plausible-looking document. */
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw localError(`the artifact at ${path} is not valid UTF-8`, "invalid_input");
  }
  if (html.includes(NUL)) {
    throw localError(`the artifact at ${path} contains a NUL character`, "invalid_input");
  }
  const body = html.startsWith(BYTE_ORDER_MARK) ? html.slice(1) : html;
  if (!HTML_MARKUP.test(body)) {
    throw localError(`the artifact at ${path} is not HTML`, "invalid_input");
  }

  return Object.freeze({
    path,
    bytes,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    contentBytes: bytes.byteLength,
  });
}

/** Validate the title a human will read on the approval screen. */
export function validateTitle(value: unknown): string {
  if (typeof value !== "string") throw localError("--title must be text", "invalid_input");
  if (UNSAFE_DISPLAY.test(value)) {
    throw localError(
      "--title must not contain control, format or line-separator characters",
      "invalid_input",
    );
  }
  if (value.trim() !== value) {
    throw localError("--title must not have leading or trailing whitespace", "invalid_input");
  }
  const scalars = [...value].length;
  if (scalars < PUBLISH_CONTRACT.TITLE_MIN_SCALARS || scalars > PUBLISH_CONTRACT.TITLE_MAX_SCALARS) {
    throw localError(
      `--title must be ${PUBLISH_CONTRACT.TITLE_MIN_SCALARS} to ${PUBLISH_CONTRACT.TITLE_MAX_SCALARS} characters`,
      "invalid_input",
    );
  }
  return value;
}

/**
 * The descriptor a human approves: the title they read plus the digest and
 * length of the bytes they are agreeing to publish.
 *
 * Nothing else belongs in it, and in particular no owner field does — the
 * owner is fixed by the server from the approving browser session, so an
 * `ownerAccountId` here would be an injection attempt and the server rejects
 * the key rather than ignoring it.
 */
export function buildDescriptor(title: string, artifact: Artifact): Descriptor {
  return Object.freeze({
    v: 1 as const,
    title: validateTitle(title),
    contentSha256: artifact.contentSha256,
    contentBytes: artifact.contentBytes,
    artifactFormat: "html" as const,
  });
}

/** Re-check a freshly read artifact against the descriptor already approved. */
export function requireDescriptorMatch(artifact: Artifact, descriptor: Descriptor): void {
  if (
    artifact.contentBytes !== descriptor.contentBytes ||
    artifact.contentSha256 !== descriptor.contentSha256
  ) {
    throw localError(
      `the file at ${artifact.path} has changed since this publication was described; start a new publication to publish the new bytes`,
      "descriptor_mismatch",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Private request state                                               */
/* ------------------------------------------------------------------ */

export interface RequestState {
  readonly v: 1;
  readonly publicationId: string;
  readonly serviceOrigin: string;
  readonly localTest: boolean;
  readonly inputPath: string;
  readonly descriptor: Descriptor;
  /** The operation bearer. Never printed, never passed in argv. */
  readonly agentSecret: string;
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/** The environment variable that relocates the state directory. */
export const STATE_DIR_ENV = "ARCHON_PUBLISH_STATE_DIR";

/**
 * The mode-0700 directory private request state lives in.
 *
 * Outside the repository, always. State carries an operation bearer, and a
 * repository is the one directory an agent is most likely to commit, archive
 * or hand to a code host.
 */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[STATE_DIR_ENV];
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw localError(`${STATE_DIR_ENV} must be an absolute path`, "invalid_state_dir");
    }
    return resolve(override);
  }
  const xdg = env["XDG_STATE_HOME"];
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) {
    return join(resolve(xdg), "archon-publish");
  }
  return join(homedir(), ".local", "state", "archon-publish");
}

/**
 * Create the state directory if it is missing, and refuse it if it is not ours
 * to write into.
 *
 * "Refuse where safe repair cannot be proven" is the rule, and a symlink is
 * the case it exists for: silently `chmod`ing a directory somebody else
 * pointed somewhere sensitive is a worse outcome than an error message.
 *
 * A relative path is refused here rather than resolved, and this is the one
 * check every writer shares. State carries an operation bearer, so "where does
 * it land" must not depend on the working directory the agent happened to be
 * invoked from: `--state-dir relative/state` run inside a checkout writes a
 * secret into the repository, which is the single directory most likely to be
 * committed. `defaultStateDir` already refuses a relative environment
 * override; putting the same rule at the choke point means the `--state-dir`
 * flag and every library caller cannot bypass it.
 */
export function ensureStateDir(dir: string): string {
  if (!isAbsolute(dir)) {
    throw localError(`the state directory must be an absolute path: ${dir}`, "invalid_state_dir");
  }
  const path = resolve(dir);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    throw localError(`the state directory is a symlink: ${path}`, "unsafe_state_dir");
  }
  if (!info.isDirectory()) {
    throw localError(`the state directory is not a directory: ${path}`, "unsafe_state_dir");
  }
  if ((info.mode & 0o077) !== 0) {
    throw localError(
      `the state directory ${path} is group- or world-accessible; it must be mode 0700`,
      "unsafe_state_dir",
    );
  }
  requireOwnedByThisUser(info.uid, path, "state directory", "unsafe_state_dir");
  return path;
}

/**
 * Refuse a path this user does not own.
 *
 * Mode 0700 says "only the owner may read this"; it does not say the owner is
 * us. With the default `~/.local/state` layout the two are the same question,
 * but `--state-dir` and `ARCHON_PUBLISH_STATE_DIR` can name anywhere, and a
 * directory somebody else owns and has made mode 0700 is a place they can read
 * our bearer from. `getuid` is absent on Windows, where this check has no
 * meaning and is skipped rather than faked.
 */
function requireOwnedByThisUser(uid: number, path: string, what: string, code: string): void {
  const me = typeof process.getuid === "function" ? process.getuid() : null;
  if (me !== null && uid !== me) {
    throw localError(`the ${what} ${path} is owned by another user`, code);
  }
}

export function requestStatePath(stateDir: string, publicationId: string): string {
  return join(resolve(stateDir), `${publicationId}.json`);
}

/**
 * Write request state atomically, without following a symlink, at mode 0600.
 *
 * `openSync(..., "wx", 0o600)` is the load-bearing call: `wx` fails rather
 * than following an existing path, so a pre-planted symlink at the temporary
 * name cannot redirect the write, and the mode is applied by `open` rather
 * than by a later `chmod` that would leave a window in which the bearer is
 * world-readable. The `rename` that follows replaces whatever is at the target
 * — including a symlink — rather than writing through it.
 *
 * Nothing unlinks the temporary name first, and the name carries random bytes
 * rather than the pid. Clearing the path before `wx` would give back exactly
 * the property `wx` is here for: an existing entry would stop being a refusal
 * and become a race against re-planting it. A collision is therefore an error,
 * not something to tidy up and proceed through.
 */
export function writeRequestState(stateDir: string, state: RequestState): string {
  const dir = ensureStateDir(stateDir);
  const target = requestStatePath(dir, state.publicationId);
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  const body = `${JSON.stringify(state, null, 2)}\n`;

  let fd: number;
  try {
    fd = openSync(temporary, "wx", 0o600);
  } catch (error) {
    throw localError(
      `cannot create request state at ${temporary}: ${(error as Error).message}`,
      "state_unwritable",
    );
  }
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw localError(
      `cannot write request state to ${target}: ${(error as Error).message}`,
      "state_unwritable",
    );
  }
  return target;
}

const requireStateString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value === "") {
    throw localError(`request state field ${field} is missing or not text`, "invalid_state");
  }
  return value;
};

const requireStateTimestamp = (value: unknown, field: string): string => {
  const text = requireStateString(value, field);
  if (!TIMESTAMP.test(text) || Number.isNaN(Date.parse(text))) {
    throw localError(`request state field ${field} is not a UTC timestamp`, "invalid_state");
  }
  return text;
};

const requireStateDisplayText = (value: unknown, max: number, field: string): string => {
  const text = requireStateString(value, field);
  if (UNSAFE_DISPLAY.test(text) || text.trim() !== text || [...text].length > max) {
    throw localError(`request state field ${field} is not safe display text`, "invalid_state");
  }
  return text;
};

/**
 * Why the browser URL is checked identically on both paths.
 *
 * `validateStartResponse` refuses a verification URL that is not on the pinned
 * origin, because it is the first thing printed and a human is about to sign
 * in there. The request file then carries that URL between processes — and a
 * file on disk is input, so `status` and `resume` print a value this process
 * never checked. Without re-running the same rules, editing one string in a
 * request file redirects the approving human to somebody else's sign-in page,
 * which is precisely the attack the wire-path check exists to stop.
 *
 * @returns the rule that was broken, or `null` when the URL is acceptable.
 */
function verificationUrlProblem(
  value: unknown,
  serviceOrigin: string,
  agentSecret: string | null,
): string | null {
  if (typeof value !== "string") return "must be text";
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    return "must be an absolute URL";
  }
  if (uri.origin !== serviceOrigin) return "must be on the pinned service origin";
  if (uri.pathname !== PUBLISH_CONTRACT.AUTHORIZE_PATH || uri.search !== "") {
    return `must be ${PUBLISH_CONTRACT.AUTHORIZE_PATH} with no query string`;
  }
  if (uri.hash.length < 2) return "must carry the browser secret in its fragment";
  if (agentSecret !== null && uri.hash.includes(agentSecret)) return "must not carry the agent secret";
  return null;
}

/**
 * Read and validate request state, then re-derive everything security-relevant
 * from it rather than trusting it.
 *
 * The file sits on disk between two processes, so it is input. Its origin is
 * re-validated through the same `resolveServiceOrigin` a flag goes through — a
 * state file edited to name `http://evil.example` must not be able to spend
 * the bearer beside it against that host.
 */
export function readRequestState(requestPath: string): { state: RequestState; path: string } {
  const path = resolve(requestPath);
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw localError(`no request state at ${path}`, "state_not_found");
  }
  if (info.isSymbolicLink()) {
    throw localError(`the request path is a symlink: ${path}`, "unsafe_state");
  }
  if (!info.isFile()) {
    throw localError(`the request path is not a regular file: ${path}`, "unsafe_state");
  }
  if ((info.mode & 0o077) !== 0) {
    throw localError(
      `request state ${path} is group- or world-accessible; refusing to use the capability it holds`,
      "unsafe_state",
    );
  }
  requireOwnedByThisUser(info.uid, path, "request state", "unsafe_state");

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw localError(`request state at ${path} is not valid JSON`, "invalid_state");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw localError(`request state at ${path} is not an object`, "invalid_state");
  }
  const raw = parsed as Record<string, unknown>;
  if (raw["v"] !== 1) throw localError(`request state at ${path} is not version 1`, "invalid_state");

  const publicationId = requireStateString(raw["publicationId"], "publicationId");
  if (!isLowerHex(publicationId, PUBLISH_CONTRACT.PUBLICATION_ID_HEX_LENGTH)) {
    throw localError("request state publicationId is malformed", "invalid_state");
  }
  const localTest = raw["localTest"] === true;
  const serviceOrigin = resolveServiceOrigin(
    requireStateString(raw["serviceOrigin"], "serviceOrigin"),
    localTest,
  );
  const inputPath = requireStateString(raw["inputPath"], "inputPath");
  if (!isAbsolute(inputPath)) {
    throw localError("request state inputPath must be absolute", "invalid_state");
  }

  const descriptorRaw = raw["descriptor"];
  if (typeof descriptorRaw !== "object" || descriptorRaw === null || Array.isArray(descriptorRaw)) {
    throw localError("request state descriptor is missing", "invalid_state");
  }
  const fields = descriptorRaw as Record<string, unknown>;
  const contentSha256 = fields["contentSha256"];
  const contentBytes = fields["contentBytes"];
  if (
    fields["v"] !== 1 ||
    fields["artifactFormat"] !== PUBLISH_CONTRACT.ARTIFACT_FORMAT ||
    !isLowerHex(contentSha256, PUBLISH_CONTRACT.SHA256_HEX_LENGTH) ||
    typeof contentBytes !== "number" ||
    !Number.isSafeInteger(contentBytes) ||
    contentBytes < PUBLISH_CONTRACT.HTML_MIN_BYTES ||
    contentBytes > PUBLISH_CONTRACT.HTML_MAX_BYTES
  ) {
    throw localError("request state descriptor is malformed", "invalid_state");
  }
  const descriptor: Descriptor = Object.freeze({
    v: 1 as const,
    title: validateTitle(fields["title"]),
    contentSha256,
    contentBytes,
    artifactFormat: "html" as const,
  });

  const agentSecret = requireStateString(raw["agentSecret"], "agentSecret");
  if (
    agentSecret.length < PUBLISH_CONTRACT.OPAQUE_TOKEN_MIN_LENGTH ||
    agentSecret.length > PUBLISH_CONTRACT.OPAQUE_TOKEN_MAX_LENGTH
  ) {
    throw localError("request state capability is malformed", "invalid_state");
  }

  const verificationUrl = requireStateString(raw["verificationUrl"], "verificationUrl");
  const problem = verificationUrlProblem(verificationUrl, serviceOrigin, agentSecret);
  if (problem !== null) {
    throw localError(`request state verificationUrl ${problem}`, "invalid_state");
  }

  const state: RequestState = Object.freeze({
    v: 1 as const,
    publicationId,
    serviceOrigin,
    localTest,
    inputPath,
    descriptor,
    agentSecret,
    verificationUrl,
    userCode: requireStateDisplayText(
      raw["userCode"],
      PUBLISH_CONTRACT.USER_CODE_MAX_SCALARS,
      "userCode",
    ),
    expiresAt: requireStateTimestamp(raw["expiresAt"], "expiresAt"),
    createdAt: requireStateTimestamp(raw["createdAt"], "createdAt"),
  });
  return { state, path };
}

/* ------------------------------------------------------------------ */
/* Wire validation                                                     */
/* ------------------------------------------------------------------ */

const requireRecord = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
};

const requireExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw protocolError(`${field} does not carry exactly the fields this protocol version defines`);
  }
};

const requireDisplayText = (value: unknown, max: number, field: string): string => {
  if (typeof value !== "string") throw protocolError(`${field} must be text`);
  if (UNSAFE_DISPLAY.test(value)) {
    throw protocolError(`${field} must not contain control or format characters`);
  }
  if (value.trim() !== value) throw protocolError(`${field} must not be padded with whitespace`);
  const scalars = [...value].length;
  if (scalars < 1 || scalars > max) throw protocolError(`${field} is outside its length bounds`);
  return value;
};

const requireTimestamp = (value: unknown, field: string): string => {
  /* The exact `Date#toISOString` spelling, milliseconds included, because that
     is the one spelling the server contract emits and accepting a second
     spelling here would mean two clients disagreeing about equality. */
  if (typeof value !== "string" || !TIMESTAMP.test(value)) {
    throw protocolError(`${field} must be a UTC ISO-8601 timestamp`);
  }
  if (Number.isNaN(Date.parse(value))) throw protocolError(`${field} must be a real instant`);
  return value;
};

export interface StartResponse {
  readonly v: 1;
  readonly publicationId: string;
  readonly verificationUriComplete: string;
  readonly userCode: string;
  readonly agentSecret: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}

const START_KEYS = [
  "v",
  "publicationId",
  "verificationUriComplete",
  "userCode",
  "agentSecret",
  "expiresAt",
  "intervalSeconds",
] as const;

/**
 * Validate the C3 start response against the origin this client pinned.
 *
 * Two checks earn their place. The browser URL must live on the *pinned* app
 * origin at the authorize path, because it is the first thing printed and the
 * human is about to visit it — a self-consistent response naming
 * `https://evil.example/publish/authorize` would otherwise be handed straight
 * to a person as the place to sign in. And the fragment must not contain the
 * agent secret: C3 puts the *browser* secret there, and an agent bearer in a
 * URL is handed to anything that sees a referrer, a history entry or a
 * shoulder.
 */
export function validateStartResponse(value: unknown, serviceOrigin: string): StartResponse {
  const body = requireRecord(value, "start response");
  requireExactKeys(body, START_KEYS, "start response");
  if (body["v"] !== 1) throw protocolError("start response v must be 1");

  const publicationId = body["publicationId"];
  if (!isLowerHex(publicationId, PUBLISH_CONTRACT.PUBLICATION_ID_HEX_LENGTH)) {
    throw protocolError("start response publicationId must be 32 lowercase hex characters");
  }
  const userCode = requireDisplayText(
    body["userCode"],
    PUBLISH_CONTRACT.USER_CODE_MAX_SCALARS,
    "start response userCode",
  );
  const agentSecret = body["agentSecret"];
  if (
    typeof agentSecret !== "string" ||
    agentSecret.length < PUBLISH_CONTRACT.OPAQUE_TOKEN_MIN_LENGTH ||
    agentSecret.length > PUBLISH_CONTRACT.OPAQUE_TOKEN_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(agentSecret)
  ) {
    throw protocolError("start response agentSecret is not an opaque bearer token");
  }
  const expiresAt = requireTimestamp(body["expiresAt"], "start response expiresAt");
  if (body["intervalSeconds"] !== PUBLISH_CONTRACT.POLL_INTERVAL_SECONDS) {
    throw protocolError(
      `start response intervalSeconds must be ${PUBLISH_CONTRACT.POLL_INTERVAL_SECONDS}`,
    );
  }

  const uriText = body["verificationUriComplete"];
  const problem = verificationUrlProblem(uriText, serviceOrigin, agentSecret);
  if (problem !== null) {
    throw protocolError(`start response verificationUriComplete ${problem}`);
  }

  return Object.freeze({
    v: 1 as const,
    publicationId,
    verificationUriComplete: uriText as string,
    userCode,
    agentSecret,
    expiresAt,
    intervalSeconds: PUBLISH_CONTRACT.POLL_INTERVAL_SECONDS,
  });
}

export interface Receipt {
  readonly documentId: string;
  readonly url: string;
  readonly ownerAccountId: string;
  readonly contentSha256: string;
  readonly contentBytes: number;
}

export interface StatusEnvelope {
  readonly v: 1;
  readonly state: PublicationState;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
  readonly result?: Receipt;
}

const ENVELOPE_KEYS = ["v", "state", "expiresAt", "intervalSeconds"] as const;
const RESULT_KEYS = ["documentId", "url", "ownerAccountId", "contentSha256", "contentBytes"] as const;

/**
 * Validate the C3 status / completion envelope against the pinned origin.
 *
 * Two rules are load-bearing. `result` is present exactly when the state is
 * `complete` — a receipt attached to any other state is a success claim for a
 * document that does not exist. And the receipt URL must be this document's
 * own `/docs/<documentId>` path on the *pinned* origin, because a hostile
 * responder can be perfectly self-consistent about
 * `https://evil.example/docs/<id>` and this client would print it as the
 * user's published document.
 */
export function validateStatusEnvelope(value: unknown, serviceOrigin: string): StatusEnvelope {
  const body = requireRecord(value, "status response");
  if (Object.hasOwn(body, "error")) {
    throw protocolError("status response must not be an error envelope");
  }

  const hasResult = Object.hasOwn(body, "result");
  requireExactKeys(body, hasResult ? [...ENVELOPE_KEYS, "result"] : ENVELOPE_KEYS, "status response");
  if (body["v"] !== 1) throw protocolError("status response v must be 1");

  const state = body["state"];
  if (typeof state !== "string" || !(PUBLICATION_STATES as readonly string[]).includes(state)) {
    throw protocolError("status response state is not a state this protocol version defines");
  }
  const expiresAt = requireTimestamp(body["expiresAt"], "status response expiresAt");
  if (body["intervalSeconds"] !== PUBLISH_CONTRACT.POLL_INTERVAL_SECONDS) {
    throw protocolError(
      `status response intervalSeconds must be ${PUBLISH_CONTRACT.POLL_INTERVAL_SECONDS}`,
    );
  }

  if (state === "complete" && !hasResult) {
    throw protocolError('status response result is required while state is "complete"');
  }
  if (state !== "complete" && hasResult) {
    throw protocolError('status response result is only permitted while state is "complete"');
  }
  if (!hasResult) {
    return Object.freeze({
      v: 1 as const,
      state: state as PublicationState,
      expiresAt,
      intervalSeconds: PUBLISH_CONTRACT.POLL_INTERVAL_SECONDS,
    });
  }

  const fields = requireRecord(body["result"], "status response result");
  requireExactKeys(fields, RESULT_KEYS, "status response result");
  const documentId = fields["documentId"];
  if (!isLowerHex(documentId, PUBLISH_CONTRACT.PUBLICATION_ID_HEX_LENGTH)) {
    throw protocolError("status response result documentId must be 32 lowercase hex characters");
  }
  const ownerAccountId = fields["ownerAccountId"];
  if (typeof ownerAccountId !== "string" || !ACCOUNT_ID.test(ownerAccountId)) {
    throw protocolError("status response result ownerAccountId is malformed");
  }
  const contentSha256 = fields["contentSha256"];
  if (!isLowerHex(contentSha256, PUBLISH_CONTRACT.SHA256_HEX_LENGTH)) {
    throw protocolError("status response result contentSha256 must be 64 lowercase hex characters");
  }
  const contentBytes = fields["contentBytes"];
  if (
    typeof contentBytes !== "number" ||
    !Number.isSafeInteger(contentBytes) ||
    contentBytes < PUBLISH_CONTRACT.HTML_MIN_BYTES ||
    contentBytes > PUBLISH_CONTRACT.HTML_MAX_BYTES
  ) {
    throw protocolError("status response result contentBytes is outside its bounds");
  }
  const url = fields["url"];
  if (typeof url !== "string" || url !== checkPublicationUrl(serviceOrigin, documentId)) {
    throw protocolError(
      "status response result url must be this document's /docs/<documentId> path on the pinned service origin",
    );
  }

  return Object.freeze({
    v: 1 as const,
    state: "complete" as const,
    expiresAt,
    intervalSeconds: PUBLISH_CONTRACT.POLL_INTERVAL_SECONDS,
    result: Object.freeze({ documentId, url, ownerAccountId, contentSha256, contentBytes }),
  });
}

/**
 * Bind a completion receipt to the publication this client actually started.
 *
 * `validateStatusEnvelope` proves the receipt is *self*-consistent — well-formed
 * fields, a `/docs/<documentId>` URL on the pinned origin. That leaves one gap,
 * and it is the only success claim in this client taken on the service's word:
 * nothing compares the receipt to what this request was about. A service that
 * answers the first status poll with a well-formed receipt for a different
 * document, or for different bytes, gets `published <url>` and exit 0 out of a
 * command that uploaded nothing.
 *
 * Both equalities are re-derivable locally, so both are checked. The digest and
 * length are the bytes the human approved. The document ID must be this
 * publication's ID because C3 builds the recovery destination as
 * `/docs/<saved-publicationId>` — a document at any other path could not be
 * found by the client's own documented check link.
 */
export function requireReceiptBinding(envelope: StatusEnvelope, state: RequestState): StatusEnvelope {
  const receipt = envelope.result;
  if (receipt === undefined) return envelope;
  if (receipt.documentId !== state.publicationId) {
    throw protocolError("the completion receipt names a different publication than this request started");
  }
  if (
    receipt.contentSha256 !== state.descriptor.contentSha256 ||
    receipt.contentBytes !== state.descriptor.contentBytes
  ) {
    throw protocolError("the completion receipt describes different bytes than the approved descriptor");
  }
  return envelope;
}

/** How a wire error code maps onto a C5 exit class. */
function failureForCode(code: WireErrorCode): PublishFailure {
  if (WIRE_ERROR_CODES[code]) return "retryable";
  if (code === "authorization_expired" || code === "receipt_expired") return "expired";
  return "local";
}

/**
 * Turn a non-2xx body into a typed error, or into a protocol error when the
 * body is not a legal C3 envelope.
 *
 * Nothing from the body reaches the message except a `message` that passed the
 * contract's own bounds and then `safeText` again. A raw provider error, an
 * HTML error page or an unfiltered body never appears in output.
 */
export function wireErrorFrom(
  status: number,
  value: unknown,
  retryAfterSeconds: number | null = null,
): PublishError {
  let body: Record<string, unknown>;
  try {
    body = requireRecord(value, "error response");
    requireExactKeys(body, ["v", "error"], "error response");
  } catch {
    return protocolError(
      `the service returned HTTP ${status} with a body this client cannot interpret`,
    );
  }
  if (body["v"] !== 1) {
    return protocolError(`the service returned HTTP ${status} with an unknown envelope version`);
  }
  const error = body["error"];
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return protocolError(`the service returned HTTP ${status} with a malformed error envelope`);
  }
  const fields = error as Record<string, unknown>;
  try {
    requireExactKeys(fields, ["code", "message", "retryable"], "error");
  } catch {
    return protocolError(`the service returned HTTP ${status} with a malformed error envelope`);
  }
  const code = fields["code"];
  if (typeof code !== "string" || !Object.hasOwn(WIRE_ERROR_CODES, code)) {
    return protocolError(
      `the service returned HTTP ${status} with an error code this client does not know`,
    );
  }
  const typed = code as WireErrorCode;
  if (fields["retryable"] !== WIRE_ERROR_CODES[typed]) {
    return protocolError(`the service returned ${typed} with the wrong retryability for that code`);
  }
  const message = fields["message"];
  const text =
    typeof message === "string" && [...message].length <= PUBLISH_CONTRACT.ERROR_MESSAGE_MAX_LENGTH
      ? safeText(message)
      : "the service did not supply a usable message";
  return new PublishError(failureForCode(typed), typed, `${typed}: ${text}`, retryAfterSeconds);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

/**
 * The seams a test replaces.
 *
 * `fetch`, the clock, sleeping and jitter are injected rather than reached
 * for, because the polling behaviour C5 specifies — five-second initial
 * spacing, `Retry-After`, growing backoff, a bounded timeout — is only
 * assertable if a test can drive time. The state directory is a separate
 * override and just as important: a test that wrote to the real user-local
 * directory would read and mutate an operator's live publications.
 */
export interface PublishDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

export function defaultDeps(): PublishDeps {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    sleep: async (ms: number) => {
      await sleepFor(ms);
    },
    random: () => Math.random(),
  };
}

interface WireRequest {
  readonly origin: string;
  readonly path: string;
  readonly method: "POST" | "PUT";
  readonly bearer?: string;
  readonly json?: unknown;
  readonly body?: Buffer;
  readonly contentType?: string;
}

interface WireResponse {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  readonly json: unknown;
}

/**
 * Read a response body, refusing one that is too large *while* reading it.
 *
 * Buffering the whole body and then checking its length is not a bound — by
 * the time the check runs the memory has already been spent, so a service
 * answering a status poll with a multi-gigabyte body kills the agent before a
 * single validation rule gets to run. Every legal C3 body is a small JSON
 * object, so the counter stops the read at the limit and cancels the stream.
 */
async function readBounded(response: Response, max: number, origin: string): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw protocolError(`the service declared a response body larger than ${max} bytes`);
  }

  const stream = response.body;
  if (stream === null) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > max) {
        throw protocolError(`the service returned more than ${max} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof PublishError) throw error;
    throw new PublishError(
      "retryable",
      "network_unavailable",
      `cannot read the response from ${origin}: ${(error as Error).message}`,
    );
  }
  return Buffer.concat(chunks);
}

/** `Retry-After` in its delta-seconds form, ignored when it is not one. */
export function parseRetryAfter(header: string | null): number | null {
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) return null;
  return Math.ceil(seconds);
}

/**
 * One request, with the two habits that keep a bearer from leaving with it.
 *
 * `redirect: "manual"` plus an outright refusal of any 3xx is the first: a
 * redirect followed while an `Authorization` header is attached hands the
 * operation capability to whatever host the response named, and "follow only
 * same-origin redirects" is a rule with more edge cases than value here — C3
 * defines no redirect, so one is a protocol violation. The second is that no
 * cookie is ever sent or stored: agent endpoints reject browser `Cookie` and
 * `Origin` headers, and this client has no browser session to offer them.
 */
async function send(deps: PublishDeps, request: WireRequest): Promise<WireResponse> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (request.bearer !== undefined) headers["authorization"] = `Bearer ${request.bearer}`;
  if (request.contentType !== undefined) headers["content-type"] = request.contentType;

  let body: string | Uint8Array | undefined;
  if (request.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(request.json);
  } else if (request.body !== undefined) {
    body = new Uint8Array(request.body);
  }

  let response: Response;
  try {
    response = await deps.fetch(`${request.origin}${request.path}`, {
      method: request.method,
      headers,
      redirect: "manual",
      /* Covers reading the body as well as establishing the connection, which
         is the half a connect timeout would miss: a service that sends headers
         and then trickles is as effective at wedging an agent as one that
         never answers. */
      signal: AbortSignal.timeout(PUBLISH_CONTRACT.REQUEST_TIMEOUT_SECONDS * 1000),
      ...(body === undefined ? {} : { body }),
    });
  } catch (error) {
    throw new PublishError(
      "retryable",
      "network_unavailable",
      `cannot reach ${request.origin}: ${(error as Error).message}`,
    );
  }

  if (response.status >= 300 && response.status < 400) {
    /* Cancel rather than abandon: an undrained body holds the socket open for
       the rest of the process's life. */
    await response.body?.cancel().catch(() => undefined);
    throw protocolError(
      `the service answered with an HTTP ${response.status} redirect; this client never follows a redirect while holding a capability`,
    );
  }

  const raw = await readBounded(response, PUBLISH_CONTRACT.RESPONSE_BODY_MAX_BYTES, request.origin);
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    throw protocolError(`the service returned HTTP ${response.status} with a body that is not JSON`);
  }

  return {
    status: response.status,
    retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
    json,
  };
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

export interface StartInput {
  readonly file: string;
  readonly title: string;
  readonly serviceOrigin: string;
  readonly localTest: boolean;
  readonly stateDir: string;
}

export interface StartResult {
  readonly state: RequestState;
  readonly requestFile: string;
}

/**
 * Start a publication and durably record it before telling anyone it exists.
 *
 * The ordering is the contract: state is written before this function returns,
 * so a caller killed just after the server created the operation still has the
 * request file needed to resume or cancel it. The reverse ordering loses the
 * bearer and strands a pending record nobody can finish.
 */
export async function startPublication(input: StartInput, deps: PublishDeps): Promise<StartResult> {
  const artifact = readArtifact(input.file);
  const descriptor = buildDescriptor(input.title, artifact);
  const stateDir = ensureStateDir(input.stateDir);

  const response = await send(deps, {
    origin: input.serviceOrigin,
    path: "/api/hosted/publications",
    method: "POST",
    json: descriptor,
  });
  if (response.status !== 201) {
    if (response.status === 200) {
      throw protocolError("the service answered a publication start with HTTP 200 rather than 201");
    }
    throw wireErrorFrom(response.status, response.json, response.retryAfterSeconds);
  }
  /* Past this point the service has created a publication, so every failure
     below is a failure that leaves one behind. Saying "nothing was published"
     there — which is what exit 22 means — is what talks a wrapper into calling
     `start` a second time for the same document. */
  let started: StartResponse;
  try {
    started = validateStartResponse(response.json, input.serviceOrigin);
  } catch (error) {
    throw protocolError(
      `the service created a publication and answered with a body this client cannot trust, so it can be neither resumed nor cancelled; do not retry automatically (${
        error instanceof PublishError ? error.message : "invalid start response"
      })`,
    );
  }

  const state: RequestState = Object.freeze({
    v: 1 as const,
    publicationId: started.publicationId,
    serviceOrigin: input.serviceOrigin,
    localTest: input.localTest,
    inputPath: artifact.path,
    descriptor,
    agentSecret: started.agentSecret,
    verificationUrl: started.verificationUriComplete,
    userCode: started.userCode,
    expiresAt: started.expiresAt,
    createdAt: new Date(deps.now()).toISOString(),
  });
  try {
    const requestFile = writeRequestState(stateDir, state);
    return { state, requestFile };
  } catch (error) {
    /* The capability is about to be lost with this process. Spending it once
       on a cancellation leaves the service with a closed publication rather
       than a pending one nobody holds the bearer for. */
    let cancelled = "could not be cancelled";
    try {
      await cancelPublication(state, deps);
      cancelled = "was cancelled";
    } catch {
      /* Nothing further is available; the message says so rather than implying
         a tidy outcome that did not happen. */
    }
    throw localError(
      `request state could not be saved (${(error as Error).message}); the publication ${cancelled}, so do not retry automatically`,
      "state_unwritable",
    );
  }
}

/** Observe the publication exactly once. Never uploads. */
export async function observeStatus(state: RequestState, deps: PublishDeps): Promise<StatusEnvelope> {
  const response = await send(deps, {
    origin: state.serviceOrigin,
    path: `/api/hosted/publications/${state.publicationId}/status`,
    method: "POST",
    bearer: state.agentSecret,
  });
  if (response.status !== 200) {
    throw wireErrorFrom(response.status, response.json, response.retryAfterSeconds);
  }
  return requireReceiptBinding(validateStatusEnvelope(response.json, state.serviceOrigin), state);
}

/**
 * Upload the approved bytes, recovering the receipt when the answer is lost.
 *
 * An ambiguous upload is the dangerous case in this whole protocol: the
 * request may have completed durably on the server while the response never
 * arrived, so retrying blindly risks a second publication and giving up risks
 * reporting failure for a document that exists. Neither is acceptable, so the
 * recovery is to *ask*: one status call with the same bearer, which returns
 * the original receipt if the upload landed. That is also why nothing here
 * starts a replacement publication — only an explicit new `start` may.
 */
export async function uploadArtifact(state: RequestState, deps: PublishDeps): Promise<StatusEnvelope> {
  /* Re-read and re-check on every attempt. The descriptor is what a human
     approved; the path is only where the bytes were, and a file that changed
     between approval and upload must not be published under that approval. */
  const artifact = readArtifact(state.inputPath);
  requireDescriptorMatch(artifact, state.descriptor);

  try {
    const response = await send(deps, {
      origin: state.serviceOrigin,
      path: `/api/hosted/publications/${state.publicationId}/artifact`,
      method: "PUT",
      bearer: state.agentSecret,
      body: artifact.bytes,
      contentType: PUBLISH_CONTRACT.ARTIFACT_MEDIA_TYPE,
    });
    if (response.status !== 201 && response.status !== 200) {
      throw wireErrorFrom(response.status, response.json, response.retryAfterSeconds);
    }
    const envelope = requireReceiptBinding(
      validateStatusEnvelope(response.json, state.serviceOrigin),
      state,
    );
    if (envelope.state !== "complete" || envelope.result === undefined) {
      throw protocolError("the service accepted the artifact without returning a completion receipt");
    }
    return envelope;
  } catch (error) {
    /* Every failure inside that block happens with the request already sent,
       so the upload may have completed durably whatever went wrong afterwards
       — a dropped connection, a 409 that means "already finished", a garbled
       201 body. Reporting any of them as "nothing was published" would be a
       guess, and the wrong one is the expensive direction. So ask once. */
    const recovered = await recoverAmbiguousUpload(state, deps);
    if (recovered !== null) return recovered;
    throw error;
  }
}

/** One status call after a lost upload answer. `null` when it did not land. */
async function recoverAmbiguousUpload(
  state: RequestState,
  deps: PublishDeps,
): Promise<StatusEnvelope | null> {
  try {
    const envelope = await observeStatus(state, deps);
    return envelope.state === "complete" ? envelope : null;
  } catch {
    /* The recovery probe failing tells us nothing new, so the original upload
       failure — which the caller still holds — stays the reported one. */
    return null;
  }
}

/**
 * Cancel a pending or approved publication.
 *
 * A publication that already completed is not deleted by this: C3 says cancel
 * returns the unchanged result, and this client reports that receipt rather
 * than a cancellation, because the document exists and saying otherwise would
 * be a lie with a URL attached.
 */
export async function cancelPublication(
  state: RequestState,
  deps: PublishDeps,
): Promise<StatusEnvelope> {
  const response = await send(deps, {
    origin: state.serviceOrigin,
    path: `/api/hosted/publications/${state.publicationId}/cancel`,
    method: "POST",
    bearer: state.agentSecret,
  });
  if (response.status !== 200) {
    throw wireErrorFrom(response.status, response.json, response.retryAfterSeconds);
  }
  return requireReceiptBinding(validateStatusEnvelope(response.json, state.serviceOrigin), state);
}

/* ------------------------------------------------------------------ */
/* Polling                                                             */
/* ------------------------------------------------------------------ */

/**
 * How long to wait before the next poll.
 *
 * The floor is the interval the server advertises, which C3 fixes at five
 * seconds; from there the wait grows by half each time up to thirty seconds,
 * and `Retry-After` overrides the growth entirely when the service asked for a
 * specific wait. Jitter is +/-20% so a fleet of agents that started together
 * does not stay in lockstep for a whole authorization window. The floor is
 * applied last, so neither jitter nor a small `Retry-After` can poll faster
 * than the server asked to be polled.
 */
export function nextPollDelayMs(
  attempt: number,
  retryAfterSeconds: number | null,
  random: () => number,
): number {
  const floor = PUBLISH_CONTRACT.POLL_INTERVAL_SECONDS * 1000;
  const ceiling = PUBLISH_CONTRACT.POLL_MAX_INTERVAL_SECONDS * 1000;
  if (retryAfterSeconds !== null) {
    /* Jitter only ever adds here. Spreading a `Retry-After` in both directions
       would let the client come back sooner than the service asked, on the one
       path where the service has already said it is being asked too often. */
    const requested = Math.max(floor, retryAfterSeconds * 1000);
    return Math.round(requested * (1 + random() * 0.2));
  }
  const base = Math.min(ceiling, Math.round(floor * 1.5 ** Math.max(0, attempt)));
  const jitter = 1 + (random() * 2 - 1) * 0.2;
  return Math.max(floor, Math.round(base * jitter));
}

/** Validate `--timeout-seconds` against the C5 bounds. */
export function validateTimeoutSeconds(value: unknown): number {
  const seconds = typeof value === "number" ? value : Number(String(value).trim());
  if (
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > PUBLISH_CONTRACT.RESUME_TIMEOUT_MAX_SECONDS
  ) {
    throw localError(
      `--timeout-seconds must be a whole number of seconds from 1 to ${PUBLISH_CONTRACT.RESUME_TIMEOUT_MAX_SECONDS}`,
      "invalid_input",
    );
  }
  return seconds;
}

export interface ResumeOutcome {
  readonly envelope: StatusEnvelope;
  /** True when the command stopped on its own timeout rather than on an answer. */
  readonly timedOut: boolean;
  /** True when the authorization window closed while this command was polling. */
  readonly windowClosed: boolean;
  readonly polls: number;
}

/**
 * Poll within a bounded, tool-friendly timeout and upload once approved.
 *
 * Three separate limits stop this loop, and conflating any two of them would
 * produce a wrong answer:
 *
 *  - the caller's timeout, which ends in a *checkpoint* — nothing is wrong,
 *    the human simply has not finished yet;
 *  - the server's own `expiresAt`, which this client never polls past. It
 *    takes one observation at or after the deadline so the *server* can say
 *    `expired`, then stops rather than inventing that verdict itself;
 *  - a terminal state, which ends the loop immediately.
 */
export async function resumePublication(
  state: RequestState,
  deps: PublishDeps,
  timeoutSeconds: number,
): Promise<ResumeOutcome> {
  const deadline = deps.now() + timeoutSeconds * 1000;
  const serverExpiry = Date.parse(state.expiresAt);
  let attempt = 0;
  let polls = 0;
  let observedAtOrAfterExpiry = false;

  /** The last wait before the server's own deadline is clamped onto it. */
  const waitFor = (wait: number): number =>
    Number.isFinite(serverExpiry) && deps.now() + wait > serverExpiry
      ? Math.max(0, serverExpiry - deps.now())
      : wait;

  for (;;) {
    observedAtOrAfterExpiry =
      observedAtOrAfterExpiry || (Number.isFinite(serverExpiry) && deps.now() >= serverExpiry);

    let envelope: StatusEnvelope;
    try {
      envelope = await observeStatus(state, deps);
    } catch (error) {
      /* A rate limit, a transient outage or a dropped connection is a reason
         to wait, not a reason to abandon a publication a human may already
         have approved. Anything the classifier does not call retryable — a
         refused capability, a protocol violation — is not something waiting
         fixes, so it leaves immediately. Deciding this from `failure` rather
         than from a list of codes keeps the two in step; the earlier code list
         silently excluded `network_unavailable`, the most common one of all. */
      if (!(error instanceof PublishError) || error.failure !== "retryable") throw error;
      polls += 1;
      const wait = nextPollDelayMs(attempt, error.retryAfterSeconds, deps.random);
      /* The same two limits as the success path: waiting past the caller's
         timeout, or past a window that has already closed, is not waiting for
         anything that can still happen. */
      if (deps.now() + wait > deadline || observedAtOrAfterExpiry) throw error;
      attempt += 1;
      await deps.sleep(waitFor(wait));
      continue;
    }
    polls += 1;

    if (envelope.state === "approved") {
      return {
        envelope: await uploadArtifact(state, deps),
        timedOut: false,
        windowClosed: false,
        polls,
      };
    }
    if (envelope.state !== "pending") {
      return { envelope, timedOut: false, windowClosed: false, polls };
    }

    const envelopeExpiry = Date.parse(envelope.expiresAt);
    if (observedAtOrAfterExpiry || deps.now() >= envelopeExpiry) {
      /* An observation has already been made at or past the server's deadline.
         Continuing would be polling an authorization that can no longer become
         approved, and calling it expired here would be inventing a verdict the
         server did not give. */
      return { envelope, timedOut: false, windowClosed: true, polls };
    }

    const wait = nextPollDelayMs(attempt, null, deps.random);
    attempt += 1;
    const wakeAt = deps.now() + wait;
    if (wakeAt > deadline) return { envelope, timedOut: true, windowClosed: false, polls };
    /* Clamp the last sleep onto the server's deadline so the loop takes exactly
       one observation past it rather than sailing a whole interval beyond. */
    const clamped = wakeAt > envelopeExpiry ? Math.max(0, envelopeExpiry - deps.now()) : wait;
    await deps.sleep(waitFor(clamped));
  }
}

/**
 * Whether a state admits no further transition.
 *
 * Exposed rather than acted on: C5 says request state and the source HTML
 * survive interruption and error, so nothing in this client deletes either. A
 * caller that wants to tidy has to decide that for itself.
 */
export function isTerminal(state: PublicationState): boolean {
  return state === "complete" || state === "denied" || state === "cancelled" || state === "expired";
}
