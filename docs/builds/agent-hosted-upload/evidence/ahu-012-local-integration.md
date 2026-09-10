# AHU-012 — local integration evidence

What `node scripts/test-hosted-integration.mjs` establishes, what it does not,
and the exact shape of the environment it establishes it in.

**This is not a deployed acceptance result.** Nothing here may be reported as
"the hosted publishing feature is live" or as closing AHU-013. The live capstone
owns real GitHub, two real registrable sites, the provider's production
conditional-write behaviour, deployed headers and rate configuration, and
external package availability.

## Topology

Five servers on loopback, plus a browser, plus two child-process clients.

| Piece | What it is | How it is reached |
| --- | --- | --- |
| Application | Every merged handler in `hosted/functions/`, dispatched by the `config.path` each module exports, plus the committed `hosted/public/` tree served with the `[[headers]]` block and the one rewrite read out of `hosted/netlify.toml` | `http://127.0.0.1:<port>` |
| Renderer | Exactly what `renderer/scripts/build.mjs` emitted, served with its own generated `_headers` | `http://localhost:<port>` |
| Storage | `BlobsServer` from `@netlify/blobs` 11.0.2 — the provider's own local server — over a private `0700` temporary directory | an HTTP edge URL the real `getStore` client is pointed at |
| Identity provider | A loopback fixture standing in for GitHub. Validates the client id, the redirect URI, the response type, the PKCE method, the client secret and the verifier→challenge hash; issues single-use codes bound to the chosen account | `https://github.com`, resolved to the fixture by a Chromium `--host-resolver-rules` mapping; the server-side token and user calls go to its plain loopback origin through the `fetchImpl` seam of `createCallbackRoute` |
| Adversary | A third origin that records every request that reaches it | `http://127.0.0.1:<port>` |
| Client | `templates/docbuild` packed with `npm pack` and installed into a directory **outside** this checkout; the document is built and published by the installed `docbuild` and `archon-publish` binaries in separate processes | — |

Browser: Chromium, pinned via `playwright@1.55.0`. The exact build is printed in
the runner's own PASS line, e.g.
`PASS  hosted integration matrix (chromium 140.0.7339.16; 96 cases)`.

Once the servers are up, nothing in the matrix contacts a network host.
`github.com` is the only external name the browser may resolve and it resolves
to the loopback fixture; every other origin is aborted by an explicit rule, so a
regression that reached the internet fails as a blocked request rather than
passing on a machine that has one. The *setup* is not network-free and does not
claim to be: the supervisor installs a pinned Playwright and downloads a
Chromium, and the client half runs `npm pack` and `npm install`. Those are
registry and CDN fetches, not provider contact.

## What is real, and what is substituted

Real: every route, the publication state machine, the publication and auth
stores, the browser approval page and its bootstrap, the trusted viewer, the
renderer build and its policies, the packaged client, the descriptor grammar,
every origin, cookie and CSRF check, and the durable records.

Substituted, and only these three:

1. **The identity provider upstream.** No GitHub account exists. The state
   cookie, the PKCE verifier, the callback handler, the session and the account
   binding are production code; only the party at the other end is a fixture.
2. **The clock, for two deadline cases.** `publicationDependencies` is the
   producer's own dependency builder and the state machine reads its clock out
   of it, so the upload-deadline and receipt-window cases move that clock rather
   than waiting ten minutes and twenty-four hours. The handler, the store and
   the record are unchanged.
3. **Three provider outcomes, one call wide.** A wrapper around the `Store`
   object — the boundary between the real store producer and the real provider
   client — can make one write not reach the provider, make one write *commit
   and lose its answer*, or make one read fail. It cannot answer a read from
   memory, cannot decide whether a conditional write wins, and never replaces a
   handler or a store.

## Limits of this evidence

These are structural. They are the reason AHU-013 exists, and none of them is a
gap that more local cases would close.

- **Two loopback ports are two origins and one site.** `http://127.0.0.1:a` and
  `http://localhost:b` are different origins, which is what every exact-origin
  comparison in the design is about, and they are *not* different registrable
  sites. So the SameSite consequences of the two-site split — the property that
  makes the renderer cookie-free in a real browser against a real cookie jar —
  are not exercised here. `hosted/lib/config.mjs` enforces the registrable-site
  rule in production and skips it in `local-test` mode precisely because a
  loopback host has no registrable site to compare. AHU-013 owns it.
- **`BlobsServer` is the provider's local server, not the provider.** In
  particular it derives an entry's ETag from that file's modification time at
  millisecond resolution, so two writes landing inside the same millisecond
  present the same `If-Match` value and both are taken. "Exactly one caller
  created the document" is therefore a claim about Netlify's production
  conditional writes and is AHU-013's to prove. What is proved locally is that
  simultaneous completions are answered successfully, are answered with the
  *same* document, leave one durable record carrying the approved owner, digest
  and bytes, and that a completion presented against an ETag the provider has
  already moved past resolves to the stored document rather than to a failure or
  a second one.
