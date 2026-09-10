/*
 * The trusted viewer.
 *
 * This script owns everything on `/docs/<id>` that is not the document: the
 * title, the account it belongs to, sign-out, the loading and error states, and
 * the handshake that hands one authorised artifact to the isolated renderer. It
 * runs on the account origin with the reader's session cookie, so the interesting
 * question about every line is what it lets the *document* do -- and the answer
 * is meant to be nothing at all.
 *
 * ## Four rules
 *
 * **The document is never text this page interprets.** Its bytes are fetched as
 * an `ArrayBuffer`, decoded, and posted to another origin. They are never
 * assigned to `innerHTML`, never parsed here, never put in a `srcdoc` on this
 * origin. There is no fallback that inserts them into this document if the
 * renderer fails -- a fallback like that is the one change that would undo the
 * whole two-origin design, and it would be reached precisely when something has
 * already gone wrong.
 *
 * **Everything user-authored goes in through `textContent`.** The title is
 * authored by whoever ran the agent, and a title that is a `<script>` element or
 * an `<img onerror=...>` is a case this page has to survive rather than reject.
 * `textContent` makes it survivable by construction: there is no markup context
 * for the value to escape from.
 *
 * **The handshake is checked on both halves, and it is checked first.** A
 * message is looked at only when `event.origin` is exactly the configured
 * renderer origin *and* `event.source` is exactly this page's renderer frame.
 * Either alone is insufficient and both are one line: another frame on this page
 * produces the right origin with the wrong source, and a page that framed us
 * produces neither. Shape validation happens after, and is not the boundary.
 *
 * **The renderer is told nothing but bytes.** No document id, no title, no
 * account, no CSRF token, no cookie -- and it could not use them if it had them,
 * since it is a cookie-free origin on a different registrable site. The frame's
 * `src` is the bare renderer origin with no query and no fragment, which is a
 * requirement of `renderer.js` rather than a preference: an `about:srcdoc`
 * document inherits its parent's base URL, so anything in that URL is readable
 * by the artifact.
 *
 * ## What the reader is told
 *
 * Every state change goes through one `role="status"` live region, and every
 * failure leaves a focusable "Try again" button. The document itself lives in a
 * frame with a real `title`, so a screen reader announces it as a region rather
 * than as unlabelled content. None of that copy comes from the server: the
 * failure messages are a closed set of literals in this file, because an error
 * string chosen elsewhere is a way to put attacker-chosen text on a trusted
 * page.
 */
