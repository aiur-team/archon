/**
 * The isolated static renderer (contract C4).
 *
 * This module is the whole of the renderer's behaviour. It runs on a
 * cookie-free origin on a different registrable site from the account
 * application, it is served as committed static code, and it has exactly one
 * job: take one authorised HTML artifact handed to it by the trusted viewer and
 * put it inside a nested, opaque-origin frame where the artifact's own scripts
 * can run without any authority over the account page.
 *
 * Three properties are the design, and each one is asserted by
 * `scripts/test-hosted-renderer.mjs` against real browsers rather than against
 * a policy string:
 *
 *  1. **Two frames, not one.** The renderer document itself is same-origin with
 *     its own origin, because exact-origin `postMessage` needs a real origin to
 *     compare against. The artifact goes one level deeper, into an iframe with
 *     `sandbox="allow-scripts"` and *without* `allow-same-origin`, so the
 *     artifact document has an opaque origin: no cookie jar, no storage, no
 *     access to this document, and none to the account page two levels up.
 *     Adding `allow-same-origin` there would hand the artifact this origin, and
 *     is the single change that turns the whole design off. It is never a fix
 *     for a content-security-policy failure.
 *  2. **Both halves of "who sent this" are checked.** A message is accepted only
 *     when `event.origin` is exactly the configured application origin *and*
 *     `event.source` is exactly the window this renderer was mounted against.
 *     Either check alone is insufficient, which is why the runner deletes each
 *     one separately and requires a different forged-message case to start
 *     passing: a sibling frame on the account origin can reach this window and
 *     produces the right origin with the wrong source, and a hostile top-level
 *     page that framed this renderer produces the right source with the wrong
 *     origin.
 *  3. **No arbitrary channel exists in either direction.** The public runtime
 *     receives the two message types of C4 and nothing else. There is no RPC,
 *     no resize protocol, no navigation request and no way for the artifact to
 *     cause a fetch: the artifact is one level below a listener that only ever
 *     accepts a message from its own parent, and its policy denies `connect-src`
 *     outright. `v1` rejects an unknown message rather than guessing at it.
 *
 * What this module deliberately does not do is as important. It never learns a
 * document id, a title, an owner, a session or a CSRF token -- the trusted
 * viewer sends bytes and nothing else -- so there is nothing here for a
 * compromised artifact to steal even if it escaped its frame. And nothing here
 * claims that a sandbox makes hostile HTML safe: it removes the artifact's
 * authority over the account origin, it does not stop the artifact from
 * consuming CPU, rendering whatever it likes inside its own box, or navigating
 * itself.
 */

/** C4: the only two message types that cross the app/renderer origin boundary. */
export const RENDER_MESSAGE_TYPES = Object.freeze({
  READY: "archon:ready",
  RENDER: "archon:render",
});

/**
 * C2's artifact byte bounds, restated here rather than imported.
 *
 * `netlify/lib/hosted/contracts.mjs` is the canonical statement of this contract, and
 * this file cannot import it: the renderer is a separate deployment on a
 * separate site with no build step and no dependency tree, and reaching into
 * the application's module graph would be exactly the coupling the two-origin
 * split exists to prevent. So the numbers are restated, and
 * `scripts/test-hosted-renderer.mjs` asserts that this validator and
 * `validateRenderMessage` from `netlify/lib/hosted/contracts.mjs` return the same
 * verdict for every row of a shared table. A drift between the two copies is a
 * test failure rather than a production surprise.
 */
export const HTML_MIN_BYTES = 1;
export const HTML_MAX_BYTES = 2097152;

/** The exact keys an `archon:render` message may carry. Nothing else. */
const RENDER_KEYS = ["type", "v", "html"];

/** C4/C2: the one character the stored bytes may never contain. */
const NUL = "\u0000";

/** The title the nested frame carries for assistive technology. */
export const ARTIFACT_FRAME_TITLE = "Published document content";

