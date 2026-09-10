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
 * The renderer deployment's fail-closed rules belong to AHU-005's
 * `scripts/test-hosted-renderer.mjs`, which guards the byte-identical copy of
 * `renderer/netlify.toml` this branch carries; restating them here would be a
 * second authority for one file. What is left here is this ticket's own: no rate
 * rule may be spelled in TOML, and the build invocation contract.
 *
 * The renderer build itself is AHU-005's: it owns `renderer/scripts/build.mjs`
 * and `scripts/test-hosted-renderer.mjs`, which builds that script for real and
 * serves its output. What this ticket owns, and what is asserted here, is the
 * *invocation contract* — the command `renderer/netlify.toml` declares, run from
 * the declared base directory, must produce the declared publish directory. It
 * is asserted against a temporary synthetic build fixture rather than against
 * the real build so that this runner does not become a second authority over
 * AHU-005's output; the fixture isolates the contract from what the build emits.
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  HOSTED_CONFIG_KEYS,
  readHostedConfig,
} from "../hosted/lib/config.mjs";
import { HOSTED_LIMITS, validateWireError } from "../hosted/lib/contracts.mjs";
import { completePublication, publicationDependencies } from "../hosted/lib/publications.mjs";
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
  credentialedStoreOpener,
  hostedBlobsSpecifier,
  parseCensusArguments,
  readOnlyHandle,
  requireBlobsCredentials,
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

section("disabled publishing refuses a new upload but not an earned receipt", async () => {
  /* C6 gates start *and* upload. AHU-004 landed the start half; this is the
     upload half, and the distinction that matters is between committing new
     bytes - which the flag refuses - and recovering a receipt for bytes already
     committed, which it must not touch. */
  /* Inside the approved record's upload window: the fixture is stamped at a
     fixed instant, so the wall clock would have it expired and every case below
     would answer authorization_expired instead of exercising the flag. */
  const beforeUploadDeadline = () => Date.parse(RECORDS.approved.uploadExpiresAt) - 1000;

  const approved = deployment({ publishEnabled: "false", seed: "approved" });
  const before = approved.provider.raw(FIXTURE_KEY);
  await assert.rejects(
    () =>
      completePublication(
        {
          publicationId: FIXTURE_PUBLICATION_ID,
          agentSecret: FIXTURE_RECORD_AGENT_SECRET,
          html: FIXTURE_HTML,
          contentSha256: VALID_DESCRIPTOR.contentSha256,
          contentBytes: VALID_DESCRIPTOR.contentBytes,
        },
        { ...approved.resolve(), now: beforeUploadDeadline },
      ),
    (error) => {
      assert.equal(error.code, "publishing_disabled", `upload must be refused for the flag, got ${error.code}`);
      return true;
    },
    "an approved publication must not commit bytes while publishing is disabled",
  );
  assert.deepEqual(
    approved.provider.raw(FIXTURE_KEY),
    before,
    "a refused upload must not write to the record",
  );

  /* The negative control: the same call with publishing on must commit, so the
     refusal above is the flag and not a broken upload path. */
  const on = deployment({ publishEnabled: "true", seed: "approved" });
  const committed = await completePublication(
    {
      publicationId: FIXTURE_PUBLICATION_ID,
      agentSecret: FIXTURE_RECORD_AGENT_SECRET,
      html: FIXTURE_HTML,
      contentSha256: VALID_DESCRIPTOR.contentSha256,
      contentBytes: VALID_DESCRIPTOR.contentBytes,
    },
    { ...on.resolve(), now: beforeUploadDeadline },
  );
  assert.equal(committed.created, true, "publishing enabled must commit the approved bytes");

  /* And receipt recovery survives the tap: an identical retry against an
     already-complete record answers with its receipt, not a 503. */
  const recovered = deployment({ publishEnabled: "false", seed: "complete" });
  const retry = await completePublication(
    {
      publicationId: FIXTURE_PUBLICATION_ID,
      agentSecret: FIXTURE_RECORD_AGENT_SECRET,
      html: RECORDS.complete.html,
      contentSha256: RECORDS.complete.descriptor.contentSha256,
      contentBytes: RECORDS.complete.descriptor.contentBytes,
    },
    { ...recovered.resolve(), now: () => Date.parse(RECORDS.complete.completedAt) + 1000 },
  );
  assert.equal(retry.created, false, "an identical retry is a recovery, not a creation");
  assert.deepEqual(retry.result, FIXTURE_RESULT, "the earned receipt must survive disabled publishing");
});

