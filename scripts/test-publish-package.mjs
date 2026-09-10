#!/usr/bin/env node
/**
 * AHU-010 — the permanent clean-consumer package regression.
 *
 *   node scripts/test-publish-package.mjs
 *
 * One entry point, no arguments. It packs the real `@aiur-team/docbuild`
 * tarball, installs it into a fresh temporary directory **outside this
 * repository**, and then does everything the packaged agent instructions tell a
 * new user to do — from the installed package only.
 *
 * The point is the isolation, not the coverage. Every other gate in this
 * repository runs against the checkout, where `templates/base/`,
 * `templates/skeleton/` and `skills/archon-doc/` are all present on disk and
 * the builder's own `repoRoot()` walk finds them. A source-checkout assumption
 * therefore passes every one of those gates and fails for the first person who
 * runs `npm install`. This runner is the only thing standing between that
 * defect and a release, so it asserts against the consumer tree and never
 * reads a repository file except to compare bytes against what shipped.
 *
 * What it proves, in order:
 *
 *   1. the tarball installs into a directory with no `templates/base/` above it
 *      and no other `@aiur-team/docbuild` on its resolution path;
 *   2. `docbuild`, `archon-publish`, the skeleton, the base assets and
 *      `dist/skills/archon-doc/SKILL.md` are all installed, and the packaged
 *      skill is byte-identical to the canonical source;
 *   3. every installed path and every command flag the skill names actually
 *      exists in the installed package or its `--help`;
 *   4. the installed builder composes a real document whose directory basename
 *      differs from its slug, writes the `--hosted` artifact at the path the
 *      skill promises, carries no remote font link or legacy collaboration
 *      client, and leaves the source and the normal artifact alone;
 *   5. the installed publisher drives start → checkpoint → resume → complete
 *      against a local C3 protocol fixture, in separate processes, with the
 *      exact exit codes and stdout shapes C5 fixes;
 *   6. the publisher refuses a missing file, a missing request state, an
 *      invalid service origin and an unconfigured service origin, and reports
 *      denial, authorization expiry and receipt expiry as their own exit codes;
 *   7. nothing in any captured stream ever carried a bearer token or a byte of
 *      the document.
 *
 * The protocol fixture is a local HTTP server that answers the four C3 agent
 * routes. It proves **packaging** — that the installed command speaks the
 * protocol it was built for. It is emphatically not evidence about a real
 * service, real GitHub sign-in or a real human approval: nobody signs in here,
 * no account exists, and every identity, code and token below is invented.
 * AHU-013 owns the live claim.
 *
 * Nothing here reads a credential, a real repository, a remote provider or a
 * private document. Publisher state goes to a private temporary state root, so
 * a run can never read or mutate an operator's live publications.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  guardedTempRoot,
  installSignalCleanup,
  removeTempRoots,
  retainEvidenceRoot,
  sweepStaleTempRoots,
} from "./lib/temp-roots.mjs";

const execFileAsync = promisify(execFile);

/**
 * The server's own descriptor validator, imported rather than restated.
 *
 * The fixture below is the only implementation of the agent routes this runner
 * can reach, and a fixture that accepts whatever the client sends proves the
 * client talks to *itself*. Holding the start body against the real
 * `validateDescriptor` is what makes it prove the client talks to the service:
 * a renamed, dropped or added descriptor key fails here instead of on somebody's
 * first real publish. `scripts/test-hosted-renderer.mjs` binds the renderer to
 * the same module for the same reason.
 *
 * It resolves out of `hosted/node_modules`, which CI installs several steps
 * before this one; the message says so rather than letting an import error
 * surface as an unexplained crash.
 */