(() => {
  "use strict";

  /** How long the renderer has to say it is ready before this page gives up. */
  const READY_TIMEOUT_MS = 15000;

  /** C4: the only two message types that cross the app/renderer boundary. */
  const READY = "archon:ready";
  const RENDER = "archon:render";

  /** C2's id grammar, so a hand-edited address never becomes a request. */
  const DOCUMENT_ID = /^\/docs\/([0-9a-f]{32})\/?$/;

  const body = document.body;
  const titleEl = document.querySelector("[data-archon-title]");
  const ownerEl = document.querySelector("[data-archon-owner]");
  const statusEl = document.querySelector("[data-archon-status]");
  const retryEl = document.querySelector("[data-archon-retry]");
  const retryButton = document.querySelector("[data-archon-retry-button]");
  const signOutButton = document.querySelector("[data-archon-signout]");
  const stage = document.querySelector("[data-archon-stage]");

  const renderOrigin = body.getAttribute("data-archon-render-origin") || "";
  const renderSrc = body.getAttribute("data-archon-render-src") || "";

  /**
   * The renderer frame. Created here rather than in the server-rendered shell,
   * because a frame in the markup begins loading -- and `renderer.js` begins
   * announcing its readiness -- before this deferred module runs at all.
   *
   * The `sandbox` is a second belt on top of the cross-site origin.
   * `allow-same-origin` is present and is not a mistake: without it the renderer
   * document would have an opaque origin and could not compare `event.origin`
   * against anything, which is the check the whole handshake rests on. What the
   * two tokens leave out is the point -- no top navigation, no popups, no forms,
   * no downloads -- and the renderer origin hosts only operator-owned static
   * code, so `allow-same-origin` grants the artifact nothing: the artifact is one
   * level further down, in a frame with `allow-scripts` alone.
   */
  function createFrame() {
    const element = document.createElement("iframe");
    element.className = "renderer";
    element.setAttribute("data-archon-renderer", "");
    element.setAttribute("title", "Document renderer");
    element.setAttribute("sandbox", "allow-scripts allow-same-origin");
    element.setAttribute("referrerpolicy", "no-referrer");
    /* Set last: assigning `src` is what starts the load, and every attribute
       that governs the loaded document has to be in place before it does. */
    element.setAttribute("src", renderSrc);
    return element;
  }

  let frame = null;

  /* The closed set of things this page will ever say about a failure. Each maps
     a condition to an action the reader can take; none of them is derived from a
     server response, so no server can choose what appears here. */
  const MESSAGES = {
    loading: "Loading your document…",
    rendering: "Preparing the document…",
    ready: "",
    notFound: "There is no document at this address, or it is not yours to read.",
    unavailable: "Archon could not load this document just now.",
    corrupt: "This document did not arrive intact and was not displayed.",
    renderer: "The document viewer did not start. Try again.",
    signOutFailed: "Sign-out did not complete. Try again.",
    misconfigured: "This page is not configured to display documents.",
  };

  let csrfToken = null;
  /** The bytes waiting for a readiness message. Sent to one window, once. */
  let pending = null;
  /** Whether the renderer this page is currently talking to has said it is ready. */
  let readySeen = false;
  let rendered = false;
  let readyTimer = null;

  function say(message, tone) {
    statusEl.textContent = message;
    if (tone === undefined) statusEl.removeAttribute("data-tone");
    else statusEl.dataset.tone = tone;
  }

  /**
   * Enter a failure state.
   *
   * The retry button is focused rather than merely shown. A reader using a
   * screen reader or a keyboard has just had the live region announce a failure,
   * and the thing to do about it should be where the focus already is; leaving
   * focus on a stale control means tabbing through the trusted header to find
   * the one control that matters.
   */
  function fail(message) {
    say(message, "error");
    stage.hidden = true;
    retryEl.hidden = false;
    retryButton.focus();
  }

  /** Clear a failure state before an attempt, so a retry starts from nothing. */
  function reset() {
    retryEl.hidden = true;
    say(MESSAGES.loading);
    document.documentElement.setAttribute("data-archon-state", "loading");
  }

  function documentIdFromLocation() {
    const match = DOCUMENT_ID.exec(window.location.pathname);
    return match === null ? null : match[1];
  }

  /**
   * A same-origin JSON GET, with the outcome split three ways.
   *
   * `not_found` and `session_required` are distinct outcomes rather than one
   * "error", because the actions differ: one is a dead end and the other is a
   * sign-in. The distinction is drawn on the HTTP status, never on the message
   * in the envelope -- the message is bounded and safe, but it is still a string
   * the client has no reason to branch on.
   */
  async function getJson(path) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (response.status === 401) return { outcome: "signIn" };
    if (response.status === 404) return { outcome: "notFound" };
    if (!response.ok) return { outcome: "unavailable" };
    try {
      return { outcome: "ok", body: await response.json() };
    } catch {
      return { outcome: "unavailable" };
    }
  }

  /** Send the reader to the local sign-in flow, with this document as the target. */
  function signIn(documentId) {
    const destination = encodeURIComponent(`/docs/${documentId}`);
    window.location.replace(`/login/?destination=${destination}`);
  }

  /**
   * Lowercase hex SHA-256 of the fetched bytes, or `null` where unavailable.
   *
   * `crypto.subtle` exists on every secure context, which includes `https` and
   * loopback, so in practice this returns a digest. It returns `null` rather
   * than failing on the one case where it does not, because refusing to display
   * an owner's document over a mechanism that is an *integrity* check would
   * trade a real capability for no security gain: the bytes came from this
   * origin over TLS, and the length check below still runs.
   */
  async function digestOf(bytes) {
    if (!window.crypto || !window.crypto.subtle) return null;
    try {
      const digest = await window.crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return null;
    }
  }

  /**
   * Fetch the raw bytes and check them against the metadata the owner approved.
   *
   * `ignoreBOM: true` is what preserves a leading byte-order mark in the decoded
   * string, and `fatal: true` refuses to substitute U+FFFD for a bad sequence.
   * Together they make the string this page holds the exact inverse of the bytes
   * the server stored, which is what makes the digest comparison mean anything.
   */
  async function fetchContent(documentId, metadata) {
    const response = await fetch(`/api/hosted/docs/${documentId}/content`, {
      credentials: "same-origin",
      headers: { accept: "application/octet-stream" },
    });
    if (response.status === 401) return { outcome: "signIn" };
    if (response.status === 404) return { outcome: "notFound" };
    if (!response.ok) return { outcome: "unavailable" };

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== metadata.contentBytes) return { outcome: "corrupt" };
    const digest = await digestOf(buffer);
    if (digest !== null && digest !== metadata.contentSha256) return { outcome: "corrupt" };

    try {
      const html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
      return { outcome: "ok", html };
    } catch {
      return { outcome: "corrupt" };
    }
  }

  /**
   * Hand the bytes over, once both halves of the rendezvous have happened.
   *
   * The two events race and either order is normal: `renderer.js` posts its
   * readiness the instant it mounts, which on a warm cache is well before a
   * two-megabyte document has been fetched and hashed, while on a cold one it is
   * well after. So neither event acts alone -- each records its half and asks
   * whether the other has arrived.
   *
   * An earlier shape had the readiness listener call the hand-off directly. When
   * readiness won the race it posted `html: null`, the renderer refused it as
   * malformed, and the guard against a second artifact then blocked the real
   * document from ever being sent: a page stuck on "Preparing the document" with
   * both sides behaving exactly as specified.
   */
  function maybeHandOff() {
    if (rendered || !readySeen || pending === null) return;
    rendered = true;
    window.clearTimeout(readyTimer);
    /* The exact configured origin, never `"*"`. A `"*"` target would deliver a
       private document to whatever happens to occupy that frame, which after a
       navigation inside it is not necessarily the renderer. */
    frame.contentWindow.postMessage({ type: RENDER, v: 1, html: pending }, renderOrigin);
    pending = null;
    stage.hidden = false;
    say(MESSAGES.ready);
    document.documentElement.setAttribute("data-archon-state", "rendered");
  }

  /**
   * Replace the renderer frame with a fresh one, and return it.
   *
   * A retry needs a *new* renderer document, not a second message to the old
   * one: `renderer.js` posts its readiness once per document and refuses a
   * second artifact by design. Reaching into the frame to reload it is not an
   * option either -- it is cross-origin, which is the property the design is
   * built on -- so the frame element itself is replaced, which is a same-origin
   * DOM operation on this page.
   */
  function mountFrame() {
    const replacement = createFrame();
    if (frame === null) stage.appendChild(replacement);
    else frame.replaceWith(replacement);
    frame = replacement;
    return frame;
  }

  /**
   * Sign out: a POST carrying the session-bound CSRF header, never a link.
   *
   * A GET that logged out would be reachable from any page on the internet, and
   * the server refuses one. The reload afterwards is deliberate: the server
   * revokes the session before it answers, so reloading lands on the same
   * address as a signed-out reader and gets the sign-in redirect, which is the
   * honest confirmation that the session is gone.
   */
  async function signOut() {
    if (csrfToken === null) {
      fail(MESSAGES.signOutFailed);
      return;
    }
    signOutButton.disabled = true;
    try {
      const response = await fetch("/api/hosted/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-archon-csrf": csrfToken, accept: "application/json" },
      });
      if (!response.ok) throw new Error("logout refused");
      window.location.reload();
    } catch {
      signOutButton.disabled = false;
      fail(MESSAGES.signOutFailed);
    }
  }

  /** One attempt at the whole sequence: session, metadata, bytes, handshake. */
  async function load() {
    reset();

    const documentId = documentIdFromLocation();
    if (documentId === null) {
      fail(MESSAGES.notFound);
      return;
    }
    if (renderOrigin === "" || renderSrc === "") {
      fail(MESSAGES.misconfigured);
      return;
    }

    const session = await getJson("/api/hosted/session");
    if (session.outcome !== "ok" || session.body.authenticated !== true) {
      if (session.outcome === "unavailable") fail(MESSAGES.unavailable);
      else signIn(documentId);
      return;
    }
    csrfToken = session.body.csrfToken;
    ownerEl.textContent = `Signed in as @${session.body.login}`;
    signOutButton.hidden = false;

    const metadata = await getJson(`/api/hosted/docs/${documentId}`);
    if (metadata.outcome === "signIn") {
      signIn(documentId);
      return;
    }
    if (metadata.outcome === "notFound") {
      fail(MESSAGES.notFound);
      titleEl.textContent = "Not found";
      return;
    }
    if (metadata.outcome !== "ok") {
      fail(MESSAGES.unavailable);
      return;
    }

    /* `textContent`, on both the visible heading and the tab title. The value is
       user-authored and may be markup; neither assignment has a markup context
       to escape from. */
    titleEl.textContent = metadata.body.title;
    document.title = `${metadata.body.title} — Archon`;

    const content = await fetchContent(documentId, metadata.body);
    if (content.outcome === "signIn") {
      signIn(documentId);
      return;
    }
    if (content.outcome === "notFound") {
      fail(MESSAGES.notFound);
      return;
    }
    if (content.outcome === "corrupt") {
      fail(MESSAGES.corrupt);
      return;
    }
    if (content.outcome !== "ok") {
      fail(MESSAGES.unavailable);
      return;
    }

    say(MESSAGES.rendering);

    pending = content.html;
    /* The frame is created only now, after the listener exists and after there
       is something to send it. Nothing is lost by the delay -- the renderer is
       four static files on a cookie-free origin -- and starting it earlier is
       what reintroduces the race the listener placement exists to remove. */
    if (frame === null) mountFrame();

    readyTimer = window.setTimeout(() => {
      if (rendered) return;
      fail(MESSAGES.renderer);
      document.documentElement.setAttribute("data-archon-state", "renderer-timeout");
    }, READY_TIMEOUT_MS);

    maybeHandOff();
  }

  /**
   * The readiness listener, attached before anything else this page does.
   *
   * Placement is the whole of it. `renderer.js` posts its readiness the instant
   * it mounts, and the frame starts loading from its `src` while the parser is
   * still reading this document -- so by the time three fetches have resolved,
   * that message is long gone. Attaching the listener inside the load sequence
   * therefore lost the handshake on every warm load, and the symptom was the
   * readiness deadline firing against a renderer that had been sitting ready for
   * fifteen seconds.
   *
   * It is attached once and compares against whatever `frame` currently is, so a
   * frame replaced by a retry is covered and the frame it replaced is not.
   */
  window.addEventListener("message", (event) => {
    /* Both halves, before the message is looked at. `source` first because it is
       the stricter: another frame on this page reaches this window with a
       flawless `event.origin` and the wrong source. */
    if (frame === null || event.source !== frame.contentWindow) return;
    if (event.origin !== renderOrigin) return;
    const data = event.data;
    if (data === null || typeof data !== "object" || data.type !== READY || data.v !== 1) return;
    readySeen = true;
    maybeHandOff();
  });

  /*
   * A retry starts over completely, including the renderer.
   *
   * `renderer.js` announces its readiness once per document and refuses a second
   * artifact by design, so a retry that reused the frame would be talking to a
   * renderer that has already had its turn. Reaching into the frame to reload it
   * is not an option either -- it is cross-origin, which is the property the
   * whole design rests on -- so the element is replaced, which is an ordinary
   * same-origin DOM operation on this page.
   */
  retryButton.addEventListener("click", () => {
    window.clearTimeout(readyTimer);
    rendered = false;
    readySeen = false;
    pending = null;
    if (frame !== null) mountFrame();
    load();
  });
  signOutButton.addEventListener("click", signOut);

  load();
})();
