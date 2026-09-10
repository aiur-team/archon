/*
 * The approval page's bootstrap.
 *
 * ## The first thing it does, and why it is first
 *
 * The agent's link is `/publish/authorize#<publicationId>.<browserSecret>`. The
 * fragment is captured and removed from the URL synchronously, before any
 * request is made and before any handler is installed. `history.replaceState`
 * rather than a navigation, so the token-bearing URL never becomes a second
 * history entry a Back press could return to. A fragment is never sent to a
 * server, so removing it here is about the *client* copies - the address bar, a
 * screen share, a synced history entry, a bookmark - which are exactly the ones
 * that outlive the fifteen-minute window.
 *
 * The removal is unconditional. A malformed fragment is cleared too: this page
 * has no use for one, and a value it refuses to act on is still a value it
 * should not leave on screen.
 *
 * ## What is kept, and what is not
 *
 * The browser secret is sent once, to `POST /api/hosted/publications/bind`, and
 * then dropped. It is never written to `sessionStorage`, never put back in the
 * URL and never sent again; from that point the browser's proof is the
 * `__Host-archon_publish` cookie the bind route set, which JavaScript cannot
 * read.
 *
 * The publication *id* is kept in `sessionStorage`, because the round trip to
 * GitHub and back is a real navigation and this page comes back with no
 * fragment. The id is not a secret - it is in the review URL and in the
 * document URL - and presenting the wrong one simply fails against the server's
 * binding, so the worst a tampered value can do is produce a refusal.
 *
 * ## Nothing here decides anything
 *
 * The server owns every state, deadline and owner. This file renders what the
 * review route says and sends what the visitor pressed. In particular there is
 * no path that approves without a click: the two buttons are the only callers of
 * the decision route, and `displayedAccountId` is read from what was actually
 * rendered, so a decision made against a stale account is refused by the server
 * rather than silently retargeted.
 *
 * There is no `innerHTML` in this file. Every variable value - a title an agent
 * chose above all - is written with `textContent`.
 */