let validateDescriptor;
try {
  ({ validateDescriptor } = await import("../hosted/lib/contracts.mjs"));
} catch (error) {
  process.stderr.write(
    "FAIL  package consumer proof: cannot load hosted/lib/contracts.mjs" +
      ` (${error.message.split("\n")[0]});` +
      " run `npm --prefix hosted ci --ignore-scripts --no-audit --no-fund` first\n",
  );
  process.exit(1);
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_DIR = join(ROOT, "templates", "docbuild");
const CANONICAL_SKILL = join(ROOT, "skills", "archon-doc", "SKILL.md");

/** The installed layout the skill, the README and this runner all name. */
const INSTALLED = {
  package: "node_modules/@aiur-team/docbuild",
  skill: "node_modules/@aiur-team/docbuild/dist/skills/archon-doc/SKILL.md",
  skeleton: "node_modules/@aiur-team/docbuild/dist/skeleton",
  base: "node_modules/@aiur-team/docbuild/dist/base/layout.html",
  docbuild: "node_modules/.bin/docbuild",
  publish: "node_modules/.bin/archon-publish",
};

/** C5's exit codes, restated here so a change to either side is a failure. */
const EXIT = { COMPLETE: 0, CHECKPOINT: 10, REFUSED: 20, EXPIRED: 21, LOCAL: 22, RETRYABLE: 23 };

const POLL_INTERVAL_SECONDS = 5;
const AUTHORIZE_PATH = "/publish/authorize";
const DOCUMENT_PATH_PREFIX = "/docs/";
const ARTIFACT_MEDIA_TYPE = "text/html; charset=utf-8";

/**
 * A string that appears in the built document's body and nowhere else, so the
 * leak check can look for the document's *content* rather than for markup that
 * a legitimate diagnostic might coincidentally contain.
 */
const DOCUMENT_SENTINEL = "sentinel-payload-cf41d7";

const TEMP_PREFIX = "archon-pkg-";

/**
 * Anything above `dir` that would give a consumer a source-checkout fallback,
 * or `null` when there is nothing.
 *
 * Two fallbacks matter and both are ancestor lookups, which is why they are
 * checked the same way. The builder's `repoRoot()` walks up from its working
 * directory for `templates/base/layout.html` and builds from the first one it
 * finds, and Node's resolution walks up for `node_modules`. A consumer with
 * either above it is not a clean consumer, and every assertion in this file
 * would pass for the wrong reason.
 */
function checkoutFallbackAbove(dir) {
  /* Resolved, not merely absolute. `dirname()` walks the *spelling* of a path,
     so a `TMPDIR` (or a `/tmp`) that is a symlink into a checkout walks a chain
     of ancestors that does not exist on disk and finds nothing -- while the
     child process, whose `cwd` is the resolved path, walks the real ancestors,
     finds `templates/base/layout.html` and builds from the repository. That is
     the one assertion this whole file rests on, bypassed by a symlink. */
  let start;
  try {
    start = realpathSync(dir);
  } catch {
    start = resolve(dir);
  }
  for (let at = start; ; at = dirname(at)) {
    if (statSafe(join(at, "templates", "base", "layout.html")) !== null) {
      return `${at}/templates/base/layout.html`;
    }
    if (statSafe(join(at, "node_modules", "@aiur-team")) !== null) {
      return `${at}/node_modules/@aiur-team`;
    }
    if (dirname(at) === at) return null;
  }
}

/**
 * A temporary directory with no source checkout above it.
 *
 * `os.tmpdir()` honours `TMPDIR`, and a sandbox or a git worktree can easily
 * point it somewhere with a checkout overhead — inside this repository, or
 * inside the repository this worktree was cut from. Falling back to the
 * platform default keeps the isolation real rather than turning the assertion
 * that enforces it into something a run can be configured past.
 */
function isolatedTmpdir() {
  const rejected = [];
  for (const candidate of [tmpdir(), "/tmp"]) {
    const fallback = checkoutFallbackAbove(candidate);
    if (fallback === null) return candidate;
    rejected.push(`${candidate} (${fallback} is above it)`);
  }
  throw new Error(`no usable temporary directory: ${rejected.join(", ")}; set TMPDIR to one`);
}

const roots = [];
const transcript = [];
const secrets = new Set();

/* --------------------------------------------------------------- process */

/**
 * Run a command and record everything it wrote.
 *
 * Every invocation goes through here, because the leak assertion at the end is
 * only worth anything if it sees every stream. `shell: false` throughout: a
 * shell would put arguments — and, in the fallback this file warns against, a
 * bearer — into a command line other processes can read.
 *
 * Asynchronous rather than `spawnSync`, and that is load-bearing rather than a
 * style choice: the C3 protocol fixture listens in *this* process, and a
 * synchronous spawn blocks the event loop that would have to accept its
 * connection. Every publisher invocation would then sit until its own request
 * timeout and report the service as unreachable.
 */
async function run(command, args, options = {}) {
  const entry = { argv: [command, ...args].join(" "), status: 0, stdout: "", stderr: "" };
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      ...options,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    entry.stdout = stdout;
    entry.stderr = stderr;
  } catch (error) {
    if (typeof error.code !== "number") throw new Error(`could not run ${command}: ${error.message}`);
    entry.status = error.code;
    entry.stdout = error.stdout ?? "";
    entry.stderr = error.stderr ?? "";
  }
  transcript.push(entry);
  return entry;
}

/** `run`, with the exit code asserted, so a failure names what it was running. */
async function runExpecting(expected, command, args, options = {}) {
  const entry = await run(command, args, options);
  assert.equal(
    entry.status,
    expected,
    `${entry.argv} exited ${entry.status}, expected ${expected}\n` +
      `stdout: ${entry.stdout}\nstderr: ${entry.stderr}`,
  );
  return entry;
}

/** The single JSON object a `--json` invocation is contractually allowed. */
function stdoutJson(entry) {
  const text = entry.stdout.trim();
  assert.notEqual(text, "", `${entry.argv} wrote nothing to stdout under --json`);
  assert.equal(
    text.split("\n").length,
    1,
    `${entry.argv} wrote more than one line to stdout: ${text}`,
  );
  return JSON.parse(text);
}

/* ----------------------------------------------------------------- fixture */

function wireError(code, message, retryable = false) {
  return { v: 1, error: { code, message, retryable } };
}

function envelope(state, expiresAt, result) {
  const body = { v: 1, state, expiresAt, intervalSeconds: POLL_INTERVAL_SECONDS };
  if (result !== undefined) body.result = result;
  return body;
}

/**
 * A local HTTP service that answers the four C3 agent routes.
 *
 * `plan` is set by the test immediately before it invokes `start`, and the
 * publication the fixture creates keeps it for its whole life. That is what
 * lets one server serve every scenario below — an approval, a denial, an
 * expiry and a lost receipt — without the test having to keep a queue of
 * replies in step with a sequence of separate processes.
 */