/**
 * A rejected message, carrying the wire error code its application-side twin
 * would have used.
 *
 * The codes match `netlify/lib/hosted/contracts.mjs` so that a reader tracing a refusal
 * across the two origins sees one vocabulary rather than two.
 */
export class RenderMessageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RenderMessageError";
    this.code = code;
  }
}

function invalid(field, rule) {
  return new RenderMessageError("invalid_request", `${field} ${rule}`);
}

/** A plain, structured-clone-shaped record -- not an array, not an exotic. */
function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A string with no lone surrogate.
 *
 * `TextEncoder` silently replaces a lone surrogate with U+FFFD, so a byte count
 * taken without this check measures a string nobody sent. The native
 * `isWellFormed` is used when the engine has it and the equivalent property is
 * tested directly otherwise; in a `u`-mode pattern a matched pair is one
 * non-surrogate code point, so `\p{Surrogate}` matches only the lone ones.
 */
const LONE_SURROGATE = /\p{Surrogate}/u;
function isWellFormedString(value) {
  if (typeof value !== "string") return false;
  if (typeof value.isWellFormed === "function") return value.isWellFormed();
  return !LONE_SURROGATE.test(value);
}

/**
 * Validate an `archon:render` message, returning a frozen copy.
 *
 * Shape validation is not the security boundary and must never be mistaken for
 * one: `mountRenderer` checks the sending origin and the sending window before
 * this function is called at all, because a perfectly well-formed message from
 * the wrong window is still an attack. What this adds is the refusal to guess.
 * Unknown keys are rejected rather than ignored, an unknown version is rejected
 * rather than treated as v1, and the byte cap is re-applied on this side of the
 * boundary because C4 requires the renderer not to trust that whoever sent the
 * message already checked.
 *
 * @param {unknown} data the `event.data` of an accepted message
 * @returns {Readonly<{type: string, v: 1, html: string}>}
 * @throws {RenderMessageError} `invalid_request` or `artifact_too_large`
 */
export function validateRenderMessage(data) {
  const field = "renderMessage";
  if (!isPlainRecord(data)) throw invalid(field, "must be an object");

  const keys = Reflect.ownKeys(data);
  if (keys.length !== RENDER_KEYS.length || !RENDER_KEYS.every((key) => keys.includes(key))) {
    throw invalid(field, `must have exactly the keys: ${RENDER_KEYS.join(", ")}`);
  }
  if (data.type !== RENDER_MESSAGE_TYPES.RENDER) {
    throw invalid(`${field}.type`, `must be "${RENDER_MESSAGE_TYPES.RENDER}"`);
  }
  if (data.v !== 1) throw invalid(`${field}.v`, "must be 1");
  if (!isWellFormedString(data.html)) {
    throw invalid(`${field}.html`, "must be a well-formed string");
  }
  if (data.html.includes(NUL)) {
    throw invalid(`${field}.html`, "must not contain a NUL character");
  }

  /* The two bounds carry different codes, matching `netlify/lib/hosted/contracts.mjs`:
     an empty document is a malformed request, and an oversized one is the one
     refusal a sender can act on by sending less. A single code for both would
     tell a client to shrink a document that has no bytes to shrink. */
  const bytes = new TextEncoder().encode(data.html).length;
  if (bytes < HTML_MIN_BYTES) {
    throw invalid(`${field}.html`, `must be at least ${HTML_MIN_BYTES}`);
  }
  if (bytes > HTML_MAX_BYTES) {
    throw new RenderMessageError(
      "artifact_too_large",
      `${field}.html must be at most ${HTML_MAX_BYTES}`,
    );
  }

  return Object.freeze({ type: data.type, v: 1, html: data.html });
}

