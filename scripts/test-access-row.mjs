#!/usr/bin/env node
/**
 * The permanent gate on the shared access-row validator.
 *
 *   node scripts/test-access-row.mjs
 *
 * `validateAccessRow()` (#132) is the single definition of "is this a
 * complete, internally consistent resolved access row?". A hand-duplicated
 * security validator only has to drift in one file to open a hole the other
 * copies still close, and whichever copy no gate happens to exercise is the
 * one that drifts (#125). The duplication kept coming back because each new
 * copy arrived under a new name — `validateAccess`, `assertResolvedAccess`,
 * `validResolvedAccess`, `accessDecision` — so a grep for the previous name
 * found nothing.
 *
 * The reason this file exists is the defect #125 found: `thread.mjs` carried a
 * copy that no test ever exercised, so neutering it left the suite green. Every
 * path converted since was in the same position — before this runner, none of
 * them had a single test of any kind. Sharing one validator makes them all
 * depend on one function; only a matrix that runs through each handler proves
 * that each one actually reaches it.
 *
 * This runner replaces the grep with three things a new copy cannot slip past:
 *
 *   1. A static inventory. Every module under `netlify/` that imports
 *      `resolveRole` must also import `validateAccessRow`, unless it is named
 *      in `KNOWN_BYPASSES` below. The list is asserted *exactly*: a new
 *      bypassing module fails, and so does leaving a name on the list after
 *      its module has been folded in. Closing one of the remaining surfaces
 *      means deleting its entry, and this runner fails until you do. The
 *      inventory is read off the import graph with the repository's pinned
 *      TypeScript rather than grepped, because naming is not the invariant:
 *      #125's acceptance check was `grep "function validateAccess"`, which
 *      `events.mjs` escaped by calling its copy `assertResolvedAccess` and
 *      `gate.ts` escaped again as `validResolvedAccess`.
 *
 *   2. A runtime matrix for the four paths #128 converted —
 *      `netlify/functions/access.mjs`, `session.mjs`, `pending.mjs`, and the
 *      copy in `events.mjs` that had drifted far enough to be called
 *      `assertResolvedAccess`.
 *
 *   3. A runtime matrix for the two surfaces #135 folded in — the realtime
 *      token endpoint and the edge document gate. Each is driven with the same
 *      table of malformed and matrix-inconsistent rows, and each must refuse
 *      every one of them. `netlify/edge-functions/gate.ts` had no test harness
 *      of its own before this file; it is transpiled with the repository's
 *      pinned TypeScript and run on Node against stubbed collaborators, which
 *      is the closest executable proof available without a Deno toolchain.
 *
 * Every row of the matrix is a mutation of a *complete* row, chosen so that a
 * validator which wrongly accepted it would produce a status this file
 * distinguishes from the rejection. Each path therefore asserts three
 * outcomes, not one:
 *
 *   - a broken row is the handler's own "impossible server state" status,
 *     with no store work attempted and nothing minted;
 *   - a well-formed row for an under-privileged role reaches that handler's
 *     authorization decision, which is a different status;
 *   - a well-formed privileged row runs past the check into the work behind it.
 *
 * Without the second and third assertions, "broken rows are rejected" would
 * also hold for a handler that rejected everything.
 *
 * `access.mjs`, `session.mjs` and `realtime-token.mjs` import their
 * collaborators statically, so their specifiers — and only theirs — are bound
 * to stubs through a resolve hook. `pending.mjs` and `events.mjs` expose
 * dependency-injecting factories and are driven directly. `gate.ts` resolves
 * its stubs as siblings under a temporary root. In every case the validator
 * under test is the real `validateAccessRow()` from `netlify/lib/access.mjs`:
 * each stub re-exports the genuine function and controls only `capabilitiesFor`
 * and `resolveRole`, so the assertions run against production logic rather than
 * a double.
 *
 * Nothing here reads a credential, a real repository, a remote provider, or a
 * private fixture. Every actor, document, and host is invented.
 *
 * Output contract: one `PASS` line per section on stdout and exit 0, or one
 * `FAIL` line per failed assertion on stderr and exit 1.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { guardedTempRoot, installSignalCleanup, removeTempRoots } from "./lib/temp-roots.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const real = (path) => pathToFileURL(join(ROOT, path)).href;

/* ========================================================================= */
/* assertions                                                                */
/* ========================================================================= */

let checks = 0;
let failures = 0;

/** A setup failure leaves nothing meaningful to assert, so it stops the run. */
function bail(message) {
  process.stderr.write(`FAIL  access-row: ${message}\n`);
  process.exit(1);
}

function ok(condition, message) {
  checks += 1;
  if (condition) return;
  failures += 1;
  process.stderr.write(`FAIL  ${message}\n`);
}

function eq(actual, expected, message) {
  ok(Object.is(actual, expected), `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

function deepEq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${message}\n  expected ${b}\n  actual   ${a}`);
}

/** Print a section's PASS line only when that section added no failures. */
function section(before, line) {
  if (failures === before) process.stdout.write(`PASS  ${line}\n`);
}

/* ========================================================================= */
/* section 1 — the static inventory                                          */
/* ========================================================================= */

/**
 * The role-resolving modules that still validate their own access rows, each
 * with the name its private copy goes by. Removing a module from this list is
 * the acceptance step for closing it.
 *
 * The list is empty: #128 folded `access.mjs`, `session.mjs`, `pending.mjs` and
 * `events.mjs` in, and #135 closed the last two — `realtime-token.mjs`, which
 * never validated the row against the matrix at all, and `gate.ts`, whose copy
 * went by the third name `validResolvedAccess()`. An entry added here needs a
 * ticket reference and a reason the fold cannot happen in the same change.
 */
const KNOWN_BYPASSES = Object.freeze([]);

const ACCESS_LIB = /(^|\/)lib\/access\.mjs$/;