async function startFixture() {
  const publications = new Map();
  const violations = [];
  let plan = { kind: "approve" };

  /* Recorded, never thrown. An `assert` inside the request callback is an
     uncaught exception rather than a test failure: the process dies where it
     stands, `main`'s cleanup never runs, the temp root leaks, and the message
     names the fixture instead of the publisher invocation that caused it. The
     list is asserted on the main path once the lifecycle is done. */
  const require = (condition, message) => {
    if (!condition) violations.push(message);
    return condition;
  };

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = request.url ?? "";
      const origin = `http://127.0.0.1:${server.address().port}`;
      const send = (status, json) => {
        response.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store" });
        response.end(JSON.stringify(json));
      };

      if (url === "/api/hosted/publications") {
        if (!require(request.method === "POST", `start must be POST, was ${request.method}`)) {
          send(405, wireError("invalid_request", "only POST is supported"));
          return;
        }
        if (!require(
          request.headers["content-type"] === "application/json",
          `start must send application/json, sent ${request.headers["content-type"]}`,
        )) {
          send(415, wireError("unsupported_media_type", "expected application/json"));
          return;
        }
        /* The server's own validator, not a hand copy: an added, dropped or
           renamed descriptor key is refused here exactly as production would
           refuse it, rather than being echoed back and called a pass. */
        let descriptor;
        try {
          descriptor = validateDescriptor(JSON.parse(body.toString("utf8")));
        } catch (error) {
          violations.push(`start descriptor is not a valid C2 descriptor: ${error.message}`);
          send(400, wireError("invalid_request", "descriptor rejected"));
          return;
        }
        const publicationId = randomBytes(16).toString("hex");
        const agentSecret = randomBytes(32).toString("base64url");
        secrets.add(agentSecret);
        publications.set(publicationId, {
          plan,
          descriptor,
          agentSecret,
          uploaded: false,
          uploads: 0,
        });
        send(201, {
          v: 1,
          publicationId,
          verificationUriComplete: `${origin}${AUTHORIZE_PATH}#${randomBytes(16).toString("base64url")}`,
          userCode: "TEST-CODE",
          agentSecret,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          intervalSeconds: POLL_INTERVAL_SECONDS,
        });
        return;
      }

      const match = /^\/api\/hosted\/publications\/([0-9a-f]{32})\/(status|artifact|cancel)$/.exec(url);
      if (match === null) {
        send(404, wireError("not_found", "no such route"));
        return;
      }
      const [, publicationId, route] = match;
      /* The real handlers refuse a wrong method with 405 and any browser
         credential with 403 before they look at the bearer. A fixture that
         answered 200 to a `GET /status` or to a request carrying `Origin`
         would let exactly that regression ship green. */
      const expectedMethod = route === "artifact" ? "PUT" : "POST";
      if (!require(
        request.method === expectedMethod,
        `${route} must be ${expectedMethod}, was ${request.method}`,
      )) {
        send(405, wireError("invalid_request", `only ${expectedMethod} is supported`));
        return;
      }
      for (const header of ["cookie", "origin"]) {
        if (!require(
          request.headers[header] === undefined,
          `${route} must not send a ${header} header`,
        )) {
          send(403, wireError("forbidden", "agent endpoints do not accept browser credentials"));
          return;
        }
      }
      const record = publications.get(publicationId);
      if (record === undefined) {
        send(404, wireError("not_found", "no such publication"));
        return;
      }
      const bearer = `Bearer ${record.agentSecret}`;
      if (request.headers.authorization !== bearer) {
        send(401, wireError("invalid_capability", "bad capability"));
        return;
      }
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const receipt = () => ({
        documentId: publicationId,
        url: `${origin}${DOCUMENT_PATH_PREFIX}${publicationId}`,
        ownerAccountId: "gh_4242",
        contentSha256: record.descriptor.contentSha256,
        contentBytes: record.descriptor.contentBytes,
      });

      if (route === "cancel") {
        send(200, envelope(record.uploaded ? "complete" : "cancelled", expiresAt, record.uploaded ? receipt() : undefined));
        return;
      }

      if (route === "artifact") {
        require(
          request.headers["content-type"] === ARTIFACT_MEDIA_TYPE,
          `the artifact upload must carry ${ARTIFACT_MEDIA_TYPE}, sent ${request.headers["content-type"]}`,
        );
        require(
          createHash("sha256").update(body).digest("hex") === record.descriptor.contentSha256,
          "the uploaded bytes are not the bytes the descriptor described",
        );
        record.uploaded = true;
        record.uploads += 1;
        send(201, envelope("complete", expiresAt, receipt()));
        return;
      }

      switch (record.plan.kind) {
        case "approve":
          send(200, envelope(record.uploaded ? "complete" : "approved", expiresAt, record.uploaded ? receipt() : undefined));
          return;
        case "pending":
          send(200, envelope("pending", expiresAt, undefined));
          return;
        case "deny":
          send(200, envelope("denied", expiresAt, undefined));
          return;
        case "authorization-expired":
          send(410, wireError("authorization_expired", "the authorization window closed"));
          return;
        case "receipt-expired":
          send(410, wireError("receipt_expired", "the completion receipt window closed"));
          return;
        default:
          send(500, wireError("unavailable", "unplanned", true));
      }
    });
  });

  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    /** Every protocol rule the client broke, asserted on the main path. */
    violations,
    /** How many times the artifact route accepted bytes for one publication. */
    uploads(publicationId) {
      return publications.get(publicationId)?.uploads ?? 0;
    },
    /** The plan every publication started from now on will follow. */
    plan(next) {
      plan = next;
    },
    /**
     * Change one existing publication's plan.
     *
     * This is how the fixture expresses "the human has now approved it": the
     * publication was created while nobody had decided, and the decision
     * arrives between two separate `archon-publish` processes, which is exactly
     * the shape C5 splits the lifecycle into.
     */
    replan(publicationId, next) {
      const record = publications.get(publicationId);
      assert.notEqual(record, undefined, `no fixture publication ${publicationId}`);
      record.plan = next;
    },
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  };
}