/**
 * The policy the artifact document runs under, added by the srcdoc itself.
 *
 * It is a *second* policy rather than a replacement. A content-security policy
 * delivered by a `meta` element can only intersect with what the document
 * already inherits, which is what makes this safe to state here and what makes
 * a hostile `meta` element inside the authored HTML harmless: an artifact can
 * tighten its own policy and lose functionality, and it cannot loosen the one
 * this renderer's HTTP response established.
 *
 * The permissions are the smallest set that lets an authored document actually
 * be a document. Inline script and style are allowed because a self-contained
 * artifact is inline by construction, and that allowance is the entire reason
 * the renderer is a separate, cookie-free site -- it is not something the
 * account application's own policy is ever asked to make room for. `data:` and
 * `blob:` images, media and fonts are allowed because a self-contained artifact
 * carries its assets in-line.
 *
 * Everything else is denied, and each denial is load-bearing rather than tidy:
 *
 *  - `connect-src 'none'` is what stops an artifact making a credentialed
 *    request at the account API. The sandbox already denies it cookies, so such
 *    a request would fetch nothing useful; denying the request outright means
 *    there is no attempt to reason about.
 *  - `base-uri 'none'` neutralises a `base` element in the authored HTML, which
 *    would otherwise repoint every relative URL in the document.
 *  - `form-action 'none'` and `object-src 'none'` remove the two classic
 *    exfiltration channels that are neither a fetch nor a subresource.
 *  - `frame-src 'none'` and `child-src 'none'` stop the artifact nesting another
 *    frame, which is the shape a payload uses to get a document with a policy
 *    the author chose.
 *  - The absence of a remote source anywhere means every subresource must be
 *    inline, `data:` or `blob:`. A remote image is a beacon; a remote script is
 *    someone else's code.
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The trusted prelude, as the source text that is placed in the srcdoc.
 *
 * Its only job is fragment-only links. A self-contained document is full of
 * `href="#section"` anchors, and inside an opaque-origin `about:srcdoc`
 * document the browser's own handling of one is not something to rely on: the
 * document has no useful base URL to resolve against, and the navigation that
 * results is at best a no-op and at worst replaces the artifact. So the prelude
 * resolves the target itself.
 *
 * Three constraints shape it, and each is asserted by the runner:
 *
 *  - **It must not stop authored click listeners.** The listener is registered
 *    on `window` in the bubble phase, which is the last node in the propagation
 *    path, so every listener the document registers on the link or on any
 *    ancestor has already run and any `preventDefault` of theirs is visible as
 *    `event.defaultPrevented`. A capture-phase listener would have pre-empted
 *    the document's own behaviour, which is the opposite of the requirement.
 *  - **It must not rewrite the artifact.** The `href` attribute is read and
 *    never written, and the stored bytes are placed in the document unchanged.
 *    An artifact whose script inspects its own links sees exactly what its
 *    author wrote.
 *  - **A missing target is not a navigation.** If the fragment names nothing,
 *    the default action is still suppressed and the artifact simply stays where
 *    it is. Leaving the default in place there is what would let a missing
 *    anchor unload the document.
 *
 * It touches neither the History API nor any window above it. Both are
 * unavailable to an opaque, sandboxed document, and a prelude that needed them
 * would be a prelude that only worked when the isolation was off.
 */
const ARTIFACT_PRELUDE = `(function () {
  "use strict";
  var doc = document;
  function anchorFor(node) {
    for (var current = node; current; current = current.parentNode) {
      if (current.nodeType === 1 && current.localName === "a" && current.hasAttribute("href")) {
        return current;
      }
    }
    return null;
  }
  function targetFor(raw) {
    var decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch (error) { decoded = raw; }
    for (var i = 0; i < 2; i += 1) {
      var name = i === 0 ? decoded : raw;
      var byId = doc.getElementById(name);
      if (byId) return byId;
      var byName = doc.getElementsByName(name);
      if (byName && byName.length > 0) return byName[0];
    }
    return null;
  }
  addEventListener("click", function (event) {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var anchor = anchorFor(event.target);
    if (!anchor) return;
    var href = anchor.getAttribute("href");
    if (typeof href !== "string" || href.charAt(0) !== "#") return;
    event.preventDefault();
    var raw = href.slice(1);
    if (raw === "") {
      scrollTo(0, 0);
      return;
    }
    var target = targetFor(raw);
    if (!target) return;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    try { target.focus({ preventScroll: true }); } catch (error) { /* not focusable */ }
    target.scrollIntoView();
  }, false);
})();`;

