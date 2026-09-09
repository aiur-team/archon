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
| `test/` | Fixtures. Never reachable from a deployed module. |

## Modules

### `lib/contracts.mjs`

Pure validators and constants for contracts v1. No network, no clock, no
`process.env`. Each validator returns a validated, frozen value or throws a
`HostedContractError` carrying a wire error code — there is no third answer, and
in particular no way to spell "could not check" as success.

| Export | Purpose |
| --- | --- |
| `validateDescriptor(value, options?)` | C2 artifact descriptor. |
| `validatePublication(value, options?)` | C2 stored publication record, including its state-dependent nullability matrix. |
| `validateResult(value, options?)` | C3 status / completion envelope. |
| `validateWireError(value, options?)` | C3 error envelope. |
| `validateOrigin(value, options?)` | One canonical origin. `{production: false}` is the loopback-only test mode. |
| `registrableSite(origin, options?)` | Registrable domain, from the public-suffix list. |
| `HOSTED_LIMITS` | C2/C3 bounds and constants. |
| `PUBLICATION_STATES`, `TERMINAL_PUBLICATION_STATES` | The C2 state vocabulary. |
| `ERROR_CODES` | C3 codes with their HTTP status and retryability. |
| `HostedContractError` | Typed invalid-input error, with `.toWire()`. |

### `lib/config.mjs`

| Export | Purpose |
| --- | --- |
| `readHostedConfig(env)` | Validated operator configuration. |
| `formatHostedConfig(config)` | One-line, log-safe rendering. |
| `HostedConfigError` | Configuration fault, naming the key and never the value. |
| `HOSTED_CONFIG_KEYS`, `REDACTED` | The keys read, and what a secret renders as. |

`readHostedConfig` takes the environment as an argument rather than reading
`process.env`, which is what lets a test inject a complete fixture — and what
lets CI import the module with no credential present.

## Operator configuration

Every key below is set in the Netlify site environment. None is set in
`netlify.toml`: a secret there would be a secret in git, and values set there
are build-scoped rather than available to a function at runtime.

| Key | Required | Meaning |
| --- | --- | --- |
| `HOSTED_APP_ORIGIN` | yes | The trusted application origin. Exact, lowercase, no trailing slash. |
| `HOSTED_RENDER_ORIGIN` | yes | The cookie-free static renderer origin. Must be a **different registrable site** in production. |
| `GITHUB_CLIENT_ID` | yes | OAuth app client ID. |
| `GITHUB_CLIENT_SECRET` | yes | OAuth app client secret. Never logged, never formatted, never committed. |
| `HOSTED_PUBLISH_ENABLED` | no | Exactly `true` or `false`. Anything else is a fault; unset means disabled. |
| `HOSTED_ENV` | no | `production` (default) or `local-test`. |

Two properties are worth stating plainly, because both are load-bearing:

- **Unset is the strict reading.** A missing `HOSTED_ENV` gets production
  parsing, and missing publish-enabled means publishing is off. There is no
  configuration a deployment can fall into that is more permissive than what an
  operator explicitly asked for.
- **"Different registrable site" is not "different hostname."** `app.example.com`
  and `render.example.com` are one site: they share cookies, and a renderer
  there is not the credential-free origin the design depends on. The comparison
  uses the public-suffix list through pinned `tldts` with private suffixes
  enabled, so `a.pages.dev` and `b.pages.dev` are correctly two sites. Comparing
  the last two hostname labels would get both of these wrong.

`HOSTED_ENV=local-test` permits `http` on a loopback host and nothing else. It
is not a bypass: every other key is still required, and a non-loopback `http`
origin is still refused.

## Checks

```sh
npm --prefix hosted ci --ignore-scripts --no-audit --no-fund
node scripts/check-hosted-modules.mjs
node --test hosted/lib/contracts.test.mjs
```

All three run in `.github/workflows/check.yml`, in that order, before anything
else in the workflow compiles or installs a workspace — a hosted function cold
starts with nothing but this directory's own `node_modules`, so proving it links
requires checking before some other tree exists to link against.