section("disabled publishing preserves completed receipts and bytes", async () => {
  const { provider, resolve: resolveDeps } = deployment({ publishEnabled: "false", seed: "complete" });
  const before = provider.raw(FIXTURE_KEY);

  /* Pin the clock inside the receipt window, as every other section does: the
     fixture is stamped at a fixed instant, so on the wall clock the receipt
     expires a day later and this section would start answering 410. */
  const withinReceiptWindow = () => ({
    ...resolveDeps(),
    now: () => Date.parse(RECORDS.complete.completedAt) + 1000,
  });
  const response = await handleStatus(
    request(`${START_ROUTE}/${FIXTURE_PUBLICATION_ID}/status`, {
      headers: { authorization: `Bearer ${FIXTURE_RECORD_AGENT_SECRET}` },
    }),
    withinReceiptWindow,
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
    let result;
    try {
      result = config(app, render);
    } catch (error) {
      /* Named rather than propagated: the two rows above fail exactly when the
         site comparison stops consulting the public-suffix list, and a bare
         "must be a different registrable site" gives no clue which row that
         was. */
      assert.fail(`${name}: must be accepted, but was refused: ${error.message}`);
    }
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

section("renderer/netlify.toml declares no rate rule of its own", async () => {
  /* Deliberately narrow. AHU-005's `scripts/test-hosted-renderer.mjs` owns the
     renderer deployment's fail-closed assertion - no functions, no edge
     function, no second header authority, no environment beyond the Node
     version, and the exact build command and publish directory - and this file
     is byte-identical to the copy that runner guards. Restating those rules
     here would be a second authority for the same file, which is the failure
     mode that assertion exists to prevent.

     What is left is this ticket's own: a rate rule may not be written in TOML.
     Netlify has no supported TOML function-rate property, so a rule spelled
     there would look configured and do nothing.

     The invocation contract is the section below. */
  const live = await liveToml("renderer/netlify.toml");
  assert.doesNotMatch(live, /rateLimit|rate_limit|windowLimit/i, "renderer/netlify.toml must declare no rate rule");
});

section("the renderer build invocation contract, against a synthetic fixture", async () => {
  /* AHU-005 owns `renderer/scripts/build.mjs` and exercises it for real in
     `scripts/test-hosted-renderer.mjs`. What is asserted here is the contract
     this ticket owns and that runner does not: the command
     `renderer/netlify.toml` declares, executed with the declared base directory
     as its working directory, produces the declared publish directory. The
     fixture stands in for the build deliberately - driving the real one here
     would put two runners in charge of one output - and a fixture pass is not a
     live acceptance result either way. */
  const live = await liveToml("renderer/netlify.toml");
  const declaredCommand = live.match(/^\s*command\s*=\s*"([^"]+)"\s*$/m);
  const declaredPublish = live.match(/^\s*publish\s*=\s*"([^"]+)"\s*$/m);
  assert.ok(declaredCommand, "renderer/netlify.toml declares no build command to invoke");
  assert.ok(declaredPublish, "renderer/netlify.toml declares no publish directory");
  assert.equal(declaredCommand[1], RENDERER_BUILD_COMMAND, "the invocation this contract covers");
  assert.equal(declaredPublish[1], RENDERER_PUBLISH_DIR, "the output directory this contract covers");

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

  /* The call log above only catches a mutator the census actually invokes. The
     surface itself is the invariant: a `delete` passthrough added to
     `readOnlyHandle` and never called would leave every assertion above green. */
  assert.deepEqual(
    Object.keys(readOnlyHandle(store)),
    ["list", "getWithMetadata"],
    "the census handle must expose exactly `list` and `getWithMetadata`",
  );
  assert.ok(Object.isFrozen(readOnlyHandle(store)), "the census handle must be frozen, so no method can be added to it");
  assert.equal(summary.total, 1, "one legible record");
  assert.equal(summary.unreadable, 1, "an illegible record is counted, never guessed at");
  assert.equal(summary.byState.complete, 1);
  assert.equal(summary.retainedBytes, RECORDS.complete.descriptor.contentBytes);
  assert.ok(!JSON.stringify(summary).includes("not json"), "unreadable bytes must not reach the report");
});

section("the census carries its own Netlify credentials", async () => {
  /* `@netlify/blobs` reads no ambient `NETLIFY_*` variable outside a Netlify
     runtime, so a `getStore({name})` in an operator's shell throws
     `MissingBlobsEnvironmentError` however carefully the runbook was followed.
     The credentials have to be read here and passed on, and a missing one has to
     name itself rather than surface as an SDK error. This is step 1 of the
     retention procedure, so it running as documented is load-bearing. */
  for (const [env, expected] of [
    [{}, /NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN/],
    [{ NETLIFY_AUTH_TOKEN: "t" }, /NETLIFY_SITE_ID must be set/],
    [{ NETLIFY_SITE_ID: "s" }, /NETLIFY_AUTH_TOKEN must be set/],
    [{ NETLIFY_SITE_ID: "s", NETLIFY_AUTH_TOKEN: "   " }, /NETLIFY_AUTH_TOKEN must be set/],
  ]) {
    assert.throws(() => requireBlobsCredentials(env), expected, `${JSON.stringify(env)} must be refused by name`);
  }

  assert.deepEqual(
    requireBlobsCredentials({ NETLIFY_SITE_ID: "site-1", NETLIFY_AUTH_TOKEN: "token-1", NETLIFY_OTHER: "x" }),
    { siteID: "site-1", token: "token-1" },
    "the census must pass exactly the two `getStore` credential keys",
  );

  /* And the runbook's command must be the one that works: the documented
     invocation, run against a provider double, has to reach `getStore` with the
     site and token attached to the store options. */
  const opened = [];
  const sdk = (options) => {
    opened.push(options);
    return { async list() { return { blobs: [] }; }, async getWithMetadata() { return null; } };
  };
  await runCensus({
    argv: ["--store", "archon-hosted-v1", "--prefix", "publications/"],
    getStore: credentialedStoreOpener(sdk, requireBlobsCredentials({ NETLIFY_SITE_ID: "site-1", NETLIFY_AUTH_TOKEN: "token-1" })),
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
  });
  assert.deepEqual(
    opened,
    [{ name: "archon-hosted-v1", consistency: "strong", siteID: "site-1", token: "token-1" }],
    "the documented invocation must reach `getStore` with the site and token attached",
  );

  /* And the SDK has to come from the deployment whose store is being read. */
  assert.ok(
    hostedBlobsSpecifier().includes("/hosted/node_modules/@netlify/blobs/"),
    "the census must load @netlify/blobs from hosted/node_modules, not the root install",
  );
  /* Resolved from a fresh temporary directory, not from a path inside the repo:
     the root install also carries `@netlify/blobs`, so a `from` under `scripts/`
     would walk up and find it, and this assertion would pass for the wrong
     reason on a machine that had run `npm ci` at the root. */
  const empty = await mkdtemp(join(tmpdir(), "archon-census-noinstall-"));
  try {
    assert.throws(
      () => hostedBlobsSpecifier(pathToFileURL(join(empty, "package.json"))),
      /npm --prefix hosted ci/,
      "a missing install must name the command that fixes it",
    );
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
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
    ["the pending window", `**${pendingMinutes} minutes** pending`],
    ["the upload window", `**${uploadMinutes} minutes** to`],
    ["that the upload is gated too", "New uploads are refused too"],
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