async function loadTypeScript() {
  const entry = join(ROOT, "templates/docbuild/node_modules/typescript/lib/typescript.js");
  let loaded;
  try {
    loaded = await import(pathToFileURL(entry).href);
  } catch {
    bail(
      "the docbuild TypeScript install is missing; run " +
        "`npm --prefix templates/docbuild ci` before this runner",
    );
  }
  return loaded.default ?? loaded;
}

/**
 * Every tracked module under `netlify/`, as sorted repository-relative paths.
 * Tracked files are the honest definition of what the deploy tree owns: an
 * installed dependency or a stray scratch file cannot join the inventory, and
 * a module that is added to the tree cannot stay out of it.
 */
function netlifyModules() {
  return execFileSync("git", ["-C", ROOT, "ls-files", "-z", "netlify"], { encoding: "utf8" })
    .split("\0")
    .filter((path) => /^netlify\/.+\.(mjs|ts)$/.test(path) && !/\.test\.mjs$/.test(path))
    .sort();
}

/** The named bindings each module imports, keyed by module specifier. */
function importedNames(ts, source, fileName) {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const found = new Map();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const names = found.get(specifier) ?? new Set();
    for (const element of statement.importClause.namedBindings.elements) {
      names.add((element.propertyName ?? element.name).text);
    }
    found.set(specifier, names);
  }
  return found;
}

async function staticInventory(ts) {
  const before = failures;
  const resolving = [];
  const bypassing = [];
  for (const path of netlifyModules()) {
    const source = readFileSync(join(ROOT, path), "utf8");
    const imports = importedNames(ts, source, path);
    let resolvesRole = false;
    let validates = false;
    for (const [specifier, names] of imports) {
      if (!ACCESS_LIB.test(specifier)) continue;
      if (names.has("resolveRole")) resolvesRole = true;
      if (names.has("validateAccessRow")) validates = true;
    }
    if (!resolvesRole) continue;
    resolving.push(path);
    if (!validates) bypassing.push(path);
  }

  ok(
    resolving.length >= 8,
    `expected the role-resolving inventory to be found, saw ${resolving.length}`,
  );
  /* The modules this runner drives at runtime must still be in the inventory:
     if one stops resolving a role the matrices below would silently cover
     nothing. */
  for (const path of [
    "netlify/edge-functions/gate.ts",
    "netlify/functions/access.mjs",
    "netlify/functions/events.mjs",
    "netlify/functions/pending.mjs",
    "netlify/functions/realtime-token.mjs",
    "netlify/functions/session.mjs",
  ]) {
    ok(resolving.includes(path), `${path} must still be counted as a role-resolving module`);
  }
  deepEq(
    bypassing,
    [...KNOWN_BYPASSES],
    "the set of role-resolving modules bypassing validateAccessRow changed;\n" +
      "  fold the new module onto validateAccessRow(), or -- if it genuinely\n" +
      "  needs its own staged ticket -- add it to KNOWN_BYPASSES with the name\n" +
      "  its private copy goes by",
  );

  // One definition, not one plus a re-export chain that could diverge.
  const definitions = netlifyModules().filter((path) =>
    /export function validateAccessRow\b/.test(readFileSync(join(ROOT, path), "utf8")),
  );
  deepEq(
    definitions,
    ["netlify/lib/access.mjs"],
    "validateAccessRow() must be defined exactly once, in netlify/lib/access.mjs",
  );

  /* The two names #135 removed must not come back in the modules it fixed.
     The names #128 converted are deliberately not listed: `validateAccess()` in
     `session.mjs` and `pending.mjs`, and `assertResolvedAccess()` in
     `events.mjs`, still exist as thin wrappers that delegate to the shared
     validator and map its answer onto the handler's own error. Keeping the
     name is fine; keeping a second implementation is not, and the import-graph
     assertion above is what covers that. */
  for (const [path, name] of [
    ["netlify/functions/realtime-token.mjs", "accessDecision"],
    ["netlify/edge-functions/gate.ts", "validResolvedAccess"],
  ]) {
    ok(
      !readFileSync(join(ROOT, path), "utf8").includes(`function ${name}(`),
      `${path} must not reintroduce ${name}()`,
    );
  }

  section(
    before,
    `static inventory: ${resolving.length} role-resolving modules, ` +
      `${bypassing.length} known bypasses`,
  );
}

/* ========================================================================= */
/* the shared row matrix                                                     */
/* ========================================================================= */

const ROW_KEYS = Object.freeze([
  "role",
  "shared",
  "canRead",
  "canComment",
  "threadControl",
  "canSuggest",
  "canEdit",
  "canAccept",
  "canShare",
  "canSeeMembers",
]);

/** A well-formed row for `role`, in matrix key order. */
function row(capabilitiesFor, role, shared = false) {
  const out = { role, shared };
  const capabilities = capabilitiesFor(role);
  for (const key of ROW_KEYS.slice(2)) out[key] = capabilities[key];
  return out;
}

/**
 * Rows a role-resolving path must refuse. Every entry is either malformed or
 * inconsistent with the capability matrix; none of them may be read as a falsy
 * capability and quietly denied, because a caller that denies a malformed row
 * is one edit away from allowing one.
 *
 * The list is the union of the two matrices this runner grew from. Where the
 * same shape was covered on both sides under different names, one entry
 * survives and its label names the shape rather than either original.
 */
