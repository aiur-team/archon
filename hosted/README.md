# `hosted/` — the hosted publishing deployment

A second Netlify deployment, separate from the repo-backed `_site` build at the
repository root. It exists to give an Archon agent a way to hand one
self-contained HTML document to a person, have that person approve it in their
own browser, and make the result readable only by them.

This directory currently holds the **service boundary and its contracts**. There
is no sign-in, no storage and no upload route yet; those are separate tickets.
The shell at `public/index.html` says so in as many words, because a placeholder
that implied otherwise would be a production surface making a claim nothing
behind it can keep.

## Why it is separate from `netlify/`

The root deployment is the self-hosted product. It resolves roles through
Netlify Identity, a `DOC_OWNERS` allowlist, organisation email defaults and the
all-path `gate` edge function. Those are correct authorities for a site an
organisation runs for itself, and the wrong ones for a shared service where the
only thing known about a visitor is which GitHub account they signed in with.

So the two trees share nothing at runtime: separate `package.json`, separate
lockfile, separate `netlify.toml`, separate functions directory. `hosted/`
imports nothing from `netlify/`, and `scripts/check-hosted-modules.mjs` fails
the build if it ever does. Nothing about the root deployment or
`scripts/connect.mjs` changes.

## Layout

| Path | What it is |
| --- | --- |
| `netlify.toml` | Deployment configuration. No edge function, no build command, no environment values. |
| `public/` | Static app shell, served as committed. |
| `lib/` | Server modules. Deployed. |
| `functions/` | Routed Netlify functions under `/api/hosted/*`. Does not exist yet. |
| `test/` | Tests and fixtures. Never reachable from a deployed module. |

## Rules for code in this tree

`scripts/check-hosted-modules.mjs` enforces these on every build, and
`scripts/check-hosted-modules.test.mjs` proves it fails when they are broken.

- **Deployable code lives in `lib/` or `functions/`.** A module anywhere else
  under `hosted/` is refused rather than left unscanned.
- **Nothing resolves outside `hosted/`**, and every bare import must be a
  declared dependency that resolves inside `hosted/node_modules` — not a package
  that happens to be installed at the repository root.
- **Nothing deployed may import `hosted/test/`.**
- **Static imports only.** Dynamic `import(` is refused anywhere in the tree,
  including inside a comment. The resolver observes every static import exactly;
  a dynamic one inside a function body is invisible to any check that does not
  execute it, and its specifier can be computed. Write "dynamic import" in prose
  if you need to mention it.
- **`.mjs` only.** No TypeScript — the deploy has no build step, and the gate
  has to be able to load what it checks. No `.cjs` or `.js` either: the boundary
  rules above are read off an ESM resolution hook, which Node never consults for
  a CommonJS `require()`, and a `.js` file's module system is decided by the
  nearest `package.json` rather than by the file itself.

## Modules

### `lib/contracts.mjs`

Pure validators and constants for contracts v1. No network, no clock, no ambient
environment. Each validator returns a validated, frozen value or throws a
`HostedContractError` carrying a wire error code — there is no third answer, and
in particular no way to spell "could not check" as success.

| Export | Purpose |
| --- | --- |
| `validateDescriptor(value, options?)` | C2 artifact descriptor. |
| `validatePublication(value, options?)` | C2 stored publication record, including its state-dependent nullability matrix. |
| `validatePrincipal(value, options?)` | C1 `HostedPrincipal`. |
| `validateSessionResponse(value, options?)` | C1 session-endpoint body, signed in or out. |
| `validateStartResponse(value, {appOrigin, ...})` | C3 201 start body. **`appOrigin` required.** |
| `validateResult(value, {appOrigin?, ...})` | C3 status / completion envelope. **`appOrigin` required when `complete`.** |
| `validateWireError(value, options?)` | C3 error envelope. |
| `validateDocumentMetadata(value, options?)` | C4 owner document metadata. |
| `validateReadyMessage` / `validateRenderMessage` | C4 renderer messages. |
| `validateOrigin(value, options?)` | One canonical origin. `{production: false}` relaxes the scheme only. |
| `registrableSite(origin, options?)` / `isLoopbackOrigin(origin)` | Site comparison helpers. |
| `decodeArtifactBytes` / `encodeArtifactBytes` | Strict-UTF-8, BOM-preserving round trip. |
| `HOSTED_LIMITS` | C2/C3 bounds and constants. |
| `PUBLICATION_STATES`, `TERMINAL_PUBLICATION_STATES`, `RENDER_MESSAGE_TYPES`, `LOOPBACK_HOSTS` | Vocabulary. |
| `ERROR_CODES` | C3 codes with their HTTP status and retryability. |
| `HostedContractError` | Typed invalid-input error, with `.toWire()`. |

