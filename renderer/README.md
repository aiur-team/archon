# `renderer/` — the isolated artifact renderer

A static deployment on its own origin whose only job is to display one uploaded
HTML document. It runs no server code, holds no session, stores nothing and
never learns which document it is showing.

It exists because of one problem. A document an Archon agent produces is *active*
HTML: it has scripts, and the interactions those scripts provide are the reason
somebody wanted to share it. Rendering that HTML on the account origin would give
the document's code the account's cookies, its storage and its APIs. Stripping
the scripts out would deliver something that is not the document. So the document
is rendered somewhere that has nothing worth taking.

## The shape

Three layers, each with strictly less authority than the one above it:

| Layer | Origin | What it can do |
| --- | --- | --- |
| Trusted viewer | the application origin | Holds the session, reads the private document, frames the renderer |
| Renderer | this origin | Receives bytes and puts them in a sandboxed frame. No cookies, no storage, no API |
| Artifact | an opaque origin | Runs its own scripts inside its own frame, and reaches nothing above it |

The artifact frame is `sandbox="allow-scripts"` and deliberately **not**
`allow-same-origin`. Those two tokens together would hand the artifact this
origin and undo the whole design; they are never the answer to a policy problem.
Everything else the sandbox withholds — top navigation, popups, forms,
downloads — is withheld by leaving the token out.

The renderer is a **different registrable site** from the application, not a
sibling subdomain. Sibling subdomains share cookies and share a site for
SameSite purposes, so `render.example.com` beside `app.example.com` would not be
the cookie-free origin this depends on. `netlify/lib/hosted/config.mjs` owns that rule
and refuses to start the application when the two configured origins share a
site.

## The message contract (C4)

Two messages, one direction each, and no other channel in either direction.

1. The renderer sends `{type: "archon:ready", v: 1}` to the exact configured
   application origin.
2. The viewer replies with `{type: "archon:render", v: 1, html}` to the exact
   renderer origin and the exact renderer frame's window.

The renderer accepts that reply only when `event.origin` is exactly the
configured application origin **and** `event.source` is exactly the window it was
mounted against. Both halves are load-bearing and neither is redundant: a sibling
frame on the account origin reaches this window and produces a flawless
`event.origin`, and a hostile page that framed the renderer produces a flawless
`event.source`.

At most one artifact is accepted per renderer instance. Malformed messages,
unknown types, unknown versions, extra keys and oversized payloads are refused
rather than guessed at, and a refusal does not settle the instance — the real
message still renders.

**The viewer owes the same two checks in the other direction.** Readiness is the
half of the handshake an attacker gets to speak first: a second frame on the
renderer origin produces a flawless `event.origin` from the wrong window, and a
frame on any other origin produces a flawless `event.source` from the wrong
origin. A viewer that checks one and not the other will hand a private document
to whichever one it forgot. Check `event.origin === HOSTED_RENDER_ORIGIN` **and**
`event.source === frame.contentWindow`, and send with an exact `targetOrigin` —
never `"*"`.

No document identifier, title, owner, session or CSRF token is ever sent. There
is nothing here for a compromised artifact to steal.

**The viewer's frame must carry `referrerpolicy="no-referrer"`.** An
`about:srcdoc` document inherits its parent's referrer, and the renderer
document's referrer is whatever the viewer's frame element sent. Firefox sends
the full application origin, so without this attribute the artifact can read the
account origin out of `document.referrer` — the one fact about the account
application that would otherwise cross the boundary. Chromium already sends
nothing; `no-referrer` makes both engines agree, and it is the viewer's
attribute to set because the renderer cannot set it on its own framing element.

**The renderer's address must carry nothing either.** An `about:srcdoc` document
inherits its parent's base URL, so anything in the renderer's query or fragment
is readable by the artifact as `document.baseURI` — and the artifact's
`base-uri 'none'` means it cannot be neutralised afterwards. The renderer
therefore refuses to mount at all when its own URL carries a query or a
fragment, so a viewer that grows a `?doc=<id>` is a visibly broken renderer on
the first try rather than a silent leak later.

## What is here

| Path | What it is |
| --- | --- |
| `public/index.html` | The shell. Inert, explanatory, and carries no sign-in control |
| `public/renderer.js` | The whole behaviour: `validateRenderMessage`, `buildArtifactSrcdoc`, `mountRenderer` |
| `public/renderer.css` | Presentation, which is almost nothing |
| `scripts/build.mjs` | Produces `dist/`: the three files above plus `renderer-config.js` and `_headers` |
| `netlify.toml` | Deployment configuration. No functions, no edge function, no headers, no environment |

There are no dependencies and no lockfile. The build imports nothing but `node:`
builtins, which is what keeps the published tree five files a reviewer can read
in full.

## Building

```sh
HOSTED_APP_ORIGIN=https://app.example.com \
HOSTED_RENDER_ORIGIN=https://render.example.net \
node renderer/scripts/build.mjs --out dist
```

The output directory is generated and gitignored; `netlify.toml` publishes
`dist`, and the build refuses a target that is the renderer tree or a directory
containing it, because `--out .` would otherwise delete the sources it is about
to copy. It also refuses to run when `public/` holds a file the build does not
declare, so adding one is a build failure rather than a page that quietly 404s
its stylesheet.