/* -------------------------------------------------------------------- pack */

/** Pack the real tarball, exactly as a release would. */
async function packTarball(into) {
  if (!statSafe(join(PACKAGE_DIR, "node_modules", "typescript"))) {
    throw new Error(
      "typescript is not installed; run `npm --prefix templates/docbuild ci --no-audit --no-fund` first",
    );
  }
  const packed = await run("npm", ["pack", "--pack-destination", into, "--silent"], { cwd: PACKAGE_DIR });
  assert.equal(packed.status, 0, `npm pack failed:\n${packed.stderr}`);
  const tarballs = readdirSync(into).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, `expected one tarball in ${into}, found ${tarballs.join(", ")}`);

  /* postpack has to have put the checkout back. A staged copy left behind
     would make the next `npm pack` in this checkout pass for a reason a clean
     clone does not have. */
  assert.equal(
    statSafe(join(PACKAGE_DIR, "dist", "skills")),
    null,
    "npm pack left staged skill assets in the checkout; postpack did not clean up",
  );
  return join(into, tarballs[0]);
}

/** Every file under `dir`, as paths relative to it, recursively. */
function filesUnder(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), relative));
    else out.push(relative);
  }
  return out.sort();
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/**
 * Install the tarball into a consumer directory that has no relationship to
 * this repository, and prove it.
 *
 * `--ignore-scripts` is deliberate: a published tarball must be usable without
 * running any of its own code at install time, and a lifecycle script that
 * quietly rebuilt something would hide exactly the packaging defect this file
 * exists to catch.
 */
async function installConsumer(consumer, tarball) {
  assert.ok(
    !`${consumer}${sep}`.startsWith(`${ROOT}${sep}`),
    `the consumer directory ${consumer} is inside this repository`,
  );
  assert.equal(
    checkoutFallbackAbove(consumer),
    null,
    `the consumer at ${consumer} has a source-checkout fallback above it`,
  );

  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "archon-consumer", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  const install = await run(
    "npm",
    ["install", tarball, "--no-audit", "--no-fund", "--ignore-scripts", "--silent"],
    { cwd: consumer },
  );
  assert.equal(install.status, 0, `installing the tarball failed:\n${install.stderr}`);
}

/* ------------------------------------------------------------------ phases */

function assertInstalledLayout(consumer) {
  for (const [what, relative] of Object.entries(INSTALLED)) {
    assert.notEqual(statSafe(join(consumer, relative)), null, `the installed package has no ${what} at ${relative}`);
  }
  assert.notEqual(
    statSafe(join(consumer, INSTALLED.skeleton, "doc.json")),
    null,
    "the installed skeleton has no doc.json",
  );

  const packaged = readFileSync(join(consumer, INSTALLED.skill));
  const canonical = readFileSync(CANONICAL_SKILL);
  assert.deepEqual(
    createHash("sha256").update(packaged).digest("hex"),
    createHash("sha256").update(canonical).digest("hex"),
    "the packaged skill is not byte-identical to skills/archon-doc/SKILL.md",
  );

  /* Every staged asset, not one file per directory. `templates/base` is read
     through two different helpers: `read()` hard-fails on a missing file, but
     `slot()` returns "" for one, so a tarball that shipped `layout.html` and
     dropped `history.js` or `theme.css` builds green and hands the consumer a
     document with no changelog and no styling. Worse, the "no remote font, no
     legacy client" assertions further down are satisfied *most* strongly by an
     empty asset set -- so stopping at one `statSafe` would make a stripped
     tarball look like the best possible pass. */
  let staged = 0;
  for (const [source, installed] of [
    [join(ROOT, "templates", "base"), join(consumer, INSTALLED.package, "dist", "base")],
    [join(ROOT, "templates", "skeleton"), join(consumer, INSTALLED.package, "dist", "skeleton")],
  ]) {
    for (const relative of filesUnder(source)) {
      const shipped = statSafe(join(installed, relative));
      assert.notEqual(shipped, null, `the tarball is missing the staged asset ${relative}`);
      assert.equal(
        createHash("sha256").update(readFileSync(join(installed, relative))).digest("hex"),
        createHash("sha256").update(readFileSync(join(source, relative))).digest("hex"),
        `the staged asset ${relative} differs from its canonical source`,
      );
      staged += 1;
    }
  }
  console.log(
    `PASS  installed layout: builder, publisher, packaged skill and ${staged} staged assets, all byte-identical`,
  );
}

/**
 * Hold the skill's own instructions against the package it ships in.
 *
 * A path or a flag that a user copies out of the skill and runs is part of the
 * product, so a rename that leaves the prose behind is a defect in exactly the
 * same way a broken import is. Both directions are read from the installed
 * copy, so this cannot pass by reading the checkout.
 */