/* The prelude is placed inside a `script` element by textual assembly, so a
   closing-tag sequence anywhere in it would end that element early and spill
   the remainder into the document as markup. It is our own source rather than
   anything a user supplied, so this can only fail on an edit to this file --
   which is exactly when it is worth failing, at module load, in every browser
   that serves the renderer. */
if (/<\/script/i.test(ARTIFACT_PRELUDE)) {
  throw new Error("the artifact prelude must not contain a script closing-tag sequence");
}

/**
 * Assemble the srcdoc document for one artifact.
 *
 * The authored HTML is appended as *markup* and never interpolated into a
 * script, a string or an attribute, which is the reason nothing here escapes
 * anything: there is no context in the output where a quote or an angle bracket
 * in the stored bytes could mean something other than what its author wrote.
 * The value is handed to the frame through the `srcdoc` IDL property rather than
 * by building an attribute, so the bytes are never HTML-escaped or re-parsed on
 * the way in either.
 *
 * Order is the security property. The policy and the prelude are emitted before
 * a single byte of authored content, so there is no window in which authored
 * script runs under the inherited policy alone, and no authored element that can
 * arrive before the prelude has claimed the click handler. Everything the
 * authored document says afterwards -- including its own `meta` policy, its own
 * `base`, its own `html` and `head` elements, which the parser merges -- happens
 * under rules that are already in force.
 *
 * @param {string} html the stored artifact bytes, decoded, exactly as stored
 * @returns {string} a complete document for `iframe.srcdoc`
 */
