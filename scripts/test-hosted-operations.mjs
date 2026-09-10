#!/usr/bin/env node
/**
 * AHU-011 — the permanent hosted operations regression runner.
 *
 *   node scripts/test-hosted-operations.mjs
 *
 * One entry point, no arguments, no credentials, no provider contact. This is
 * the gate for the operational half of the hosted service: the publish-disable
 * policy, the two platform rate rules, the production origin rules, the redacted
 * operator environment example, the renderer deployment definition, and the
 * read-only census projection.
 *
 * Everything here drives *real* code. The disable policy is asserted by calling
 * AHU-004's exported handlers with a dependency set built by AHU-004's own
 * `publicationDependencies` from AHU-001's real `readHostedConfig`, so a change
 * to either producer that broke the policy fails here rather than being matched
 * against a documentation string. The rate rules are read off the handler
 * modules' actual `config` exports, which is the object Netlify packages, not
 * off the TOML and not off prose. The origin matrix goes through
 * `readHostedConfig` and therefore through the pinned public-suffix list.
 *
 * The one thing that cannot be real yet is the renderer build: AHU-005 owns
 * `renderer/scripts/build.mjs` and has not merged at this phase barrier. The
 * *invocation contract* is what this ticket owns and what is asserted here — the
 * command `renderer/netlify.toml` declares, run from the declared base
 * directory, must produce the declared publish directory — and it is asserted
 * against a temporary synthetic build fixture written into a fresh temp
 * directory. Reconnecting that assertion to the real renderer build is
 * AHU-012's.
 *
 * Every identity, origin, secret and document in this file is synthetic.
 *
 * Output contract: one `PASS  ` line per section on stdout and exit 0, or one
 * `FAIL  ` line naming the section and the assertion on stderr and exit 1.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  HOSTED_CONFIG_KEYS,
  readHostedConfig,
} from "../hosted/lib/config.mjs";
import { HOSTED_LIMITS, validateWireError } from "../hosted/lib/contracts.mjs";
import { publicationDependencies } from "../hosted/lib/publications.mjs";
import startHandler, {
  handleStart,
  config as startConfig,
} from "../hosted/functions/publications-start.mjs";
import statusHandler, {
  handleStatus,
  config as statusConfig,
} from "../hosted/functions/publications-status.mjs";
import cancelHandler, { config as cancelConfig } from "../hosted/functions/publications-cancel.mjs";
import {
  FIXTURE_APP_ORIGIN,
  FIXTURE_HTML,
  FIXTURE_KEY,
  FIXTURE_PUBLICATION_ID,
  FIXTURE_RECORD_AGENT_SECRET,
  FIXTURE_RESULT,
  PUBLISHING_ENV,
  RECORDS,
  VALID_DESCRIPTOR,
} from "../hosted/test/fixtures/publications.mjs";
import {
  FIXTURE_LOCAL_APP_ORIGIN,
  FIXTURE_LOCAL_RENDER_ORIGIN,
  FIXTURE_PRIVATE_SUFFIX_APP_ORIGIN,
  FIXTURE_PRIVATE_SUFFIX_RENDER_ORIGIN,
  FIXTURE_RENDER_ORIGIN,
  FIXTURE_SIBLING_RENDER_ORIGIN,
  FIXTURE_UNLISTED_SUFFIX_ORIGIN,
} from "../hosted/test/contract-fixtures.mjs";
import { createProviderDouble } from "../hosted/test/helpers/publication-store.mjs";
import {
  CENSUS_FORBIDDEN_FIELDS,
  CENSUS_ROW_FIELDS,
  censusRow,
  parseCensusArguments,
  runCensus,
  summariseCensus,
} from "./hosted-census.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);

/* The values C6 freezes, written out as literals rather than imported from the
   modules under test. Asserting a production constant against itself proves only
   that the constant was used, so halving a limit would keep every check green. */