function brokenRows(capabilitiesFor) {
  const valid = () => row(capabilitiesFor, "editor");
  const owner = () => row(capabilitiesFor, "owner");
  return [
    // The hole #135 names: `role: "none"` cannot carry `canRead: true`. Before
    // this ticket the realtime endpoint minted a token for exactly this row.
    ["a none role claiming canRead", { ...row(capabilitiesFor, "none"), canRead: true }],
    ["a capability contradicting the matrix", { ...valid(), canShare: true }],
    ["a capability withheld from the role", { ...owner(), canComment: false }],
    ["an unknown role", { ...valid(), role: "admin" }],
    ["an unknown threadControl", { ...valid(), threadControl: "some" }],
    ["a non-boolean capability", { ...valid(), canEdit: "yes" }],
    ["a non-boolean shared", { ...valid(), shared: "no" }],
    ["a missing capability", (() => {
      const partial = valid();
      delete partial.canSeeMembers;
      return partial;
    })()],
    ["a missing capability at the end of the matrix", (() => {
      const partial = owner();
      delete partial.canShare;
      return partial;
    })()],
    ["an extra key", { ...valid(), canPublish: true }],
    ["an accessor-backed capability", Object.defineProperty(valid(), "canRead", {
      get: () => true,
      enumerable: true,
      configurable: true,
    })],
    ["a non-enumerable capability", Object.defineProperty(valid(), "canRead", {
      value: true,
      enumerable: false,
      writable: true,
      configurable: true,
    })],
    ["a symbol-keyed extra", Object.assign(valid(), { [Symbol("canPublish")]: true })],
    ["a null-prototype row", Object.assign(Object.create(null), valid())],
    ["a non-ordinary prototype", Object.assign(Object.create({ ping: 1 }), valid())],
    ["a class instance", Object.assign(new (class Access {})(), valid())],
    ["an array", Object.assign([], valid())],
    ["null", null],
    ["a string", "owner"],
    ["undefined", undefined],
    /* The key-order requirement `pending.mjs` had grown and the other copies
       had not. A resolved row is always `role`, `shared`, then the frozen
       matrix spread in order, so any other order was assembled elsewhere. */
    ["keys out of matrix order", (() => {
      const { role, shared, ...rest } = valid();
      return { shared, role, ...rest };
    })()],
  ];
}

/**
 * Capability tables no row can be validated against. An unusable table is
 * invalid server state, never an implicit denial: a path that fell back to
 * "deny" here would report the same status for a broken table as for a
 * legitimately unprivileged caller, and the two need different answers.
 */
function unusableTables(canonical) {
  return [
    ["a table that throws", () => { throw new Error("no row"); }],
    ["a table answering null", () => null],
    ["a table answering a callable", () => () => true],
    ["a table answering a short row", (role) => {
      const short = { ...canonical(role) };
      delete short.canShare;
      return short;
    }],
    ["a table answering an extra key", (role) => ({ ...canonical(role), canPublish: true })],
    ["a table answering out of order", (role) => {
      const { canRead, ...rest } = canonical(role);
      return { ...rest, canRead };
    }],
    ["a table answering an accessor", (role) => Object.defineProperty(
      { ...canonical(role) }, "canRead", { get: () => true, enumerable: true, configurable: true },
    )],
  ];
}

/* ========================================================================= */
/* fixtures and the shared control channel                                   */
/* ========================================================================= */

const DOC_ID = "a1b2c3";
/* `sub, email, emailVerified, name`, in that order: every identity validator on
   these paths requires the exact key order, so a fixture written in another
   order fails as an invalid identity before the access row is ever looked at.
   `sub` is a C1 v2 account id, which is the only grant key there is now. */
const SESSION = Object.freeze({
  sub: `a0_${"3".repeat(32)}`,
  email: "sample.reader@example.com",
  emailVerified: true,
  name: "Sample Reader",
});
const TOKEN = Object.freeze({ keyName: "invented.key", token: "invented-token" });

/**
 * The one control surface every stub and factory reads. The sections run in
 * sequence and each assigns the collaborators it needs, so a single channel
 * serves all of them without the stubs having to know which section is live.
 */
const control = {
  identify: () => ({ ...SESSION }),
  resolveRole: null,
  capabilitiesFor: null,
  mintToken: () => ({ ...TOKEN }),
  storeCalls: 0,
  minted: 0,
};
globalThis.__ACCESSROW__ = control;

const request = (path) => new Request(`https://docs.example.invalid${path}`);

/* ========================================================================= */
/* section 2 — the four paths #128 converted                                 */
/* ========================================================================= */

/**
 * Bind the two statically-importing handlers' collaborators to stubs.
 *
 * Each stub re-exports its real module wholesale with `export *` and then
 * declares only the collaborators this file controls; an explicit local export
 * shadows the same name arriving through the star. Naming the pass-through
 * exports individually instead would make every stub a second copy of its
 * module's import list, and each time a handler grew a dependency the stub
 * would fail to resolve rather than exercise the handler — which is how this
 * runner broke when P4-J (#120) landed.
 */
