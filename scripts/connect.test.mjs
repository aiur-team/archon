import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { open as openAsync } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

const HOSTED_ENV = "AIUR_CONNECT_HOSTED";
const HOSTED_TIMEOUT = 900_000;
const CHILD_OUTPUT_LIMIT = 65_536;
const SITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SITE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CHILD_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "LANG",
  "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CI", "NO_COLOR",
];

function printableStrictChild(root, candidate) {
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  if (
    !/^[\x20-\x7e]+$/.test(normalizedRoot) ||
    !/^[\x20-\x7e]+$/.test(normalizedCandidate) ||
    normalizedRoot === parse(normalizedRoot).root ||
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) throw new Error("unsafe hosted path");
  return normalizedCandidate;
}

function hostedChildEnvironment(siteId = null) {
  const result = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = Object.getOwnPropertyDescriptor(process.env, key)?.value;
    if (typeof value === "string" && !value.includes("\0")) result[key] = value;
  }
  if (siteId !== null) result.NETLIFY_SITE_ID = siteId;
  return result;
}

function hostedExecutable() {
  const configured = Object.getOwnPropertyDescriptor(process.env, "NETLIFY_CLI_PATH")?.value;
  if (configured === undefined) return "netlify";
  if (
    typeof configured !== "string" ||
    configured.includes("\0") ||
    !isAbsolute(configured) ||
    realpathSync(configured) !== configured
  ) throw new Error("invalid hosted executable");
  const stat = lstatSync(configured);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid hosted executable");
  return configured;
}

async function runHostedChild(executable, args, cwd, { siteId = null, timeout = 60_000, abortSignal = null } = {}) {
  if (abortSignal?.aborted) throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("hosted lifecycle timeout");
  const child = spawn(executable, args, {
    cwd,
    env: hostedChildEnvironment(siteId),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return await new Promise((resolvePromise, rejectPromise) => {
    const output = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let failure = null;
    let closed = false;
    let killTimer = null;
    let terminationStarted = false;
    const terminate = (error) => {
      failure ??= error;
      if (terminationStarted || closed) return;
      terminationStarted = true;
      child.stdout.resume();
      child.stderr.resume();
      try { child.kill("SIGTERM"); } catch {}
      killTimer ??= setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2_000);
    };
    const abort = () => terminate(abortSignal.reason instanceof Error ? abortSignal.reason : new Error("hosted lifecycle timeout"));
    abortSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => terminate(new Error("hosted child timeout")), timeout);
    for (const streamName of ["stdout", "stderr"]) {
      child[streamName].on("data", (chunk) => {
        const length = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk?.byteLength;
        if (!Number.isSafeInteger(length) || length < 0) {
          terminate(new Error("invalid hosted child output"));
          return;
        }
        sizes[streamName] += length;
        if (sizes[streamName] > CHILD_OUTPUT_LIMIT) terminate(new Error("hosted child overflow"));
        else output[streamName].push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
    }
    child.on("error", terminate);
    child.on("close", (code, signal) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      abortSignal?.removeEventListener("abort", abort);
      if (failure !== null) rejectPromise(failure);
      else resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(output.stdout),
        stderr: Buffer.concat(output.stderr),
      });
    });
  });
}

function exactUtf8(buffer) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
}

function oneFinalNewline(value) {
  return value.endsWith("\n") ? value.slice(0, value.endsWith("\r\n") ? -2 : -1) : value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertHelp(text, usageLine, requiredOptions) {
  const normalized = text.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  const headings = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^[A-Z][A-Z ]*$/.test(line) && !line.endsWith(" "));
  const usage = headings.filter(({ line }) => line === "USAGE");
  const options = headings.filter(({ line }) => line === "OPTIONS");
  assert.equal(usage.length, 1);
  assert.equal(options.length, 1);
  assert.ok(options[0].index > usage[0].index);
  const nextAfterUsage = headings.find(({ index }) => index > usage[0].index);
  assert.equal(nextAfterUsage.index, options[0].index);
  assert.equal(lines.slice(usage[0].index + 1, options[0].index).filter((line) => line === usageLine).length, 1);
  const nextAfterOptions = headings.find(({ index }) => index > options[0].index)?.index ?? lines.length;
  const optionSection = lines.slice(options[0].index + 1, nextAfterOptions).join("\n");
  for (const spelling of requiredOptions) {
    assert.match(optionSection, new RegExp(`^  (?:-[A-Za-z], )?${escapeRegExp(spelling)}(?: {2,}|$)`, "m"));
  }
}

function snapshotLinkState(path) {
  try {
    const first = lstatSync(path);
    assert.ok(first.isFile() && !first.isSymbolicLink());
    const bytes = readFileSync(path);
    const stat = lstatSync(path);
    for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) assert.equal(stat[key], first[key]);
    return {
      present: true,
      bytes,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false };
    throw error;
  }
}

function assertLinkState(path, before) {
  const after = snapshotLinkState(path);
  assert.equal(after.present, before.present);
  if (before.present) {
    assert.ok(after.bytes.equals(before.bytes));
    for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) assert.equal(after[key], before[key]);
  }
}