const START_ROUTE = "/api/hosted/publications";
const STATUS_ROUTE = "/api/hosted/publications/:publicationId/status";
const START_RATE = { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] };
const STATUS_RATE = { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] };
const RENDERER_BUILD_COMMAND = "node scripts/build.mjs";
const RENDERER_PUBLISH_DIR = "dist";

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const sections = [];
const section = (name, body) => sections.push({ name, body });

/** A dependency set built the way the deploy builds it: real config, real store adapter. */
function deployment({ publishEnabled, seed = null } = {}) {
  const provider = createProviderDouble();
  if (seed !== null) provider.put(FIXTURE_KEY, JSON.stringify(RECORDS[seed]));
  const env = { ...PUBLISHING_ENV };
  if (publishEnabled === undefined) delete env.HOSTED_PUBLISH_ENABLED;
  else env.HOSTED_PUBLISH_ENABLED = publishEnabled;
  return {
    provider,
    resolve: () => publicationDependencies({ env, getStore: provider.getStore }),
  };
}

const request = (path, { method = "POST", headers = {}, body } = {}) =>
  new Request(`${FIXTURE_APP_ORIGIN}${path}`, { method, headers, body });

const descriptorBody = (descriptor = VALID_DESCRIPTOR) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(descriptor),
});

/** A TOML file with its comment lines removed, so prose cannot satisfy a check. */
async function liveToml(path) {
  const text = await readFile(join(ROOT, path), "utf8");
  return text.replace(/^\s*#.*$/gm, "");
}

/* ------------------------------------------------------------------ */
/* 1. the publish-disable policy, against the real handlers            */
/* ------------------------------------------------------------------ */

section("publish-disable policy runs against AHU-004's real handlers", async () => {
  /* Unset and the literal "false" are one policy, and both are asserted: an
     operator who never set the key and one who set it to false have both not
     enabled publishing, and a default that differed between them would make the
     example file's `false` and a fresh site behave differently. */
  for (const publishEnabled of [undefined, "false"]) {
    const spelling = publishEnabled === undefined ? "unset" : `"${publishEnabled}"`;
    const { resolve: resolveDeps } = deployment({ publishEnabled });
    const response = await handleStart(
      request(START_ROUTE, descriptorBody()),
      resolveDeps,
    );
    const body = await response.json();
    assert.equal(response.status, 503, `${spelling}: start must answer 503, got ${response.status}`);
    assert.deepEqual(validateWireError(body), body, `${spelling}: must be a legal C3 error envelope`);
    assert.equal(
      body.error.code,
      "publishing_disabled",
      `${spelling}: start must be refused as publishing_disabled, got ${body.error.code}`,
    );
  }

  /* The negative control. Without it the two checks above would still pass on a
     deployment that refused every start for some unrelated reason - a broken
     descriptor validator, say - and the policy would be "asserted" by a service
     that does not work at all. */
  const enabled = deployment({ publishEnabled: "true" });
  const started = await handleStart(request(START_ROUTE, descriptorBody()), enabled.resolve);
  assert.equal(started.status, 201, `enabled: start must answer 201, got ${started.status}`);

  /* And the refusal must be the flag rather than the payload: with publishing
     off, a descriptor that would be rejected as invalid is still refused as
     publishing_disabled, which is what proves the check runs first and is not
     an artefact of the body. */
  const off = deployment({ publishEnabled: "false" });
  const garbage = await handleStart(
    request(START_ROUTE, descriptorBody({ v: 1, title: "" })),
    off.resolve,
  );
  assert.equal(garbage.status, 503, "an invalid descriptor must still be refused for the flag");
});

section("disabled publishing preserves completed receipts and bytes", async () => {
  const { provider, resolve: resolveDeps } = deployment({ publishEnabled: "false", seed: "complete" });
  const before = provider.raw(FIXTURE_KEY);

  const response = await handleStatus(
    request(`${START_ROUTE}/${FIXTURE_PUBLICATION_ID}/status`, {
      headers: { authorization: `Bearer ${FIXTURE_RECORD_AGENT_SECRET}` },
    }),
    resolveDeps,
  );
  const body = await response.json();
  assert.equal(response.status, 200, `status must answer 200 while disabled, got ${response.status}`);
  assert.equal(body.state, "complete", `state must stay complete, got ${body.state}`);
  assert.deepEqual(body.result, FIXTURE_RESULT, "the completed receipt must be served unchanged");
  assert.equal(
    body.intervalSeconds,
    HOSTED_LIMITS.POLL_INTERVAL_SECONDS,
    "the advertised poll interval must be unchanged while disabled",
  );

  const after = provider.raw(FIXTURE_KEY);
  assert.deepEqual(after, before, "reading a receipt must not rewrite the stored record");
  const stored = JSON.parse(after.data);
  assert.equal(stored.ownerAccountId, RECORDS.complete.ownerAccountId, "owner must not change");
  assert.equal(stored.html, RECORDS.complete.html, "completed bytes must not change");
});

/* ------------------------------------------------------------------ */
/* 2. the two platform rate rules, on the real exports                 */
/* ------------------------------------------------------------------ */

section("exactly two rate rules, on exactly the start and status routes", async () => {
  const routes = [
    { name: "start", module: { default: startHandler, config: startConfig }, path: START_ROUTE, rate: START_RATE },
    { name: "status", module: { default: statusHandler, config: statusConfig }, path: STATUS_ROUTE, rate: STATUS_RATE },
    { name: "cancel", module: { default: cancelHandler, config: cancelConfig }, path: null, rate: null },
  ];

  for (const route of routes) {
    if (route.path !== null) {
      assert.equal(route.module.config.path, route.path, `${route.name} must keep its exact C3 path`);
    }
    if (route.rate === null) {
      assert.equal(
        route.module.config.rateLimit,
        undefined,
        `${route.name} must not declare a rate rule: C6 budgets two, on the public and polled routes`,
      );
      continue;
    }
    assert.deepEqual(
      route.module.config.rateLimit,
      route.rate,
      `${route.name} must declare exactly its C6 rule; a field the platform cannot parse is dropped silently`,
    );
  }

  /* A rule can only be misapplied by being attached to a route that matches more
     than it should, so the route shapes are checked too: every hosted function
     is namespaced, and none of them is a catch-all that a rule would then cover
     for the whole application. */
  for (const route of routes) {
    const declared = Array.isArray(route.module.config.path)
      ? route.module.config.path
      : [route.module.config.path];
    for (const path of declared) {
      assert.equal(typeof path, "string", `${route.name} must declare string routes`);
      assert.ok(path.startsWith("/api/hosted/"), `${route.name} is routed outside /api/hosted/*`);
      assert.ok(!path.includes("*"), `${route.name} declares the wildcard route ${path}`);
    }
  }

  /* Netlify has no supported TOML function-rate property, so a rule written
     there would look configured and do nothing. Neither deployment file may
     carry one. */
  for (const file of ["hosted/netlify.toml", "renderer/netlify.toml"]) {
    const live = await liveToml(file);
    assert.doesNotMatch(live, /rateLimit|rate_limit|windowLimit/i, `${file} must declare no rate rule`);
  }
});

/* ------------------------------------------------------------------ */
/* 3. production origin rules, through the real config owner           */
/* ------------------------------------------------------------------ */

section("production origin and registrable-site rules", async () => {
  const base = { ...PUBLISHING_ENV };
  const config = (app, render, options) =>
    readHostedConfig({ ...base, HOSTED_APP_ORIGIN: app, HOSTED_RENDER_ORIGIN: render }, options);

  const accepted = [
    ["two separate sites", FIXTURE_APP_ORIGIN, FIXTURE_RENDER_ORIGIN],
    /* The private-suffix pair. `pages.dev` is a *private* entry on the
       public-suffix list, so these are two registrable sites; a check that
       compared the last two hostname labels would call them one and refuse a
       correct configuration. This row is the one that fails under that
       mutation. */
    ["a private public-suffix pair", FIXTURE_PRIVATE_SUFFIX_APP_ORIGIN, FIXTURE_PRIVATE_SUFFIX_RENDER_ORIGIN],
    /* Two sites under one multi-label public suffix. Same shape, the other way
       round: `co.uk` is the suffix, so these differ, and a last-two-labels
       check would call them both "co.uk" and refuse. */
    ["two sites under a multi-label suffix", "https://archon-app.co.uk", "https://archon-render.co.uk"],
  ];
  for (const [name, app, render] of accepted) {
    const result = config(app, render);
    assert.equal(result.appOrigin, app, `${name}: must be accepted`);
    assert.notEqual(result.appSite, result.renderSite, `${name}: must resolve to two sites`);
  }

  const refused = [
    ["identical origins", FIXTURE_APP_ORIGIN, FIXTURE_APP_ORIGIN],
    ["sibling subdomains of one site", FIXTURE_APP_ORIGIN, FIXTURE_SIBLING_RENDER_ORIGIN],
    /* A bare public suffix has no registrable domain above it, so there is no
       site to compare. A last-two-labels check would happily call this a site. */
    ["a bare public suffix", "https://co.uk", FIXTURE_RENDER_ORIGIN],
    ["an unlisted suffix", FIXTURE_UNLISTED_SUFFIX_ORIGIN, FIXTURE_RENDER_ORIGIN],
    ["plain http in production", "http://app.archon.example.com", FIXTURE_RENDER_ORIGIN],
    ["credentials in the origin", "https://user:pass@app.archon.example.com", FIXTURE_RENDER_ORIGIN],
    ["a wildcard host", "https://*.archon.example.com", FIXTURE_RENDER_ORIGIN],
    ["a trailing slash", "https://app.archon.example.com/", FIXTURE_RENDER_ORIGIN],
    ["a path", "https://app.archon.example.com/publish", FIXTURE_RENDER_ORIGIN],
    ["a trailing dot", "https://app.archon.example.com.", FIXTURE_RENDER_ORIGIN],
    ["a loopback origin in production", FIXTURE_LOCAL_APP_ORIGIN, FIXTURE_RENDER_ORIGIN],
  ];
  for (const [name, app, render] of refused) {
    assert.throws(
      () => config(app, render),
      (error) => {
        assert.equal(error.name, "HostedConfigError", `${name}: must fail as configuration`);
        /* A configuration error is copied into deploy logs and issue comments
           verbatim, and half of these keys carry a credential. The rule may be
           named; the value may not. */
        assert.ok(
          !error.message.includes(app) && !error.message.includes(base.GITHUB_CLIENT_SECRET),
          `${name}: the error must name the key and a rule, never a value`,
        );
        return true;
      },
      `${name}: must be refused`,
    );
  }

  /* The relaxed mode is reachable only by argument. No value an operator can set
     on a deployed site selects it, which is what keeps "loopback is allowed" out
     of production. */
  const local = config(FIXTURE_LOCAL_APP_ORIGIN, FIXTURE_LOCAL_RENDER_ORIGIN, { mode: "local-test" });
  assert.equal(local.production, false, "local-test mode must not be production");
  assert.throws(
    () => config(FIXTURE_APP_ORIGIN, FIXTURE_RENDER_ORIGIN, { mode: "local-test" }),
    /loopback/,
    "local-test mode must refuse two real sites",
  );
});

/* ------------------------------------------------------------------ */
/* 4. the operator environment example                                 */
/* ------------------------------------------------------------------ */

section("hosted/.env.example is redacted and defaults to disabled", async () => {
  const text = await readFile(join(ROOT, "hosted/.env.example"), "utf8");
  const env = Object.fromEntries(
    text
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

  assert.deepEqual(
    Object.keys(env).sort(),
    [...HOSTED_CONFIG_KEYS].sort(),
    "the example must carry exactly the five C6 keys the config owner reads",
  );
  assert.equal(
    env.HOSTED_PUBLISH_ENABLED,
    "false",
    "the example must ship with publishing disabled",
  );

  /* The placeholders are held to every rule a deploy is held to. An example that
     an operator copies and that then fails to start is worse than no example. */
  const config = readHostedConfig(env);
  assert.equal(config.publishEnabled, false, "the example must read back as disabled");
  assert.notEqual(config.appSite, config.renderSite, "the example origins must be two sites");

  /* Reserved documentation names only: nothing here may name a domain somebody
     owns, because an example is what gets pasted into a production site. */
  for (const key of ["HOSTED_APP_ORIGIN", "HOSTED_RENDER_ORIGIN"]) {
    const { hostname } = new URL(env[key]);
    assert.ok(
      hostname.endsWith(".example.com") || hostname.endsWith(".example.net"),
      `${key} must use a reserved documentation domain, got ${hostname}`,
    );
  }

  /* And no credential-shaped string anywhere in the file, in a value or in the
     prose around it. */
  assert.ok(
    env.GITHUB_CLIENT_SECRET.includes("example"),
    "the client secret placeholder must announce itself as an example",
  );
  for (const pattern of [/gh[pousr]_[A-Za-z0-9]{20,}/, /\b[0-9a-f]{40}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY/]) {
    assert.doesNotMatch(text, pattern, `the example must contain no credential matching ${pattern}`);
  }
});

/* ------------------------------------------------------------------ */
/* 5. the renderer deployment definition and its invocation contract   */
/* ------------------------------------------------------------------ */

section("renderer/netlify.toml deploys static files and no functions", async () => {
  const live = await liveToml("renderer/netlify.toml");

  assert.match(
    live,
    new RegExp(`^\\s*command\\s*=\\s*"${RENDERER_BUILD_COMMAND}"\\s*$`, "m"),
    "the renderer must invoke its own build",
  );
  assert.match(
    live,
    new RegExp(`^\\s*publish\\s*=\\s*"${RENDERER_PUBLISH_DIR}"\\s*$`, "m"),
    "the renderer must publish the build's output directory",
  );
  assert.match(live, /^\s*NODE_VERSION\s*=\s*"[^"]+"\s*$/m, "the renderer must pin NODE_VERSION");

  /* The absences are the security property, and an absence is exactly what a
     diff review skims. */
  assert.doesNotMatch(live, /\[functions\]/, "the renderer runs no server code");
  assert.doesNotMatch(live, /\[\[edge_functions\]\]/, "the renderer carries no edge function");
  assert.doesNotMatch(live, /included_files/, "included_files would widen the deploy tree");
  assert.doesNotMatch(
    live,
    /\[\[headers\]\]/,
    "the renderer's headers are generated by its build; a second authority here could disagree",
  );

  const environment = live.match(/^\[build\.environment\]$([\s\S]*?)(?=^\[|\Z)/m);
  assert.ok(environment, "renderer/netlify.toml is missing [build.environment]");
  const keys = [...environment[1].matchAll(/^\s*([A-Za-z_][\w]*)\s*=/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["NODE_VERSION"], "no secret or C6 key belongs in git");

  /* The renderer directory itself must hold no server code and no private
     fixture, whatever the TOML says. */
  assert.ok(!existsSync(join(ROOT, "renderer/functions")), "renderer/functions must not exist");
  assert.ok(!existsSync(join(ROOT, "renderer/.env")), "renderer/.env must not exist");
});

section("the renderer build invocation contract, against a synthetic fixture", async () => {
  /* AHU-005 owns `renderer/scripts/build.mjs` and has not merged at this phase
     barrier, so what is asserted here is the contract this ticket owns: the
     command `renderer/netlify.toml` declares, executed with the declared base
     directory as its working directory, produces the declared publish
     directory. The fixture stands in for the real build; reconnecting this to
     it is AHU-012's, and a fixture pass is not a live acceptance result. */
  const root = await mkdtemp(join(tmpdir(), "archon-renderer-contract-"));
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(
      join(root, "scripts", "build.mjs"),
      [
        'import { mkdir, writeFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        `const out = join(process.cwd(), ${JSON.stringify(RENDERER_PUBLISH_DIR)});`,
        "await mkdir(out, { recursive: true });",
        'await writeFile(join(out, "index.html"), "<!doctype html><title>synthetic</title>\\n");',
        'await writeFile(join(out, "_headers"), "/*\\n  X-Content-Type-Options: nosniff\\n");',
      ].join("\n"),
    );

    const [command, ...args] = RENDERER_BUILD_COMMAND.split(" ");
    assert.equal(command, "node", "the declared build command must be a plain node invocation");
    await run(process.execPath, args, { cwd: root });

    for (const emitted of ["index.html", "_headers"]) {
      assert.ok(
        existsSync(join(root, RENDERER_PUBLISH_DIR, emitted)),
        `the declared command must emit ${RENDERER_PUBLISH_DIR}/${emitted} into the publish directory`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 6. the read-only census                                             */
/* ------------------------------------------------------------------ */

section("the census counts records without disclosing content", async () => {
  const nowMs = Date.parse(RECORDS.complete.completedAt) + 7200 * 1000;

  const row = censusRow(RECORDS.complete, nowMs);
  assert.deepEqual(
    Object.keys(row).sort(),
    [...CENSUS_ROW_FIELDS].sort(),
    "a census row must carry exactly the declared fields",
  );
  assert.equal(row.state, "complete");
  assert.equal(row.artifactBytes, RECORDS.complete.descriptor.contentBytes);
  assert.equal(row.ageBucket, "under1d", `a two-hour-old record is under1d, got ${row.ageBucket}`);

  /* A pending record holds no bytes, so counting its declared size as retained
     would report storage that does not exist. */
  assert.equal(censusRow(RECORDS.pending, nowMs).artifactBytes, 0);

  const summary = summariseCensus(Object.values(RECORDS).map((record) => censusRow(record, nowMs)));
  assert.equal(summary.total, Object.keys(RECORDS).length);
  assert.equal(
    summary.retainedBytes,
    RECORDS.complete.descriptor.contentBytes,
    "retained bytes must count completed records only",
  );

  /* The disclosure check, over the serialised report rather than over one row:
     a field added to `Publication` must not reach an operational report, and
     neither must the values that identify or unlock a document. */
  const serialised = JSON.stringify(summary);
  for (const field of CENSUS_FORBIDDEN_FIELDS) {
    assert.ok(!serialised.includes(`"${field}"`), `the census must not emit a ${field} field`);
  }
  for (const [what, value] of [
    ["the document's HTML", FIXTURE_HTML.slice(0, 40)],
    ["the artifact digest", RECORDS.complete.descriptor.contentSha256],
    ["the agent secret hash", RECORDS.complete.agentSecretHash],
    ["the browser secret hash", RECORDS.complete.browserSecretHash],
    ["the pairing code", RECORDS.complete.userCode],
    ["the owner account", RECORDS.complete.ownerAccountId],
    ["the document title", RECORDS.complete.descriptor.title],
  ]) {
    assert.ok(!serialised.includes(value), `the census must not disclose ${what}`);
  }
});

section("the census requires explicit targets and cannot write", async () => {
  for (const argv of [[], ["--store", "archon-hosted-v1"], ["--prefix", "publications/"], ["--wipe"]]) {
    assert.throws(
      () => parseCensusArguments(argv),
      /required|unknown argument/,
      `\`${argv.join(" ") || "(no arguments)"}\` must be refused`,
    );
  }

  const calls = [];
  const mutate = (name) => () => {
    throw new Error(`the census called the mutating method ${name}`);
  };
  const store = {
    async list(options) {
      calls.push("list");
      assert.equal(options.prefix, "publications/", "the census must list the prefix it was given");
      return { blobs: [{ key: FIXTURE_KEY }, { key: "publications/unreadable" }] };
    },
    async getWithMetadata(key) {
      calls.push("get");
      if (key === FIXTURE_KEY) return { data: JSON.stringify(RECORDS.complete), etag: '"1"' };
      return { data: "{not json", etag: '"2"' };
    },
    set: mutate("set"),
    setJSON: mutate("setJSON"),
    delete: mutate("delete"),
  };

  const opened = [];
  const summary = await runCensus({
    argv: ["--store", "archon-hosted-v1", "--prefix", "publications/"],
    getStore: (options) => {
      opened.push(options);
      return store;
    },
    now: () => Date.parse(RECORDS.complete.completedAt) + 1000,
  });

  assert.deepEqual(opened, [{ name: "archon-hosted-v1", consistency: "strong" }], "the census must open the named store strongly");
  assert.deepEqual(calls, ["list", "get", "get"], "the census must only list and read");
  assert.equal(summary.total, 1, "one legible record");
  assert.equal(summary.unreadable, 1, "an illegible record is counted, never guessed at");
  assert.equal(summary.byState.complete, 1);
  assert.equal(summary.retainedBytes, RECORDS.complete.descriptor.contentBytes);
  assert.ok(!JSON.stringify(summary).includes("not json"), "unreadable bytes must not reach the report");
});

/* ------------------------------------------------------------------ */
/* 7. the runbook documents what the code actually does                */
/* ------------------------------------------------------------------ */

section("hosted/OPERATIONS.md matches the deployed configuration", async () => {
  const runbook = await readFile(join(ROOT, "hosted/OPERATIONS.md"), "utf8");

  /* Only facts a reader would act on wrongly if they drifted: the two rate
     numbers, the store the census names, the two build settings an operator
     types into a provider form, and the window the runbook tells them to wait
     out before believing publishing has stopped. */
  const pendingMinutes = HOSTED_LIMITS.PENDING_TTL_SECONDS / 60;
  const uploadMinutes = HOSTED_LIMITS.UPLOAD_TTL_SECONDS / 60;
  for (const [what, needle] of [
    ["the start rate limit", `| \`POST ${START_ROUTE}\` | ${START_RATE.windowLimit} | 60s |`],
    ["the status rate limit", `| ${STATUS_RATE.windowLimit} | 60s |`],
    ["the renderer build command", `\`${RENDERER_BUILD_COMMAND}\``],
    ["the publication store name", "archon-hosted-v1"],
    ["the census entry point", "scripts/hosted-census.mjs"],
    ["the disable tail", `${pendingMinutes} minutes + ${uploadMinutes} minutes`],
    ["the total disable tail", `${pendingMinutes + uploadMinutes} minutes`],
    ["the receipt window", `${HOSTED_LIMITS.RECEIPT_TTL_SECONDS / 3600}-hour`],
  ]) {
    assert.ok(runbook.includes(needle), `the runbook must state ${what} (${JSON.stringify(needle)})`);
  }

  /* The runbook must not promise what the platform does not deliver. */
  for (const claim of [/instantly revok/i, /immediately revok/i, /takes effect immediately/i]) {
    assert.doesNotMatch(runbook, claim, `the runbook must not promise instant revocation (${claim})`);
  }
});

/* ------------------------------------------------------------------ */

let failed = 0;
for (const { name, body } of sections) {
  try {
    await body();
    process.stdout.write(`PASS  ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`FAIL  ${name}: ${error.message.split("\n")[0]}\n`);
  }
}
if (failed === 0) {
  process.stdout.write(`PASS  hosted operations: ${sections.length} sections\n`);
} else {
  process.stderr.write(`FAIL  hosted operations: ${failed}/${sections.length} sections failed\n`);
  process.exitCode = 1;
}
