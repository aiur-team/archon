#!/usr/bin/env node
/**
 * A read-only census of the hosted publication store.
 *
 * This is the inspection half of `hosted/OPERATIONS.md`. It answers the three
 * questions an operator has to answer before they can reason about retention at
 * all -- how many records exist in each state, how many bytes of published
 * artifact are retained, and how old those records are -- and it answers them
 * without ever being able to change one.
 *
 * Three properties are the whole design:
 *
 *  - **Read-only by construction, not by discipline.** The provider handle this
 *    tool opens is wrapped so that only `list` and `getWithMetadata` are
 *    reachable. `set`, `setJSON`, `delete` and every other name are absent from
 *    the object the census body holds, so a future edit that tried to write
 *    would fail on a missing method rather than succeed. There is no `--delete`,
 *    no `--prune` and no `--fix`, and v1 ships no automatic deletion of a
 *    publication record at all; physical removal is the paused-maintenance
 *    procedure in OPERATIONS.md, performed by a human against exact targets.
 *  - **No content and no capability material leaves this process.** A stored
 *    record carries the published HTML, the artifact digest, the two secret
 *    hashes, the user-visible pairing code and the title. None of them is a
 *    census fact, and printing any of them would turn an operational count into
 *    a disclosure -- a digest identifies a document, a secret hash is offline
 *    guessable, and the title is authored content. `censusRow` is a positive
 *    projection: it names the fields it emits rather than deleting the ones it
 *    must not, so a field added to `Publication` tomorrow is absent from this
 *    output by default instead of present by default.
 *  - **Targets are explicit.** The store name and key prefix are required
 *    arguments with no defaults. A census that defaulted to the production store
 *    is one mistyped command away from being run against the wrong site, and the
 *    operator who has to name the store is the operator who has read which one
 *    they are naming.
 *
 * Usage:
 *
 *   node scripts/hosted-census.mjs --store archon-hosted-v1 --prefix publications/
 *
 * Netlify credentials come from `NETLIFY_SITE_ID` and `NETLIFY_AUTH_TOKEN`.
 * `@netlify/blobs` does **not** read those variables by itself outside a
 * Netlify runtime -- `getStore({name})` in a plain shell throws
 * `MissingBlobsEnvironmentError` -- so this tool reads them itself and passes
 * them to `getStore` as `siteID` and `token`. Either one missing is a loud
 * failure before any request is made. Neither is ever printed.
 *
 * Output contract: a JSON summary object on stdout and exit 0, or one
 * `FAIL hosted census:` line on stderr and exit 1.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { validatePublication } from "../hosted/lib/contracts.mjs";

/**
 * The exact fields a census row may contain.
 *
 * Frozen and exported so `scripts/test-hosted-operations.mjs` can assert the
 * emitted keys against this list *and* assert that the forbidden names are not
 * in it. A row is built from this contract rather than checked against it after
 * the fact.
 */
export const CENSUS_ROW_FIELDS = Object.freeze(["id", "state", "artifactBytes", "ageSeconds", "ageBucket"]);

/**
 * The field names that must never appear in census output.
 *
 * Content (`html`, `title`), the artifact digest, the two capability hashes, the
 * pairing code and the owner's account id. The owner is excluded deliberately:
 * a census is a count, and "which accounts hold documents on this deployment" is
 * not a question an operator needs answered to size retention. The retention
 * procedure targets publication ids, which this output does carry.
 */
export const CENSUS_FORBIDDEN_FIELDS = Object.freeze([
  "html",
  "title",
  "descriptor",
  "contentSha256",
  "agentSecretHash",
  "browserSecretHash",
  "userCode",
  "ownerAccountId",
]);

/** Coarse age buckets, in seconds, from youngest to oldest. */
export const AGE_BUCKETS = Object.freeze([
  { name: "under1h", maxSeconds: 3600 },
  { name: "under1d", maxSeconds: 86400 },
  { name: "under7d", maxSeconds: 604800 },
  { name: "under30d", maxSeconds: 2592000 },
  { name: "over30d", maxSeconds: Infinity },
]);

/** The bucket an age in seconds falls in. */
export function ageBucketFor(ageSeconds) {
  for (const bucket of AGE_BUCKETS) {
    if (ageSeconds < bucket.maxSeconds) return bucket.name;
  }
  return AGE_BUCKETS[AGE_BUCKETS.length - 1].name;
}

/**
 * One publication as a census row.
 *
 * `artifactBytes` is the descriptor's declared length rather than the stored
 * string's, and it is reported as retained bytes only for a `complete` record,
 * because a record in any other state holds no HTML: reporting a pending
 * record's declared size as retained would count bytes that were never stored.
 *
 * A negative age is clamped to zero rather than reported. Clock skew between the
 * writer and the machine running the census is ordinary, and a negative number
 * in an operational report reads as a bug in the store.
 *
 * @param {object} record a validated `Publication`
 * @param {number} nowMs the census instant, in epoch milliseconds
 */
export function censusRow(record, nowMs) {
  const createdMs = Date.parse(record.createdAt);
  const ageSeconds = Number.isFinite(createdMs) ? Math.max(0, Math.floor((nowMs - createdMs) / 1000)) : 0;
  return {
    id: record.id,
    state: record.state,
    artifactBytes: record.state === "complete" ? record.descriptor.contentBytes : 0,
    ageSeconds,
    ageBucket: ageBucketFor(ageSeconds),
  };
}