Two things are worth knowing before you consume these:

- **`appOrigin` is required, not optional, for a receipt.** A self-consistent
  URL is not enough. Without pinning the origin, a hostile responder can return
  a perfectly well-formed `complete` envelope pointing at its own host and a
  client will print it as the user's published document. Omitting the option
  raises a `TypeError`, so the unsafe call cannot be written by accident.
- **`HOSTED_LIMITS.RECOMMENDED_USER_CODE_PATTERN` is advice, not a rule.** C2
  says `userCode: string`, so that is all `validatePublication` enforces.
  AHU-004 is welcome to mint codes in the recommended alphabet; a shared
  validator that demanded it would silently amend the contract for every sibling.

### `lib/config.mjs`

| Export | Purpose |
| --- | --- |
| `readHostedConfig(env, options?)` | Validated operator configuration. |
| `formatHostedConfig(config)` | One-line, log-safe rendering. |
| `HostedConfigError` | Configuration fault, naming the key and never the value. |
| `HOSTED_CONFIG_KEYS`, `REDACTED`, `PRODUCTION`, `LOCAL_TEST` | The keys read, and the two modes. |

`readHostedConfig` takes the environment as an argument, which is what lets a
test inject a complete fixture and lets CI import the module with no credential
present.

## Operator configuration

Every key below is set in the Netlify site environment. None is set in
`netlify.toml`: a secret there would be a secret in git, and values set there
are build-scoped rather than available to a function at runtime.

| Key | Required | Meaning |
| --- | --- | --- |
| `HOSTED_APP_ORIGIN` | yes | The trusted application origin. Exact, lowercase, no trailing slash, no trailing dot. |
| `HOSTED_RENDER_ORIGIN` | yes | The cookie-free static renderer origin. Must be a **different registrable site**. |
| `GITHUB_CLIENT_ID` | yes | OAuth app client ID. |
| `GITHUB_CLIENT_SECRET` | yes | OAuth app client secret. Never logged, never formatted, never committed. |
| `HOSTED_PUBLISH_ENABLED` | no | Exactly `true` or `false`. Anything else is a fault; unset means disabled. |

That is the whole list. Three properties are load-bearing:

- **Unset is the strict reading.** Missing publish-enabled means publishing is
  off. There is no configuration a deployment can fall into that is more
  permissive than what an operator explicitly asked for.
- **There is no environment variable that relaxes anything.** Loopback-only
  local testing is `readHostedConfig(env, { mode: "local-test" })` — an
  argument, not a key — so no value an operator can set on a site, deliberately
  or "temporarily on a preview", can turn off the HTTPS requirement or the
  two-site separation. That mode additionally requires *both* origins to be
  loopback, so it cannot describe a real deployment even by mistake.
- **"Different registrable site" is not "different hostname."** `app.example.com`
  and `render.example.com` are one site: they share cookies, and a renderer
  there is not the credential-free origin the design depends on. The comparison
  uses the public-suffix list through pinned `tldts` with private suffixes
  enabled, so `a.pages.dev` and `b.pages.dev` are correctly two sites. Comparing
  the last two hostname labels would get both of these wrong.

Reading the client secret is `config.github.readClientSecret()`. It is a call
rather than a property so that no inspector can print it: `JSON.stringify`,
`util.inspect` — including `{showHidden: true, getters: true, customInspect:
false}` — spread, `structuredClone` and template interpolation all render
`[redacted]`.

## Checks

```sh
npm --prefix hosted ci --ignore-scripts --no-audit --no-fund
node scripts/check-hosted-modules.mjs
node --test scripts/check-hosted-modules.test.mjs
node --test hosted/test/contracts.test.mjs
```

All four run in `.github/workflows/check.yml`.