async function assertSkillMatchesPackage(consumer) {
  const skill = readFileSync(join(consumer, INSTALLED.skill), "utf8");

  const paths = [...new Set([...skill.matchAll(/node_modules\/@aiur-team\/docbuild[\w./-]*/g)].map((m) => m[0].replace(/[./]+$/, "")))];
  assert.ok(paths.length >= 3, `the skill names ${paths.length} installed paths; expected the package, the skeleton and itself`);
  for (const named of paths) {
    assert.notEqual(statSafe(join(consumer, named)), null, `the skill names ${named}, which the installed package does not have`);
  }

  const builderHelp = await runExpecting(0, join(consumer, INSTALLED.docbuild), ["--help"], { cwd: consumer });
  const publishHelp = await runExpecting(0, join(consumer, INSTALLED.publish), ["--help"], { cwd: consumer });
  const help = `${builderHelp.stdout}${builderHelp.stderr}${publishHelp.stdout}${publishHelp.stderr}`;

  for (const command of ["start", "status", "resume", "cancel"]) {
    assert.ok(
      new RegExp(`archon-publish ${command}\\b`).test(publishHelp.stdout + publishHelp.stderr),
      `archon-publish --help does not document the ${command} command the skill tells people to run`,
    );
  }
  const flags = [...new Set([...skill.matchAll(/(?<![\w-])--[a-z][a-z-]+/g)].map((m) => m[0]))];
  for (const flag of flags) {
    /* Word-bounded, not a substring: `help.includes("--time")` is satisfied by
       `--timeout-seconds`, so a flag the skill invented would pass by being a
       prefix of a real one. */
    assert.ok(
      new RegExp(`${flag}(?![a-z-])`).test(help),
      `the skill names ${flag}, which neither installed command's --help documents`,
    );
  }
  for (const code of Object.values(EXIT)) {
    assert.ok(
      new RegExp(`^\\s*\\|?\\s*${code}\\s`, "m").test(skill),
      `the skill's exit-code table has no row for ${code}`,
    );
    assert.ok(
      new RegExp(`^\\s*${code}\\s{2,}`, "m").test(publishHelp.stdout),
      `archon-publish --help has no exit-code line for ${code}`,
    );
  }
  console.log(`PASS  the skill's ${paths.length} installed paths and ${flags.length} flags all exist in the package`);
}

/**
 * Build a real document with the installed builder.
 *
 * The instance directory is deliberately named something other than the slug in
 * `doc.json`. The output is named after the *directory*, the skill says so, and
 * a document whose two names agree could not tell the difference.
 */
async function buildDocument(consumer) {
  const instance = "notes-and-decisions";
  const instanceDir = join(consumer, instance);
  cpSync(join(consumer, INSTALLED.skeleton), instanceDir, { recursive: true });

  writeFileSync(
    join(instanceDir, "doc.json"),
    `${JSON.stringify(
      {
        id: "a41c07",
        slug: "payments-review",
        aliases: [],
        title: "Payments review",
        eyebrow: "Platform · Payments",
        status: "Draft for review",
        heading: "What the payments path guarantees",
        lede: "One settlement path, two failure modes, and the one guarantee that survives both.",
        meta: { DRI: "A. Consumer", Status: "Drafted", Related: "none" },
        footer: "Payments review · Draft · Internal",
      },
      null,
      2,
    )}\n`,
  );
  /* Written in the section format the skill teaches — the metadata comment,
     then the body — so a change to either one has to change the other. */
  for (const [index, name] of readdirSync(join(instanceDir, "sections")).entries()) {
    const id = name.replace(/^\d+-/, "").replace(/\.html$/, "");
    writeFileSync(
      join(instanceDir, "sections", name),
      `<!--\nid: ${id}\nlabel: Section ${index + 1}\nsummary: What section ${index + 1} concludes.\n-->\n` +
        `<!-- body -->\n      <h2>Section ${index + 1}</h2>\n` +
        `      <p>Consumer fixture content. ${DOCUMENT_SENTINEL}</p>\n`,
    );
  }

  const normal = await runExpecting(0, join(consumer, INSTALLED.docbuild), [instance], { cwd: consumer });
  const hosted = await runExpecting(0, join(consumer, INSTALLED.docbuild), [instance, "--hosted"], { cwd: consumer });

  const expected = join(instanceDir, "dist", `${instance}.hosted.html`);
  assert.ok(
    hosted.stdout.includes(`${instance}/dist/${instance}.hosted.html`),
    `the builder did not report the hosted artifact path; it said:\n${hosted.stdout}`,
  );
  assert.notEqual(statSafe(expected), null, `the installed builder did not write ${expected}`);
  assert.ok(
    normal.stdout.includes(`${instance}/dist/${instance}.html`),
    "the normal profile must still write <instance>.html",
  );
  /* The slug is not the filename, and a build that started naming output after
     it would break every path in the skill. */
  assert.equal(statSafe(join(instanceDir, "dist", "payments-review.hosted.html")), null, "output must be named after the instance directory, not the slug");

  const html = readFileSync(expected, "utf8");
  assert.ok(html.includes(DOCUMENT_SENTINEL), "the hosted artifact does not contain the document's own content");

  /* Positive markers first, because every check below this is a *negative* one
     and an empty artifact satisfies all of them. Each of these comes from a
     different staged asset routed through a different builder helper, so a
     silently-dropped one fails here instead of shipping. */
  for (const [marker, from] of [
    ['<meta name="doc-id" content="a41c07">', "doc.json metadata"],
    ["<title>Payments review</title>", "the document title"],
    ["--bg", "templates/base/theme.css"],
    ["scanBlocks", "the compiled anchor core"],
    ["runHistory", "templates/base/history.js"],
  ]) {
    assert.ok(html.includes(marker), `the hosted artifact carries nothing from ${from} (${marker})`);
  }
  for (const remote of ["fonts.googleapis.com", "fonts.gstatic.com"]) {
    assert.ok(!html.includes(remote), `the hosted artifact still references ${remote}`);
  }
  for (const endpoint of ["/api/session", "/api/threads", "/api/edit", "/api/realtime-token", "/api/access"]) {
    assert.ok(!html.includes(endpoint), `the hosted artifact still carries the legacy ${endpoint} client`);
  }

  /* Retention: building the hosted profile leaves the source and the normal
     artifact exactly where they were. The skill promises the local HTML stays
     available when publishing cannot happen, and that promise starts here. */
  assert.notEqual(statSafe(join(instanceDir, "doc.json")), null, "the builder removed the source doc.json");
  assert.notEqual(statSafe(join(instanceDir, "sections")), null, "the builder removed the source sections");
  assert.notEqual(statSafe(join(instanceDir, "dist", `${instance}.html`)), null, "the hosted build removed the normal artifact");

  console.log(`PASS  installed builder wrote ${instance}/dist/${instance}.hosted.html from a slug-mismatched instance`);
  return expected;
}