/**
 * The whole census: counts by state, retained bytes, and an age distribution.
 *
 * `retainedBytes` counts only completed records, which is the number that
 * answers "how much published content is this deployment storing".
 *
 * There is deliberately no "expired non-complete" count. Which records are past
 * their deadlines is a retention *judgement* -- it depends on the pending and
 * upload windows in force when each record was written -- and OPERATIONS.md §7
 * step 2 has the operator derive that target list by hand from `state` and
 * `ageSeconds`. A number printed here would read as an authorised deletion list,
 * which is exactly what this tool must not produce.
 */
export function summariseCensus(rows) {
  const byState = {};
  const byAgeBucket = {};
  let retainedBytes = 0;
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
    byAgeBucket[row.ageBucket] = (byAgeBucket[row.ageBucket] ?? 0) + 1;
    retainedBytes += row.artifactBytes;
  }
  return { total: rows.length, byState, byAgeBucket, retainedBytes, rows };
}

/**
 * A read-only view of a provider store: exactly two methods, and no others.
 *
 * Exported so the gate can assert the surface directly. A double that only
 * throws when a mutator is *called* stays green if a `delete` passthrough is
 * ever added here and never exercised; enumerating the keys catches that.
 */
export function readOnlyHandle(store) {
  return Object.freeze({
    list: (options) => store.list(options),
    getWithMetadata: (key, options) => store.getWithMetadata(key, options),
  });
}

/**
 * The Netlify credentials `getStore` needs, read from the process environment.
 *
 * Outside a Netlify runtime `@netlify/blobs` has no ambient configuration to
 * pick up, so a `getStore({name})` that omitted these would throw
 * `MissingBlobsEnvironmentError` from inside the SDK -- a failure that reads as
 * a broken tool rather than as a missing credential. Reading them here turns
 * that into one sentence that names the variable the operator forgot.
 *
 * Exported so the gate can assert both the refusal and the exact keys passed on.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{siteID: string, token: string}}
 */
export function requireBlobsCredentials(env) {
  const missing = ["NETLIFY_SITE_ID", "NETLIFY_AUTH_TOKEN"].filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length > 0) {
    throw new Error(`${missing.join(" and ")} must be set; the census reads the store through the Netlify API`);
  }
  return { siteID: env.NETLIFY_SITE_ID, token: env.NETLIFY_AUTH_TOKEN };
}

/**
 * Where the CLI shell loads `@netlify/blobs` from: the hosted deployment's own
 * install, resolved as `hosted/` would resolve it.
 *
 * Missing install is a prerequisite failure, not a crash: say which command
 * fixes it.
 */
export function hostedBlobsSpecifier(from = new URL("../hosted/package.json", import.meta.url)) {
  try {
    return pathToFileURL(createRequire(from).resolve("@netlify/blobs")).href;
  } catch {
    throw new Error("@netlify/blobs is not installed under hosted/; run `npm --prefix hosted ci` first");
  }
}

/**
 * The `getStore` the CLI shell hands to `runCensus`: the SDK's own, with the
 * operator's credentials attached to every store it opens.
 *
 * A named function rather than an inline closure so the gate drives the exact
 * composition the CLI uses, instead of re-deriving it and asserting its own
 * arithmetic.
 */
export function credentialedStoreOpener(getStore, credentials) {
  return (options) => getStore({ ...options, ...credentials });
}

/**
 * Parse the command line. Both targets are required and there are no defaults.
 */
export function parseCensusArguments(argv) {
  const options = { store: null, prefix: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--store" || flag === "--prefix") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      options[flag.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(flag)}`);
  }
  if (options.store === null) throw new Error("--store <name> is required; there is no default store");
  if (options.prefix === null) throw new Error("--prefix <prefix> is required; there is no default prefix");
  return options;
}

/**
 * Run the census.
 *
 * `getStore` is injected so a test drives this exact body against a provider
 * double, and so that importing this module contacts nothing.
 */
export async function runCensus({ argv, getStore, now = Date.now }) {
  const { store: storeName, prefix } = parseCensusArguments(argv);
  const handle = readOnlyHandle(getStore({ name: storeName, consistency: "strong" }));
  const nowMs = now();

  const listed = await handle.list({ prefix });
  const keys = (listed?.blobs ?? []).map((blob) => blob.key);

  const rows = [];
  const unreadable = [];
  for (const key of keys) {
    const entry = await handle.getWithMetadata(key, { type: "text", consistency: "strong" });
    if (entry === null || entry === undefined || typeof entry.data !== "string") {
      unreadable.push(key);
      continue;
    }
    let record;
    try {
      record = validatePublication(JSON.parse(entry.data));
    } catch {
      /* A record this version cannot interpret is counted, never guessed at and
         never printed: its bytes are exactly what must not reach the report. */
      unreadable.push(key);
      continue;
    }
    rows.push(censusRow(record, nowMs));
  }

  return { store: storeName, prefix, takenAt: new Date(nowMs).toISOString(), unreadable: unreadable.length, ...summariseCensus(rows) };
}

/* The CLI shell; `runCensus` is what the tests drive.
 *
 * `@netlify/blobs` is reached here rather than at the top of the file so that
 * importing this module needs no installed dependency at all: the census
 * projection is pure, and a gate that only wants to assert what it emits should
 * not have to install a provider SDK to find out. */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const credentials = requireBlobsCredentials(process.env);
    /* Resolved out of `hosted/node_modules` rather than the root install: this
       tool inspects the hosted deployment's store, so it should speak to it
       through the same lockfile-pinned SDK that deployment ships. A bare
       `import "@netlify/blobs"` from this directory would resolve against the
       root package instead, which is a different install of a different tree. */
    const { getStore } = await import(hostedBlobsSpecifier());
    const summary = await runCensus({
      argv: process.argv.slice(2),
      getStore: credentialedStoreOpener(getStore, credentials),
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`FAIL hosted census: ${error.message.split("\n")[0]}\n`);
    process.exitCode = 1;
  }
}