`--local-test` relaxes the HTTPS requirement for loopback testing. It is an
argument rather than an environment variable, exactly as it is in
`netlify/lib/hosted/config.mjs`: no value an operator can set on a deployed site can
select it.

The build owns the security headers because one of them cannot be a committed
file. `frame-ancestors` has to name the exact configured application origin, and
neither a `meta` element nor `X-Frame-Options` can express "this specific other
site". So `_headers` is generated, `netlify.toml` sets none, and there is one
authority rather than two that can disagree. In particular there is deliberately
no `X-Frame-Options`: `SAMEORIGIN` would forbid the one framing this design
requires.

The configured origin is parsed with `URL`, required to equal its own origin
serialization, held to a character allowlist with no room for a newline or a
quote, and JSON-encoded on the way into script. A build-time substitution that
pasted an operator string into a header line would be an injection point in a
file nobody reads again.

## Operator configuration

| Key | Required | Meaning |
| --- | --- | --- |
| `HOSTED_APP_ORIGIN` | yes | The one origin allowed to frame this renderer and send it a document |
| `HOSTED_RENDER_ORIGIN` | yes | This deployment's own origin. Must differ from the application origin |

Both are the same keys `hosted/` reads, deliberately: the application and the
renderer have to agree on the pair, and two names for one value is how they stop
agreeing. No secret is read here, because there is none this deployment could
need.

## Content-security policy, and why the outer one is not strict

A `srcdoc` document inherits its parent's policy and then intersects whatever its
own `meta` element adds. That inheritance decides the whole header set:

- The **renderer's HTTP policy** allows inline script and style, because the
  artifact one level down is inline by construction and cannot run otherwise.
  That allowance is the entire reason this is a separate, cookie-free site — the
  account application's own policy stays strict and is never asked to make room
  for it.
- The **artifact's `srcdoc` policy** is emitted before a single byte of authored
  content and denies `connect-src`, `form-action`, `object-src`, `base-uri`,
  nested frames and every remote subresource. Because policies intersect, an
  artifact that ships a more permissive `meta` policy of its own loosens nothing.

Every directive the srcdoc declares is also declared, more strictly, by the
response the artifact inherits — so on a normal page the inner policy is
invisible. It is there for the day the shell's own headers are loosened for some
reason of the shell's own, and one case in the runner exists solely to keep it
honest: the shell is served under a policy that grants everything, and the
artifact has to be contained by its own `meta` element alone.

The authored HTML is appended as markup and never interpolated into a script, a
string or an attribute, and it reaches the frame through the `srcdoc` IDL
property rather than an assembled attribute. Nothing escapes anything, because
there is no context in the output where a character in the stored bytes could
mean something other than what its author wrote.

### Fragment links

A self-contained document is full of `href="#section"` anchors, and an
opaque-origin `about:srcdoc` document has no useful base URL to resolve one
against. A trusted prelude, emitted ahead of the authored content, resolves them:
it listens on `window` in the bubble phase so every authored click listener has
already run, it suppresses the default navigation, and it scrolls to the target
itself. Original `href` attributes are read and never rewritten, the stored bytes
are untouched, and a fragment that names nothing leaves the artifact exactly
where it is.

## What this is not

The sandbox removes the artifact's authority over the account origin. It does not
make hostile HTML harmless, and nothing here should ever be described as
network-proof or end-to-end encrypted: an artifact can still spend the reader's
CPU and draw whatever it likes inside its own frame.

Self-navigation is worth naming precisely, because it is the one escape neither
the sandbox nor the artifact's own policy speaks to: a frame may always navigate
itself. What stops it reaching an attacker's page is the shell's `frame-src
'self'`, which both tested engines enforce — the request never leaves the
browser. The artifact can still destroy its own view that way. It cannot replace
it with someone else's, which is what would turn the trusted viewer's chrome
into a phishing surface.

There is no owner or session API, no document fetch, no token bridge, no content
storage, no sharing, no clipboard permission, no artifact-driven resizing or
navigation, no remote asset proxy and no sanitization promise. A future protocol
change needs a coordinated, versioned application update; v1 rejects an unknown
message rather than guessing.

## Checks

```sh
node renderer/scripts/build.mjs --local-test --out /tmp/renderer-dist  # with both origins set
node scripts/test-hosted-renderer.mjs
```

The runner is the real gate. It builds this tree, serves the output on its own
loopback origin with the generated headers applied, and drives Chromium and
Firefox against a separate account origin and a third adversary origin: a real
inline control changing real computed style, the artifact failing to read the
parent DOM, cookies or storage, credentialed account requests obtaining no bytes
and causing no mutation, forged messages with the right origin and wrong window
and with the right window and wrong origin, remote scripts and images and forms
and popups and top navigation reaching nothing, and a payload of hostile meta
tags, base tags, event handlers, nested frames and closing-tag sequences going
through the actual bootstrap. It runs in `.github/workflows/check.yml`.

A pass means the isolation holds in those engines at those versions. It is not a
certification of production DNS, of a real deployment's response headers, or of
every browser a reader might use; AHU-013's live capstone is where those are
established.