/**
 * Drive the whole publication lifecycle through separate processes.
 *
 * Separate processes rather than one library call, because that is the shape
 * C5 fixes and the shape the skill teaches: `start` finishes while a human has
 * not decided yet, and `resume` is a *different* invocation that finds the
 * publication again through the request file alone.
 */
async function publishLifecycle(consumer, artifact, fixture, stateDir) {
  const publish = join(consumer, INSTALLED.publish);
  const env = { ARCHON_PUBLISH_STATE_DIR: stateDir, ARCHON_PUBLISH_SERVICE: "" };
  const startArgs = (title) => [
    "start",
    "--file", artifact,
    "--title", title,
    "--service", fixture.origin,
    "--local-test",
    "--json",
  ];

  /* 1. start, while nobody has approved anything: exit 10 and exactly the
        seven fields C5 allows this command to print. */
  fixture.plan({ kind: "pending" });
  const started = await runExpecting(EXIT.CHECKPOINT, publish, startArgs("Payments review"), { cwd: consumer, env });
  const start = stdoutJson(started);
  assert.deepEqual(
    Object.keys(start).sort(),
    ["nextAction", "requestFile", "serviceOrigin", "state", "userCode", "v", "verificationUrl"],
    `start printed fields C5 does not fix: ${Object.keys(start).join(", ")}`,
  );
  assert.equal(start.state, "pending");
  assert.equal(start.serviceOrigin, fixture.origin, "start must report the resolved service origin");
  assert.ok(started.stderr.includes(fixture.origin), "the resolved service origin must be visible to the human on stderr");
  assert.ok(start.verificationUrl.startsWith(`${fixture.origin}${AUTHORIZE_PATH}#`), "the browser link must be on the pinned origin");
  assert.ok(
    start.requestFile.startsWith(`${stateDir}${sep}`),
    `request state landed at ${start.requestFile}, outside the private state directory`,
  );
  assert.ok(
    !`${start.requestFile}`.startsWith(`${consumer}${sep}`),
    "request state must never be written into the consumer's own tree",
  );
  assert.equal(statSafe(start.requestFile).mode & 0o777, 0o600, "request state must be mode 0600");
  assert.equal(statSafe(stateDir).mode & 0o777, 0o700, "the state directory must be mode 0700");

  /* 2. status observes once, uploads nothing, and stays a checkpoint. */
  const observed = await runExpecting(EXIT.CHECKPOINT, publish, ["status", "--request", start.requestFile, "--json"], { cwd: consumer, env });
  const publicationId = stdoutJson(observed).publicationId;
  assert.equal(stdoutJson(observed).state, "pending");
  assert.equal(fixture.uploads(publicationId), 0, "status must never upload");

  /* 3. resume with a one-second window: still pending, still exit 10, and it
        says so rather than reporting a failure. */
  const waited = await runExpecting(EXIT.CHECKPOINT, publish, ["resume", "--request", start.requestFile, "--timeout-seconds", "1", "--json"], { cwd: consumer, env });
  assert.equal(stdoutJson(waited).state, "pending");
  assert.ok(waited.stderr.includes("nothing was uploaded"), "a timed-out resume must say nothing was uploaded");
  assert.notEqual(statSafe(start.requestFile), null, "a checkpoint must keep the request state");
  assert.notEqual(statSafe(artifact), null, "a checkpoint must keep the source HTML");

  /* 4. the human approves; a later, separate resume uploads and completes. */
  fixture.replan(publicationId, { kind: "approve" });
  const completed = await runExpecting(EXIT.COMPLETE, publish, ["resume", "--request", start.requestFile, "--json"], { cwd: consumer, env });
  const receipt = stdoutJson(completed);
  assert.equal(receipt.state, "complete");
  assert.deepEqual(
    Object.keys(receipt.result).sort(),
    ["contentBytes", "contentSha256", "documentId", "ownerAccountId", "url"],
    "the completion receipt is not the set of fields C5 fixes",
  );
  assert.equal(receipt.result.url, `${fixture.origin}${DOCUMENT_PATH_PREFIX}${receipt.result.documentId}`);
  assert.equal(
    receipt.result.contentSha256,
    createHash("sha256").update(readFileSync(artifact)).digest("hex"),
    "the receipt must describe the bytes on disk",
  );
  assert.notEqual(statSafe(artifact), null, "completing must not remove the local HTML");
  assert.equal(fixture.uploads(publicationId), 1, "the approved bytes must be uploaded exactly once");
  assert.deepEqual(fixture.violations, [], "the client broke the C3 request contract");

  console.log("PASS  installed publisher: start → checkpoint → resume → complete, in four separate processes");
}