- **`BlobsServer` omits the `etag` header on `GET`.** It emits one on `PUT` and
  on `LIST` and not on the read the publication store's compare-and-set depends
  on, so against the local server as shipped the real store producer cannot run
  at all. The runner closes that gap by asking the same server for the same
  key's ETag through `list` — the provider's value, computed by the provider's
  own function, used in the provider's own comparison. Nothing local decides
  whether a write wins. This is a limitation of the local runtime rather than of
  the code under test, and it is named here because a reader is entitled to know
  that one read in the loop takes a second call it would not take in
  production.
- **The pilot rate rules are declared, not demonstrated.** The runner asserts
  the `rateLimit` objects the start and status route modules export — the
  objects Netlify packages — and then makes twelve status calls in a row and
  requires all twelve to succeed, because nothing local implements the
  platform's edge counters. Configured is not enforced; live efficacy is
  AHU-013's.
- **No real GitHub scope, callback registration, deployed header or CDN
  behaviour is observed.** A fixture provider cannot establish any of them.
- **Isolation is not an absolute.** C4 says the sandbox removes the artifact's
  authority over the account origin; it does not claim to be network-proof or
  end-to-end encrypted, and the hostile fixture is written to test the former
  rather than to assert the latter.

## What the run covers

Ninety-six cases across ten matrices, each named in the runner and counted by
its supervisor:

1. The whole happy path — clean-installed client, browser approval, a *second*
   client process resuming and uploading, the durable record, the owner's
   receipt URL rendering the real artifact, and the local source unchanged.
2. Account binding — switching accounts mid-review, a stale displayed identity,
   an absent and a wrong CSRF token, a foreign `Origin`, and `GET`.
3. Provider faults — a replayed callback in the same browser and in another, an
   outage, and a grant carrying an unexpected scope.
4. Upload and receipt — a client-supplied owner, an unapproved upload, altered
   bytes, a wrong media type, the identical retry, and recovery inside and
   outside the receipt window.
5. Owner read and enumeration — the owner's metadata and content, a signed-out
   reader, a second account holding the owner's URL, a missing id, a malformed
   id, `HEAD`, the byte-identical refusal shell, and the rule that legacy
   `DOC_OWNERS`, organisation defaults and `PUBLIC_DEFAULT_ROLE` cannot widen a
   hosted read.
6. Storage faults and races — a create the provider never took, an unanswerable
   read, a committed write whose answer was lost on a completion *and* on an
   approval, a completion whose claimed digest and length disagree with the
   approval, the store's demand for strongly consistent reads, simultaneous
   completions, a cancel racing an upload, and the rule that nothing partial
   becomes readable.
7. Rendered isolation — a positive control proving the adversary recorder can
   see a request that does reach it, an ordinary artifact operated through its own theme
   toggle and fragment navigation, the *packaged* document's real section
   navigation inside the sandbox, and a hostile artifact's attempts on the
   parent window, the account origin, the renderer's message channel, the tab
   and the network.
8. Deployment connection — the header block on the static surfaces, the viewer's
   policy naming the configured renderer, the renderer's generated
   `frame-ancestors`, an adversary that cannot frame the renderer into talking
   to it, a readiness message from the right origin and the wrong window, and an
   unreachable renderer producing a readable failure with no bytes sent.
9. Operations — publishing disabled refusing new work while existing reads and
   completed recovery keep working, the payload bound at both ends, the private
   header set on every refusal, the declared rate rules, and a check that no
   operation secret or private content reached any client transcript.
10. Accessibility — live regions on the approval page and the viewer, a
    publication approved entirely from the keyboard, accessible names on both
    frames, the title and account outside the untrusted frame, and a keyboard
    sign-out that revokes server-side.

## Reproducing it

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm --prefix hosted ci --ignore-scripts --no-audit --no-fund
npm --prefix templates/docbuild ci --no-audit --no-fund
node scripts/test-hosted-integration.mjs
```

`openssl` must be on `PATH`: the provider fixture mints a one-name certificate
so it can complete a TLS handshake for `github.com`. The key never leaves the
run's temporary root and the browser is the only thing that ever trusts it.

`TMPDIR` must not have a checkout of this repository above it — the runner
refuses to install the client package anywhere the builder's own repository walk
could find `templates/base/`, because every packaging assertion would otherwise
pass for the wrong reason.

No credential and no provider account is required, which is why this runs on an
untrusted pull request. The only network the run needs is the npm registry and
the Chromium download.