function bindStaticModules(stubRoot) {
  mkdirSync(stubRoot, { recursive: true });
  const stub = (name, source) => {
    const file = join(stubRoot, name);
    writeFileSync(file, source, "utf8");
    return pathToFileURL(file).href;
  };

  const stubs = new Map([
    ["../lib/identity.mjs", stub("identity.mjs", `
      export * from ${JSON.stringify(real("netlify/lib/identity.mjs"))};
      export function identify(req) { return globalThis.__ACCESSROW__.identify(req); }
    `)],
    /* Everything except the two controlled collaborators is the real export.
       `validateAccessRow` above all: substituting it would make this file
       assert against a double of the very function it exists to cover. */
    ["../lib/access.mjs", stub("access.mjs", `
      export * from ${JSON.stringify(real("netlify/lib/access.mjs"))};
      export function capabilitiesFor(role) {
        return globalThis.__ACCESSROW__.capabilitiesFor(role);
      }
      export function resolveRole(docId, user, options) {
        return globalThis.__ACCESSROW__.resolveRole(docId, user, options);
      }
    `)],
    ["../lib/store.mjs", stub("store.mjs", `
      import { StoreError } from ${JSON.stringify(real("netlify/lib/store.mjs"))};
      export * from ${JSON.stringify(real("netlify/lib/store.mjs"))};
      export function docState() {
        globalThis.__ACCESSROW__.storeCalls += 1;
        throw new StoreError("unavailable", 503, "Access store unavailable");
      }
    `)],
    ["../lib/realtime.mjs", stub("realtime.mjs", `
      export function mintToken(session, docId) {
        return globalThis.__ACCESSROW__.mintToken(session, docId);
      }
    `)],
  ]);

  const bound = new Set([
    real("netlify/functions/access.mjs"),
    real("netlify/functions/session.mjs"),
    real("netlify/functions/realtime-token.mjs"),
  ]);

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (bound.has(context.parentURL) && stubs.has(specifier)) {
        return { url: stubs.get(specifier), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

async function convertedPathsMatrix(accessLib) {
  const before = failures;
  const { capabilitiesFor } = accessLib;
  const rowFor = (role) => row(capabilitiesFor, role);

  const sessionHandler = (await import(real("netlify/functions/session.mjs"))).default;
  const accessHandler = (await import(real("netlify/functions/access.mjs"))).default;
  const { createPendingHandler } = await import(real("netlify/functions/pending.mjs"));
  const { createEventsHandler } = await import(real("netlify/functions/events.mjs"));
  const storeLib = await import(real("netlify/lib/store.mjs"));

  /* `pending.mjs` selects its manifest through the injected
     `readApplyManifestFn` rather than walking a deploy tree (P4-N), so the
     "no manifest for this document" case is the library's own 404 ApplyError.
     Raising it directly keeps the accepted outcome an unambiguous 404, which
     cannot collide with the store-failure status the other paths use as their
     accepted control. */
  const { ApplyError } = await import(real("netlify/lib/gitedit.mjs"));
  const manifestNotFound = async () => { throw new ApplyError("not-found"); };

  /* Each entry drives one converted path. `run(access, table)` installs the
     resolved row and the capability table, invokes the handler, and reports
     the status plus how much store work the handler attempted. */
  const paths = [
    {
      name: "session.mjs",
      reject: 500,
      async run(access, table = capabilitiesFor) {
        control.storeCalls = 0;
        control.capabilitiesFor = table;
        control.resolveRole = async () => access;
        const response = await sessionHandler(request(`/api/session?doc=${DOC_ID}`));
        return { status: response.status, storeCalls: control.storeCalls };
      },
      /* `session.mjs` opens no store at all: a valid row is simply projected
         into the 200 body, so 200-versus-500 is the whole signal. */
      accepted: [
        ["an owner row", "owner", 200, 0],
        ["a role with no capabilities", "none", 200, 0],
      ],
    },
    {
      name: "access.mjs",
      reject: 500,
      async run(access, table = capabilitiesFor) {
        control.storeCalls = 0;
        control.capabilitiesFor = table;
        control.resolveRole = async () => access;
        const response = await accessHandler(request(`/api/access?doc=${DOC_ID}`));
        return { status: response.status, storeCalls: control.storeCalls };
      },
      /* An accepted owner row reaches `docState()`, which the stub answers
         with the P2-B unavailable error — so 503 with one store call is proof
         the handler ran past the check, and 403 with none is proof it ran past
         the check and then denied on `canSeeMembers`. */
      accepted: [
        ["an owner row", "owner", 503, 1],
        ["a viewer row", "viewer", 403, 0],
      ],
    },
    {
      name: "pending.mjs",
      reject: 500,
      async run(access, table = capabilitiesFor) {
        let storeCalls = 0;
        const handler = createPendingHandler({
          identify: () => ({ ...SESSION }),
          resolveRole: async () => access,
          capabilitiesFor: table,
          assertIdentitySub: accessLib.assertIdentitySub,
          normalizeEmail: accessLib.normalizeEmail,
          docState: () => { storeCalls += 1; throw new storeLib.StoreError("unavailable", 503, "x"); },
          editPrefix: storeLib.editPrefix,
          editKey: storeLib.editKey,
          read: storeLib.read,
          upgrade: storeLib.upgrade,
          readApplyManifestFn: manifestNotFound,
        });
        const response = await handler(request(`/api/pending?doc=${DOC_ID}`));
        return { status: response.status, storeCalls };
      },
      /* The apply library reports no manifest for this document, so an
         accepted `canRead` row falls through to the 404 for an unknown
         document — a status the rejection can never produce. A `none` row is
         denied at 403 before that lookup. */
      accepted: [
        ["an owner row", "owner", 404, 0],
        ["a role with no capabilities", "none", 403, 0],
      ],
    },
    {
      name: "events.mjs",
      reject: 500,
      async run(access, table = capabilitiesFor) {
        control.storeCalls = 0;
        control.capabilitiesFor = table;
        let storeCalls = 0;
        const handler = createEventsHandler({
          requireOriginFn: () => {},
          identifyFn: () => ({ ...SESSION }),
          resolveRoleFn: async () => access,
          storeFn: () => { storeCalls += 1; throw new storeLib.StoreError("unavailable", 503, "x"); },
        });
        const response = await handler(request(`/api/events?doc=${DOC_ID}&month=2026-01`));
        return { status: response.status, storeCalls };
      },
      /* `events.mjs` authorizes before it opens the store, so an accepted
         owner row reaches `storeFn()` and reports 503, while a viewer row is
         denied on `canSeeMembers` with the store untouched. */
      accepted: [
        ["an owner row", "owner", 503, 1],
        ["a viewer row", "viewer", 403, 0],
      ],
      /* Alone among the four, `events.mjs` takes no capability table as a
         dependency — its factory injects the identity, role and store
         collaborators but reads `capabilitiesFor` from the module scope. There
         is no table to make unusable, so it always validates against the real
         matrix and the table cases below do not apply to it. */
      injectableTable: false,
    },
  ];

  /* ---- every path rejects every broken row, without doing any work ------ */

  for (const path of paths) {
    for (const [label, access] of brokenRows(capabilitiesFor)) {
      const { status, storeCalls } = await path.run(access);
      eq(status, path.reject, `${path.name}: ${label} is ${path.reject}`);
      eq(storeCalls, 0, `${path.name}: ${label} performs no store work`);
    }
  }

  /* ---- and rejects a valid row against an unusable capability table ----- */

  for (const path of paths.filter((path) => path.injectableTable !== false)) {
    for (const [label, table] of unusableTables(capabilitiesFor)) {
      const { status, storeCalls } = await path.run(rowFor("owner"), table);
      eq(status, path.reject, `${path.name}: ${label} is ${path.reject}`);
      eq(storeCalls, 0, `${path.name}: ${label} performs no store work`);
    }
  }

  /* ---- while a row the validator accepts still runs the path ------------ */

  for (const path of paths) {
    for (const [label, role, expected, expectedStoreCalls] of path.accepted) {
      const { status, storeCalls } = await path.run(rowFor(role));
      eq(status, expected, `${path.name}: ${label} is ${expected}`);
      eq(storeCalls, expectedStoreCalls, `${path.name}: ${label} store calls`);
    }
  }

  section(before, "access-row matrix across the four converted paths");
}

/* ========================================================================= */
/* section 3 — netlify/functions/realtime-token.mjs                          */
/* ========================================================================= */

async function realtimeTokenMatrix(accessLib) {
  const before = failures;
  process.env.ABLY_API_KEY = "invented-ably-key";

  const handler = (await import(real("netlify/functions/realtime-token.mjs"))).default;

  const run = async (overrides) => {
    control.storeCalls = 0;
    control.minted = 0;
    Object.assign(control, {
      identify: () => ({ ...SESSION }),
      resolveRole: () => row(accessLib.capabilitiesFor, "editor"),
      capabilitiesFor: (role) => accessLib.capabilitiesFor(role),
      mintToken: () => {
        control.minted += 1;
        return { ...TOKEN };
      },
      ...overrides,
    });
    return handler(request(`/api/realtime-token?doc=${DOC_ID}`));
  };

  for (const [label, access] of brokenRows(accessLib.capabilitiesFor)) {
    const response = await run({ resolveRole: () => access });
    eq(response.status, 500, `realtime-token refuses ${label} with 500`);
    eq(control.minted, 0, `realtime-token mints nothing for ${label}`);
  }

  // A proxied row is refused before the validator sees it: a trapped row can
  // answer one way while it is checked and another when the capability is read.
  {
    const target = row(accessLib.capabilitiesFor, "editor");
    const response = await run({ resolveRole: () => new Proxy(target, {}) });
    eq(response.status, 500, "realtime-token refuses a proxied row with 500");
    eq(control.minted, 0, "realtime-token mints nothing for a proxied row");
  }

  // An unusable capability table is invalid state, never an implicit denial.
  for (const [label, table] of unusableTables(accessLib.capabilitiesFor)) {
    const response = await run({ capabilitiesFor: table });
    eq(response.status, 500, `realtime-token refuses ${label} with 500`);
    eq(control.minted, 0, `realtime-token mints nothing for ${label}`);
  }

  // A well-formed row is still answered exactly as before.
  {
    const response = await run({ resolveRole: () => row(accessLib.capabilitiesFor, "none") });
    eq(response.status, 403, "realtime-token denies a well-formed unreadable row");
    eq(control.minted, 0, "a denied realtime request mints nothing");
  }
  for (const role of ["owner", "editor", "commenter", "viewer"]) {
    const response = await run({ resolveRole: () => row(accessLib.capabilitiesFor, role, true) });
    eq(response.status, 200, `realtime-token allows a well-formed ${role} row`);
    deepEq(await response.json(), TOKEN, `a ${role} request returns the minted token`);
    eq(control.minted, 1, `a ${role} request mints exactly one token`);
  }
  {
    const response = await run({ mintToken: () => null });
    eq(response.status, 204, "an absent realtime provider is still 204");
  }

  section(before, "realtime-token.mjs validates the resolved row");
}

/* ========================================================================= */
/* section 4 — netlify/edge-functions/gate.ts                                */
/* ========================================================================= */

const META_LINE = `<meta name="doc-id" content="${DOC_ID}">\n`;
const PAGE = `${META_LINE}<p>An invented document body.</p>\n`;

/**
 * The edge gate is TypeScript that runs on Deno and has no test harness of its
 * own. Transpiling it with the repository's pinned TypeScript and loading it
 * on Node is the closest executable proof available here: the transpile is
 * type-erasure only, so the control flow under test is the shipped control
 * flow. The stubs are written as siblings under the temporary root so the
 * module's own relative specifiers resolve without a loader hook.
 */
function transpileGate(ts, gateRoot) {
  mkdirSync(join(gateRoot, "edge-functions"), { recursive: true });
  mkdirSync(join(gateRoot, "lib"), { recursive: true });

  /* The gate resolves identity by an internal request to the hosted session
     route rather than by importing `../lib/identity.mjs`, so the seam is
     `fetch` and the only module it needs here is the real address grammar. */
  mkdirSync(join(gateRoot, "lib/hosted"), { recursive: true });
  writeFileSync(
    join(gateRoot, "lib/hosted/email.mjs"),
    `export * from ${JSON.stringify(real("netlify/lib/hosted/email.mjs"))};\n`,
    "utf8",
  );
  writeFileSync(
    join(gateRoot, "lib/access.mjs"),
    `import { validateAccessRow } from ${JSON.stringify(real("netlify/lib/access.mjs"))};\n` +
      `export { validateAccessRow };\n` +
      `export function capabilitiesFor(role) { return globalThis.__ACCESSROW__.capabilitiesFor(role); }\n` +
      `export function resolveRole(docId, user, options) {\n` +
      `  return globalThis.__ACCESSROW__.resolveRole(docId, user, options);\n` +
      `}\n`,
    "utf8",
  );

  /* The gate classifies the request host through `../lib/edge-host.mjs` before
     it reaches the access-row logic this runner exercises. Its host
     classification and header helpers are pure and self-contained, so the real
     module is re-exported rather than stubbed; with no `HOSTED_*` variables set
     the classifier returns "app" and this matrix runs the application branch
     exactly as before. */
  writeFileSync(
    join(gateRoot, "lib/edge-host.mjs"),
    `export * from ${JSON.stringify(real("netlify/lib/edge-host.mjs"))};\n`,
    "utf8",
  );

  const source = readFileSync(join(ROOT, "netlify/edge-functions/gate.ts"), "utf8");
  const emitted = ts.transpileModule(source, {
    fileName: "gate.ts",
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const errors = (emitted.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  ok(errors.length === 0, `gate.ts failed to transpile: ${errors.map((d) => d.messageText).join("; ")}`);

  const file = join(gateRoot, "edge-functions/gate.mjs");
  writeFileSync(file, emitted.outputText, "utf8");
  return pathToFileURL(file).href;
}

async function gateMatrix(ts, gateRoot, accessLib) {
  const before = failures;
  const gate = (await import(transpileGate(ts, gateRoot))).default;

  const gateRequest = () => new Request("https://docs.example.invalid/doc/", { method: "GET" });
  const downstream = () =>
    new Response(PAGE, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  const context = () => ({ next: async () => downstream() });

  /* ACN-006 moved the gate's identity step off a module import and onto an
     internal request to `/api/hosted/session`, so the seam this matrix drives
     is `fetch`. The body is the frozen C1 signed-in shape; the gate projects it
     onto the identity `resolveRole` is handed, and that projection is what the
     access-row assertions below sit on top of. */
  const sessionBody = () => JSON.stringify({
    v: 1,
    authenticated: true,
    accountId: SESSION.sub,
    login: SESSION.name,
    email: SESSION.email,
    emailVerified: SESSION.emailVerified,
    csrfToken: "aW52ZW50ZWQtY3NyZi10b2tlbi1mb3ItdGhlLWdhdGUtbWF0cml4",
  });

  const run = async (overrides) => {
    Object.assign(control, {
      capabilitiesFor: (role) => accessLib.capabilitiesFor(role),
      resolveRole: () => row(accessLib.capabilitiesFor, "editor"),
      ...overrides,
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      ok(url.pathname === "/api/hosted/session", `the gate fetched ${url.pathname}`);
      return new Response(sessionBody(), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    };
    try {
      return await gate(gateRequest(), context());
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  for (const [label, access] of brokenRows(accessLib.capabilitiesFor)) {
    const response = await run({ resolveRole: () => access });
    eq(response.status, 500, `the edge gate refuses ${label} with 500`);
    eq(
      await response.text(),
      "Document access could not be verified.",
      `the edge gate reports ${label} as unverified`,
    );
  }

  /* Not asserted here: a proxied row. `realtime-token.mjs` refuses one through
     `isProxy()` from `node:util/types`, but `gate.ts` has no equivalent — Deno
     exposes no such predicate — so a `new Proxy(validRow, {})` is served. The
     shared validator cannot close this on its own, and the asymmetry is filed
     as #157 rather than pinned here, because asserting the current 200 would
     enshrine it. */

  for (const [label, table] of unusableTables(accessLib.capabilitiesFor)) {
    const response = await run({ capabilitiesFor: table });
    eq(response.status, 500, `the edge gate refuses ${label} with 500`);
  }

  {
    const response = await run({ resolveRole: () => row(accessLib.capabilitiesFor, "none") });
    eq(response.status, 403, "the edge gate denies a well-formed unreadable row");
    eq(
      await response.text(),
      "You do not have access to this document.",
      "a denied document says so in plain text",
    );
  }
  for (const role of ["owner", "editor", "commenter", "viewer"]) {
    const response = await run({ resolveRole: () => row(accessLib.capabilitiesFor, role, true) });
    eq(response.status, 200, `the edge gate serves a well-formed ${role} row`);
    eq(await response.text(), PAGE, `a ${role} request replays the whole document`);
  }

  // A deliberate relaxation, recorded because it is a behaviour change and not
  // a refactor: `validResolvedAccess()` required every own property to be
  // writable *and* configurable, so a frozen row was a 500. The shared
  // validator requires an enumerable data property and nothing more, which is
  // what every other write path has always accepted.
  {
    const frozen = Object.freeze(row(accessLib.capabilitiesFor, "editor", true));
    const response = await run({ resolveRole: () => frozen });
    eq(response.status, 200, "the edge gate accepts a frozen well-formed row");
  }

  section(before, "gate.ts validates the resolved row through the shared validator");
}

/* ========================================================================= */
/* section 5 — PUBLIC_DEFAULT_ROLE                                           */
/* ========================================================================= */

/**
 * `PUBLIC_DEFAULT_ROLE` is the one site variable that widens access to a person
 * no owner has ever named: a signed-in visitor who matches no owner, grant,
 * invitation, or organization rule. Everything above in this file proves that a
 * resolved row is internally consistent; this section proves the row is the
 * right one, by driving the real `resolveRole()` — no stub, no double — over
 * every branch of the precedence chain with the variable set and unset.
 *
 * The sole authority for the value is the invocation-local environment, so the
 * matrix sets and restores `process.env.PUBLIC_DEFAULT_ROLE` around each case,
 * and covers the `Netlify.env` reader an Edge Function uses as well. Every
 * actor, document and address here is invented.
 */

/** An invented permanent document ID, in the `^[0-9a-f]{6}$` P1-A shape. */
const PUBLIC_DOC = "0dc0de";
const NOW = "2026-09-05T12:00:00.000Z";
const LATER = "2026-10-05T12:00:00.000Z";

const VISITOR = Object.freeze({
  sub: `a0_${"a".repeat(32)}`,
  email: "stranger@elsewhere.invalid",
  emailVerified: true,
  name: "Stranger",
});
const OWNER_USER = Object.freeze({
  sub: `a0_${"b".repeat(32)}`,
  email: "owner@example.com",
  emailVerified: true,
  name: "Owner",
});
/* Named MEMBER for continuity with the case it used to drive. It is an ordinary
   signed-in visitor now: ACN-006 removed the site-wide organisation rule, so no
   address makes anybody a member of anything. */
const MEMBER = Object.freeze({
  sub: `a0_${"c".repeat(32)}`,
  email: "member@example.com",
  emailVerified: true,
  name: "Member",
});

/** The minimum blob store `read()`, `createOnly()` and `delete()` accept. */
function fakeStore(entries = new Map()) {
  let counter = 0;
  return {
    entries,
    seed(key, value) {
      entries.set(key, value);
      return this;
    },
    async getWithMetadata(key) {
      if (!entries.has(key)) return null;
      counter += 1;
      return { data: structuredClone(entries.get(key)), etag: `etag-${counter}` };
    },
    async setJSON(key, value) {
      if (entries.has(key)) return { modified: false };
      entries.set(key, structuredClone(value));
      return { modified: true };
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

function documentRecord(orgDefault = "commenter") {
  return {
    v: 1,
    docId: PUBLIC_DOC,
    ownerSub: OWNER_USER.sub,
    ownerEmail: OWNER_USER.email,
    orgDefault,
    boundAt: NOW,
    boundFrom: "env:DOC_OWNERS",
  };
}

function grantRecord(user, role) {
  return {
    v: 1,
    docId: PUBLIC_DOC,
    sub: user.sub,
    email: user.email,
    name: user.name,
    role,
    grantedBy: { sub: OWNER_USER.sub, name: OWNER_USER.name, email: OWNER_USER.email },
    grantedAt: NOW,
    fromInvitation: null,
  };
}

function invitationRecord(user, role) {
  return {
    v: 1,
    docId: PUBLIC_DOC,
    email: user.email,
    role,
    invitedBy: { sub: OWNER_USER.sub, name: OWNER_USER.name, email: OWNER_USER.email },
    invitedAt: NOW,
    expiresAt: LATER,
    accountCreated: true,
  };
}

/** Every configuration that must deny, with the reason it is rejected. */
const DENYING_CONFIGURATIONS = Object.freeze([
  ["unset", undefined],
  ["the empty string", ""],
  ["a single space", " "],
  ["ASCII whitespace only", " \t\n\r\f\v "],
  ["the writing role editor", "editor"],
  ["the writing role owner", "owner"],
  ["the literal none", "none"],
  ["a differently cased viewer", "Viewer"],
  ["an upper-case COMMENTER", "COMMENTER"],
  ["a list of roles", "viewer,commenter"],
  ["a role with a trailing writing role", "viewer editor"],
  ["a role with an internal space", "com menter"],
  ["a truthy-looking value", "true"],
  ["a numeric value", "1"],
  ["an unrelated word", "public"],
  ["a role name with a suffix", "viewers"],
  ["a JSON spelling", "\"viewer\""],
]);

async function publicDefaultRoleMatrix(accessLib) {
  const before = failures;
  const { capabilitiesFor, resolveRole, parsePublicDefaultRole } = accessLib;

  ok(typeof parsePublicDefaultRole === "function", "access.mjs exports parsePublicDefaultRole()");
  deepEq(
    [...accessLib.PUBLIC_DEFAULT_ROLES],
    ["viewer", "commenter"],
    "PUBLIC_DEFAULT_ROLE may name exactly viewer and commenter",
  );
  ok(
    Object.isFrozen(accessLib.PUBLIC_DEFAULT_ROLES),
    "the public-default role list is frozen",
  );

  const had = Object.hasOwn(process.env, "PUBLIC_DEFAULT_ROLE");
  const original = process.env.PUBLIC_DEFAULT_ROLE;
  const configure = (value) => {
    if (value === undefined) delete process.env.PUBLIC_DEFAULT_ROLE;
    else process.env.PUBLIC_DEFAULT_ROLE = value;
  };

  /* A visitor who matches nothing: the document is owned by somebody else, the
     visitor holds no grant and no invitation, and is not an organization
     member. This is the only caller the new tier may ever speak for. */
  const strangerStore = () =>
    fakeStore(new Map([[accessLib.accessDocumentKey(PUBLIC_DOC), documentRecord()]]));

  const resolveVisitor = (store = strangerStore(), user = VISITOR) =>
    resolveRole(PUBLIC_DOC, user, { store, docOwners: "", now: NOW });

  try {
    /* ---- fail closed on every configuration that is not exactly a role ---- */
    for (const [label, value] of DENYING_CONFIGURATIONS) {
      configure(value);
      eq(parsePublicDefaultRole(value), "none", `parse: ${label} is none`);
      deepEq(
        await resolveVisitor(),
        row(capabilitiesFor, "none", true),
        `a signed-in visitor with ${label} resolves the none row`,
      );
    }

    /* A non-string can only arrive through the parser, never through env. */
    for (const [label, value] of [
      ["null", null],
      ["a number", 7],
      ["an array of roles", ["viewer"]],
      ["an object", { role: "viewer" }],
      ["a boolean", true],
      ["a role-like object with toString", { toString: () => "viewer" }],
    ]) {
      eq(parsePublicDefaultRole(value), "none", `parse: ${label} is none`);
    }

    /* ---- each valid role grants exactly its documented row, and no more ---- */
    for (const role of ["viewer", "commenter"]) {
      configure(role);
      eq(parsePublicDefaultRole(role), role, `parse: ${role} is accepted`);
      eq(parsePublicDefaultRole(`  ${role}\n`), role, `parse: ${role} tolerates edge whitespace`);
      const actual = await resolveVisitor();
      deepEq(
        actual,
        row(capabilitiesFor, role, true),
        `a signed-in visitor with PUBLIC_DEFAULT_ROLE=${role} resolves exactly the ${role} row`,
      );
      eq(actual.canEdit, false, `a public ${role} cannot edit`);
      eq(actual.canAccept, false, `a public ${role} cannot accept`);
      eq(actual.canShare, false, `a public ${role} cannot share`);
      eq(actual.canSeeMembers, false, `a public ${role} cannot see members`);
      ok(
        accessLib.validateAccessRow(actual, capabilitiesFor),
        `the public ${role} row passes the shared row validator`,
      );
    }

    configure("viewer");
    eq((await resolveVisitor()).canComment, false, "a public viewer cannot comment");
    configure("commenter");
    eq((await resolveVisitor()).threadControl, "own", "a public commenter controls only own threads");

    /* ---- an anonymous caller is untouched ---- */
    for (const role of ["viewer", "commenter"]) {
      configure(role);
      deepEq(
        await resolveRole(PUBLIC_DOC, null, { store: strangerStore(), docOwners: "", now: NOW }),
        row(capabilitiesFor, "none", false),
        `an anonymous caller with PUBLIC_DEFAULT_ROLE=${role} still resolves none`,
      );
    }

    /* ---- nothing above the new tier moves ---- */
    configure("viewer");

    deepEq(
      await resolveVisitor(strangerStore(), OWNER_USER),
      row(capabilitiesFor, "owner", true),
      "the bound owner still resolves owner",
    );

    for (const granted of ["editor", "commenter", "viewer"]) {
      const store = strangerStore();
      store.seed(accessLib.accessGrantKey(PUBLIC_DOC, VISITOR.sub), grantRecord(VISITOR, granted));
      deepEq(
        await resolveVisitor(store),
        row(capabilitiesFor, granted, true),
        `an explicit ${granted} grant still resolves ${granted}`,
      );
    }

    {
      const store = strangerStore();
      store.seed(
        await accessLib.accessInvitationKey(PUBLIC_DOC, VISITOR.email),
        invitationRecord(VISITOR, "editor"),
      );
      deepEq(
        await resolveVisitor(store),
        row(capabilitiesFor, "editor", true),
        "a live editor invitation still outranks the public default",
      );
    }

    /* The organisation tier used to sit here, and this loop asserted that a
       member resolved `orgDefault` rather than the public default. ACN-006
       removed it: `orgDefault` no longer grants anybody anything by address, so
       the same caller now falls through to the public default like everybody
       else. The stored field is still read below, where an explicit "none"
       suppresses that default -- which is the only thing it does now. */
    for (const orgDefault of ["commenter", "viewer"]) {
      const store = fakeStore(
        new Map([[accessLib.accessDocumentKey(PUBLIC_DOC), documentRecord(orgDefault)]]),
      );
      deepEq(
        await resolveVisitor(store, MEMBER),
        row(capabilitiesFor, "viewer", true),
        `orgDefault ${orgDefault} grants nobody a role by address`,
      );
    }

    /* ---- an explicit denial is never resurrected ---- */
    for (const user of [MEMBER, VISITOR]) {
      const store = fakeStore(
        new Map([[accessLib.accessDocumentKey(PUBLIC_DOC), documentRecord("none")]]),
      );
      deepEq(
        await resolveVisitor(store, user),
        row(capabilitiesFor, "none", true),
        `orgDefault "none" denies ${user.sub} even with PUBLIC_DEFAULT_ROLE set`,
      );
    }

    /* ---- an unbound document keeps its unshared answer shape ---- */
    deepEq(
      await resolveRole(PUBLIC_DOC, VISITOR, { store: fakeStore(), docOwners: "", now: NOW }),
      row(capabilitiesFor, "viewer", false),
      "an unbound document reports the public role as unshared",
    );

    /* ---- the Edge Function reader is the same rule ---- */
    {
      const reads = [];
      const previous = Object.hasOwn(globalThis, "Netlify")
        ? globalThis.Netlify
        : undefined;
      configure("editor");
      globalThis.Netlify = {
        env: {
          get(name) {
            reads.push(name);
            return name === "PUBLIC_DEFAULT_ROLE" ? "commenter" : undefined;
          },
        },
      };
      try {
        deepEq(
          await resolveVisitor(),
          row(capabilitiesFor, "commenter", true),
          "an Edge Function reads PUBLIC_DEFAULT_ROLE from Netlify.env, not process.env",
        );
        ok(
          reads.includes("PUBLIC_DEFAULT_ROLE"),
          "the Netlify environment is asked for PUBLIC_DEFAULT_ROLE by name",
        );
      } finally {
        if (previous === undefined) delete globalThis.Netlify;
        else globalThis.Netlify = previous;
      }
    }

    /* ---- the configured value never leaves the module ---- */
    {
      const secret = "editor-please-do-not-echo";
      configure(secret);
      const serialized = JSON.stringify(await resolveVisitor());
      ok(!serialized.includes(secret), "a rejected configuration never reaches the resolved row");
      let thrown = null;
      try {
        await resolveRole(PUBLIC_DOC, { ...VISITOR, name: "" }, { docOwners: "", now: NOW });
      } catch (error) {
        thrown = error;
      }
      ok(thrown !== null, "an invalid user still rejects while the variable is set");
      ok(
        !`${thrown?.message} ${thrown?.stack}`.includes(secret),
        "a rejected configuration never reaches an error message or stack",
      );
    }
  } finally {
    if (had) process.env.PUBLIC_DEFAULT_ROLE = original;
    else delete process.env.PUBLIC_DEFAULT_ROLE;
  }

  section(before, "PUBLIC_DEFAULT_ROLE widens only the authenticated-none branch");
}

/* ========================================================================= */
/* entry point                                                               */
/* ========================================================================= */

async function main() {
  const ts = await loadTypeScript();
  await staticInventory(ts);

  const roots = [];
  installSignalCleanup(roots);
  const temporaryRoot = guardedTempRoot("access-row-");
  roots.push(temporaryRoot);
  try {
    /* The stub tree must exist before any handler is imported: the resolve
       hook is consulted at import time, not at call time. */
    bindStaticModules(join(temporaryRoot, "stubs"));
    const accessLib = await import(real("netlify/lib/access.mjs"));

    await convertedPathsMatrix(accessLib);
    await realtimeTokenMatrix(accessLib);
    await gateMatrix(ts, join(temporaryRoot, "gate"), accessLib);
    await publicDefaultRoleMatrix(accessLib);
  } finally {
    removeTempRoots(roots);
  }

  if (failures === 0) {
    process.stdout.write(`PASS  access-row: ${checks} checks\n`);
    return 0;
  }
  process.stderr.write(`FAIL  access-row: ${failures} of ${checks} checks failed\n`);
  return 1;
}

const deadline = setTimeout(() => {
  bail("the runner exceeded its 120s deadline");
}, 120_000);
deadline.unref();

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`FAIL  access-row runner: ${error.stack}\n`);
  process.exitCode = 1;
}
