# The publication adapter

`hosted/lib/publications.mjs` is the single authority for publication state:
approval, ownership, completion and receipt recovery. `hosted/lib/publication-store.mjs`
underneath it is the only code that talks to the blob provider.

This page is for the consumers — AHU-007's browser approval UI and AHU-008's
artifact upload route — and it documents the exports as they actually are.

## Getting an adapter

Every operation needs an injected dependency set. Two spellings, same code:

```js
import { getStore } from "@netlify/blobs";
import { createPublications, publicationDependencies } from "../lib/publications.mjs";

const publications = createPublications(
  publicationDependencies({ env: process.env, getStore }),
);

const envelope = await publications.statusPublication({ publicationId, agentSecret });
```

or the module-level function with the dependency set as its second argument,
which is what the tests use:

```js
import { statusPublication } from "../lib/publications.mjs";

const envelope = await statusPublication({ publicationId, agentSecret }, dependencies);
```

`createPublications(dependencies)` returns a frozen object whose nine methods
have exactly the C3 signatures — one domain argument each. The module-level
functions take that same argument plus the dependency set, because C3 also
requires the provider to be injected into a factory and a function cannot both
take one argument and be told which store to use. The bound methods are the
frozen shape; the two-argument functions are how the binding happens.

A dependency set is:

| Field | Meaning |
| --- | --- |
| `store` | a `createPublicationStore({ getStore })` adapter |
| `appOrigin` | the configured app origin; receipts and the approval URL are built on it |
| `production` | `false` only for the loopback-only local-test mode |
| `publishEnabled` | `HOSTED_PUBLISH_ENABLED`; `createPublication` is the only operation that reads it (see below) |
| `now` | `() => epochMilliseconds`, defaulting to `Date.now` |
| `randomBytes` | `(size) => Uint8Array`, defaulting to `node:crypto` |

`publishEnabled` gating only `createPublication` is a decision, not an omission.
Turning publishing off stops new publications from starting; it does not revoke
authorisation users already hold, so for up to
`PENDING_TTL_SECONDS + UPLOAD_TTL_SECONDS` (25 minutes) an already-started
publication can still be approved and can still commit its bytes. The
alternative — a human's approval becoming a 503 after they gave it, and documents
stranded mid-upload — is worse. An operator who needs the harder stop takes the
deployment down. `statusPublication` skips the flag for a different reason: a
receipt for an already-published document must survive the switch.

`publicationDependencies({ env, getStore, mode })` builds the first four from
`readHostedConfig`. It does not open the store — `createPublicationStore` opens
it lazily on first use — so calling it costs nothing and contacts nothing.

Handlers must not call `getStore` themselves, and must not write storage. There
is one compare-and-set loop in this codebase and it is in `publications.mjs`.

## The nine operations

| Export | Argument | Resolves to |
| --- | --- | --- |
| `createPublication` | `descriptor` | the C3 start body, including `agentSecret` — the only time either secret exists in plaintext |
| `readPublication` | `id` | the whole stored record, or `null`. **Server-internal**; never an HTTP projection |
| `bindPublication` | `{publicationId, browserSecret}` | `{publicationId, browserSecretHash}` after verifying the secret |
| `reviewPublication` | `{publicationId, browserBinding, principal}` | the safe review fields below |
| `decidePublication` | `{publicationId, browserBinding, principal, decision, displayedAccountId}` | the review fields, post-decision |
| `statusPublication` | `{publicationId, agentSecret}` | the C3 status envelope, with `result` exactly when `complete` |
| `cancelPublication` | `{publicationId, agentSecret}` | the same status envelope |
| `completePublication` | `{publicationId, agentSecret, html, contentSha256, contentBytes}` | `{created, result}` |
| `readOwnedPublication` | `{publicationId, principal}` | the complete record, HTML included, for its owner |

The review projection is `{v, publicationId, descriptor, userCode, state,
ownerAccountId, currentAccountId, expiresAt}`. It never carries a secret hash and
never carries `html`, in any state.