/**
 * Every way this can go wrong, and the actionable refusal it has to produce.
 *
 * A packaged command that fails vaguely is worse than one that fails: an agent
 * with no diagnosis retries, and retrying `start` is how one document becomes
 * two. Each case below asserts the exit code *and* that the message names
 * something the caller can act on.
 */
async function assertRefusals(consumer, artifact, fixture, stateDir) {
  const publish = join(consumer, INSTALLED.publish);
  const env = { ARCHON_PUBLISH_STATE_DIR: stateDir, ARCHON_PUBLISH_SERVICE: "" };
  const start = (extra) => [
    "start",
    "--file", artifact,
    "--title", "Payments review",
    ...extra,
    "--json",
  ];

  const missingFile = await runExpecting(EXIT.LOCAL, publish, [
    "start", "--file", join(consumer, "no-such-document.html"),
    "--title", "Payments review", "--service", fixture.origin, "--local-test", "--json",
  ], { cwd: consumer, env });
  assert.ok(stdoutJson(missingFile).message.includes("no-such-document.html"), "a missing artifact must name the path");

  const missingState = await runExpecting(EXIT.LOCAL, publish, ["status", "--request", join(consumer, "no-such-request.json"), "--json"], { cwd: consumer, env });
  assert.equal(stdoutJson(missingState).code, "state_not_found");

  const badService = await runExpecting(EXIT.LOCAL, publish, start(["--service", "http://docs.example.com"]), { cwd: consumer, env });
  assert.equal(stdoutJson(badService).code, "invalid_service_origin");

  /* Only safe to run while the release bakes in no origin. Once AHU-013 sets
     `RELEASED_SERVICE_ORIGIN`, an invocation with no `--service` and no
     environment value stops refusing and starts POSTing a real descriptor to
     the production service from CI on every push -- creating a real pending
     publication and only then failing the assertion. So the constant is read
     out of the *installed* package and decides which claim is checked. */
  const { RELEASED_SERVICE_ORIGIN, resolveServiceOrigin } = await import(
    pathToFileURL(join(consumer, INSTALLED.package, "dist", "publish.js")).href
  );
  if (RELEASED_SERVICE_ORIGIN === null) {
    const noService = await runExpecting(EXIT.LOCAL, publish, start([]), { cwd: consumer, env });
    assert.equal(stdoutJson(noService).code, "missing_service_origin");
    assert.ok(
      stdoutJson(noService).message.includes("ARCHON_PUBLISH_SERVICE"),
      "an unconfigured destination must name the two ways to configure one",
    );
  } else {
    /* No network call: the released origin is validated locally by the same
       function `start` would use, which is the whole of what this runner can
       honestly claim about a destination it must not contact. */
    assert.equal(
      resolveServiceOrigin(RELEASED_SERVICE_ORIGIN, false),
      RELEASED_SERVICE_ORIGIN,
      "the released service origin is not a canonical https origin",
    );
    console.log(`NOTE  a released service origin is set; the unconfigured-destination case is checked offline`);
  }

  /* A human declining is terminal and is not a transport failure. */
  fixture.plan({ kind: "deny" });
  const denyStart = stdoutJson(await runExpecting(EXIT.CHECKPOINT, publish, [
    "start", "--file", artifact, "--title", "Declined document", "--service", fixture.origin, "--local-test", "--json",
  ], { cwd: consumer, env }));
  const denied = await runExpecting(EXIT.REFUSED, publish, ["resume", "--request", denyStart.requestFile, "--json"], { cwd: consumer, env });
  assert.equal(stdoutJson(denied).state, "denied");
  assert.ok(/do not retry/i.test(stdoutJson(denied).nextAction), "a denial must tell the caller not to retry");
  assert.notEqual(statSafe(artifact), null, "a denial must keep the local HTML");

  /* An authorization window that closed is exit 21, not a retryable error. */
  fixture.plan({ kind: "authorization-expired" });
  const expiredStart = stdoutJson(await runExpecting(EXIT.CHECKPOINT, publish, [
    "start", "--file", artifact, "--title", "Expired document", "--service", fixture.origin, "--local-test", "--json",
  ], { cwd: consumer, env }));
  const expired = await runExpecting(EXIT.EXPIRED, publish, ["status", "--request", expiredStart.requestFile, "--json"], { cwd: consumer, env });
  assert.equal(stdoutJson(expired).code, "authorization_expired");

  /* A lost receipt is the case the skill is most explicit about: exit 21, a
     Check publication destination built from the pinned origin, and no claim
     that the document exists. */
  fixture.plan({ kind: "receipt-expired" });
  const lostStart = stdoutJson(await runExpecting(EXIT.CHECKPOINT, publish, [
    "start", "--file", artifact, "--title", "Lost receipt", "--service", fixture.origin, "--local-test", "--json",
  ], { cwd: consumer, env }));
  const lost = await runExpecting(EXIT.EXPIRED, publish, ["status", "--request", lostStart.requestFile, "--json"], { cwd: consumer, env });
  const lostBody = stdoutJson(lost);
  assert.equal(lostBody.code, "receipt_expired");
  assert.equal(
    lostBody.checkPublicationUrl,
    `${fixture.origin}${DOCUMENT_PATH_PREFIX}${lostBody.publicationId}`,
    "the Check publication link must be built from the pinned origin and the saved publication ID",
  );
  assert.ok(/^Check publication:/.test(lostBody.nextAction), "the recovery link must be labelled Check publication");
  assert.equal(lostBody.state, "error", "an expired receipt is an error envelope, not a state envelope");
  assert.equal(lostBody.result, undefined, "an expired receipt must never carry a completion result");
  assert.ok(
    !lost.stdout.includes('"documentId"') && !lost.stderr.includes("published "),
    "an expired receipt must never be reported as a completed publication",
  );
  assert.ok(
    lost.stderr.includes("not proof the document exists"),
    "the recovery link must be described as a sign-in destination rather than a receipt",
  );

  console.log("PASS  actionable refusals: missing file, missing state, bad and unconfigured service, denial, both expiries");
}