async function runHosted(connectModule, {
  fetchFn = fetch,
  fetchTimeoutMs = 10_000,
  scheduleDeadline = setTimeout,
  clearDeadline = clearTimeout,
  repositoryRoot: suppliedRepositoryRoot = null,
} = {}) {
  const lifecycle = new AbortController();
  const deadline = scheduleDeadline(() => lifecycle.abort(new Error("hosted lifecycle timeout")), HOSTED_TIMEOUT);
  const repositoryRoot = suppliedRepositoryRoot ?? resolve(dirname(fileURLToPath(new URL("./connect.mjs", import.meta.url))), "..");
  const tempRoot = realpathSync(tmpdir());
  const evidenceRoot = printableStrictChild(tempRoot, mkdtempSync(join(tempRoot, "p4s-hosted-"), { encoding: "utf8", mode: 0o700 }));
  const remediationPath = printableStrictChild(evidenceRoot, join(evidenceRoot, "manual-remediation.json"));
  const siteName = `aiur-p4s-${process.pid.toString(36)}-${randomBytes(16).toString("hex")}`;
  assert.match(siteName, SITE_NAME);
  const recovery = { v: 1, siteName, siteId: null };
  const recoveryHandle = openSync(remediationPath, "wx", 0o600);
  try {
    writeFileSync(recoveryHandle, `${JSON.stringify(recovery, null, 2)}\n`);
  } finally {
    closeSync(recoveryHandle);
  }
  const linkPaths = [...new Set([
    join(process.cwd(), ".netlify", "state.json"),
    join(repositoryRoot, ".netlify", "state.json"),
  ])];
  const linkStates = new Map(linkPaths.map((path) => [path, snapshotLinkState(path)]));
  const executable = hostedExecutable();
  let cleanupTarget = null;
  let blobWriteMayHaveOccurred = false;
  let remoteCleanupComplete = false;
  let cleanupFailure = false;

  const active = () => {
    if (lifecycle.signal.aborted) throw lifecycle.signal.reason instanceof Error ? lifecycle.signal.reason : new Error("hosted lifecycle timeout");
  };
  const search = async (abortSignal = lifecycle.signal) => {
    const result = await runHostedChild(executable, ["sites:search", siteName, "--json"], evidenceRoot, { abortSignal });
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    const rows = JSON.parse(exactUtf8(result.stdout));
    assert.ok(Array.isArray(rows) && rows.length <= 100);
    for (const row of rows) {
      assert.ok(row !== null && typeof row === "object" && !Array.isArray(row) && Object.getPrototypeOf(row) === Object.prototype);
      assert.match(row.id, SITE_ID);
      assert.match(row.name, SITE_NAME);
    }
    const matches = rows.filter((row) => row.name === siteName);
    assert.ok(matches.length <= 1);
    return matches;
  };
  const replaceRecovery = (siteId) => {
    assert.match(siteId, SITE_ID);
    const sibling = printableStrictChild(evidenceRoot, join(evidenceRoot, "manual-remediation.next"));
    try {
      writeFileSync(sibling, `${JSON.stringify({ v: 1, siteName, siteId }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(sibling, remediationPath);
    } finally {
      rmSync(sibling, { force: true });
    }
  };

  try {
    active();
    const version = await runHostedChild(executable, ["--version"], evidenceRoot, { abortSignal: lifecycle.signal });
    assert.equal(version.code, 0);
    assert.equal(version.signal, null);
    assert.equal(version.stderr.length, 0);
    const versionText = exactUtf8(version.stdout);
    const normalizedVersion = oneFinalNewline(versionText);
    assert.ok(!normalizedVersion.endsWith("\n") && !normalizedVersion.endsWith("\r"));
    assert.equal(normalizedVersion.split(" ")[0], "netlify-cli/27.4.2");
    const helpCases = [
      [["sites:create", "--help"], "$ netlify sites:create [options]", ["--disable-linking", "--json", "--name <name>"]],
      [["sites:search", "--help"], "$ netlify sites:search [options] <search-term>", ["--json"]],
      [["env:get", "--help"], "$ netlify env:get [options] <name>", ["--context <context>"]],
      [["env:set", "--help"], "$ netlify env:set [options] <key> [value]", []],
      [["blobs:set", "--help"], "$ netlify blobs:set [options] <store> <key> [value...]", ["--input <path>"]],
      [["blobs:get", "--help"], "$ netlify blobs:get [options] <store> <key>", ["--output <path>"]],
      [["blobs:delete", "--help"], "$ netlify blobs:delete [options] <store> <key>", ["--force"]],
      [["deploy", "--help"], "$ netlify deploy [options]", ["--prod", "--no-build", "--dir <path>", "--json"]],
      [["sites:delete", "--help"], "$ netlify sites:delete [options] <id>", ["--force"]],
    ];
    for (const [args, usage, options] of helpCases) {
      const result = await runHostedChild(executable, args, evidenceRoot, { abortSignal: lifecycle.signal });
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stderr.length, 0);
      assertHelp(exactUtf8(result.stdout), usage, options);
    }
    assert.deepEqual(await search(), []);

    const inputRoot = printableStrictChild(evidenceRoot, join(evidenceRoot, "input"));
    mkdirSync(inputRoot, { mode: 0o700 });
    const hostedDocId = "4b7d2a";
    const hostedAid = "a12345678";
    const hostedInner = "Hosted lifecycle fixture";
    const hostedHistory = {
      doc: "hosted",
      head: "abc1234",
      versions: [{ sha: "abc1234", date: "2026-09-03T12:34:56.000Z", author: "Fixture", subject: "Hosted proof", url: "", changed: [] }],
    };
    const hostedManifest = {
      docId: hostedDocId,
      instance: "hosted",
      commit: "abc1234",
      blocks: { [hostedAid]: { file: "sections/hosted.html", section: "hosted", tag: "p", hash: createHash("sha256").update(hostedInner).digest("hex") } },
    };
    const hostedHtml = `<meta name="doc-id" content="${hostedDocId}">\n<!doctype html><html><body><p data-editable data-aid="${hostedAid}">${hostedInner}</p><script type="application/json" id="doc-history" data-head="${hostedHistory.head}">${JSON.stringify(hostedHistory).replaceAll("</", "<\\/")}</script></body></html>\n`;
    writeFileSync(join(inputRoot, "page.html"), hostedHtml);
    writeFileSync(join(inputRoot, "edit.json"), `${JSON.stringify(hostedManifest, null, 2)}\n`);
    writeFileSync(join(inputRoot, "history.json"), `${JSON.stringify(hostedHistory, null, 2)}\n`);
    const hostedCalls = [];
    const wrappedSpawn = (command, args, options) => {
      hostedCalls.push([...args]);
      const child = spawn(command, args, options);
      if (args[0] === "blobs:set") blobWriteMayHaveOccurred = true;
      let killTimer = null;
      const interrupt = () => {
        try { child.kill("SIGTERM"); } catch {}
        killTimer ??= setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2_000);
      };
      lifecycle.signal.addEventListener("abort", interrupt, { once: true });
      child.once("close", () => {
        lifecycle.signal.removeEventListener("abort", interrupt);
        if (killTimer !== null) clearTimeout(killTimer);
      });
      if (lifecycle.signal.aborted) interrupt();
      return child;
    };
    const capturedEnv = {};
    for (const key of [...CHILD_ENV_KEYS, "NETLIFY_CLI_PATH"]) {
      const value = Object.getOwnPropertyDescriptor(process.env, key)?.value;
      if (typeof value === "string") capturedEnv[key] = value;
    }
    const runner = connectModule.createConnectRunner({
      workingDirectory: inputRoot,
      repositoryRoot,
      env: capturedEnv,
      spawnFn: wrappedSpawn,
    });
    const baseArgs = ["--file", "page.html", "--manifest", "edit.json", "--history", "history.json"];
    active();
    const first = await runner(connectModule.parseConnectArgs([...baseArgs, "--owner", "hosted@example.com", "--name", siteName]));
    cleanupTarget = first.siteId;
    replaceRecovery(cleanupTarget);
    const repeatStart = hostedCalls.length;
    const repeated = await runner(connectModule.parseConnectArgs([...baseArgs, "--owner", "hosted@example.com", "--site", cleanupTarget]));
    assert.equal(repeated.siteId, first.siteId);
    assert.equal(repeated.url, first.url);
    assert.ok(!hostedCalls.slice(repeatStart).some((args) => args[0] === "env:set"));
    const conflictStart = hostedCalls.length;
    await assert.rejects(
      runner(connectModule.parseConnectArgs([...baseArgs, "--owner", "different@example.com", "--site", cleanupTarget])),
      (error) => error.tag === "conflict",
    );
    assert.deepEqual(hostedCalls.slice(conflictStart).map((args) => args[0]), ["env:get"]);
    active();
    const fetchController = new AbortController();
    const abortFetch = () => fetchController.abort(lifecycle.signal.reason);
    lifecycle.signal.addEventListener("abort", abortFetch, { once: true });
    const fetchTimer = setTimeout(() => fetchController.abort(new Error("hosted fetch timeout")), fetchTimeoutMs);
    let response;
    try {
      response = await fetchFn(first.url, { redirect: "manual", signal: fetchController.signal });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "/login/?next=%2F");
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    } catch (error) {
      try { await response?.body?.cancel?.(); } catch {}
      throw error;
    } finally {
      clearTimeout(fetchTimer);
      lifecycle.signal.removeEventListener("abort", abortFetch);
    }
  } finally {
    clearDeadline(deadline);
    try {
      const matches = await search(null);
      if (cleanupTarget === null && matches.length === 1) {
        cleanupTarget = matches[0].id;
        replaceRecovery(cleanupTarget);
      } else if (cleanupTarget !== null && matches.length === 1) {
        assert.equal(matches[0].id, cleanupTarget);
      }
      if (cleanupTarget !== null) {
        if (blobWriteMayHaveOccurred) {
          try {
            await runHostedChild(executable, ["blobs:delete", "doc-state", "mode/4b7d2a/manifest.json", "--force"], evidenceRoot, { siteId: cleanupTarget });
          } catch {}
        }
        const deleted = await runHostedChild(executable, ["sites:delete", cleanupTarget, "--force"], evidenceRoot);
        assert.equal(deleted.code, 0);
        assert.equal(deleted.signal, null);
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if ((await search(null)).length === 0) {
          remoteCleanupComplete = true;
          break;
        }
        if (attempt < 4) await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
      }
      for (const [path, before] of linkStates) assertLinkState(path, before);
      assert.equal(remoteCleanupComplete, true);
      rmSync(evidenceRoot, { recursive: true, force: true });
    } catch {
      cleanupFailure = true;
      process.stderr.write(`P4-S hosted cleanup failed; inspect ${remediationPath}\n`);
    }
    if (cleanupFailure) throw new Error("hosted lifecycle failed");
  }
}

const connect = await import("./connect.mjs");
const {
  assertModeManifest,
  assertPromotionHistory,
  createConnectRunner,
  createPromotion,
  createPromotionRunner,
  inspectStandaloneHtml,
  main,
  normalizeConnectOwner,
  parseConnectArgs,
  parsePromoteArgs,
} = connect;

const hostedArguments = process.argv.slice(2);
const hostedMode = hostedArguments.length === 1 && hostedArguments[0] === "--hosted" && process.env[HOSTED_ENV] === "1";
const hostedRequested = hostedArguments.length !== 0 || Object.hasOwn(process.env, HOSTED_ENV);

if (hostedMode) {
  try {
    await runHosted(connect);
    process.stdout.write("PASS  P4-S hosted connect lifecycle\n");
  } catch {
    process.exitCode = 1;
  }
} else if (hostedRequested) {
  process.exitCode = 1;
} else {
assert.deepEqual(Object.keys(connect).sort(), [
  "assertModeManifest",
  "assertPromotionHistory",
  "createConnectRunner",
  "createPromotion",
  "createPromotionRunner",
  "inspectStandaloneHtml",
  "main",
  "normalizeConnectOwner",
  "parseConnectArgs",
  "parsePromoteArgs",
]);

const hostedAbortController = new AbortController();
const hostedAbortReason = new Error("invented hosted deadline");
const hostedAbortRun = runHostedChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], tmpdir(), {
  abortSignal: hostedAbortController.signal,
  timeout: 10_000,
});
hostedAbortController.abort(hostedAbortReason);
await assert.rejects(hostedAbortRun, (error) => error === hostedAbortReason);

assert.deepEqual(parseConnectArgs(["--help"]), { help: true });
const parsed = parseConnectArgs([
  "--owner", " Owner@Example.COM ",
  "--history", "history.json",
  "--file", "page.html",
  "--site", "123e4567-e89b-12d3-a456-426614174000",
  "--manifest", "edit.json",
]);
assert.deepEqual(parsed, {
  file: "page.html",
  manifest: "edit.json",
  history: "history.json",
  owner: " Owner@Example.COM ",
  name: null,
  site: "123e4567-e89b-12d3-a456-426614174000",
});
assert.deepEqual(parseConnectArgs([
  "--owner", "owner@example.com",
  "--file", "page.html",
  "--site", "123e4567-e89b-12d3-a456-426614174000",
  "--manifest", "edit.json",
]), {
  file: "page.html",
  manifest: "edit.json",
  history: null,
  owner: "owner@example.com",
  name: null,
  site: "123e4567-e89b-12d3-a456-426614174000",
});
assert.equal(parseConnectArgs([
  "--file", "--opaque-file",
  "--manifest", "--opaque-manifest",
  "--history", "--opaque-history",
  "--owner", "--opaque-owner",
  "--name", "--opaque-name",
]).file, "--opaque-file");
for (const argv of [
  [],
  ["--help", "x"],
  ["--file=x"],
  ["value"],
  ["--file", ""],
  ["--file", "--owner"],
  ["--file", "a", "--file", "b", "--history", "h", "--manifest", "m", "--owner", "o", "--site", "s"],
]) {
  assert.throws(() => parseConnectArgs(argv));
}

const originalStderrWrite = process.stderr.write;
const originalExitCode = process.exitCode;
let malformedMainStderr = "";
try {
  process.stderr.write = (chunk) => {
    malformedMainStderr += String(chunk);
    return true;
  };
  process.exitCode = undefined;
  await main(null);
  assert.equal(process.exitCode, 2);
  assert.equal(malformedMainStderr, "connect: invalid arguments\n");
  malformedMainStderr = "";
  const throwingArguments = [];
  Object.defineProperty(throwingArguments, "0", { get() { throw new Error("invented argument read failure"); } });
  await main(throwingArguments);
  assert.equal(process.exitCode, 2);
  assert.equal(malformedMainStderr, "connect: invalid arguments\n");
} finally {
  process.stderr.write = originalStderrWrite;
  process.exitCode = originalExitCode;
}

assert.equal(normalizeConnectOwner("\tOWNER+tag@Sub.Example.COM\r"), "owner+tag@sub.example.com");
assert.equal(normalizeConnectOwner("a..b@example.com"), "a..b@example.com");
for (const owner of ["a@localhost", "a/b@example.com", "a@-bad.example", "a@bad..example", "K@example.com", "a@example.com\u0085"]) {
  assert.throws(() => normalizeConnectOwner(owner));
}

const docId = "4b7d2a";
const aid = "a12345678";
const inner = "Hello <em>world</em>";
const history = {
  doc: "sample",
  head: "abc1234",
  versions: [{
    sha: "abc1234",
    date: "2026-09-03T12:34:56.000Z",
    author: "Example Author",
    subject: "Initial document",
    url: "",
    changed: [],
  }],
};
const manifest = {
  docId,
  instance: "sample",
  commit: "abc1234",
  blocks: {
    [aid]: {
      file: "sections/example.html",
      section: "example",
      tag: "p",
      hash: createHash("sha256").update(inner).digest("hex"),
    },
  },
};
const embeddedHistoryScript =
  `<script type="application/json" id="doc-history" data-head="${history.head}">${JSON.stringify(history).replaceAll("</", "<\\/")}</script>`;
const html =
  `<meta name="doc-id" content="${docId}">\n` +
  `<!doctype html><html><body><p data-editable data-aid="${aid}">${inner}</p>` +
  embeddedHistoryScript +
  `<script>const fake = '<meta name="doc-id" content="ffffff">';</script></body></html>\n`;
const noHistoryManifest = { ...manifest, commit: "" };
const noHistoryHtml = html.replace(embeddedHistoryScript, "");
const unicodeRawTextHtml = html.replace(
  "<script>const fake",
  "<script>const dotted = 'İ'; const fake",
);

assert.deepEqual(parsePromoteArgs(["--help"]), { help: true });
assert.deepEqual(parsePromoteArgs([
  "--output", "review",
  "--site", "123e4567-e89b-12d3-a456-426614174000",
  "--file", "page.html",
  "--manifest", "edit.json",
]), {
  file: "page.html",
  manifest: "edit.json",
  history: null,
  site: "123e4567-e89b-12d3-a456-426614174000",
  output: "review",
});
assert.deepEqual(assertPromotionHistory(history, "sample"), history);
assert.throws(() => assertPromotionHistory({ doc: "sample", head: "", versions: [] }, "sample"));
assert.equal(typeof createPromotion, "function");
assert.equal(typeof createPromotionRunner, "function");
assert.equal(createPromotionRunner({ env: {} }).name, "run");
for (const dependencies of [
  null,
  [],
  Object.create(null),
  { unknownFn() {} },
  { openFn: undefined },
  { openFn: null },
  { processId: 0 },
  { processId: 1.5 },
  { workingDirectory: "." },
  { repositoryRoot: "." },
  { env: null },
]) assert.throws(() => createPromotionRunner(dependencies), { name: "TypeError", message: "Invalid promotion dependencies" });
const accessorDependencies = {};
Object.defineProperty(accessorDependencies, "openFn", { enumerable: true, get() { return openAsync; } });
assert.throws(() => createPromotionRunner(accessorDependencies), { name: "TypeError", message: "Invalid promotion dependencies" });
assert.throws(() => createPromotionRunner({ [Symbol("dependency")]: () => {} }), { name: "TypeError", message: "Invalid promotion dependencies" });
for (const argv of [
  [],
  ["--help", "extra"],
  ["--file=x"],
  ["--file", "page.html", "--manifest", "edit.json", "--site", "site"],
  ["--file", "page.html", "--manifest", "edit.json", "--site", "site", "--output", "out", "--history", ""],
  ["--file", "page.html", "--manifest", "edit.json", "--site", "site", "--output", "out", "--output", "again"],
]) assert.throws(() => parsePromoteArgs(argv));

const directReceipt = {
  v: 1,
  aid,
  text: "Updated **world**",
  by: { sub: "reader-1", name: "Sample Reader", email: "reader@example.com" },
  at: "2026-09-04T12:00:00.000Z",
  baseHash: noHistoryManifest.blocks[aid].hash,
  pr: null,
  via: "edit",
};
const promotionNoHistoryHtml = noHistoryHtml.replace(
  `<p data-editable data-aid="${aid}">`,
  `<p data-aid="${aid}" data-editable data-md="Hello *world*">`,
);
const originalNoHistoryManifest = JSON.stringify(noHistoryManifest);
const firstPromotion = createPromotion({
  html: promotionNoHistoryHtml,
  manifest: noHistoryManifest,
  history: null,
  receipts: [directReceipt],
}, { nowMs: Date.parse("2026-09-04T12:05:00.000Z") });
const firstManifest = JSON.parse(firstPromotion.manifestBytes);
const firstHistory = JSON.parse(firstPromotion.historyBytes);
assert.equal(JSON.stringify(noHistoryManifest), originalNoHistoryManifest, "pure promotion preserves manifest input");
assert.equal(promotionNoHistoryHtml.includes("Updated"), false, "pure promotion preserves HTML input");
assert.equal(firstPromotion.promoted, 1);
assert.match(firstManifest.commit, /^[0-9a-f]{7}$/);
assert.equal(firstHistory.head, firstManifest.commit);
assert.equal(firstHistory.versions[0].author, "Sample Reader");
assert.equal(firstHistory.versions[0].changed[0].file, "example.html");
assert.match(firstPromotion.html, /Updated <strong>world<\/strong>/);
assert.match(firstPromotion.html, new RegExp(`id="doc-history" data-head="${firstManifest.commit}"`));
assert.deepEqual(assertModeManifest(firstManifest, firstPromotion.html), { docId, manifest: firstManifest });
assert.deepEqual(assertPromotionHistory(firstHistory, "sample"), firstHistory);

const secondReceipt = {
  ...directReceipt,
  text: "Accepted *revision*",
  by: { sub: "reader-2", name: "", email: "second@example.com" },
  at: "2026-09-04T13:00:00.000Z",
  baseHash: firstManifest.blocks[aid].hash,
  via: "suggestion",
  sugId: "s_review_12345678",
  acceptedBy: { sub: "deployer-1", name: "Site Deployer", email: "deployer@example.com" },
  acceptedAt: "2026-09-04T13:01:00.000Z",
};
const secondPromotion = createPromotion({
  html: firstPromotion.html,
  manifest: firstManifest,
  history: firstHistory,
  receipts: [secondReceipt],
}, { nowMs: Date.parse("2026-09-04T13:05:00.000Z") });
const secondHistory = JSON.parse(secondPromotion.historyBytes);
assert.equal(secondHistory.versions.length, 2);
assert.equal(secondHistory.versions[0].author, "second@example.com");
assert.match(secondPromotion.html, /Accepted <em>revision<\/em>/);
assert.throws(() => createPromotion({
  html: promotionNoHistoryHtml,
  manifest: noHistoryManifest,
  history: null,
  receipts: [{ ...directReceipt, baseHash: "0".repeat(64) }],
}, { nowMs: Date.parse("2026-09-04T12:05:00.000Z") }));
assert.throws(() => createPromotion({
  html: promotionNoHistoryHtml,
  manifest: noHistoryManifest,
  history: null,
  receipts: [{ ...directReceipt, text: "Hello *world*" }],
}, { nowMs: Date.parse("2026-09-04T12:05:00.000Z") }), "a same-as-built overlay cannot claim stale-on-reconnect promotion");

const inlineFixtures = JSON.parse(readFileSync(
  fileURLToPath(new URL("../templates/fixtures/inline.json", import.meta.url)),
  "utf8",
));
assert.equal(inlineFixtures.length, 12);
const attributeEscape = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");
for (const [index, fixture] of inlineFixtures.entries()) {
  const nextFixture = inlineFixtures[(index + 1) % inlineFixtures.length];
  const fixtureAid = `a${(index + 1).toString(16).padStart(8, "0")}`;
  const marked = ["code", "strong", "em"].some((tag) => fixture.html.includes(`<${tag}>`) && fixture.html.includes(`</${tag}>`));
  const fixtureOpening = `<p data-aid="${fixtureAid}" data-editable${marked ? ` data-md="${attributeEscape(fixture.md)}"` : ""}>`;
  const fixtureHtml = `<meta name="doc-id" content="${docId}">\n<!doctype html><html><body>${fixtureOpening}${fixture.html}</p></body></html>\n`;
  const fixtureManifest = {
    docId,
    instance: "fixture",
    commit: "",
    blocks: {
      [fixtureAid]: {
        file: "sections/fixture.html",
        section: "fixture",
        tag: "p",
        hash: createHash("sha256").update(fixture.html).digest("hex"),
      },
    },
  };
  const fixturePromotion = createPromotion({
    html: fixtureHtml,
    manifest: fixtureManifest,
    history: null,
    receipts: [{
      ...directReceipt,
      aid: fixtureAid,
      text: nextFixture.md,
      baseHash: fixtureManifest.blocks[fixtureAid].hash,
    }],
  }, { nowMs: Date.parse("2026-09-04T12:05:00.000Z") });
  const nextMarked = ["code", "strong", "em"].some((tag) => nextFixture.html.includes(`<${tag}>`) && nextFixture.html.includes(`</${tag}>`));
  const promotedOpening = `<p data-aid="${fixtureAid}" data-editable${nextMarked ? ` data-md="${attributeEscape(nextFixture.md)}"` : ""}>`;
  assert.match(fixturePromotion.html, new RegExp(`${escapeRegExp(promotedOpening)}${escapeRegExp(nextFixture.html)}</p>`), `inline fixture ${index + 1}`);
}

const promotionSet = (count) => {
  const blocks = {};
  const receipts = [];
  const body = [];
  for (let index = 0; index < count; index += 1) {
    const blockAid = `a${(index + 1).toString(16).padStart(8, "0")}`;
    const oldText = `Old ${index + 1}`;
    const fileNumber = String(count - index).padStart(2, "0");
    blocks[blockAid] = {
      file: `sections/${fileNumber}.html`,
      section: `section-${fileNumber}`,
      tag: "p",
      hash: createHash("sha256").update(oldText).digest("hex"),
    };
    body.push(`<p data-aid="${blockAid}" data-editable>${oldText}</p>`);
    receipts.push({
      ...directReceipt,
      aid: blockAid,
      text: `New ${index + 1}`,
      at: `2026-09-04T12:00:${String(index).padStart(2, "0")}.000Z`,
      baseHash: blocks[blockAid].hash,
    });
  }
  return {
    html: `<meta name="doc-id" content="${docId}">\n<!doctype html><html><body>${body.join("")}</body></html>\n`,
    manifest: { docId, instance: "many", commit: "", blocks },
    receipts,
  };
};
const twelve = promotionSet(12);
const twelvePromotion = createPromotion({
  html: twelve.html,
  manifest: twelve.manifest,
  history: null,
  receipts: twelve.receipts,
}, { nowMs: Date.parse("2026-09-04T14:00:00.000Z") });
const twelveHistory = JSON.parse(twelvePromotion.historyBytes);
assert.equal(twelveHistory.versions.length, 12);
assert.deepEqual(
  twelveHistory.versions.map((version) => version.changed[0].file),
  Array.from({ length: 12 }, (_, index) => `${String(index + 1).padStart(2, "0")}.html`),
  "new history rows use lexical file order",
);
const thirteen = promotionSet(13);
assert.throws(() => createPromotion({
  html: thirteen.html,
  manifest: thirteen.manifest,
  history: null,
  receipts: thirteen.receipts,
}, { nowMs: Date.parse("2026-09-04T14:00:00.000Z") }));

const crPromotion = createPromotion({
  html: promotionNoHistoryHtml,
  manifest: noHistoryManifest,
  history: null,
  receipts: [{ ...directReceipt, text: "Line one\rLine two" }],
}, { nowMs: Date.parse("2026-09-04T14:00:00.000Z") });
const crChange = JSON.parse(crPromotion.historyBytes).versions[0].changed[0];
assert.deepEqual({ patch: crChange.patch, clipped: crChange.clipped, add: crChange.add, del: crChange.del }, {
  patch: "", clipped: true, add: 1, del: 1,
});
assert.ok(crPromotion.html.includes("Line one\rLine two"), "CR fallback preserves promoted text");

const unicodePromotion = createPromotion({
  html: promotionNoHistoryHtml,
  manifest: noHistoryManifest,
  history: null,
  receipts: [{ ...directReceipt, text: "é".repeat(1000) }],
}, { nowMs: Date.parse("2026-09-04T14:00:00.000Z") });
const unicodeChange = JSON.parse(unicodePromotion.historyBytes).versions[0].changed[0];
assert.equal(unicodeChange.clipped, true);
assert.ok(Buffer.byteLength(unicodeChange.patch, "utf8") <= 1200);
assert.doesNotMatch(unicodeChange.patch, /\uFFFD/);

const retainedVersions = Array.from({ length: 12 }, (_, index) => ({
  sha: `${(index + 1).toString(16).padStart(7, "0")}`,
  date: `2026-09-${String(3 - Math.floor(index / 8)).padStart(2, "0")}T${String(23 - (index % 8)).padStart(2, "0")}:00:00.000Z`,
  author: `Reader ${index + 1}`,
  subject: `Existing ${index + 1}`,
  url: "",
  changed: [],
}));
const retainedHistory = { doc: "sample", head: retainedVersions[0].sha, versions: retainedVersions };
const retainedScript = `<script type="application/json" id="doc-history" data-head="${retainedHistory.head}">${JSON.stringify(retainedHistory).replaceAll("</", "<\\/")}</script>`;
const retainedHtml = promotionNoHistoryHtml.replace("</body>", `${retainedScript}</body>`);
const retainedManifest = { ...noHistoryManifest, commit: retainedHistory.head };
const retainedPromotion = createPromotion({
  html: retainedHtml,
  manifest: retainedManifest,
  history: retainedHistory,
  receipts: [directReceipt],
}, { nowMs: Date.parse("2026-09-04T14:00:00.000Z") });
const afterRetention = JSON.parse(retainedPromotion.historyBytes);
assert.equal(afterRetention.versions.length, 12);
assert.equal(afterRetention.versions.at(-1).sha, retainedVersions[10].sha, "retention evicts only the oldest row");

const collidingHistory = { doc: "sample", head: firstHistory.head, versions: firstHistory.versions };
const collidingScript = `<script type="application/json" id="doc-history" data-head="${collidingHistory.head}">${JSON.stringify(collidingHistory).replaceAll("</", "<\\/")}</script>`;
const collidingHtml = promotionNoHistoryHtml.replace("</body>", `${collidingScript}</body>`);
assert.throws(() => createPromotion({
  html: collidingHtml,
  manifest: { ...noHistoryManifest, commit: collidingHistory.head },
  history: collidingHistory,
  receipts: [directReceipt],
}, { nowMs: Date.parse("2026-09-04T12:05:00.000Z") }), (error) => error.tag === "history-collision");

assert.deepEqual(inspectStandaloneHtml(html), { docId });
assert.deepEqual(assertModeManifest(manifest, html), { docId, manifest });
assert.deepEqual(assertModeManifest(noHistoryManifest, noHistoryHtml), { docId, manifest: noHistoryManifest });
assert.deepEqual(assertModeManifest(manifest, unicodeRawTextHtml), { docId, manifest });
for (const badHtml of [
  `\ufeff${html}`,
  html.replace("</body>", '<meta content="ffffff" name="doc-id"></body>'),
  html.replace("data-editable", "DATA-EDITABLE"),
  html.replace(`data-aid="${aid}"`, `data-aid='${aid}'`),
  html.replace("</p>", "</h2>"),
  html.replace("<script>const", "<script data-aid=\"a00000000\">const"),
  html.replace("<script>const fake", "<script/><script>const fake"),
  html.replace("</body>", "<style/></body>"),
]) {
  assert.throws(() => assertModeManifest(manifest, badHtml));
}
assert.throws(() => assertModeManifest({ ...manifest, commit: "abc123" }, html));
assert.throws(() => assertModeManifest({ ...manifest, blocks: {} }, html));

const source = readFileSync(fileURLToPath(new URL("./connect.mjs", import.meta.url)), "utf8");
const importBlock = source.match(/^import[\s\S]+?(?=\n\nconst USAGE)/)?.[0];
assert.ok(importBlock);
const importDeclarations = importBlock.split(/;\n/).filter((declaration) => declaration.trim() !== "");
assert.equal(importDeclarations.length, 6);
assert.ok(importDeclarations.every((declaration) => /^import\s+{[\s\S]+}\s+from\s+"[^"]+"$/.test(declaration.trim().replace(/;$/, ""))));
const importSources = [...source.matchAll(/^import\s+{[^;]+}\s+from\s+"([^"]+)";/gms)].map((match) => match[1]).sort();
assert.deepEqual(importSources, [
  "node:child_process",
  "node:crypto",
  "node:fs/promises",
  "node:os",
  "node:path",
  "node:url",
]);
assert.doesNotMatch(source, /\b(?:exec|execFile|execSync|execFileSync|fork|spawnSync|fetch)\s*\(/);
assert.doesNotMatch(source, /\bprocess\s*\.\s*exit\s*\(/);
assert.doesNotMatch(source, /\b[A-Z0-9_]*(?:TOKEN|PASSWORD|COOKIE|SECRET)[A-Z0-9_]*\b/);
assert.doesNotMatch(source, /\b(?:require|import)\s*\(/);

const testRoot = mkdtempSync(join(tmpdir(), "p4s-test-"));
try {
  const repositoryRoot = join(testRoot, "repository");
  const inputRoot = join(testRoot, "input");
  mkdirSync(join(repositoryRoot, "netlify", "functions"), { recursive: true });
  mkdirSync(join(repositoryRoot, "scripts"), { recursive: true });
  mkdirSync(inputRoot, { recursive: true });
  writeFileSync(join(repositoryRoot, "netlify", "functions", "noop.mjs"), "export default () => new Response();\n");
  writeFileSync(join(repositoryRoot, "netlify.toml"), "[build]\npublish = \"publish\"\n");
  writeFileSync(join(repositoryRoot, "package.json"), "{\"type\":\"module\"}\n");
  writeFileSync(join(repositoryRoot, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  copyFileSync(fileURLToPath(new URL("./connect.mjs", import.meta.url)), join(repositoryRoot, "scripts", "connect.mjs"));
  writeFileSync(join(inputRoot, "page.html"), html);
  writeFileSync(join(inputRoot, "edit.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(inputRoot, "history.json"), `${JSON.stringify(history, null, 2)}\n`);
  writeFileSync(join(inputRoot, "page-no-history.html"), noHistoryHtml);
  writeFileSync(join(inputRoot, "edit-no-history.json"), `${JSON.stringify(noHistoryManifest, null, 2)}\n`);
  writeFileSync(join(inputRoot, "page-promote.html"), promotionNoHistoryHtml);
  const promotionHistoryHtml = promotionNoHistoryHtml.replace("</body>", `${embeddedHistoryScript}</body>`);
  writeFileSync(join(inputRoot, "page-promote-history.html"), promotionHistoryHtml);
  writeFileSync(join(inputRoot, "edit-promote-history.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const promotionCalls = [];
  let promotionChildren = 0;
  let promotionRemoteManifest = noHistoryManifest;
  let promotionRemoteReceipts = new Map([[aid, directReceipt]]);
  let promotionInventory = {
    blobs: [{ etag: "fixture-etag", key: `edits/${docId}/${aid}.json` }],
    directories: [],
  };
  const promotionSpawn = (executable, args, options) => {
    assert.equal(executable, "netlify");
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.cwd, repositoryRoot);
    assert.equal(options.env.NETLIFY_SITE_ID, "123e4567-e89b-12d3-a456-426614174000");
    assert.equal(options.env.NETLIFY_AUTH_TOKEN, undefined);
    promotionChildren += 1;
    assert.equal(promotionChildren, 1, "promotion children are serialized");
    promotionCalls.push([...args]);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      if (args[0] === "blobs:list") {
        assert.deepEqual(args, ["blobs:list", "doc-state", "--prefix", `edits/${docId}/`, "--json"]);
        child.stdout.write(JSON.stringify(promotionInventory));
      } else if (args[0] === "blobs:get") {
        const outputPath = args.at(-1);
        if (args[2] === `mode/${docId}/manifest.json`) {
          assert.deepEqual(args.slice(0, -1), ["blobs:get", "doc-state", `mode/${docId}/manifest.json`, "--output"]);
          writeFileSync(outputPath, `${JSON.stringify(promotionRemoteManifest, null, 2)}\n`);
        } else {
          const receiptMatch = args[2].match(new RegExp(`^edits/${docId}/(a[0-9a-f]{8})\\.json$`));
          assert.ok(receiptMatch);
          assert.deepEqual(args.slice(0, -1), ["blobs:get", "doc-state", args[2], "--output"]);
          writeFileSync(outputPath, JSON.stringify(promotionRemoteReceipts.get(receiptMatch[1])));
        }
      } else assert.fail(`unexpected promotion command ${args[0]}`);
      child.stdout.end();
      child.stderr.end();
      promotionChildren -= 1;
      child.emit("close", 0, null);
    });
    return child;
  };

  const existingPromotionOutput = join(inputRoot, "existing-promotion-output");
  mkdirSync(existingPromotionOutput);
  const existingPromotionOutputStat = lstatSync(existingPromotionOutput);
  let existingOutputClockCalls = 0;
  let existingOutputProviderCalls = 0;
  await assert.rejects(createPromotionRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    nowFn() { existingOutputClockCalls += 1; throw new Error("existing output sampled time"); },
    spawnFn() { existingOutputProviderCalls += 1; throw new Error("existing output reached provider"); },
  })(parsePromoteArgs([
    "--file", "page-promote.html", "--manifest", "edit-no-history.json",
    "--site", "123e4567-e89b-12d3-a456-426614174000", "--output", "existing-promotion-output",
  ])), (error) => error.tag === "promotion");
  assert.equal(existingOutputClockCalls, 0);
  assert.equal(existingOutputProviderCalls, 0);
  assert.deepEqual(readdirSync(existingPromotionOutput), []);
  const existingPromotionOutputAfter = lstatSync(existingPromotionOutput);
  assert.deepEqual(
    { dev: existingPromotionOutputAfter.dev, ino: existingPromotionOutputAfter.ino },
    { dev: existingPromotionOutputStat.dev, ino: existingPromotionOutputStat.ino },
    "pre-existing output remains untouched",
  );
  rmSync(existingPromotionOutput, { recursive: true });

  await assert.rejects(createPromotionRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    nowFn: () => Number.NaN,
    spawnFn() { assert.fail("malformed first clock reached provider"); },
  })(parsePromoteArgs([
    "--file", "page-promote.html", "--manifest", "edit-no-history.json",
    "--site", "123e4567-e89b-12d3-a456-426614174000", "--output", "bad-first-clock",
  ])), (error) => error.tag === "promotion");
  assert.equal(existsSync(join(inputRoot, "bad-first-clock.publish.lock")), false);
  assert.equal(existsSync(join(inputRoot, "edit-no-history.json.promote.lock")), false);

  const promotionTimes = [Date.parse("2026-09-04T12:02:00.000Z"), Date.parse("2026-09-04T12:05:00.000Z")];
  const promotionLockWrites = [];
  const promotionRunner = createPromotionRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH, NETLIFY_AUTH_TOKEN: "must-not-cross" },
    processId: 1234,
    tmpdirFn: () => testRoot,
    nowFn: () => promotionTimes.shift(),
    spawnFn: promotionSpawn,
    async openFn(path, flags, mode) {
      const handle = await openAsync(path, flags, mode);
      if (!path.endsWith(".promote.lock") && !path.endsWith(".publish.lock")) return handle;
      return {
        stat: handle.stat.bind(handle),
        async writeFile(value) {
          promotionLockWrites.push({ path, flags, mode, value: String(value) });
          await handle.writeFile(value);
        },
        sync: handle.sync.bind(handle),
        close: handle.close.bind(handle),
      };
    },
  });
  const promotionResult = await promotionRunner(parsePromoteArgs([
    "--file", "page-promote.html",
    "--manifest", "edit-no-history.json",
    "--site", "123e4567-e89b-12d3-a456-426614174000",
    "--output", "promoted",
  ]));
  assert.deepEqual(promotionResult, {
    output: join(inputRoot, "promoted"),
    siteId: "123e4567-e89b-12d3-a456-426614174000",
    promoted: 1,
    stale: 0,
  });
  assert.deepEqual(promotionCalls.map((args) => args[0]), ["blobs:get", "blobs:list", "blobs:get"]);
  assert.deepEqual(readdirSync(join(inputRoot, "promoted")), ["document.edit.json", "history.json", "index.html"]);
  for (const name of ["document.edit.json", "history.json", "index.html"]) {
    assert.equal(lstatSync(join(inputRoot, "promoted", name)).mode & 0o777, 0o600);
  }
  assert.equal(existsSync(join(inputRoot, "edit-no-history.json.promote.lock")), false);
  assert.equal(existsSync(join(inputRoot, "promoted.publish.lock")), false);
  assert.equal(existsSync(join(inputRoot, "promoted.promote-staging")), false);
  assert.deepEqual(promotionTimes, [], "promotion samples exactly two clocks");
  const expectedLockLine = `${JSON.stringify({
    v: 1,
    pid: 1234,
    startedAt: "2026-09-04T12:02:00.000Z",
    output: join(inputRoot, "promoted"),
  })}\n`;
  assert.deepEqual(promotionLockWrites, [
    { path: join(inputRoot, "edit-no-history.json.promote.lock"), flags: "wx", mode: 0o600, value: expectedLockLine },
    { path: join(inputRoot, "promoted.publish.lock"), flags: "wx", mode: 0o600, value: expectedLockLine },
  ], "history and output locks receive identical immutable bytes in order");

  promotionRemoteManifest = manifest;
  const historicalTimes = [Date.parse("2026-09-04T13:02:00.000Z"), Date.parse("2026-09-04T13:05:00.000Z")];
  const historicalRunner = createPromotionRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    processId: 1236,
    tmpdirFn: () => testRoot,
    nowFn: () => historicalTimes.shift(),
    spawnFn: promotionSpawn,
  });
  const historicalResult = await historicalRunner(parsePromoteArgs([
    "--file", "page-promote-history.html",
    "--manifest", "edit-promote-history.json",
    "--history", "history.json",
    "--site", "123e4567-e89b-12d3-a456-426614174000",
    "--output", "promoted-history",
  ]));
  assert.equal(historicalResult.promoted, 1);
  assert.equal(JSON.parse(readFileSync(join(inputRoot, "promoted-history", "history.json"), "utf8")).versions.length, 2);
  assert.deepEqual(historicalTimes, []);

  const partialTopology = [
    ["page-promote.html", "edit-promote-history.json", null],
    ["page-promote-history.html", "edit-no-history.json", null],
    ["page-promote.html", "edit-no-history.json", "history.json"],
    ["page-promote-history.html", "edit-promote-history.json", null],
    ["page-promote.html", "edit-promote-history.json", "history.json"],
    ["page-promote-history.html", "edit-no-history.json", "history.json"],
  ];
  let partialSpawns = 0;
  for (const [index, [fileName, manifestName, historyName]] of partialTopology.entries()) {
    const partialRunner = createPromotionRunner({
      workingDirectory: inputRoot,
      repositoryRoot,
      env: { PATH: process.env.PATH },
      tmpdirFn: () => testRoot,
      nowFn() { assert.fail("partial history topology sampled time"); },
      spawnFn() { partialSpawns += 1; throw new Error("partial history topology reached provider"); },
    });
    const tokens = [
      "--file", fileName,
      "--manifest", manifestName,
      ...(historyName === null ? [] : ["--history", historyName]),
      "--site", "123e4567-e89b-12d3-a456-426614174000",
      "--output", `partial-${index}`,
    ];
    await assert.rejects(partialRunner(parsePromoteArgs(tokens)), (error) => error.tag === "promotion");
    assert.equal(existsSync(join(inputRoot, `partial-${index}`)), false);
  }
  assert.equal(partialSpawns, 0, "partial history topologies stop before provider work");

  let ambiguousHistoryProviderCalls = 0;
  await assert.rejects(createPromotionRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    nowFn: () => Date.parse("2026-09-04T14:00:00.000Z"),
    spawnFn() {
      ambiguousHistoryProviderCalls += 1;
      throw new Error("ambiguous history reached provider");
    },
  })(parsePromoteArgs([
    "--file", "page-promote-history.html",
    "--manifest", "edit-promote-history.json",
    "--site", "123e4567-e89b-12d3-a456-426614174000",
    "--output", "ambiguous-history",
  ])), (error) => error.tag === "promotion");
  assert.equal(ambiguousHistoryProviderCalls, 0, "missing history sidecar fails before provider work");
  assert.equal(existsSync(join(inputRoot, "ambiguous-history")), false);
  promotionRemoteManifest = noHistoryManifest;

  const malformedSecondTimes = [Date.parse("2026-09-04T14:00:00.000Z"), Number.NaN];
  await assert.rejects(createPromotionRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    tmpdirFn: () => testRoot,
    nowFn: () => malformedSecondTimes.shift(),
    spawnFn: promotionSpawn,
  })(parsePromoteArgs([
    "--file", "page-promote.html", "--manifest", "edit-no-history.json",
    "--site", "123e4567-e89b-12d3-a456-426614174000", "--output", "bad-second-clock",
  ])), (error) => error.tag === "promotion");
  assert.deepEqual(malformedSecondTimes, []);
  assert.equal(existsSync(join(inputRoot, "bad-second-clock")), false);
  assert.equal(existsSync(join(inputRoot, "bad-second-clock.publish.lock")), false);
  assert.equal(existsSync(join(inputRoot, "edit-no-history.json.promote.lock")), false);

  let rejectedPromotionIndex = 0;
  const rejectPromotion = async (inventory, receipts, expectedTag = "promotion") => {
    promotionInventory = inventory;
    promotionRemoteReceipts = receipts;
    const outputName = `rejected-promotion-${rejectedPromotionIndex}`;
    rejectedPromotionIndex += 1;
    const times = [Date.parse("2026-09-04T15:00:00.000Z"), Date.parse("2026-09-04T15:01:00.000Z")];
    const runner = createPromotionRunner({
      workingDirectory: inputRoot,
      repositoryRoot,
      env: { PATH: process.env.PATH },
      tmpdirFn: () => testRoot,
      nowFn: () => times.shift(),
      spawnFn: promotionSpawn,
    });
    await assert.rejects(runner(parsePromoteArgs([
      "--file", "page-promote.html",
      "--manifest", "edit-no-history.json",
      "--site", "123e4567-e89b-12d3-a456-426614174000",
      "--output", outputName,
    ])), (error) => error.tag === expectedTag);
    assert.equal(existsSync(join(inputRoot, outputName)), false);
    assert.equal(existsSync(join(inputRoot, `${outputName}.publish.lock`)), false);
    assert.equal(existsSync(join(inputRoot, "edit-no-history.json.promote.lock")), false);
  };
  const validInventoryRow = { etag: "fixture-etag", key: `edits/${docId}/${aid}.json` };
  for (const invalidInventory of [
    [],
    { blobs: [], directories: ["edits/"] },
    { blobs: [{ ...validInventoryRow, etag: "" }], directories: [] },
    { blobs: [{ ...validInventoryRow, etag: "x".repeat(513) }], directories: [] },
    { blobs: [{ ...validInventoryRow, key: `edits/${docId}/wrong.json` }], directories: [] },
    { blobs: [validInventoryRow, validInventoryRow], directories: [] },
    { blobs: Array.from({ length: 1001 }, (_, index) => ({
      etag: `etag-${index}`,
      key: `edits/${docId}/a${index.toString(16).padStart(8, "0")}.json`,
    })), directories: [] },
    "x".repeat(1_048_577),
  ]) await rejectPromotion(invalidInventory, new Map([[aid, directReceipt]]));
  await rejectPromotion(
    { blobs: [validInventoryRow], directories: [] },
    new Map([[aid, { ...directReceipt, baseHash: "0".repeat(64) }]]),
    "no-current",
  );
  await rejectPromotion(
    { blobs: [validInventoryRow], directories: [] },
    new Map([[aid, {
      ...directReceipt,
      via: "suggestion",
      sugId: "malformed",
      acceptedBy: { sub: "deployer-1", name: "Site Deployer", email: "deployer@example.com" },
      acceptedAt: "2026-09-04T13:01:00.000Z",
    }]]),
  );

  writeFileSync(join(inputRoot, "page-promote-thirteen.html"), thirteen.html);
  writeFileSync(join(inputRoot, "edit-promote-thirteen.json"), `${JSON.stringify(thirteen.manifest, null, 2)}\n`);
  promotionRemoteManifest = thirteen.manifest;
  promotionRemoteReceipts = new Map(thirteen.receipts.map((receipt) => [receipt.aid, receipt]));
  promotionInventory = {
    blobs: thirteen.receipts.map((receipt) => ({ etag: `etag-${receipt.aid}`, key: `edits/${docId}/${receipt.aid}.json` })),
    directories: [],
  };
  const tooManyRunner = createPromotionRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    tmpdirFn: () => testRoot,
    nowFn: () => Date.parse("2026-09-04T15:00:00.000Z"),
    spawnFn: promotionSpawn,
  });
  await assert.rejects(tooManyRunner(parsePromoteArgs([
    "--file", "page-promote-thirteen.html",
    "--manifest", "edit-promote-thirteen.json",
    "--site", "123e4567-e89b-12d3-a456-426614174000",
    "--output", "too-many-promotion",
  ])), (error) => error.tag === "too-many");
  assert.equal(existsSync(join(inputRoot, "too-many-promotion")), false);
  promotionRemoteManifest = noHistoryManifest;
  promotionRemoteReceipts = new Map([[aid, directReceipt]]);
  promotionInventory = { blobs: [validInventoryRow], directories: [] };

  const atomicFailure = async (outputName, overrides, expectedTag = "promotion", { sourceLockRemains = false } = {}) => {
    const runner = createPromotionRunner({
      workingDirectory: inputRoot,
      repositoryRoot,
      env: { PATH: process.env.PATH },
      tmpdirFn: () => testRoot,
      nowFn: () => Date.parse("2026-09-04T16:00:00.000Z"),
      spawnFn: promotionSpawn,
      ...overrides,
    });
    await assert.rejects(runner(parsePromoteArgs([
      "--file", "page-promote.html",
      "--manifest", "edit-no-history.json",
      "--site", "123e4567-e89b-12d3-a456-426614174000",
      "--output", outputName,
    ])), (error) => error.tag === expectedTag);
    assert.equal(existsSync(join(inputRoot, `${outputName}.publish.lock`)), false);
    assert.equal(existsSync(join(inputRoot, "edit-no-history.json.promote.lock")), sourceLockRemains);
  };

  const sourceLockPath = join(inputRoot, "edit-no-history.json.promote.lock");

  const lateOutputCollision = join(inputRoot, "late-output-collision");
  let lateOutputIdentity;
  await atomicFailure("late-output-collision", {
    createPromotionFn(input, options) {
      mkdirSync(lateOutputCollision);
      const stat = lstatSync(lateOutputCollision);
      lateOutputIdentity = { dev: stat.dev, ino: stat.ino };
      return createPromotion(input, options);
    },
  });
  const lateOutputAfter = lstatSync(lateOutputCollision);
  assert.deepEqual(
    { dev: lateOutputAfter.dev, ino: lateOutputAfter.ino },
    lateOutputIdentity,
    "output appearing during promotion remains untouched",
  );
  assert.deepEqual(readdirSync(lateOutputCollision), []);
  rmSync(lateOutputCollision, { recursive: true });

  writeFileSync(sourceLockPath, "existing source lock\n", { mode: 0o600 });
  await atomicFailure("history-lock-output", {}, "history-lock", { sourceLockRemains: true });
  assert.equal(readFileSync(sourceLockPath, "utf8"), "existing source lock\n");
  rmSync(sourceLockPath);

  const outputLockPath = join(inputRoot, "output-lock-output.publish.lock");
  writeFileSync(outputLockPath, "existing output lock\n", { mode: 0o600 });
  await assert.rejects(createPromotionRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    tmpdirFn: () => testRoot,
    nowFn: () => Date.parse("2026-09-04T16:00:00.000Z"),
    spawnFn: promotionSpawn,
  })(parsePromoteArgs([
    "--file", "page-promote.html", "--manifest", "edit-no-history.json",
    "--site", "123e4567-e89b-12d3-a456-426614174000", "--output", "output-lock-output",
  ])), (error) => error.tag === "output-lock");
  assert.equal(readFileSync(outputLockPath, "utf8"), "existing output lock\n");
  assert.equal(existsSync(sourceLockPath), false);
  rmSync(outputLockPath);

  const invalidHandleLock = join(inputRoot, "invalid-handle.publish.lock");
  const invalidHandleRunner = createPromotionRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    tmpdirFn: () => testRoot,
    nowFn: () => Date.parse("2026-09-04T16:00:00.000Z"),
    spawnFn: promotionSpawn,
    async openFn(path, flags, mode) {
      const handle = await openAsync(path, flags, mode);
      if (path === invalidHandleLock) {
        await handle.close();
        return {};
      }
      return handle;
    },
  });
  await assert.rejects(invalidHandleRunner(parsePromoteArgs([
    "--file", "page-promote.html", "--manifest", "edit-no-history.json",
    "--site", "123e4567-e89b-12d3-a456-426614174000", "--output", "invalid-handle",
  ])), (error) => error.tag === "promotion-cleanup" && error.detail === invalidHandleLock);
  assert.equal(existsSync(invalidHandleLock), true);
  assert.equal(existsSync(sourceLockPath), false);
  rmSync(invalidHandleLock);

  const stagingCollision = join(inputRoot, "staging-collision.promote-staging");
  mkdirSync(stagingCollision);
  writeFileSync(join(stagingCollision, "keep.txt"), "preserve\n");
  await atomicFailure("staging-collision", {});
  assert.equal(readFileSync(join(stagingCollision, "keep.txt"), "utf8"), "preserve\n");
  rmSync(stagingCollision, { recursive: true });

  await atomicFailure("rename-failure", {
    async renameFn() { throw new Error("invented rename failure"); },
  });
  assert.equal(existsSync(join(inputRoot, "rename-failure")), false);
  assert.equal(existsSync(join(inputRoot, "rename-failure.promote-staging")), false);

  await atomicFailure("staged-sync-failure", {
    async openFn(path, flags, mode) {
      const handle = await openAsync(path, flags, mode);
      if (path === join(inputRoot, "staged-sync-failure.promote-staging", "index.html")) {
        return {
          writeFile: handle.writeFile.bind(handle),
          async sync() { throw new Error("invented staged sync failure"); },
          close: handle.close.bind(handle),
        };
      }
      return handle;
    },
  });
  assert.equal(existsSync(join(inputRoot, "staged-sync-failure")), false);
  assert.equal(existsSync(join(inputRoot, "staged-sync-failure.promote-staging")), false);

  await atomicFailure("parent-sync-failure", {
    async openFn(path, flags, mode) {
      const handle = await openAsync(path, flags, mode);
      if (path === inputRoot && flags === "r") {
        return {
          async sync() { throw new Error("invented parent sync failure"); },
          close: handle.close.bind(handle),
        };
      }
      return handle;
    },
  });
  assert.ok(lstatSync(join(inputRoot, "parent-sync-failure")).isDirectory(), "complete renamed output survives parent sync uncertainty");

  const cleanupFailureLock = join(inputRoot, "cleanup-failure.publish.lock");
  const cleanupRunner = createPromotionRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    tmpdirFn: () => testRoot,
    nowFn: () => Date.parse("2026-09-04T16:00:00.000Z"),
    spawnFn: promotionSpawn,
    async rmFn(path, options) {
      if (path === cleanupFailureLock) throw new Error("invented cleanup failure");
      rmSync(path, options);
    },
  });
  await assert.rejects(cleanupRunner(parsePromoteArgs([
    "--file", "page-promote.html", "--manifest", "edit-no-history.json",
    "--site", "123e4567-e89b-12d3-a456-426614174000", "--output", "cleanup-failure",
  ])), (error) => error.tag === "promotion-cleanup" && error.detail === cleanupFailureLock);
  assert.ok(lstatSync(join(inputRoot, "cleanup-failure")).isDirectory(), "cleanup failure overrides completed publication");
  assert.equal(existsSync(cleanupFailureLock), true);
  rmSync(cleanupFailureLock);

  const promotionSignals = [];
  const promotionTimers = [];
  const timedPromotionRunner = createPromotionRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    processId: 1235,
    tmpdirFn: () => testRoot,
    nowFn: () => Date.parse("2026-09-04T12:02:00.000Z"),
    setTimeoutFn(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false };
      promotionTimers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cleared = true; },
    spawnFn() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        promotionSignals.push(signal);
        if (signal === "SIGKILL") process.nextTick(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit("close", null, "SIGKILL");
        });
        return true;
      };
      return child;
    },
  });
  const timedPromotion = timedPromotionRunner(parsePromoteArgs([
    "--file", "page-promote.html",
    "--manifest", "edit-no-history.json",
    "--site", "123e4567-e89b-12d3-a456-426614174000",
    "--output", "timed-promotion",
  ]));
  for (let attempt = 0; attempt < 100 && !promotionTimers.some((timer) => timer.milliseconds === 60_000); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  const promotionOperationTimer = promotionTimers.find((timer) => timer.milliseconds === 60_000);
  assert.ok(promotionOperationTimer, "promotion operation deadline starts");
  promotionOperationTimer.callback();
  const promotionEscalationTimer = promotionTimers.find((timer) => timer.milliseconds === 2_000);
  assert.ok(promotionEscalationTimer, "promotion kill escalation starts");
  promotionEscalationTimer.callback();
  await assert.rejects(timedPromotion, (error) => error.tag === "promotion");
  assert.deepEqual(promotionSignals, ["SIGTERM", "SIGKILL"]);
  assert.ok(promotionTimers.every((timer) => timer.cleared));
  assert.equal(existsSync(join(inputRoot, "edit-no-history.json.promote.lock")), false);
  assert.equal(existsSync(join(inputRoot, "timed-promotion.publish.lock")), false);

  const calls = [];
  let ownerSeed = "";
  let activeChildren = 0;
  const fakeSpawn = (executable, args, options) => {
    assert.equal(executable, "netlify");
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.ok(options.cwd.endsWith("/project"));
    assert.equal(options.env.NETLIFY_AUTH_TOKEN, undefined);
    assert.equal(options.env.GITHUB_TOKEN, undefined);
    activeChildren += 1;
    assert.equal(activeChildren, 1);
    calls.push({ args: [...args], options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      let code = 0;
      let output = "";
      if (args[0] === "sites:create") {
        assert.deepEqual(args, ["sites:create", "--name", "fixture-site", "--disable-linking", "--json"]);
        output = '{"site_id":"123e4567-e89b-12d3-a456-426614174000"}';
      }
      else if (args[0] === "env:get") {
        assert.deepEqual(args, ["env:get", "DOC_OWNERS", "--context", "production"]);
        if (ownerSeed === "") code = 1;
        else output = `${ownerSeed}\n`;
      } else if (args[0] === "env:set") {
        assert.deepEqual(args, ["env:set", "DOC_OWNERS", `${docId}:owner@example.com`]);
        ownerSeed = args[2];
      }
      else if (args[0] === "blobs:get") {
        assert.deepEqual(args.slice(0, -1), ["blobs:get", "doc-state", `mode/${docId}/manifest.json`, "--output"]);
        assert.equal(args.at(-1).split(sep).at(-1), "manifest.output");
        const outputPath = args[args.indexOf("--output") + 1];
        const inputPath = calls.find((call) => call.args[0] === "blobs:set").args.at(-1);
        copyFileSync(inputPath, outputPath);
      } else if (args[0] === "blobs:set") {
        assert.deepEqual(args.slice(0, -1), ["blobs:set", "doc-state", `mode/${docId}/manifest.json`, "--input"]);
        assert.equal(args.at(-1).split(sep).at(-1), "manifest.input");
      } else if (args[0] === "deploy") {
        assert.deepEqual(args, ["deploy", "--prod", "--no-build", "--dir", "publish", "--json"]);
        const publishRoot = join(options.cwd, args[args.indexOf("--dir") + 1]);
        assert.deepEqual(readdirSync(publishRoot), ["index.html"]);
        const publishedManifest = JSON.parse(readFileSync(join(options.cwd, "private", "manifest.input"), "utf8"));
        const expectedHtml = publishedManifest.commit === "" ? noHistoryHtml : html;
        assert.ok(readFileSync(join(publishRoot, "index.html")).equals(Buffer.from(expectedHtml)));
        assert.ok(lstatSync(join(options.cwd, "netlify")).isDirectory());
        for (const name of ["netlify.toml", "package.json", "package-lock.json"]) {
          assert.ok(lstatSync(join(options.cwd, name)).isFile());
        }
        output = '{"url":"https://fixture-site.netlify.app"}';
      } else assert.fail(`unexpected fake command ${args[0]}`);
      child.stdout.end(output);
      child.stderr.end();
      activeChildren -= 1;
      child.emit("close", code, null);
    });
    return child;
  };
  const runner = createConnectRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH, NETLIFY_AUTH_TOKEN: "must-not-cross" },
    spawnFn: fakeSpawn,
  });
  const result = await runner(parseConnectArgs([
    "--file", "page.html",
    "--manifest", "edit.json",
    "--history", "history.json",
    "--owner", "Owner@Example.com",
    "--name", "fixture-site",
  ]));
  assert.deepEqual(result, {
    docId,
    owner: "owner@example.com",
    siteId: "123e4567-e89b-12d3-a456-426614174000",
    url: "https://fixture-site.netlify.app/",
  });
  assert.deepEqual(calls.map((call) => call.args[0]), [
    "sites:create", "env:get", "env:set", "env:get", "blobs:set", "blobs:get", "deploy",
  ]);
  assert.equal(calls[0].options.env.NETLIFY_SITE_ID, undefined);
  assert.ok(calls.slice(1).every((call) => call.options.env.NETLIFY_SITE_ID === result.siteId));
  assert.equal(calls.at(-1).args.join(" "), "deploy --prod --no-build --dir publish --json");
  const noHistoryArguments = () => parseConnectArgs([
    "--file", "page-no-history.html",
    "--manifest", "edit-no-history.json",
    "--owner", "owner@example.com",
    "--site", result.siteId,
  ]);

  const exactProtocol = [
    ["sites:create", "--name", "fixture-site", "--disable-linking", "--json"],
    ["env:get", "DOC_OWNERS", "--context", "production"],
    ["env:set", "DOC_OWNERS", `${docId}:owner@example.com`],
    ["env:get", "DOC_OWNERS", "--context", "production"],
    ["blobs:set", "doc-state", `mode/${docId}/manifest.json`, "--input"],
    ["blobs:get", "doc-state", `mode/${docId}/manifest.json`, "--output"],
    ["deploy", "--prod", "--no-build", "--dir", "publish", "--json"],
  ];
  for (const [index, expected] of exactProtocol.entries()) {
    const actual = calls[index].args;
    if (["blobs:set", "blobs:get"].includes(expected[0])) {
      assert.deepEqual(actual.slice(0, -1), expected);
      assert.ok(actual.at(-1).startsWith(calls[index].options.cwd));
    } else {
      assert.deepEqual(actual, expected);
    }
  }

  calls.length = 0;
  const noHistoryResult = await runner(noHistoryArguments());
  assert.deepEqual(noHistoryResult, {
    docId,
    owner: "owner@example.com",
    siteId: result.siteId,
    url: "https://fixture-site.netlify.app/",
  });
  assert.deepEqual(calls.map((call) => call.args[0]), ["env:get", "env:get", "blobs:set", "blobs:get", "deploy"]);

  calls.length = 0;
  const repeated = await runner(parseConnectArgs([
    "--file", "page.html",
    "--manifest", "edit.json",
    "--history", "history.json",
    "--owner", "owner@example.com",
    "--site", result.siteId,
  ]));
  assert.equal(repeated.siteId, result.siteId);
  assert.deepEqual(calls.map((call) => call.args[0]), ["env:get", "env:get", "blobs:set", "blobs:get", "deploy"]);

  calls.length = 0;
  await assert.rejects(runner(parseConnectArgs([
    "--file", "page.html",
    "--manifest", "edit.json",
    "--history", "history.json",
    "--owner", "different@example.com",
    "--site", result.siteId,
  ])), (error) => error.tag === "conflict");
  assert.deepEqual(calls.map((call) => call.args[0]), ["env:get"]);

  const errorSignals = [];
  const errorTimers = [];
  const errorRunner = createConnectRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    setTimeoutFn(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false };
      errorTimers.push(timer);
      if (milliseconds === 2_000) process.nextTick(() => callback());
      return timer;
    },
    clearTimeoutFn(timer) { timer.cleared = true; },
    spawnFn() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        errorSignals.push(signal);
        if (signal === "SIGKILL") process.nextTick(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit("close", null, "SIGKILL");
        });
        return true;
      };
      process.nextTick(() => child.emit("error", new Error("invented spawn failure")));
      return child;
    },
  });
  await assert.rejects(errorRunner(parseConnectArgs([
    "--file", "page.html",
    "--manifest", "edit.json",
    "--history", "history.json",
    "--owner", "owner@example.com",
    "--site", result.siteId,
  ])), (error) => error.tag === "setup");
  assert.deepEqual(errorSignals, ["SIGTERM", "SIGKILL"]);
  assert.ok(errorTimers.every((timer) => timer.cleared));

  const siteArguments = (owner = "owner@example.com") => parseConnectArgs([
    "--file", "page.html",
    "--manifest", "edit.json",
    "--history", "history.json",
    "--owner", owner,
    "--site", result.siteId,
  ]);
  const nameArguments = parseConnectArgs([
    "--file", "page.html",
    "--manifest", "edit.json",
    "--history", "history.json",
    "--owner", "owner@example.com",
    "--name", "failure-fixture",
  ]);
  const makeProtocolSpawn = (override = () => null, signalLog = [], commandLog = []) => {
    let storedManifest = null;
    let index = 0;
    return (_executable, args) => {
      const callIndex = index;
      index += 1;
      const command = args[0];
      commandLog.push(command);
      let response = command === "sites:create"
        ? { stdout: `{"site_id":"${result.siteId}"}` }
        : command === "env:get"
          ? { stdout: `${docId}:owner@example.com\n` }
          : command === "deploy"
            ? { stdout: '{"url":"https://fixture-site.netlify.app/"}' }
            : {};
      response = override({ args, callIndex, command, response }) ?? response;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let closed = false;
      const close = (
        code = response.code === undefined ? 0 : response.code,
        childSignal = response.signal === undefined ? null : response.signal,
      ) => {
        if (closed) return;
        closed = true;
        child.stdout.end();
        child.stderr.end();
        child.emit("close", code, childSignal);
      };
      child.kill = (childSignal) => {
        signalLog.push(childSignal);
        process.nextTick(() => close(null, childSignal));
        return true;
      };
      process.nextTick(() => {
        if (command === "blobs:set" && response.code === undefined) storedManifest = args.at(-1);
        if (command === "blobs:get" && response.code === undefined) {
          if (response.output !== undefined) writeFileSync(args.at(-1), response.output);
          else if (storedManifest !== null) copyFileSync(storedManifest, args.at(-1));
        }
        if (response.stdout !== undefined) child.stdout.write(response.stdout);
        if (response.stderr !== undefined) child.stderr.write(response.stderr);
        if (response.close !== false) close();
      });
      return child;
    };
  };
  const runProtocolFailure = async ({ arguments: parsedArguments = siteArguments(), override, rmFn }) => {
    const signals = [];
    const commands = [];
    const failureRunner = createConnectRunner({
      workingDirectory: inputRoot,
      repositoryRoot,
      env: { PATH: process.env.PATH },
      spawnFn: makeProtocolSpawn(override, signals, commands),
      ...(rmFn === undefined ? {} : { rmFn }),
    });
    let failure;
    try {
      await failureRunner(parsedArguments);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    return { failure, signals, commands };
  };

  const providerFailures = [
    ["malformed create JSON", nameArguments, ({ command }) => command === "sites:create" ? { stdout: "{" } : null, "new-site"],
    ["malformed created site id", nameArguments, ({ command }) => command === "sites:create" ? { stdout: '{"site_id":"invalid"}' } : null, "new-site"],
    ["contradictory created site ids", nameArguments, ({ command }) => command === "sites:create" ? { stdout: `{"site_id":"${result.siteId}","id":"223e4567-e89b-12d3-a456-426614174000"}` } : null, "new-site"],
    ["missing auth", siteArguments(), ({ callIndex }) => callIndex === 0 ? { code: 2, stderr: "Not logged in\n" } : null, "setup"],
    ["post-create unexpected nonzero", nameArguments, ({ callIndex }) => callIndex === 1 ? { code: 2, stderr: "provider failure\n" } : null, "new-site"],
    ["signal close", siteArguments(), ({ callIndex }) => callIndex === 0 ? { code: null, signal: "SIGTERM" } : null, "setup"],
    ["malformed deploy JSON", siteArguments(), ({ command }) => command === "deploy" ? { stdout: "{" } : null, "setup"],
    ["malformed deploy URL", siteArguments(), ({ command }) => command === "deploy" ? { stdout: '{"url":"http://fixture-site.netlify.app/"}' } : null, "setup"],
    ["malformed secondary deploy URL", siteArguments(), ({ command }) => command === "deploy" ? { stdout: '{"url":"https://fixture-site.netlify.app/","deploy_url":"https://fixture-site.netlify.app/?"}' } : null, "setup"],
  ];
  for (const [label, parsedArguments, override, expectedTag] of providerFailures) {
    const { failure } = await runProtocolFailure({ arguments: parsedArguments, override });
    assert.equal(failure.tag, expectedTag, label);
  }
  for (const [label, parsedArguments] of [
    ["history snapshot requires sidecar", parseConnectArgs([
      "--file", "page.html",
      "--manifest", "edit.json",
      "--owner", "owner@example.com",
      "--site", result.siteId,
    ])],
    ["empty history rejects sidecar", { ...noHistoryArguments(), history: "history.json" }],
    ["empty history rejects mirror", { ...noHistoryArguments(), file: "page.html" }],
  ]) {
    const { failure, commands } = await runProtocolFailure({ arguments: parsedArguments });
    assert.equal(failure.tag, "setup", label);
    assert.deepEqual(commands, [], `${label} stops before remote work`);
  }
  const manifestBytes = readFileSync(join(inputRoot, "edit.json"));
  for (const [label, drifted] of [
    ["appended byte", Buffer.concat([manifestBytes, Buffer.from("\n")])],
    ["truncated byte", manifestBytes.subarray(0, manifestBytes.length - 1)],
    ["reserialized manifest", Buffer.from(JSON.stringify(manifest))],
  ]) {
    const readbackCommands = [];
    const { failure } = await runProtocolFailure({
      override: ({ command }) => {
        readbackCommands.push(command);
        return command === "blobs:get" ? { output: drifted } : null;
      },
    });
    assert.equal(failure.tag, "setup", `read-back ${label}`);
    assert.deepEqual(readbackCommands, ["env:get", "env:get", "blobs:set", "blobs:get"], `read-back ${label} stops before deploy`);
  }

  const leakedRoot = join(testRoot, "leaked\ttemp");
  const leakRunner = createConnectRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    spawnFn: makeProtocolSpawn(),
    mkdtempFn: async () => {
      mkdirSync(leakedRoot, { mode: 0o700 });
      return leakedRoot;
    },
  });
  await assert.rejects(leakRunner(siteArguments()), (error) => error.tag === "setup");
  assert.equal(existsSync(leakedRoot), false, "rejected temp root removed");

  const linkedInput = join(testRoot, "linked-input");
  symlinkSync(inputRoot, linkedInput);
  const linkedRunner = createConnectRunner({
    workingDirectory: linkedInput,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    spawnFn: makeProtocolSpawn(),
  });
  await assert.rejects(linkedRunner(siteArguments()), (error) => error.tag === "setup");

  for (const deployUrl of [
    "https://fixture-site.netlify.app/?",
    "https://fixture-site.netlify.app/#",
    "https://fixture-site.netlify.app/?query",
    "https://fixture-site.netlify.app/#fragment",
  ]) {
    const { failure } = await runProtocolFailure({
      override: ({ command }) => command === "deploy" ? { stdout: JSON.stringify({ url: deployUrl }) } : null,
    });
    assert.equal(failure.tag, "setup", deployUrl);
  }
  for (const streamName of ["stdout", "stderr"]) {
    const { failure, signals } = await runProtocolFailure({
      override: ({ callIndex }) => callIndex === 0 ? { [streamName]: Buffer.alloc(CHILD_OUTPUT_LIMIT + 1) } : null,
    });
    assert.equal(failure.tag, "setup", `${streamName} overflow`);
    assert.deepEqual(signals, ["SIGTERM"], `${streamName} overflow termination`);
  }
  const synchronousCreateRunner = createConnectRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    spawnFn() { throw new Error("invented synchronous create failure"); },
  });
  await assert.rejects(synchronousCreateRunner(nameArguments), (error) => error.tag === "setup");

  const cleanupRm = async (path, options) => {
    rmSync(path, options);
    throw new Error("invented cleanup failure");
  };
  for (const [label, owner] of [["success cleanup", "owner@example.com"], ["conflict cleanup precedence", "different@example.com"]]) {
    const { failure } = await runProtocolFailure({ arguments: siteArguments(owner), rmFn: cleanupRm });
    assert.equal(failure.tag, "cleanup", label);
  }

  const timeoutSignals = [];
  const timeoutTimers = [];
  const timeoutRunner = createConnectRunner({
    workingDirectory: inputRoot,
    repositoryRoot,
    env: { PATH: process.env.PATH },
    setTimeoutFn(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false };
      timeoutTimers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cleared = true; },
    spawnFn() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (childSignal) => {
        timeoutSignals.push(childSignal);
        if (childSignal === "SIGKILL") process.nextTick(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit("close", null, "SIGKILL");
        });
        return true;
      };
      return child;
    },
  });
  const timedRun = timeoutRunner(siteArguments());
  for (let attempt = 0; attempt < 100 && !timeoutTimers.some((timer) => timer.milliseconds === 60_000); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  const operationTimer = timeoutTimers.find((timer) => timer.milliseconds === 60_000);
  assert.ok(operationTimer, "operation timeout was initiated");
  operationTimer.callback();
  const escalationTimer = timeoutTimers.find((timer) => timer.milliseconds === 2_000);
  assert.ok(escalationTimer, "kill escalation was initiated");
  escalationTimer.callback();
  await assert.rejects(timedRun, (error) => error.tag === "setup");
  assert.deepEqual(timeoutSignals, ["SIGTERM", "SIGKILL"]);
  assert.ok(timeoutTimers.every((timer) => timer.cleared));

  const fakeBin = join(testRoot, "bin");
  const fakeCli = join(fakeBin, "netlify");
  const statePath = join(testRoot, "fake-state.json");
  const blobPath = join(testRoot, "fake-blob.json");
  mkdirSync(fakeBin);
  writeFileSync(statePath, "{}\n");
  writeFileSync(fakeCli, `#!/usr/bin/env node
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const blobPath = ${JSON.stringify(blobPath)};
const promotionReceipt = ${JSON.stringify(directReceipt)};
const state = JSON.parse(readFileSync(statePath, "utf8"));
const siteId = "123e4567-e89b-12d3-a456-426614174000";
const exact = (expected) => JSON.stringify(args) === JSON.stringify(expected);
const reject = () => { process.exitCode = 2; };
const save = () => writeFileSync(statePath, JSON.stringify(state));
const help = {
  "sites:create": ["$ netlify sites:create [options]", ["--disable-linking", "--json", "--name <name>"]],
  "sites:search": ["$ netlify sites:search [options] <search-term>", ["--json"]],
  "env:get": ["$ netlify env:get [options] <name>", ["--context <context>"]],
  "env:set": ["$ netlify env:set [options] <key> [value]", []],
  "blobs:set": ["$ netlify blobs:set [options] <store> <key> [value...]", ["--input <path>"]],
  "blobs:get": ["$ netlify blobs:get [options] <store> <key>", ["--output <path>"]],
  "blobs:delete": ["$ netlify blobs:delete [options] <store> <key>", ["--force"]],
  deploy: ["$ netlify deploy [options]", ["--prod", "--no-build", "--dir <path>", "--json"]],
  "sites:delete": ["$ netlify sites:delete [options] <id>", ["--force"]],
};
if (exact(["--version"])) process.stdout.write("netlify-cli/27.4.2\\n");
else if (args.length === 2 && args[1] === "--help" && help[args[0]] !== undefined) {
  const [usage, options] = help[args[0]];
  process.stdout.write("USAGE\\n" + usage + "\\n\\nOPTIONS\\n" + options.map((option) => "  " + option + "  fixture").join("\\n") + "\\n");
} else if (args[0] === "sites:search") {
  if (args.length !== 3 || args[2] !== "--json") reject();
  else process.stdout.write(JSON.stringify(state.siteName === args[1] ? [{ id: siteId, name: state.siteName }] : []));
} else if (args[0] === "sites:create") {
  if (args.length !== 5 || args[1] !== "--name" || args[3] !== "--disable-linking" || args[4] !== "--json") reject();
  else { state.siteName = args[2]; save(); process.stdout.write(JSON.stringify({ site_id: siteId })); }
} else if (args[0] === "sites:delete") {
  if (!exact(["sites:delete", siteId, "--force"])) reject();
  else { delete state.siteName; delete state.owner; state.deleted = (state.deleted ?? 0) + 1; save(); }
} else if (args[0] === "blobs:delete") {
  if (!exact(["blobs:delete", "doc-state", "mode/4b7d2a/manifest.json", "--force"]) || process.env.NETLIFY_SITE_ID !== siteId) reject();
} else if (args[0] === "env:get") {
  if (!exact(["env:get", "DOC_OWNERS", "--context", "production"]) || process.env.NETLIFY_SITE_ID !== siteId) reject();
  else if (state.owner === undefined) process.exitCode = 1;
  else process.stdout.write(state.owner + "\\n");
} else if (args[0] === "env:set") {
  if (
    args.length !== 3 ||
    args[0] !== "env:set" ||
    args[1] !== "DOC_OWNERS" ||
    !["4b7d2a:owner@example.com", "4b7d2a:hosted@example.com"].includes(args[2]) ||
    process.env.NETLIFY_SITE_ID !== siteId
  ) reject();
  else { state.owner = args[2]; save(); }
} else if (args[0] === "blobs:set") {
  const input = args[4];
  if (args.length !== 5 || !exact(["blobs:set", "doc-state", "mode/4b7d2a/manifest.json", "--input", input]) || !isAbsolute(input) || basename(input) !== "manifest.input" || process.env.NETLIFY_SITE_ID !== siteId) reject();
  else copyFileSync(input, blobPath);
} else if (args[0] === "blobs:list") {
  if (!exact(["blobs:list", "doc-state", "--prefix", "edits/4b7d2a/", "--json"]) || process.env.NETLIFY_SITE_ID !== siteId) reject();
  else process.stdout.write(JSON.stringify(state.emptyInventory === true
    ? { blobs: [], directories: [] }
    : { blobs: [{ etag: "fixture-etag", key: "edits/4b7d2a/a12345678.json" }], directories: [] }));
} else if (args[0] === "blobs:get") {
  const output = args[4];
  if (args.length !== 5 || !isAbsolute(output) || process.env.NETLIFY_SITE_ID !== siteId) reject();
  else if (args[2] === "mode/4b7d2a/manifest.json" && ["manifest.output", "manifest.json"].includes(basename(output))) {
    if (state.drift === true) writeFileSync(output, Buffer.concat([readFileSync(blobPath), Buffer.from("\\n")]));
    else copyFileSync(blobPath, output);
  } else if (args[2] === "edits/4b7d2a/a12345678.json" && /^receipt-0\\.json$/.test(basename(output))) {
    writeFileSync(output, JSON.stringify(promotionReceipt));
  } else reject();
} else if (args[0] === "deploy") {
  if (!exact(["deploy", "--prod", "--no-build", "--dir", "publish", "--json"]) || process.env.NETLIFY_SITE_ID !== siteId) reject();
  else { state.deploys = (state.deploys ?? 0) + 1; save(); process.stdout.write('{"url":"https://fixture-site.netlify.app/"}'); }
} else process.exitCode = 2;
`);
  chmodSync(fakeCli, 0o700);
  const originalCliPath = Object.getOwnPropertyDescriptor(process.env, "NETLIFY_CLI_PATH")?.value;
  process.env.NETLIFY_CLI_PATH = fakeCli;
  try {
    for (const abortKind of ["fetch timeout", "lifecycle timeout"]) {
      let deadlineCallback = null;
      let bodyStarted = false;
      let bodyAborted = false;
      let bodyCancelled = false;
      const fakeFetch = async (_url, options) => ({
        status: 302,
        headers: new Map([
          ["location", "/login/?next=%2F"],
          ["cache-control", "private, no-store"],
        ]),
        body: {
          async cancel() { bodyCancelled = true; },
        },
        arrayBuffer() {
          bodyStarted = true;
          return new Promise((_resolvePromise, rejectPromise) => {
            const aborted = () => {
              bodyAborted = true;
              rejectPromise(options.signal.reason);
            };
            options.signal.addEventListener("abort", aborted, { once: true });
            if (options.signal.aborted) aborted();
            if (abortKind === "lifecycle timeout") process.nextTick(() => deadlineCallback());
          });
        },
      });
      const hostedFailure = runHosted(connect, {
        fetchFn: fakeFetch,
        fetchTimeoutMs: abortKind === "fetch timeout" ? 5 : 10_000,
        repositoryRoot,
        ...(abortKind === "lifecycle timeout" ? {
          scheduleDeadline(callback) {
            deadlineCallback = callback;
            return { kind: "deadline" };
          },
          clearDeadline() {},
        } : {}),
      });
      let hostedError;
      try { await hostedFailure; } catch (error) { hostedError = error; }
      assert.ok(hostedError, `${abortKind} rejected`);
      assert.equal(hostedError.message, `hosted ${abortKind}`);
      assert.equal(bodyStarted, true, `${abortKind} body started: ${hostedError.stack}\n${readFileSync(statePath, "utf8")}`);
      assert.equal(bodyAborted, true, `${abortKind} aborted stalled body`);
      assert.equal(bodyCancelled, true, `${abortKind} cancelled failed body`);
      const hostedState = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(hostedState.siteName, undefined, `${abortKind} remote cleanup`);
      assert.ok(hostedState.deleted >= 1, `${abortKind} site deleted`);
    }
  } finally {
    if (originalCliPath === undefined) delete process.env.NETLIFY_CLI_PATH;
    else process.env.NETLIFY_CLI_PATH = originalCliPath;
  }
  const rejectedBlob = spawnSync(fakeCli, [
    "blobs:set", "wrong-store", `mode/${docId}/manifest.json`, "--input", join(inputRoot, "edit.json"),
  ], {
    env: { PATH: process.env.PATH, NETLIFY_SITE_ID: "123e4567-e89b-12d3-a456-426614174000" },
    encoding: "utf8",
  });
  assert.equal(rejectedBlob.status, 2);
  assert.equal(rejectedBlob.stdout, "");
  assert.equal(rejectedBlob.stderr, "");
  const helpCommand = spawnSync(process.execPath, [join(repositoryRoot, "scripts", "connect.mjs"), "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(helpCommand.status, 0);
  assert.equal(helpCommand.stderr, "");
  assert.equal(helpCommand.stdout,
    "node scripts/connect.mjs --file <html> --manifest <edit.json> [--history <history.json>] --owner <email> --name <new-site-name>\n" +
    "node scripts/connect.mjs --file <html> --manifest <edit.json> [--history <history.json>] --owner <email> --site <site-id>\n" +
    "--history is required when manifest.commit is set; omit --history and #doc-history when it is empty.\n" +
    "node scripts/connect.mjs --help\n");
  const promoteHelpCommand = spawnSync(process.execPath, [join(repositoryRoot, "scripts", "connect.mjs"), "promote", "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(promoteHelpCommand.status, 0);
  assert.equal(promoteHelpCommand.stderr, "");
  assert.equal(promoteHelpCommand.stdout,
    "node scripts/connect.mjs promote --file <html> --manifest <edit.json> [--history <history.json>] --site <site-id> --output <new-directory>\n" +
    "node scripts/connect.mjs promote --help\n");
  const invalidPromoteCommand = spawnSync(process.execPath, [join(repositoryRoot, "scripts", "connect.mjs"), "promote", "--file=page.html"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(invalidPromoteCommand.status, 2);
  assert.equal(invalidPromoteCommand.stdout, "");
  assert.equal(invalidPromoteCommand.stderr, "connect: invalid promotion arguments\n");
  const command = spawnSync(process.execPath, [
    join(repositoryRoot, "scripts", "connect.mjs"),
    "--file", join(inputRoot, "page.html"),
    "--manifest", join(inputRoot, "edit.json"),
    "--history", join(inputRoot, "history.json"),
    "--owner", "OWNER@example.com",
    "--site", "123e4567-e89b-12d3-a456-426614174000",
  ], {
    cwd: repositoryRoot,
    env: { PATH: `${fakeBin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(command.status, 0, command.stderr);
  assert.equal(command.stderr, "");
  assert.equal(command.stdout,
    "Connected document 4b7d2a with owner owner@example.com at https://fixture-site.netlify.app/.\n" +
    "Whoever can deploy this file decides who owns it.\n" +
    "WARNING: In standalone mode, an editor can change the live document without review.\n" +
    "WARNING: Export is the only path back to a reviewable artifact.\n" +
    "WARNING: A Netlify account with site access outranks the document owner.\n");
  const commandTempRoot = join(testRoot, "command-tmp");
  mkdirSync(commandTempRoot);
  const noHistoryCommand = spawnSync(process.execPath, [
    join(repositoryRoot, "scripts", "connect.mjs"),
    "--file", join(inputRoot, "page-no-history.html"),
    "--manifest", join(inputRoot, "edit-no-history.json"),
    "--owner", "OWNER@example.com",
    "--name", "no-history-fixture",
  ], {
    cwd: repositoryRoot,
    env: { PATH: `${fakeBin}:${process.env.PATH}`, TMPDIR: commandTempRoot },
    encoding: "utf8",
  });
  assert.equal(noHistoryCommand.status, 0, noHistoryCommand.stderr);
  assert.equal(noHistoryCommand.stderr, "");
  assert.equal(noHistoryCommand.stdout, command.stdout);
  assert.doesNotMatch(noHistoryHtml, /Example Author/);
  assert.deepEqual(readdirSync(commandTempRoot), [], "no-history create cleans its temporary project");
  const stateAfterNoHistoryCreate = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(stateAfterNoHistoryCreate.siteName, "no-history-fixture", "successful create keeps the new site");
  const deploysAfterSuccess = stateAfterNoHistoryCreate.deploys;
  assert.ok(Number.isInteger(deploysAfterSuccess) && deploysAfterSuccess >= 1);
  const promotedOutput = join(inputRoot, "promoted-cli");
  const promoteCommand = spawnSync(process.execPath, [
    join(repositoryRoot, "scripts", "connect.mjs"), "promote",
    "--file", join(inputRoot, "page-promote.html"),
    "--manifest", join(inputRoot, "edit-no-history.json"),
    "--site", "123e4567-e89b-12d3-a456-426614174000",
    "--output", promotedOutput,
  ], {
    cwd: repositoryRoot,
    env: { PATH: `${fakeBin}:${process.env.PATH}`, TMPDIR: commandTempRoot },
    encoding: "utf8",
  });
  assert.equal(promoteCommand.status, 0, promoteCommand.stderr);
  assert.equal(promoteCommand.stderr, "");
  assert.equal(promoteCommand.stdout,
    "Promoted 1 current overlays; skipped 0 stale overlays.\n" +
    `Wrote reviewable Mode A bundle to '${promotedOutput}'.\n` +
    "Review index.html, document.edit.json, and history.json before reconnecting.\n" +
    `Reconnect with: node scripts/connect.mjs --file '${join(promotedOutput, "index.html")}' --manifest '${join(promotedOutput, "document.edit.json")}' --history '${join(promotedOutput, "history.json")}' --owner <owner-email> --site 123e4567-e89b-12d3-a456-426614174000\n`);
  assert.deepEqual(readdirSync(promotedOutput), ["document.edit.json", "history.json", "index.html"]);
  assert.deepEqual(readdirSync(commandTempRoot), [], "promotion CLI cleans its temporary root");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).deploys, deploysAfterSuccess, "promotion CLI performs no remote deployment");
  const runPromoteCommand = (outputName) => spawnSync(process.execPath, [
    join(repositoryRoot, "scripts", "connect.mjs"), "promote",
    "--file", join(inputRoot, "page-promote.html"),
    "--manifest", join(inputRoot, "edit-no-history.json"),
    "--site", "123e4567-e89b-12d3-a456-426614174000",
    "--output", join(inputRoot, outputName),
  ], {
    cwd: repositoryRoot,
    env: { PATH: `${fakeBin}:${process.env.PATH}`, TMPDIR: commandTempRoot },
    encoding: "utf8",
  });
  const cliSourceLock = join(inputRoot, "edit-no-history.json.promote.lock");
  writeFileSync(cliSourceLock, "pre-existing source lock\n", { mode: 0o600 });
  const historyLockCommand = runPromoteCommand("cli-history-lock");
  assert.equal(historyLockCommand.status, 1);
  assert.equal(historyLockCommand.stdout, "");
  assert.equal(historyLockCommand.stderr, "connect: another promotion owns this history\n");
  assert.equal(readFileSync(cliSourceLock, "utf8"), "pre-existing source lock\n");
  rmSync(cliSourceLock);
  const cliOutputLock = join(inputRoot, "cli-output-lock.publish.lock");
  writeFileSync(cliOutputLock, "pre-existing output lock\n", { mode: 0o600 });
  const outputLockCommand = runPromoteCommand("cli-output-lock");
  assert.equal(outputLockCommand.status, 1);
  assert.equal(outputLockCommand.stdout, "");
  assert.equal(outputLockCommand.stderr, "connect: another promotion owns this output\n");
  assert.equal(readFileSync(cliOutputLock, "utf8"), "pre-existing output lock\n");
  assert.equal(existsSync(cliSourceLock), false);
  rmSync(cliOutputLock);
  const emptyInventoryState = JSON.parse(readFileSync(statePath, "utf8"));
  emptyInventoryState.emptyInventory = true;
  writeFileSync(statePath, JSON.stringify(emptyInventoryState));
  const noCurrentCommand = runPromoteCommand("cli-no-current");
  assert.equal(noCurrentCommand.status, 1);
  assert.equal(noCurrentCommand.stdout, "");
  assert.equal(noCurrentCommand.stderr, "connect: no current overlays to promote\n");
  assert.equal(existsSync(join(inputRoot, "cli-no-current")), false);
  const restoredInventoryState = JSON.parse(readFileSync(statePath, "utf8"));
  delete restoredInventoryState.emptyInventory;
  writeFileSync(statePath, JSON.stringify(restoredInventoryState));
  const runCommand = (owner) => spawnSync(process.execPath, [
    join(repositoryRoot, "scripts", "connect.mjs"),
    "--file", join(inputRoot, "page.html"),
    "--manifest", join(inputRoot, "edit.json"),
    "--history", join(inputRoot, "history.json"),
    "--owner", owner,
    "--site", "123e4567-e89b-12d3-a456-426614174000",
  ], {
    cwd: repositoryRoot,
    env: { PATH: `${fakeBin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  const conflictCommand = runCommand("different@example.com");
  assert.equal(conflictCommand.status, 1);
  assert.equal(conflictCommand.stdout, "");
  assert.equal(conflictCommand.stderr, "connect: setup failed\n");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).deploys, deploysAfterSuccess, "conflict never deploys");
  const driftedState = JSON.parse(readFileSync(statePath, "utf8"));
  driftedState.drift = true;
  writeFileSync(statePath, JSON.stringify(driftedState));
  const driftCommand = runCommand("owner@example.com");
  assert.equal(driftCommand.status, 1);
  assert.equal(driftCommand.stdout, "");
  assert.equal(driftCommand.stderr, "connect: setup failed\n");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).deploys, deploysAfterSuccess, "read-back drift never deploys");
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * A vendored tree with no HOSTED_* variables still serves / and /<slug>/.
 *
 * The connect tool copies four entries into a connected site, and one of them
 * is `netlify.toml`. That file used to configure a repository whose only job
 * was documents. It now configures the merged site as well -- the hosted
 * application, the renderer shell, an edge gate on every path -- and the two
 * origins the hosted half needs are operator-set variables that a connected
 * site does not have and is never asked for.
 *
 * So the property to hold is that none of that reaches a vendored tree. A
 * connected site sets no `HOSTED_APP_ORIGIN` and no `HOSTED_RENDER_ORIGIN`, and
 * what it serves is still a document at `/` and a document at `/<slug>/`. The
 * failure this guards against is a configuration that grew a requirement: an
 * environment key with no default, a redirect that claims a document path, or a
 * header rule that needs a value nobody set.
 * ------------------------------------------------------------------ */
{
  const shippedToml = readFileSync(fileURLToPath(new URL("../netlify.toml", import.meta.url)), "utf8");
  /* Comments explain the absences; a rule a comment can satisfy is not a rule. */
  const live = shippedToml.replace(/^\s*#.*$/gm, "");

  /* The file names no operator variable at all. `HOSTED_APP_ORIGIN` and
     `HOSTED_RENDER_ORIGIN` are read from the site environment by the hosted
     half and default to their strict reading when unset; a value written here
     would be a value every vendored copy inherited. */
  assert.doesNotMatch(live, /HOSTED_/, "the vendored configuration names a hosted operator key");
  /* A block runs to the next line that starts a new one at column zero, or to
     the end of the file. `$` under `m` would end it at the first newline, which
     is a parser that reads no block at all and asserts nothing. */
  const END = "(?=^\\[|(?![\\s\\S]))";
  for (const block of live.matchAll(new RegExp(`^\\[(?:build\\.environment|context\\.[^\\]]+\\.environment)\\]([\\s\\S]*?)${END}`, "gm"))) {
    const keys = [...block[1].matchAll(/^\s*([A-Za-z_][\w]*)\s*=/gm)].map((match) => match[1]);
    for (const key of keys) {
      assert.ok(!key.startsWith("HOSTED_"), `the vendored configuration sets ${key}`);
    }
  }

  /* No rule in the file claims `/` or a document path. The document routes a
     site serves come from the generated `_redirects` in its own publish tree,
     which a connected site's single-document deploy does not carry and does not
     need. */
  for (const redirect of live.matchAll(new RegExp(`^\\[\\[redirects\\]\\]([\\s\\S]*?)${END}`, "gm"))) {
    const from = redirect[1].match(/^\s*from\s*=\s*"([^"]+)"\s*$/m);
    assert.ok(from === null, `the vendored configuration redirects ${from?.[1]}`);
  }

  /* And it applies no header that a browser could refuse the page over. The
     merged site's security headers belong to the edge gate, which a vendored
     tree does not run, so what is left here has to be inert. */
  const headerRules = [];
  /* `[headers.values]` is indented, so it does not end its own block. */
  for (const headers of live.matchAll(new RegExp(`^\\[\\[headers\\]\\]([\\s\\S]*?)${END}`, "gm"))) {
    const forPath = headers[1].match(/^\s*for\s*=\s*"([^"]+)"\s*$/m);
    assert.ok(forPath, "a [[headers]] rule declares no path");
    const values = [...headers[1].matchAll(/^\s{4,}([A-Za-z-]+)\s*=\s*"([^"]*)"\s*$/gm)]
      .map((match) => [match[1], match[2]]);
    assert.ok(values.length > 0, `the ${forPath[1]} header rule declares no values`);
    headerRules.push({ path: forPath[1], values });
  }
  /* A parser that read nothing would satisfy every absence below, so what it
     read is asserted first: the two path-scoped cache rules the merged
     configuration keeps, and nothing else. */
  assert.deepEqual(
    headerRules.map((rule) => rule.path),
    ["/*", "/_assets/*"],
    "the vendored configuration no longer declares the header rules this parses",
  );
  for (const rule of headerRules) {
    for (const [name] of rule.values) {
      assert.ok(
        !/^(content-security-policy|x-frame-options|referrer-policy)$/i.test(name),
        `the vendored configuration declares ${name} on ${rule.path}`,
      );
    }
  }

  /* Now serve it. A two-page publish tree -- the root document and one at a
     slug -- through a server that applies exactly the rules parsed above, with
     every hosted variable removed from the environment first. */
  const previousHosted = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("HOSTED_")) {
      previousHosted[key] = process.env[key];
      delete process.env[key];
    }
  }

  const ROOT_PAGE = "<!doctype html><title>vendored root</title>\n";
  const SLUG_PAGE = "<!doctype html><title>vendored slug</title>\n";
  const tree = new Map([
    ["/", ROOT_PAGE],
    ["/how-archon-works/", SLUG_PAGE],
  ]);
  const matches = (pattern, path) =>
    pattern.endsWith("/*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path;

  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const body = tree.get(path.endsWith("/") ? path : `${path}/`);
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    const headers = { "content-type": "text/html; charset=utf-8" };
    for (const rule of headerRules) {
      if (!matches(rule.path, path)) continue;
      for (const [name, value] of rule.values) headers[name.toLowerCase()] = value;
    }
    response.writeHead(200, headers).end(body);
  });
  try {
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const origin = `http://127.0.0.1:${server.address().port}`;

    for (const [path, expected] of [["/", ROOT_PAGE], ["/how-archon-works/", SLUG_PAGE]]) {
      const response = await fetch(`${origin}${path}`, { redirect: "manual" });
      assert.equal(response.status, 200, `a vendored tree did not serve ${path}`);
      assert.equal(await response.text(), expected, `a vendored tree served the wrong bytes at ${path}`);
      assert.equal(response.headers.get("content-security-policy"), null, `${path} carried a TOML policy`);
      assert.equal(response.headers.get("x-frame-options"), null, `${path} carried a TOML frame rule`);
      /* The one thing the configuration does still say about these paths, and
         it says the same thing on either of the site's two hosts. */
      assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    }
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    for (const [key, value] of Object.entries(previousHosted)) process.env[key] = value;
  }
  console.log("PASS  ACN-001 vendored tree serves / and /<slug>/ with no HOSTED_* variables");
}

console.log("PASS  P4-S pure connect contract");
console.log("PASS  P4-S supervised Netlify protocol");
console.log("PASS  P4-R supervisor signals and deadline");
console.log("PASS  P4-R pure promotion and atomic bundle");
console.log("PASS  P4-R supervised tokenless export");
console.log("PASS  P4-R fixture cleaned");
}