(() => {
  "use strict";

  /* ---------------------------------------------------------------- */
  /* fragment capture, before anything else                            */
  /* ---------------------------------------------------------------- */

  const rawFragment = window.location.hash;
  try {
    window.history.replaceState(null, "", window.location.pathname);
  } catch {
    /* A browser that refuses `replaceState` still must not keep the token on
       screen, and `location.hash = ""` leaves a bare "#". Overwriting the local
       copy is all that is left; the visit is refused below either way. */
  }

  /* `<32 hex>.<32-256 base64url>` and nothing else. The server checks the same
     thing and is the authority; this is about never sending garbage and never
     rendering any part of a fragment. */
  const FRAGMENT = /^#([0-9a-f]{32})\.([A-Za-z0-9_-]{32,256})$/;
  const captured = FRAGMENT.exec(rawFragment);
  const linked = captured === null ? null : { publicationId: captured[1], browserSecret: captured[2] };

  /* ---------------------------------------------------------------- */
  /* elements                                                          */
  /* ---------------------------------------------------------------- */

  const status = document.getElementById("status");
  const retryRow = document.getElementById("retry-row");
  const retry = document.getElementById("retry");
  const review = document.getElementById("review");
  const titleCell = document.getElementById("title");
  const sizeCell = document.getElementById("size");
  const userCodeCell = document.getElementById("user-code");
  const accountCell = document.getElementById("account");
  const approve = document.getElementById("approve");
  const deny = document.getElementById("deny");
  const signin = document.getElementById("signin");
  const switcher = document.getElementById("switch");
  const csrfField = document.getElementById("csrf");

  /** Where the publication id survives the provider round trip. */
  const STORAGE_KEY = "archon.publish.pending";

  /** The account and token the page last rendered, and will act as. */
  let displayed = null;

  /* ---------------------------------------------------------------- */
  /* rendering                                                         */
  /* ---------------------------------------------------------------- */

  function say(message, tone, { retryable = false } = {}) {
    status.textContent = message;
    status.dataset.tone = tone;
    retryRow.hidden = !retryable;
  }

  /** Show exactly one of the page's three regions, or none of them. */
  function show({ card = false, signIn = false, switchAccount = false } = {}) {
    review.hidden = !card;
    signin.hidden = !signIn;
    switcher.hidden = !switchAccount;
  }

  /**
   * A byte count with thousands separators.
   *
   * Grouped by hand rather than through `toLocaleString`, whose separator
   * depends on the visitor's locale: the number beside a document about to be
   * published under someone's name should read the same everywhere, and a
   * separator that varies is one more thing a screenshot cannot be compared
   * against.
   */
  function bytes(count) {
    return `${String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} bytes`;
  }

  /* ---------------------------------------------------------------- */
  /* transport                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * One JSON call, returning `{ok, status, body}` and never throwing.
   *
   * A network failure is reported as a synthetic `unavailable` envelope so that
   * every caller has one shape to branch on, and so an offline visitor is told
   * to retry rather than shown nothing at all.
   */
  async function call(path, options = {}) {
    try {
      const response = await fetch(path, {
        credentials: "same-origin",
        headers: { accept: "application/json", ...(options.headers ?? {}) },
        method: options.method ?? "GET",
        body: options.body,
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { ok: response.ok, status: response.status, body };
    } catch {
      return { ok: false, status: 0, body: { v: 1, error: { code: "unavailable", retryable: true } } };
    }
  }

  /** The error code of a failed call, or `"unavailable"` when it said nothing. */
  function codeOf(answer) {
    const code = answer.body?.error?.code;
    return typeof code === "string" ? code : "unavailable";
  }

  /* ---------------------------------------------------------------- */
  /* the flow                                                          */
  /* ---------------------------------------------------------------- */

  /** The session route, which also mints the single-use pre-login binding. */
  async function readSession() {
    const answer = await call("/api/hosted/session");
    return answer.ok && answer.body !== null ? answer.body : null;
  }

  function remember(publicationId) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, publicationId);
    } catch {
      /* Private modes and storage-partitioned embeds can refuse. The page still
         works for the visitor who does not need to sign in; one who does will be
         told the link has to be opened again, which is true and actionable. */
    }
  }

  function remembered() {
    try {
      const value = window.sessionStorage.getItem(STORAGE_KEY);
      return typeof value === "string" && /^[0-9a-f]{32}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  function forget() {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* Nothing to do, and nothing that depends on it having worked. */
    }
  }

  /** The messages a terminal or refused operation is reported with. */
  const TERMINAL = {
    approved: "Approved. Your agent can finish uploading the document now.",
    complete: "This document is already published. Your agent has the link.",
    denied: "Denied. Nothing was published, and nothing will be.",
    cancelled: "The agent cancelled this publication. Nothing was published.",
    expired: "This request expired before it was approved. Ask your agent to start again.",
  };

  const REFUSED = {
    approval_required:
      "This browser is not holding a pending publication. Open the link your agent printed again.",
    authorization_expired:
      "This request expired before it was approved. Ask your agent to start again.",
    invalid_capability: "This link cannot be used. Ask your agent for a new one.",
    not_found: "This link cannot be used. Ask your agent for a new one.",
    csrf_failed: "Archon could not verify this page. Select Try again.",
    state_conflict: "This publication already has an answer.",
    publishing_disabled: "Publishing is turned off on this Archon deployment.",
  };

  function reportRefusal(code) {
    if (code === "unavailable") {
      say("Archon is not reachable right now. Select Try again.", "error", { retryable: true });
      show({});
      return;
    }
    say(REFUSED[code] ?? "This publication cannot be authorised.", "error", {
      retryable: code === "csrf_failed",
    });
    show({});
  }

  /**
   * Exchange the link's secret for a server-side binding.
   *
   * Runs at most once per page load, and only when a fragment was actually
   * present. A previous pending id is dropped first, so a second link never
   * falls back to the operation the first one bound.
   */
  async function bind(link) {
    forget();
    const answer = await call("/api/hosted/publications/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicationId: link.publicationId,
        browserSecret: link.browserSecret,
      }),
    });
    if (!answer.ok) return codeOf(answer);
    remember(link.publicationId);
    return null;
  }

  /** Render one review projection, in whatever state it is in. */
  function renderReview(projection, session) {
    if (projection.state !== "pending") {
      say(TERMINAL[projection.state] ?? "This publication already has an answer.", "ok");
      show({});
      return;
    }

    displayed = { accountId: session.accountId, csrfToken: session.csrfToken };
    titleCell.textContent = projection.descriptor.title;
    sizeCell.textContent = bytes(projection.descriptor.contentBytes);
    userCodeCell.textContent = projection.userCode;
    accountCell.textContent = `@${session.login} (${session.accountId})`;
    csrfField.value = session.csrfToken;
    approve.disabled = false;
    deny.disabled = false;
    say("Approve only if you recognise this document and this pairing code.", "ok");
    show({ card: true, switchAccount: true });
  }

  /** Ask for the review body and render whatever it says. */
  async function loadReview(publicationId, session) {
    const answer = await call(`/api/hosted/publications/${publicationId}/review`);
    if (!answer.ok) {
      const code = codeOf(answer);
      if (code === "session_required") return askToSignIn();
      return reportRefusal(code);
    }
    renderReview(answer.body, session);
  }

  function askToSignIn() {
    say("Sign in with GitHub to see what is being published.", "ok");
    show({ signIn: true });
  }

  /** The whole page, from a cold load or from the retry button. */
  async function start() {
    say("Checking this link…", "pending");
    show({});

    let session = await readSession();
    if (session === null) {
      say("Archon is not reachable right now. Select Try again.", "error", { retryable: true });
      return;
    }

    if (linked !== null) {
      const failure = await bind(linked);
      if (failure !== null) return reportRefusal(failure);
      /* The bind consumed the pre-login binding, so the sign-in form below needs
         a fresh one - and this second answer is also the authoritative account
         after any redirect that landed here. */
      session = await readSession();
      if (session === null) {
        say("Archon is not reachable right now. Select Try again.", "error", { retryable: true });
        return;
      }
    }

    const publicationId = remembered();
    if (publicationId === null) {
      say(
        "No pending publication. Open the link your agent printed, on this device.",
        "error",
      );
      show({});
      return;
    }

    if (session.authenticated !== true) return askToSignIn();
    await loadReview(publicationId, session);
  }

  /* ---------------------------------------------------------------- */
  /* the decision                                                      */
  /* ---------------------------------------------------------------- */

  async function decide(decision) {
    const publicationId = remembered();
    if (publicationId === null || displayed === null) return reportRefusal("approval_required");

    approve.disabled = true;
    deny.disabled = true;
    say(decision === "approve" ? "Approving…" : "Denying…", "pending");

    const answer = await call(`/api/hosted/publications/${publicationId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-archon-csrf": displayed.csrfToken },
      /* The account sent back is the one this page rendered, not the one a later
         `/api/hosted/session` might report. That is the point: if they have
         diverged the server refuses, because the click consented to publishing
         as the account that was on screen. */
      body: JSON.stringify({ decision, displayedAccountId: displayed.accountId }),
    });

    if (!answer.ok) {
      const code = codeOf(answer);
      approve.disabled = false;
      deny.disabled = false;
      /* The pending id and the binding are both left in place here: a session
         that expired mid-decision is recoverable by signing in and coming back
         to this same operation. */
      if (code === "session_required") return askToSignIn();
      return reportRefusal(code);
    }

    /* The binding is gone now, server-side and in the browser, so the outcome is
       drawn from this response rather than from another review call. */
    forget();
    displayed = null;
    say(TERMINAL[answer.body?.state] ?? "This publication has an answer.", "ok");
    show({});
  }

  approve.addEventListener("click", () => decide("approve"));
  deny.addEventListener("click", () => decide("deny"));
  retry.addEventListener("click", () => start());

  start();
})();