export function buildArtifactSrcdoc(html) {
  if (typeof html !== "string") throw invalid("html", "must be a string");
  return [
    "<!doctype html>",
    '<html lang="">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    `<title>${ARTIFACT_FRAME_TITLE}</title>`,
    `<script>${ARTIFACT_PRELUDE}</script>`,
    "</head>",
    "<body>",
    html,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * A canonical origin, or `null`.
 *
 * The renderer compares origins by exact string equality everywhere, so the one
 * value it is configured with has to be in the one spelling a browser produces.
 * `URL` is asked rather than a pattern: a trailing slash, an upper-case host, a
 * default port written out and a trailing dot all round-trip differently through
 * `URL.origin` than they were written, and each would silently never match.
 */
export function canonicalOrigin(value) {
  if (typeof value !== "string" || value === "") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value) return null;
  if (url.hostname.endsWith(".")) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin;
}

/**
 * The reasons a message was refused, as the runner names them.
 *
 * They are recorded on the document element rather than reported anywhere,
 * because there is nowhere to report them to: the renderer has no backend, and a
 * channel back to the account origin for refusals would be a channel.
 */
export const REJECTION_REASONS = Object.freeze({
  WRONG_WINDOW: "wrong-window",
  WRONG_ORIGIN: "wrong-origin",
  MALFORMED: "malformed",
  ALREADY_RENDERED: "already-rendered",
});

/** The states the renderer document advertises, for the shell's own copy. */
export const RENDERER_STATES = Object.freeze({
  STANDALONE: "standalone",
  WAITING: "waiting",
  RENDERED: "rendered",
  REFUSED: "refused",
});

/**
 * Mount the renderer against one parent window.
 *
 * @param {{
 *   parentWindow: Window | null,
 *   appOrigin: string,
 *   container: Element,
 *   status?: Element | null,
 *   self?: Window,
 * }} options
 * @returns {{state: () => string, rejections: () => string[], dispose: () => void}}
 */
export function mountRenderer({
  parentWindow,
  appOrigin,
  container,
  status = null,
  self: win = globalThis,
}) {
  const origin = canonicalOrigin(appOrigin);
  if (origin === null) {
    throw new Error("mountRenderer requires an exact application origin");
  }
  if (!container || typeof container.replaceChildren !== "function") {
    throw new Error("mountRenderer requires a container element");
  }

  const doc = container.ownerDocument;
  /* A set, not a list. The artifact's `window.parent` is this window, and an
     artifact that runs `for (;;) parent.postMessage(0, "*")` would otherwise
     grow an unbounded array, rejoin it on every message and write the result to
     an attribute -- quadratic work in the tab that is also showing the account
     page, which is a denial of service against the reader rather than against
     this frame. Distinct reasons are all a reader or a test ever needs, and
     there are four of them. */
  const rejections = new Set();
  /* A counter beside the set. The set is what keeps the work bounded -- an
     artifact that floods this window cannot grow it past four entries -- and the
     counter is what keeps a refusal countable, so "every one of fourteen
     malformed messages was refused" is an observable fact rather than an
     inference from a single set entry. Incrementing an integer and writing one
     attribute is constant work per message; the array-and-rejoin it replaces was
     quadratic. */
  let refusals = 0;
  let state = RENDERER_STATES.WAITING;
  let rendered = false;
  let listener = null;
  let published = "";

  const announce = (text) => {
    if (status) status.textContent = text;
  };
  const publish = () => {
    const value = `${state} ${refusals} ${[...rejections].join(" ")}`;
    if (value === published) return;
    published = value;
    const element = doc.documentElement;
    element.setAttribute("data-archon-state", state);
    element.setAttribute("data-archon-rejections", [...rejections].join(" "));
    element.setAttribute("data-archon-refusals", String(refusals));
  };
  /**
   * Record a refusal, and decide whether the reader should be told.
   *
   * Only a message that already passed both the source and the origin check
   * changes what the reader sees. A message from some other window is not a
   * failed document -- it is a browser extension's content script, or another
   * frame on the page, talking to the wrong recipient -- and announcing "this
   * document could not be displayed" for one would put an error in front of a
   * reader whose document is about to arrive and render perfectly.
   */
  const reject = (reason, { visible = false } = {}) => {
    rejections.add(reason);
    refusals += 1;
    if (visible && !rendered) {
      state = RENDERER_STATES.REFUSED;
      announce("This document could not be displayed.");
    }
    publish();
  };

  /* A renderer opened on its own is a public page that nobody handed anything
     to. It says so and stops: it does not post a readiness message to a window
     that is itself, it does not offer to sign anybody in -- this origin has no
     session and never will -- and it leaves the shell's inert explanation in
     place. */
  if (!parentWindow || parentWindow === win) {
    state = RENDERER_STATES.STANDALONE;
    publish();
    return {
      state: () => state,
      rejections: () => [...rejections],
      refusals: () => refusals,
      dispose: () => {},
    };
  }

  listener = (event) => {
    /* Both halves, in this order, before the message is looked at. `source`
       first because it is the cheaper and stricter of the two: exactly one
       window may speak to this renderer, and a sibling frame on the account
       origin -- which reaches this window through `parent.frames` and produces a
       flawless `event.origin` -- is refused here rather than three lines later. */
    if (event.source !== parentWindow) {
      reject(REJECTION_REASONS.WRONG_WINDOW);
      return;
    }
    if (event.origin !== origin) {
      reject(REJECTION_REASONS.WRONG_ORIGIN);
      return;
    }
    /* One artifact per renderer instance. A second document would mean the
       account page could replace what a person is looking at after the fact, and
       the recovery path for a failed render is a fresh renderer rather than a
       second attempt inside a frame whose first occupant may still be running. */
    if (rendered) {
      reject(REJECTION_REASONS.ALREADY_RENDERED);
      return;
    }

    let message;
    try {
      message = validateRenderMessage(event.data);
    } catch {
      /* Refusing without settling: a malformed message is not an artifact, so
         the instance stays open for the real one. Nothing is echoed back --
         a validation detail returned across the boundary would be a channel out
         of the renderer, and the sender already knows what it sent. */
      reject(REJECTION_REASONS.MALFORMED, { visible: true });
      return;
    }

    const frame = doc.createElement("iframe");
    /* `allow-scripts` and nothing else. Every other token is a capability the
       artifact does not get: `allow-same-origin` would give it this origin,
       `allow-top-navigation` the account page's address bar, `allow-popups` a
       window outside the sandbox, `allow-forms` a submission target and
       `allow-downloads` a file on the reader's disk. */
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("title", ARTIFACT_FRAME_TITLE);
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.className = "artifact-frame";
    frame.srcdoc = buildArtifactSrcdoc(message.html);

    container.replaceChildren(frame);
    rendered = true;
    state = RENDERER_STATES.RENDERED;
    announce("");
    publish();
    /* The listener stays. It cannot render again -- `rendered` is the guard, and
       it is checked before the message is even parsed -- and leaving it attached
       keeps a second attempt observable rather than silent, which is what makes
       the "at most one artifact" rule testable from outside. Leaving it attached
       is safe because the refusal log is a set and `publish` writes only on a
       change, so a flooding artifact does bounded work. */
  };

  win.addEventListener("message", listener);
  publish();
  /* Readiness goes to the exact configured origin. A `"*"` target here would
     broadcast the fact that a renderer is waiting to whatever page happened to
     frame it, and would be the first half of a handshake with an attacker. */
  parentWindow.postMessage({ type: RENDER_MESSAGE_TYPES.READY, v: 1 }, origin);

  return {
    state: () => state,
    rejections: () => [...rejections],
    refusals: () => refusals,
    dispose: () => {
      if (listener) win.removeEventListener("message", listener);
      listener = null;
    },
  };
}

/**
 * Mount the shipped shell, once, when this module is loaded by the shipped page.
 *
 * The configuration is a build-generated global rather than an import so that
 * the deployed tree stays three static files and a generated one, with no
 * bundler and no module graph to reason about. A page without the marker root
 * -- a test importing this module to exercise a seam directly, for instance --
 * mounts nothing.
 */
function autoMount() {
  if (typeof document === "undefined") return;
  const container = document.querySelector("[data-archon-artifact-root]");
  if (!container || container.hasAttribute("data-archon-mounted")) return;
  const config = globalThis.__ARCHON_RENDERER_CONFIG__;
  const appOrigin = config && typeof config.appOrigin === "string" ? config.appOrigin : "";
  const status = document.querySelector("[data-archon-status]");
  container.setAttribute("data-archon-mounted", "");

  /* The renderer's URL must carry nothing, and this is where that stops being a
     convention and becomes a rule.

     An `about:srcdoc` document inherits its parent's base URL, so anything in
     this page's query or fragment is readable by the artifact as
     `document.baseURI` -- and `base-uri 'none'` in the artifact's own policy
     means it cannot be neutralised with a trusted `base` element afterwards.
     Today the viewer frames a bare origin and there is nothing to leak. The
     natural next edit on the viewer side is `?doc=<id>` or `#<token>`, and that
     value would go straight to the author of arbitrary uploaded HTML -- exactly
     the thing this module promises never reaches it. Refusing to mount turns an
     invisible future leak into a visibly broken renderer on the first try. */
  if (globalThis.location && (globalThis.location.search !== "" || globalThis.location.hash !== "")) {
    document.documentElement.setAttribute("data-archon-state", "unconfigured");
    if (status) {
      status.textContent = "This renderer address does not accept parameters.";
    }
    return;
  }

  try {
    mountRenderer({
      parentWindow: globalThis.parent,
      appOrigin,
      container,
      status,
    });
  } catch {
    /* A renderer built without a valid application origin has no safe fallback:
       there is no origin to trust, so there is nobody to accept a document from.
       It stays inert and says so, which is the same visible outcome as being
       opened directly. */
    document.documentElement.setAttribute("data-archon-state", "unconfigured");
    if (status) status.textContent = "This renderer is not configured.";
  }
}

autoMount();
