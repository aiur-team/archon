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
    if (frame === null || rendered || !readySeen || pending === null) return;
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
  /**
   * Report a failure that does not invalidate what is on screen.
   *
   * `fail` hides the stage and moves focus, which is right for a document that
   * could not be loaded and wrong for a sign-out that did not go through: the
   * document is still there, still authorised and still readable, and taking it
   * off the screen tells the reader they lost something they did not. The only
   * thing that failed is the button they pressed, so the message goes to the
   * live region and the button becomes pressable again.
   */
  function warn(message) {
    say(message, "error");
  }

  async function signOut() {
    if (csrfToken === null) {
      warn(MESSAGES.signOutFailed);
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
      warn(MESSAGES.signOutFailed);
    }
  }

  /* ------------------------------------------------------------------ *
   * ACN-009 - the owner's "Who can read" panel.
   * ------------------------------------------------------------------ */

  /**
   * Almost everything this panel says, as literals in this file.
   *
   * Same rule as `MESSAGES` above, and for the same reason: a string chosen by
   * a server is a way to put text on a trusted page. There are exactly two
   * deliberate exceptions, both required by the C-block for this route and both
   * narrow. `public_mailbox_domain` and `too_many_domains` render the server's
   * own `message`, because each carries a value only the server knows -- the
   * domain the owner typed and the limit they have to cut to -- and a local
   * copy of either would be a second, drifting statement of a policy that lives
   * in `domain-access.mjs`. Both are bounded by `safeMessage` before they leave
   * the server and bounded again here, and both go in through `textContent`.
   * Every other refusal renders a literal from this table.
   */
  const ACCESS = {
    heading: "Who can read",
    empty: "Only you and people you invite can read this",
    label: "Email domain",
    add: "Add domain",
    remove: "Remove",
    loading: "Loading the reading list…",
    saving: "Saving…",
    saved: "Saved.",
    blank: "Type a domain to add.",
    invalid: "That is not a domain we can use.",
    failed: "That change could not be saved.",
    loadFailed: "The reading list could not be loaded.",
    retry: "Try again",
  };

  /** The panel's address on the account origin. One route, two verbs. */
  const accessPath = (documentId) => `/api/hosted/publications/${documentId}/access`;

  /** How much of a server message this page will ever put on the screen. */
  const ACCESS_MESSAGE_MAX = 200;

  /**
   * `normalizeDomainList`'s output grammar, restated the way this file restates
   * the handshake contract: `viewer.js` is a committed static asset with no
   * build step and no module graph.
   *
   * It is a shape check on a response, never an access decision. What it buys
   * is that the only strings this page ever renders as domains are strings that
   * look like the ones the server says it stores -- lowercase, dotted, bounded
   * and at most twenty of them -- so a route that started answering something
   * else renders nothing rather than rendering it.
   */
  const ACCESS_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

  /**
   * Anything this page refuses to put in a line of text.
   *
   * `UNSAFE_DISPLAY` from `netlify/lib/hosted/contracts.mjs`, restated for
   * the same reason the handshake contract is: no build step, no module
   * graph. The server has already applied it, and applying it again here is
   * what makes "this page renders no control character" a property of this
   * file rather than a property of a module it cannot import.
   */
  const ACCESS_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

  function validAccessBody(body, documentId) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
    if (body.v !== 1 || body.publicationId !== documentId) return false;
    const list = body.allowedDomains;
    if (!Array.isArray(list) || list.length > 20) return false;
    return list.every(
      (entry) => typeof entry === "string" && entry.length <= 253 && ACCESS_DOMAIN.test(entry),
    );
  }

  /** A server message, bounded and stripped of anything that is not a line. */
  function boundedAccessMessage(value) {
    if (typeof value !== "string") return null;
    const cleaned = value.replace(ACCESS_UNSAFE, " ").trim();
    if (cleaned === "") return null;
    const scalars = [...cleaned];
    return scalars.length <= ACCESS_MESSAGE_MAX
      ? cleaned
      : `${scalars.slice(0, ACCESS_MESSAGE_MAX - 1).join("")}…`;
  }

  let accessEl = null;
  let accessListEl = null;
  let accessEmptyEl = null;
  let accessStatusEl = null;
  let accessInput = null;
  let accessRetryEl = null;
  let accessDocumentId = null;
  let accessDomains = [];
  /** One request at a time. A second would race the first over one list. */
  let accessBusy = false;

  function sayAccess(message, tone) {
    accessStatusEl.textContent = message;
    if (tone === undefined) accessStatusEl.removeAttribute("data-tone");
    else accessStatusEl.dataset.tone = tone;
  }

  /**
   * Disable every control in the panel for the duration of one request.
   *
   * Blunt on purpose. The list is replaced wholesale by every write, so a
   * second control pressed while the first is in flight would send a list built
   * from a state the server has already moved past -- which is the two-tabs
   * problem the `PUT` shape exists to avoid, reproduced inside one tab.
   */
  function setAccessBusy(busy) {
    accessBusy = busy;
    for (const control of accessEl.querySelectorAll("button, input")) control.disabled = busy;
  }

  function createAccessPanel() {
    const section = document.createElement("section");
    section.className = "access";
    section.setAttribute("data-archon-access", "");
    section.setAttribute("aria-labelledby", "archon-access-title");

    const title = document.createElement("h2");
    title.id = "archon-access-title";
    title.textContent = ACCESS.heading;

    accessEmptyEl = document.createElement("p");
    accessEmptyEl.className = "access-empty";
    accessEmptyEl.setAttribute("data-archon-access-empty", "");
    accessEmptyEl.textContent = ACCESS.empty;

    accessListEl = document.createElement("ul");
    accessListEl.className = "access-list";
    accessListEl.setAttribute("data-archon-access-list", "");

    const form = document.createElement("form");
    form.className = "access-add";
    form.setAttribute("data-archon-access-form", "");
    /* The browser's own validation would refuse values this server accepts and
       accept values it refuses, and the answer that matters comes from the
       server either way. */
    form.setAttribute("novalidate", "");

    /* A real `<label>`, not an `aria-label`: the accessible name is text in the
       document rather than a value in an attribute, which is the same rule the
       collaboration panel's controls follow. */
    const label = document.createElement("label");
    label.className = "access-label";
    label.setAttribute("for", "archon-access-domain");
    label.textContent = ACCESS.label;

    accessInput = document.createElement("input");
    accessInput.id = "archon-access-domain";
    accessInput.setAttribute("data-archon-access-input", "");
    accessInput.setAttribute("type", "text");
    accessInput.setAttribute("autocomplete", "off");
    accessInput.setAttribute("autocapitalize", "none");
    accessInput.setAttribute("spellcheck", "false");
    accessInput.setAttribute("maxlength", "253");

    const add = document.createElement("button");
    add.setAttribute("type", "submit");
    add.className = "access-add-button";
    add.setAttribute("data-archon-access-add", "");
    add.textContent = ACCESS.add;
    form.append(label, accessInput, add);

    accessStatusEl = document.createElement("p");
    accessStatusEl.className = "access-status";
    accessStatusEl.setAttribute("data-archon-access-status", "");
    /* The error state is announced, not merely coloured: every message this
       panel produces -- including every refusal -- goes through one live
       region a screen reader reads without the reader going to look. */
    accessStatusEl.setAttribute("role", "status");
    accessStatusEl.setAttribute("aria-live", "polite");

    accessRetryEl = document.createElement("p");
    accessRetryEl.className = "access-retry";
    accessRetryEl.hidden = true;
    const retryControl = document.createElement("button");
    retryControl.setAttribute("type", "button");
    retryControl.setAttribute("data-archon-access-retry", "");
    retryControl.textContent = ACCESS.retry;
    retryControl.addEventListener("click", loadAccess);
    accessRetryEl.appendChild(retryControl);

    section.append(title, accessEmptyEl, accessListEl, form, accessStatusEl, accessRetryEl);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      addAccessDomain();
    });
    return section;
  }

  function renderAccessList() {
    accessEmptyEl.hidden = accessDomains.length !== 0;
    accessListEl.replaceChildren(
      ...accessDomains.map((domain) => {
        const row = document.createElement("li");
        /* `bdi`, like the collaboration panel's rows: a domain is an isolated
           value inside a sentence of this page's own text, and the isolation is
           what stops one entry from reordering the row around it. */
        const name = document.createElement("bdi");
        name.className = "access-domain";
        name.textContent = domain;

        const remove = document.createElement("button");
        remove.setAttribute("type", "button");
        remove.className = "access-remove";
        remove.setAttribute("data-archon-access-remove", "");
        remove.appendChild(document.createTextNode(ACCESS.remove));
        /* The domain rides in the button's accessible name as *text*, visually
           hidden, so every row's control is distinctly named for a reader who
           hears the controls without the rows -- and so the value still never
           reaches an attribute, an id or a selector. */
        const named = document.createElement("span");
        named.className = "visually-hidden";
        named.textContent = ` ${domain}`;
        remove.appendChild(named);
        remove.addEventListener("click", () => {
          writeAccess(accessDomains.filter((entry) => entry !== domain), null);
        });

        row.append(name, remove);
        return row;
      }),
    );
  }

  /**
   * The `PUT`, carrying the whole list and the session's own token.
   *
   * The same mutation shape sign-out uses: a null token is a refusal here
   * rather than a request sent without the header, because a request the server
   * is certain to refuse is a round trip spent to learn what this page already
   * knows.
   */
  async function putAccess(allowedDomains) {
    if (csrfToken === null) return { outcome: "refused", code: null, message: "" };
    let response;
    try {
      response = await fetch(accessPath(accessDocumentId), {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-archon-csrf": csrfToken,
          accept: "application/json",
        },
        body: JSON.stringify({ v: 1, allowedDomains }),
      });
    } catch {
      return { outcome: "unavailable" };
    }
    if (response.ok) {
      try {
        return { outcome: "ok", body: await response.json() };
      } catch {
        return { outcome: "unavailable" };
      }
    }
    if (response.status === 503) return { outcome: "unavailable" };
    let code = null;
    let message = "";
    try {
      const body = await response.json();
      const error = body === null || typeof body !== "object" ? null : body.error;
      if (error !== null && typeof error === "object" && !Array.isArray(error)) {
        if (typeof error.code === "string") code = error.code;
        if (typeof error.message === "string") message = error.message;
      }
    } catch {
      /* An envelope this page cannot read is a refusal with no reason, which is
         the same thing it renders for the refusals that have one it must not
         repeat. */
    }
    return { outcome: "refused", code, message };
  }

  /**
   * What the owner is told about a refused list, per refusal.
   *
   * `csrf_failed` and `not_found` deliberately fall through to the generic
   * line. Naming them would tell whoever is sitting at a forged request which
   * of the two ways it failed, and neither is something the owner of the
   * document could act on: an owner whose token was rejected has a page to
   * reload, not a list to correct.
   */
  function accessRefusal(result, entered) {
    if (result.code === "public_mailbox_domain" || result.code === "too_many_domains") {
      const message = boundedAccessMessage(result.message);
      return message === null ? ACCESS.failed : message;
    }
    if (result.code === "invalid_domain") {
      return entered === null ? ACCESS.invalid : `${ACCESS.invalid} ${entered}`;
    }
    return ACCESS.failed;
  }

  /**
   * Read the list the document actually has.
   *
   * A failure here leaves the panel with its own retry rather than calling
   * `fail`, for the reason `warn` exists: the document is on the screen, still
   * authorised and still readable, and a reading list that could not be fetched
   * is not a reason to take it away.
   */
  async function loadAccess() {
    if (accessBusy) return;
    setAccessBusy(true);
    sayAccess(ACCESS.loading);
    const result = await getJson(accessPath(accessDocumentId));
    setAccessBusy(false);
    if (result.outcome !== "ok" || !validAccessBody(result.body, accessDocumentId)) {
      sayAccess(ACCESS.loadFailed, "error");
      accessRetryEl.hidden = false;
      return;
    }
    accessRetryEl.hidden = true;
    accessDomains = [...result.body.allowedDomains];
    renderAccessList();
    sayAccess("");
  }

  /**
   * Write a list, and render whatever came back.
   *
   * `entered` is the value the owner typed, or `null` for a removal. It is this
   * page's own input rather than anything a server sent, which is what lets the
   * invalid-domain line name the offending value without taking it from a
   * response -- and it is what stays in the box on a refusal, so the owner can
   * correct a domain rather than retype it.
   */
  async function writeAccess(next, entered) {
    if (accessBusy) return;
    setAccessBusy(true);
    sayAccess(ACCESS.saving);
    const result = await putAccess(next);
    setAccessBusy(false);

    if (result.outcome === "ok") {
      if (!validAccessBody(result.body, accessDocumentId)) {
        sayAccess(MESSAGES.unavailable, "error");
        return;
      }
      accessDomains = [...result.body.allowedDomains];
      renderAccessList();
      if (entered !== null) accessInput.value = "";
      sayAccess(ACCESS.saved);
      return;
    }
    if (result.outcome === "unavailable") {
      sayAccess(MESSAGES.unavailable, "error");
      return;
    }
    sayAccess(accessRefusal(result, entered), "error");
  }

  /**
   * Add whatever is in the box.
   *
   * Trimmed and lowercased, and otherwise sent exactly as typed. This page
   * holds no copy of the public-mailbox list and does not pre-validate against
   * one: the denylist and its site-wide override are the server's, and a second
   * copy here would be a policy that drifts and a refusal the owner could not
   * argue with. An empty box is the one thing refused locally, because there is
   * nothing to send.
   */
  function addAccessDomain() {
    if (accessBusy) return;
    const entered = accessInput.value.trim().toLowerCase();
    if (entered === "") {
      sayAccess(ACCESS.blank, "error");
      accessInput.focus();
      return;
    }
    if (accessDomains.includes(entered)) {
      accessInput.value = "";
      sayAccess(ACCESS.saved);
      return;
    }
    writeAccess([...accessDomains, entered], entered);
  }

  /**
   * Create the panel, once, for an owner.
   *
   * It is created rather than unhidden. The shell carries no panel markup at
   * all, so a reader who is not the owner has nothing to reveal with a
   * stylesheet, a devtools toggle or a `hidden` attribute removed -- and the
   * server refuses their request regardless, which is the half that actually
   * decides.
   */
  function mountAccessPanel(documentId) {
    if (accessEl !== null) return;
    accessDocumentId = documentId;
    accessEl = createAccessPanel();
    statusEl.parentNode.insertBefore(accessEl, statusEl);
    loadAccess();
  }

  /** One attempt at the whole sequence: session, metadata, bytes, handshake. */
  /** Whether an attempt is in flight. A second one would race the first. */
  let loading = false;

  async function load() {
    /* Two quick presses of "Try again" used to start two attempts. The first to
       resolve handed off and the second then overwrote the status line with
       "Preparing the document…" over an already-rendered document, installed a
       second deadline and re-held the whole document in `pending`. One attempt
       at a time; the button says so too. */
    if (loading) return;
    loading = true;
    retryButton.disabled = true;
    try {
      await attempt();
    } finally {
      loading = false;
      retryButton.disabled = false;
    }
  }

  async function attempt() {
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

    /* ACN-009: the owner's panel, and only the owner's. The signal is the
       account on the session compared with the account on the document's own
       metadata -- two values this page has already been given -- rather than
       the access route's answer, which would make a 200 the gate and a 403 a
       probe every reader's browser performs on every load. */
    if (session.body.accountId === metadata.body.ownerAccountId) mountAccessPanel(documentId);

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
      /* The attempt is over, not merely late. Without discarding the bytes and
         the frame, a renderer that finally announced itself after the deadline
         would hand off underneath a live error state: the document would appear
         while the status line still said it had failed and focus still sat on a
         "Try again" button that would then tear the document back down. */
      pending = null;
      readySeen = false;
      frame = null;
      stage.replaceChildren();
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
  /**
   * The readiness message, as `validateReadyMessage` in
   * `netlify/lib/hosted/contracts.mjs` defines it.
   *
   * Exact keys, not "has the two I care about". That module is explicit about
   * why -- a handshake that tolerated extra fields would be a channel from the
   * renderer origin back into this page's decision about what to send -- and an
   * inline check that accepted `{type, v, ...anything}` was the app side of the
   * frozen contract quietly drifting from it. Nothing downstream reads another
   * field today; the point is that the next thing that does would inherit an
   * unvalidated object from across an origin boundary.
   *
   * It is restated rather than imported because `viewer.js` is a committed
   * static asset with no build step and no module graph, the same reason
   * `renderer.js` restates its own half of the contract.
   */
  function isReadyMessage(data) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
    const keys = Object.keys(data);
    if (keys.length !== 2 || !keys.includes("type") || !keys.includes("v")) return false;
    return data.type === READY && data.v === 1;
  }

  /**
   * Decide whether one `message` event is the renderer announcing readiness.
   *
   * Both halves of the sender identity, before the message is looked at.
   * `source` first because it is the stricter of the two: another frame on this
   * page reaches this window with a flawless `event.origin` and the wrong
   * source, which is the one forgery an origin comparison alone cannot see.
   * `origin` second because the converse -- the right window showing a
   * different origin, after a navigation inside the frame -- is what the origin
   * comparison alone can see.
   *
   * It takes the two expectations as arguments rather than closing over `frame`
   * and `renderOrigin` so that it is a pure predicate over an event shape. That
   * is not a decoration: the `frame-src` directive on this page refuses to
   * navigate the renderer frame anywhere but the configured origin, so a
   * conforming browser cannot produce the right-source/wrong-origin event at
   * all, and the guard against it is unreachable from any browser probe. Being
   * pure is what lets `scripts/test-hosted-owner-viewer.mjs` synthesise that
   * event directly and prove the comparison is load-bearing rather than
   * decorative. See the parity table there.
   *
   * @param {MessageEvent} event
   * @param {Window|null} expectedSource
   * @param {string} expectedOrigin
   * @returns {boolean}
   */
  function acceptsReady(event, expectedSource, expectedOrigin) {
    if (expectedSource === null || event.source !== expectedSource) return false;
    if (event.origin !== expectedOrigin) return false;
    return isReadyMessage(event.data);
  }

  window.addEventListener("message", (event) => {
    if (!acceptsReady(event, frame === null ? null : frame.contentWindow, renderOrigin)) return;
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