/**
 * Nothing this run captured may carry a bearer or a byte of the document.
 *
 * The transcript is every stream of every process above, which is what makes
 * this worth asserting once at the end rather than case by case: a leak added
 * to any one code path fails here.
 */
function assertNoLeaks() {
  assert.ok(secrets.size >= 4, `expected the fixture to have issued several bearers, saw ${secrets.size}`);
  for (const entry of transcript) {
    const streams = `${entry.stdout}${entry.stderr}`;
    for (const secret of secrets) {
      assert.ok(!streams.includes(secret), `${entry.argv} printed an operation bearer`);
    }
    assert.ok(!streams.includes(DOCUMENT_SENTINEL), `${entry.argv} printed the document's content`);
    /* Markers the artifact under test actually contains. `<!doctype html` was
       the obvious spelling and it is exactly the one a docbuild artifact never
       has -- the guard could not fire for the bytes it was guarding. */
    for (const markup of ["<title>", '<meta name="doc-id"', "<section", "</html>"]) {
      assert.ok(!streams.includes(markup), `${entry.argv} printed artifact markup (${markup})`);
    }
  }
  console.log(`PASS  no bearer and no document content in ${transcript.length} captured invocations`);
}

/* ------------------------------------------------------------------- main */

async function main() {
  const directory = isolatedTmpdir();
  /* Best effort. On a shared or self-hosted runner another user's leftover
     directory answers `EACCES`, and failing this gate over somebody else's
     stale temp directory would be a spurious red on a green change. */
  try {
    sweepStaleTempRoots([TEMP_PREFIX], { directory });
  } catch (error) {
    process.stderr.write(`NOTE  could not sweep stale temp roots: ${error.message}\n`);
  }
  installSignalCleanup(roots);

  const workRoot = guardedTempRoot(TEMP_PREFIX, { directory });
  roots.push(workRoot);
  const consumer = join(workRoot, "consumer");
  const stateDir = join(workRoot, "state");
  mkdirSync(consumer, { mode: 0o700 });
  mkdirSync(stateDir, { mode: 0o700 });

  const tarball = await packTarball(workRoot);
  await installConsumer(consumer, tarball);
  console.log(`PASS  packed and installed ${tarball.split(sep).pop()} into a clean consumer outside the repository`);

  assertInstalledLayout(consumer);
  await assertSkillMatchesPackage(consumer);
  const artifact = await buildDocument(consumer);

  const fixture = await startFixture();
  try {
    await publishLifecycle(consumer, artifact, fixture, stateDir);
    await assertRefusals(consumer, artifact, fixture, stateDir);
  } finally {
    await fixture.close();
  }

  assertNoLeaks();
  console.log("PASS  AHU-010 package consumer proof");
}

try {
  await main();
  removeTempRoots(roots);
} catch (error) {
  process.stderr.write(`FAIL  package consumer proof: ${error.message}\n`);
  if (error.stack !== undefined) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
  /* A red run is the one run whose tree is worth having. Deleting the consumer,
     the tarball and the built artifact on the way out leaves nothing but the
     assertion message, and an intermittent `npm pack` or `npm install` failure
     is then undiagnosable -- which is how a gate ends up disabled rather than
     fixed. `retainEvidenceRoot` renames it aside under mode 0700 and keeps only
     the last few. */
  for (const root of roots) {
    try {
      const { locator } = retainEvidenceRoot(root, "AHU-010 package consumer proof failed", {
        directory: dirname(root),
      });
      process.stderr.write(`NOTE  evidence retained; see ${locator}\n`);
    } catch (retainError) {
      process.stderr.write(`NOTE  could not retain evidence: ${retainError.message}\n`);
      removeTempRoots([root]);
    }
  }
}