> **`readPublication` and `readOwnedPublication` are server-internal reads, not
> HTTP projections. Project before you serialise.**
>
> C3 freezes both as returning the stored record, and a stored record carries
> `agentSecretHash` and `browserSecretHash` as well as, once complete, the
> document. `browserSecretHash` is not merely a digest of a capability: C3 also
> freezes `bindPublication` as returning `{publicationId, browserSecretHash}`,
> and `reviewPublication` / `decidePublication` authorise a binding by comparing
> the *presented* hash to the stored one — so the stored value is itself
> replayable as the browser binding. A consumer that serialises one of these
> records into a response body, a page, or a JSON island publishes the ability to
> approve that publication. Build a projection with the two hashes and (except
> for the owner's own document route) `html` removed.
>
> Hardening the binding itself — an HMAC under a server key, or keeping the
> browser secret in the cookie and re-running the secret verifier — would change
> a frozen C3 shape and needs a coordinated contract edit, so it is filed rather
> than done here.

`completePublication` returns `created: true` for the write that actually
committed the document and `created: false` for an identical retry of an
already-completed publication. AHU-008 maps those to HTTP 201 and 200.

## The transition table

`state` below is the *effective* state: a `pending` record past
`pendingExpiresAt` and an `approved` record past `uploadExpiresAt` are both
`expired` to every caller, with nothing written. Expiry is logical and evaluated
at every use, because nothing in v1 deletes a record.

| From | `decidePublication` | `completePublication` | `cancelPublication` |
| --- | --- | --- | --- |
| `pending` | → `approved` / `denied`, owner fixed | `403 approval_required` | → `cancelled` |
| `approved` | `409 state_conflict` | → `complete` | → `cancelled` |
| `complete` | `409 state_conflict` | identical bytes → the same receipt; anything else → `409 descriptor_mismatch` | returns the receipt; **never deletes**. Past the receipt deadline, `410 receipt_expired` — cancel returns the receipt, so it is bounded by the receipt window too |
| `denied` | `409 state_conflict` | `409 state_conflict` | returns `denied` |
| `cancelled` | `409 state_conflict` | `409 state_conflict` | returns `cancelled` |
| `expired` | `410 authorization_expired` | `410 authorization_expired` | returns `expired` |

A completed record is never written over, and its owner, descriptor and HTML
never change. Approval fixes the owner permanently. A cancellation and a
completion racing each other are arbitrated by the provider's conditional write,
and precisely one of them wins.

## Typed failures

Every rejection is a `HostedContractError` carrying `code`, `status`,
`retryable` and a bounded message, and `error.toWire()` is the C3 envelope. The
codes this module produces:

| Code | When |
| --- | --- |
| `invalid_request` | a malformed id, descriptor, principal or decision |
| `invalid_capability` | a bearer or browser binding that does not match the record |
| `approval_required` | an upload against a publication nobody has approved |
| `csrf_failed` | the account the approval page displayed is not the session account |
| `not_found` | no such publication — and every owner-read refusal, so that route is not an ownership oracle. Note that `statusPublication`, `cancelPublication` and `bindPublication` deliberately do *not* flatten `invalid_capability` into this, so a genuinely wrong bearer stays distinguishable from a mistyped id; the id is 128-bit, so the residual existence oracle needs the id already |
| `descriptor_mismatch` | bytes that are not the approved descriptor, or a differing retry of a completed record |
| `state_conflict` | a transition out of a terminal state |
| `authorization_expired` | the approval or upload deadline has passed |
| `receipt_expired` | more than 24 hours after completion; the owner can still read the document |
| `publishing_disabled` | `HOSTED_PUBLISH_ENABLED` is not `true` |
| `unavailable` | storage failed, or an ambiguous write could not be resolved |

`unavailable` is the only retryable one, and it is deliberately also the answer
for a stored record that cannot be interpreted — an unknown state name or schema
version is never coerced into `pending` or `complete`.

## Ambiguous writes

`@netlify/blobs` resolves a conditional `setJSON` as `{modified: true, etag: ""}`
for any response status that is neither 200 nor 412, it can throw after the
provider has already committed, **and it retries the same conditional PUT up to
five times on a network error or a 5xx**. That last one is why a resolved
`modified: false` is not proof that nothing was written: a write that commits and
then loses its response is re-sent with the same `If-Match`, answered 412 by a
server that has already applied it, and arrives as `modified: false`.

So only one shape is taken at face value, and everything else is read back:

* **committed** — `modified: true` with a non-empty ETag. This call wrote the
  record.
* **observed** — the readback shows exactly the record that was intended, but the
  provider's answer did not prove this call wrote it. The state the caller wanted
  is the state that is stored.
* **refused** — the readback shows a different record, or none. The caller
  re-evaluates its whole transition against fresh state and a fresh clock
  reading. It must not assume its write lost.

A readback that *also* fails surfaces as retryable `unavailable` with the
uncertainty intact — never as a definitive failure, and never as a retry that
would allocate a second document.

`observed` is the distinction that matters to consumers. `decidePublication` and
`cancelPublication` treat it as success, because the approver or canceller asked
for a state and that state is stored — reporting a conflict there told a human
their successful approval had failed. `completePublication` treats it as
`created: false`, because C3 reserves 201 for the write that first commits a
document and an unproven write cannot claim it; the receipt is still returned, so
the caller gets the same answer a retry would give rather than an error.

Each attempt of a compare-and-set loop re-reads the record, re-reads the clock,
and re-checks every guard: state, owner, digest, length and deadline. A write
already submitted before the upload deadline may land after it and is kept; a new
attempt after the deadline never starts. The loop is bounded at
`MAX_WRITE_ATTEMPTS`, which is **6** — the same discipline the self-hosted
store settled on. Exhausting it is reported as retryable `unavailable`, not as a
conflict, because six lost rounds on a single record is a fault rather than
contention.

## Storage and retention

One site-wide, strongly consistent store named `archon-hosted-v1`, one key per
publication at `publications/<id>`, and nothing else. The document id *is* the
publication id: 128 bits of server-chosen randomness, never a client-supplied
value and never a six-hex self-hosted document id.

There is no second blob, no account index, no publishing lease and no
multi-record transaction. There is also no `delete`: Netlify offers no verified
conditional delete here, so an unconditional one could race a completion and
remove a document that a moment earlier had been published. **v1 therefore never
removes a publication record.** Expiry bounds *access*, not storage — an expired
pending record and an expired upload window both keep behaving correctly forever
with no cleanup — and physical removal is an operator census and a
paused-maintenance runbook, not a worker this service ships.

## Fixtures

`hosted/test/fixtures/publications.mjs` publishes immutable records for every
state, validated at import through the same `validatePublication` production
uses, plus the principals, the expected receipt, and the plaintext capabilities
behind the fixture hashes. `hosted/test/helpers/publication-store.mjs` publishes
the store double: real `onlyIfNew` / `onlyIfMatch` semantics over per-key ETags,
a hand-moved clock, deterministic random sources, and fault hooks that can commit
a write and *then* throw.

```js
import { RECORDS, FIXTURE_RECORD_AGENT_SECRET } from "../test/fixtures/publications.mjs";
import { createProviderDouble, createClock } from "../test/helpers/publication-store.mjs";
```

Consumers may use these; they may not invent a divergent `Publication` shape. And
what they demonstrate is deterministic adapter verification — not evidence about
the real provider's concurrency semantics, which the live capstone owns.
