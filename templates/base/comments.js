/* Comments client, read only.
   Waits for the one `session` reveal, then reads a bounded prefix of the
   thread list with same-origin GETs and shows it in a private margin rail and
   side panel.  Every anchored thread is classified as exact, drifted, moved or
   orphaned against the current rendered blocks; the quote is resolved through
   P1-D's published normaliser and painted with the CSS Custom Highlight API so
   no prose node is ever wrapped or moved.  Outside HTTP(S), or without the
   document id, the anchor core, the platform primitives or a session, the
   module returns before touching anything and the static document is
   unchanged.

   P4-A adds the write path on top of that read model: one selection tooltip,
   anchored-comment and unanchored-discussion drafts, per-thread replies, and
   resolve/reopen.  Selection capture is the exact inverse of the text map
   above -- a stable block aid plus a normalised quote, never a DOM path, an
   ordinal, or a range clamped across two blocks.  The session only decides
   what is *shown*; every mutation is still authorised by the server, and one
   401 or 403 retires this page's write controls for good.

   P4-Q publishes the two bounded surfaces a second client may use without
   owning any of this: `window.doc.rail` places one marker per block per kind,
   and `window.doc.panel` rents one empty section inside the existing panel.
   Neither carries a suggestion record, an identity, or any authority -- they
   coordinate presentation and nothing else, and comments.js remains the only
   owner of the rail, the panel, the anchor locator and the highlight
   registries.  P4-Q also orders the first anchor resolution behind P4-B's
   optional overlay barrier and repairs anchors when a later `doc:overlay`
   replaces the contents of a named block.

   Amendment chain: P3-C (this read path) -> P4-A (comment writes) -> P4-Q
   (shared rail/panel publication, Suggestions filter, overlay repair).  The
   public seams are `window.doc.comments.refresh()`, `window.doc.rail` and
   `window.doc.panel`. */

const PROTOCOL = location.protocol;
if (PROTOCOL === "http:" || PROTOCOL === "https:") installComments();

function installComments() {
  const meta = document.querySelector('meta[name="doc-id"]');
  const content = meta === null ? null : meta.getAttribute("content");
  const docId = typeof content === "string" ? content.trim() : "";
  if (docId === "") return;

  const doc = window.doc;
  if (doc === null || typeof doc !== "object") return;
  const anchor = doc.anchor;
  if (anchor === null || typeof anchor !== "object") return;
  if (!Array.isArray(anchor.BLOCK) || typeof anchor.norm !== "function") return;
  const BLOCK = anchor.BLOCK;
  const norm = anchor.norm;

  if (typeof fetch !== "function"
    || typeof AbortController !== "function"
    || typeof CustomEvent !== "function"
    || typeof NodeFilter === "undefined" || NodeFilter === null
    || typeof NodeFilter.SHOW_TEXT !== "number"
    || typeof Range !== "function"
    || typeof requestAnimationFrame !== "function"
    || typeof performance !== "object" || performance === null
    || typeof performance.now !== "function"
    || typeof document.createTreeWalker !== "function") {
    return;
  }

  if (doc.comments !== null && doc.comments !== undefined) return;

  /* P1-B initialises both shared fields to exactly null.  Anything else means
     another owner already published them, and this module returns before any
     UI, listener or request rather than replacing a live surface. */
  if (doc.rail !== null || doc.panel !== null) return;

  /* ------------------------------------------------------------ constants */

  const MAX_PAGES = 5;
  const MAX_THREADS = 500;
  const MAX_COMMENTS = 5000;
  const MAX_THREAD_COMMENTS = 500;
  const PASS_DEADLINE_MS = 5000;
  const WRITE_DEADLINE_MS = 5000;
  const SELECTION_DELAY_MS = 250;
  const REFUSAL_MS = 3000;
  const MAX_BODY = 8000;
  const MAX_TITLE = 200;
  const MAX_EXACT = 1000;
  const CONTEXT_LIMIT = 32;
  const VISIBILITY_WINDOW_MS = 30000;
  const MARKER_STEP = 24;
  const BARRIER_DEADLINE_MS = 5500;
  const OVERLAY_MAX = 50;
  const MAX_RAIL_LABEL = 160;

  const THREAD_ID = /^t_[a-z0-9]{1,48}_[0-9a-f]{8}$/;
  const COMMENT_ID = /^c_[a-z0-9]{1,48}_[0-9a-f]{8}$/;
  const DOC_ID = /^[0-9a-f]{6}$/;
  const SECTION = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
  const DOC_VERSION = /^[0-9a-f]{7}$/;
  const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const SUB = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
  const EMAIL_LOCAL = /^[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/;
  const EMAIL_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const AID = /^a[0-9a-f]{8}$/;

  const THREAD_KEYS = ["v", "id", "docId", "kind", "status", "section", "anchor", "title",
    "docVersion", "createdAt", "author", "resolvedAt", "resolvedBy", "comments"];
  const COMMENT_KEYS = ["id", "body", "author", "createdAt", "editedAt"];
  const ACTOR_KEYS = ["sub", "name", "email"];
  const ANCHOR_KEYS = ["block", "exact", "prefix", "suffix", "start"];
  const PAGE_KEYS = ["threads", "nextCursor"];
  const ENVELOPE_KEYS = ["thread"];
  const SESSION_KEYS = ["sub", "email", "name", "canComment", "canEdit", "doc", "role",
    "shared", "canSuggest", "canAccept", "canShare", "canSeeMembers"];
  const SESSION_FLAGS = ["canComment", "canEdit", "shared", "canSuggest", "canAccept",
    "canShare", "canSeeMembers"];
  const ROLES = ["owner", "editor", "commenter", "viewer", "none"];

  const OPEN_HIGHLIGHT = "doc-comments-open";
  const ACTIVE_HIGHLIGHT = "doc-comments-active";
  const BLOCK_CLASS = "doc-comment-block";
  const BLOCK_ACTIVE_CLASS = "doc-comment-block-active";
  const REFRESH_FAILED = "Comments could not be refreshed.";
  const WRITE_DENIED = "You no longer have permission to change comments.";
  const WRITE_FAILED = "The comment change was not saved.";
  const WRITE_PENDING = "Saving the comment change.";
  const WRITE_SAVED = "The comment change was saved.";
  const MULTI_BLOCK = "Select inside one paragraph";
  const NO_SUGGESTIONS = "Suggestions are unavailable.";
  const MARKER_CLASS = "doc-comment-marker";
  const RAIL_CLASS = Object.freeze({ comment: "doc-rail-comment", suggestion: "doc-rail-suggestion" });
  const EXTENSION_CLASS = "doc-panel-extension";

  const STATE_LABEL = Object.freeze({
    exact: "",
    drifted: "Text changed",
    moved: "Moved from its original block",
    orphaned: "Not attached any more",
  });

  /* ---------------------------------------------------------------- state */

  let activated = false;
  let batch = null;
  let again = false;
  let lastVisibilityRefresh = null;

  /* The last good view: validated threads with their computed locations. */
  let model = [];
  let truncation = null;
  let activeId = null;
  let statusFilter = "open";
  let kindFilter = "all";
  /* The block filter is private to `window.doc.panel.open()`: a validated aid
     or null.  Any kind-filter click clears it. */
  let blockFilter = null;
  /* The block index the last commit resolved against, kept so an overlay can
     recompute `textMap()` for the named blocks only. */
  let blockIndex = null;

  /* Write state.  `writesDenied` is deliberately page-lifetime: a server
     denial is never cleared in place, only by a fresh navigation. */
  let session = null;
  let writesDenied = false;
  let writing = false;
  let draft = null;
  let tooltip = null;
  let tooltipTimer = 0;
  let selectionTimer = 0;

  let toggle = null;
  let rail = null;
  let panel = null;
  let title = null;
  let status = null;
  let truncationNote = null;
  let actions = null;
  let list = null;
  let opener = null;
  let placementFrame = 0;
  const markers = new Map();
  const cards = new Map();
  const decoratedBlocks = new Set();

  /* The one placement registry.  Comment markers are entered here by this
     module; suggestion markers by whoever holds `window.doc.rail`.  The key is
     the opaque token handed back to the caller, so a foreign value can never
     name someone else's entry. */
  const railEntries = new Map();
  let railSeq = 0;

  /* The single registered panel extension renderer, and the section it last
     rendered into.  `rendering` is true only while the renderer is on the
     stack, so a repaint it asks for from inside itself is refused rather than
     recursed. */
  let extensionRenderer = null;
  let extension = null;
  let rendering = false;

  /* The initial-read barrier and the overlay reconciliation queue. */
  let readiness = null;
  let overlayBatch = null;
  let overlayNext = null;
  let overlayScheduled = false;
  let selectKind = null;

  /* --------------------------------------------------------- validation */

  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  function isPlain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  }

  function exactKeys(value, keys) {
    if (!isPlain(value)) return false;
    const own = Object.keys(value);
    if (own.length !== keys.length) return false;
    for (const key of keys) if (!hasOwn(value, key)) return false;
    return true;
  }

  function validTimestamp(value) {
    if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
    const time = new Date(value).getTime();
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }

  function validEmail(value) {
    if (typeof value !== "string") return false;
    if (value === "") return true;
    if (value.length > 254) return false;
    const at = value.indexOf("@");
    if (at === -1 || value.indexOf("@", at + 1) !== -1) return false;
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    if (local.length > 64 || !EMAIL_LOCAL.test(local)) return false;
    const labels = domain.split(".");
    if (labels.length < 2) return false;
    for (const label of labels) if (!EMAIL_LABEL.test(label)) return false;
    return true;
  }

  function validActor(value) {
    if (!exactKeys(value, ACTOR_KEYS)) return false;
    if (typeof value.sub !== "string" || !SUB.test(value.sub)) return false;
    if (typeof value.name !== "string" || value.name.length > 200) return false;
    return validEmail(value.email);
  }

  function sameActor(a, b) {
    return a.sub === b.sub && a.name === b.name && a.email === b.email;
  }

  /* Only non-whitespace code units separated by single spaces; one boundary
     space on either side is allowed because a context slice may end on it. */
  function validContext(value) {
    if (typeof value !== "string" || value.length > 32) return false;
    let previousSpace = false;
    for (let i = 0; i < value.length; i += 1) {
      const unit = value[i];
      if (norm(unit) === "") {
        if (unit !== " " || previousSpace) return false;
        previousSpace = true;
      } else {
        previousSpace = false;
      }
    }
    return true;
  }

  function validAnchor(value) {
    if (!exactKeys(value, ANCHOR_KEYS)) return false;
    if (typeof value.block !== "string" || !AID.test(value.block)) return false;
    if (typeof value.exact !== "string" || value.exact.length === 0 || value.exact.length > 1000) return false;
    if (norm(value.exact) !== value.exact) return false;
    if (!validContext(value.prefix) || !validContext(value.suffix)) return false;
    return Number.isSafeInteger(value.start) && value.start >= 0;
  }

  function validComment(value, seen) {
    if (!exactKeys(value, COMMENT_KEYS)) return false;
    if (typeof value.id !== "string" || !COMMENT_ID.test(value.id) || seen.has(value.id)) return false;
    seen.add(value.id);
    if (typeof value.body !== "string" || value.body.length === 0 || value.body.length > 8000) return false;
    if (value.body.trim().length === 0) return false;
    if (!validActor(value.author)) return false;
    if (!validTimestamp(value.createdAt)) return false;
    return value.editedAt === null || validTimestamp(value.editedAt);
  }

  function validThread(value) {
    if (!exactKeys(value, THREAD_KEYS)) return false;
    if (value.v !== 1) return false;
    if (typeof value.id !== "string" || !THREAD_ID.test(value.id)) return false;
    if (typeof value.docId !== "string" || !DOC_ID.test(value.docId) || value.docId !== docId) return false;
    if (value.kind !== "comment" && value.kind !== "discussion") return false;
    if (value.status !== "open" && value.status !== "resolved") return false;
    if (typeof value.section !== "string" || value.section.length > 64 || !SECTION.test(value.section)) return false;
    if (typeof value.docVersion !== "string" || !DOC_VERSION.test(value.docVersion)) return false;
    if (!validTimestamp(value.createdAt)) return false;
    if (!validActor(value.author)) return false;

    if (value.status === "open") {
      if (value.resolvedAt !== null || value.resolvedBy !== null) return false;
    } else if (!validTimestamp(value.resolvedAt) || !validActor(value.resolvedBy)) {
      return false;
    }

    if (value.kind === "comment") {
      if (value.title !== null || !validAnchor(value.anchor)) return false;
    } else {
      if (value.anchor !== null) return false;
      if (typeof value.title !== "string" || value.title.length > 200 || value.title.trim().length === 0) return false;
    }

    const comments = value.comments;
    if (!Array.isArray(comments) || comments.length === 0 || comments.length > MAX_THREAD_COMMENTS) return false;
    const seen = new Set();
    for (let i = 0; i < comments.length; i += 1) {
      if (!validComment(comments[i], seen)) return false;
    }
    const first = comments[0];
    if (!sameActor(first.author, value.author) || first.createdAt !== value.createdAt) return false;
    return true;
  }

  /* ----------------------------------------------------- text mapping */

  function opaque(node, root) {
    let parent = node.parentNode;
    while (parent !== null && parent !== root) {
      const name = parent.localName;
      if (name === "script" || name === "style") return true;
      parent = parent.parentNode;
    }
    return false;
  }

  /* One span per UTF-16 code unit of the normalised text; a collapsed
     whitespace run maps to the whole source run, across text nodes. */
  function textMap(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = "";
    const spans = [];
    let started = false;
    let pending = null;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (opaque(node, root)) continue;
      const data = node.data;
      for (let offset = 0; offset < data.length; offset += 1) {
        const unit = data[offset];
        if (norm(unit) === "") {
          if (!started) continue;
          if (pending === null) pending = { startNode: node, startOffset: offset, endNode: node, endOffset: offset + 1 };
          else {
            pending.endNode = node;
            pending.endOffset = offset + 1;
          }
          continue;
        }
        if (pending !== null) {
          text += " ";
          spans.push(pending);
          pending = null;
        }
        started = true;
        text += unit;
        spans.push({ startNode: node, startOffset: offset, endNode: node, endOffset: offset + 1 });
      }
    }
    return { text, spans };
  }

  function rangeFor(map, start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    if (start < 0 || start >= end || end > map.text.length) return null;
    const first = map.spans[start];
    const last = map.spans[end - 1];
    if (first === undefined || last === undefined) return null;
    try {
      const range = new Range();
      range.setStart(first.startNode, first.startOffset);
      range.setEnd(last.endNode, last.endOffset);
      return range;
    } catch (error) {
      return null;
    }
  }

  /* ------------------------------------------------------ quote scoring */

  function commonPrefix(a, b) {
    const limit = Math.min(a.length, b.length);
    let count = 0;
    while (count < limit && a[count] === b[count]) count += 1;
    return count;
  }

  function commonSuffix(a, b) {
    const limit = Math.min(a.length, b.length);
    let count = 0;
    while (count < limit && a[a.length - 1 - count] === b[b.length - 1 - count]) count += 1;
    return count;
  }

  function findQuote(text, quote) {
    const exact = quote.exact;
    if (exact.length === 0) return -1;
    let best = -1;
    let bestScore = -Infinity;
    let from = 0;
    for (;;) {
      const i = text.indexOf(exact, from);
      if (i === -1) break;
      const before = text.slice(Math.max(0, i - quote.prefix.length), i);
      const after = text.slice(i + exact.length, i + exact.length + quote.suffix.length);
      const context = commonSuffix(before, quote.prefix) + commonPrefix(after, quote.suffix);
      const distancePenalty = Math.min(Math.abs(i - quote.start), text.length) / (text.length + 1);
      const score = context - distancePenalty;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
      from = i + 1;
    }
    return best;
  }

  /* Every rendered block by aid; a duplicate or out-of-policy element aborts
     the commit because choosing between candidates would misattach threads.

     `previous` and `named` are the overlay path: an accepted `doc:overlay`
     replaced the children of the named blocks only, so every other block that
     is still the same element keeps the text map it already had and only the
     named ones are walked again. */
  function buildBlockIndex(previous, named) {
    const index = new Map();
    const elements = document.querySelectorAll("[data-aid]");
    for (let order = 0; order < elements.length; order += 1) {
      const element = elements[order];
      if (!BLOCK.includes(element.localName)) return null;
      const id = element.getAttribute("data-aid");
      if (id === null || !AID.test(id) || index.has(id)) return null;
      let map = null;
      if (previous !== undefined && previous !== null && !named.has(id)) {
        const before = previous.get(id);
        if (before !== undefined && before.element === element) map = before.map;
      }
      index.set(id, { element, order, map: map === null ? textMap(element) : map });
    }
    return index;
  }

  function locate(quote, index) {
    const home = index.get(quote.block);
    if (home !== undefined) {
      const hit = findQuote(home.map.text, quote);
      const range = hit === -1 ? null : rangeFor(home.map, hit, hit + quote.exact.length);
      if (range === null) return { state: "drifted", element: home.element, range: null, order: home.order };
      return { state: "exact", element: home.element, range, order: home.order };
    }
    let found = null;
    let count = 0;
    for (const entry of index.values()) {
      const hit = findQuote(entry.map.text, quote);
      if (hit === -1) continue;
      count += 1;
      if (count > 1) break;
      found = { entry, hit };
    }
    if (count === 1) {
      const range = rangeFor(found.entry.map, found.hit, found.hit + quote.exact.length);
      if (range !== null) return { state: "moved", element: found.entry.element, range, order: found.entry.order };
    }
    return { state: "orphaned", element: null, range: null, order: Infinity };
  }

  /* --------------------------------------------------------- transport */

  function teardown() {
    activated = false;
    again = false;
    window.removeEventListener("resize", schedulePlacement);
    window.removeEventListener("hashchange", schedulePlacement);
    window.removeEventListener("resize", removeTooltip);
    document.removeEventListener("toggle", schedulePlacement, true);
    document.removeEventListener("visibilitychange", visibilityRefresh);
    document.removeEventListener("mouseup", selectionSettled);
    document.removeEventListener("selectionchange", selectionChanged);
    document.removeEventListener("keydown", writeKeydown, true);
    document.removeEventListener("scroll", removeTooltip, true);
    document.removeEventListener("doc:overlay", onOverlay);
    clearSelectionTimer();
    removeTooltip();
    detachDraft();
    writing = false;
    clearDecoration();
    if (toggle !== null && toggle.parentNode !== null) toggle.parentNode.removeChild(toggle);
    if (rail !== null && rail.parentNode !== null) rail.parentNode.removeChild(rail);
    if (panel !== null && panel.parentNode !== null) panel.parentNode.removeChild(panel);
    toggle = null;
    rail = null;
    panel = null;
    title = null;
    status = null;
    truncationNote = null;
    actions = null;
    list = null;
    opener = null;
    /* Every token this controller ever issued dies with the rail, including
       the ones a suggestion client is still holding. */
    railEntries.clear();
    markers.clear();
    cards.clear();
    extension = null;
    selectKind = null;
    blockFilter = null;
    blockIndex = null;
    overlayBatch = null;
    overlayNext = null;
    model = [];
    truncation = null;
    activeId = null;
  }

  /* Consume one already-parsed page into the retained prefix.  Returns
     `false` for a malformed used/boundary value, or the page verdict. */
  function consumePage(page, priorCursor, retained, seenIds, totals) {
    if (!exactKeys(page, PAGE_KEYS)) return false;
    const threads = page.threads;
    const nextCursor = page.nextCursor;
    if (!Array.isArray(threads) || threads.length > 100) return false;
    if (nextCursor !== null && (typeof nextCursor !== "string" || !THREAD_ID.test(nextCursor))) return false;
    if (threads.length === 0) return nextCursor === null ? { next: null, stop: false } : false;
    if (nextCursor !== null) {
      const final = threads[threads.length - 1];
      if (final === null || typeof final !== "object") return false;
      if (!hasOwn(final, "id")) return false;
      const finalId = final.id;
      if (typeof finalId !== "string" || !THREAD_ID.test(finalId) || finalId !== nextCursor) return false;
    }

    let previous = priorCursor;
    for (let i = 0; i < threads.length; i += 1) {
      if (totals.comments >= MAX_COMMENTS) return { next: null, stop: true };
      const thread = threads[i];
      if (!validThread(thread)) return false;
      if (previous !== null && !(thread.id > previous)) return false;
      if (seenIds.has(thread.id)) return false;
      previous = thread.id;
      if (totals.comments + thread.comments.length > MAX_COMMENTS) return { next: null, stop: true };
      seenIds.add(thread.id);
      retained.push(thread);
      totals.comments += thread.comments.length;
      const more = i + 1 < threads.length || nextCursor !== null;
      if (more && (retained.length >= MAX_THREADS || totals.comments >= MAX_COMMENTS)) {
        return { next: null, stop: true };
      }
    }
    return { next: nextCursor, stop: false };
  }

  async function runPass() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PASS_DEADLINE_MS);
    try {
      const retained = [];
      const seenIds = new Set();
      const totals = { comments: 0 };
      let cursor = null;
      let truncated = false;
      for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
        const endpoint = new URL("/api/threads", location.href);
        endpoint.searchParams.set("doc", docId);
        endpoint.searchParams.set("limit", "100");
        if (cursor !== null) endpoint.searchParams.set("cursor", cursor);
        const response = await fetch(endpoint, {
          method: "GET",
          mode: "same-origin",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          teardown();
          return false;
        }
        if (response.status !== 200) return false;
        const page = await response.json();
        const verdict = consumePage(page, cursor, retained, seenIds, totals);
        if (verdict === false) return false;
        if (verdict.stop) {
          truncated = true;
          break;
        }
        if (verdict.next === null) break;
        cursor = verdict.next;
        if (pageNumber === MAX_PAGES - 1) truncated = true;
      }
      if (!activated) return false;
      return commit(retained, totals.comments, truncated);
    } catch (error) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /* One pass; a failure after a prior good view keeps that view and says so. */
  async function pass() {
    const committed = await runPass();
    if (!committed && activated && panel !== null) setStatus(REFRESH_FAILED);
    return committed;
  }

  async function runBatch() {
    let committed = await pass();
    if (again && activated) {
      again = false;
      if (await pass()) committed = true;
    }
    return committed;
  }

  /* The public seam.  Before the initial overlay barrier settles every caller
     joins the same readiness Promise instead of resolving anchors against
     text that is about to be replaced. */
  function refresh() {
    if (!activated) return Promise.resolve(false);
    if (readiness !== null) return readiness;
    return startRefresh();
  }

  function startRefresh() {
    if (!activated) return Promise.resolve(false);
    if (batch !== null) {
      again = true;
      return batch;
    }
    batch = runBatch().then((result) => {
      batch = null;
      if (again) {
        again = false;
        queueMicrotask(() => { refresh(); });
      }
      return result;
    }, () => {
      batch = null;
      return false;
    });
    return batch;
  }

  /* ---------------------------------------------------------- commit */

  function commit(threads, commentCount, truncated) {
    const index = buildBlockIndex();
    if (index === null) return false;
    if (panel === null && document.querySelector(".head-top") === null) return false;
    blockIndex = index;
    const next = threads.map((thread) => ({
      thread,
      location: thread.kind === "comment" ? locate(thread.anchor, index) : null,
    }));
    model = next;
    truncation = truncated ? { threads: threads.length, comments: commentCount } : null;
    if (activeId !== null && !model.some((entry) => entry.thread.id === activeId)) activeId = null;
    if (panel === null && !createUI()) return false;
    render();
    setStatus(`${threads.length} ${threads.length === 1 ? "thread" : "threads"} loaded.`);
    return true;
  }

  /* -------------------------------------------------------- DOM helpers */

  function el(name, attributes, text) {
    const node = document.createElement(name);
    if (attributes !== undefined) {
      for (const key of Object.keys(attributes)) node.setAttribute(key, attributes[key]);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function timeNode(value) {
    return el("time", { datetime: value }, `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`);
  }

  /* Once writes are denied that announcement is the only one this panel
     makes, so a later refresh cannot talk over it. */
  function setStatus(text) {
    if (status === null) return;
    if (writesDenied && text !== WRITE_DENIED) return;
    status.textContent = text;
  }

  function openCount() {
    let count = 0;
    for (const entry of model) if (entry.thread.status === "open") count += 1;
    return count;
  }

  function byCreated(a, b) {
    if (a.thread.createdAt !== b.thread.createdAt) return a.thread.createdAt < b.thread.createdAt ? -1 : 1;
    return a.thread.id < b.thread.id ? -1 : a.thread.id > b.thread.id ? 1 : 0;
  }

  function byLocation(a, b) {
    if (a.location.order !== b.location.order) return a.location.order - b.location.order;
    return byCreated(a, b);
  }

  const isLive = (entry) => entry.location !== null && entry.location.state !== "orphaned";
  const isOpenLive = (entry) => isLive(entry) && entry.thread.status === "open";

  /* ------------------------------------------------------------- UI */

  function createUI() {
    const head = document.querySelector(".head-top");
    if (head === null) return false;

    toggle = el("button", {
      type: "button",
      id: "doc-comments-toggle",
      "aria-controls": "doc-comments-panel",
      "aria-expanded": "false",
    }, "Comments");
    toggle.addEventListener("click", () => {
      if (panel.hidden) openPanel(toggle, null);
      else closePanel();
    });
    const share = head.querySelector(":scope > .share-btn");
    if (share !== null) head.insertBefore(toggle, share);
    else head.appendChild(toggle);

    /* P4-Q: the rail carries both kinds now, so the group a screen reader
       lands in has to say so. */
    rail = el("div", { id: "doc-comments-rail", "aria-label": "Comment and suggestion locations" });
    document.body.appendChild(rail);

    panel = el("aside", { id: "doc-comments-panel", "aria-labelledby": "doc-comments-title" });
    panel.hidden = true;
    const header = el("header");
    title = el("h2", { id: "doc-comments-title", tabindex: "-1" }, "Comments");
    const close = el("button", { type: "button", id: "doc-comments-close" }, "Close comments");
    close.addEventListener("click", closePanel);
    header.appendChild(title);
    header.appendChild(close);
    status = el("div", { id: "doc-comments-status", role: "status", "aria-live": "polite" });
    truncationNote = el("p", { id: "doc-comments-truncation" });
    truncationNote.hidden = true;
    actions = el("div", { id: "doc-comments-actions" });
    const filters = el("div", { id: "doc-comments-filters" });
    filters.appendChild(filterGroup("Status",
      [["open", "Open"], ["resolved", "Resolved"], ["all", "All"]],
      statusFilter, (value) => { statusFilter = value; }, null).group);
    /* Choosing a kind is the reader taking the panel back from whatever
       `open(aid)` narrowed it to, so the block filter clears with it. */
    const kindGroup = filterGroup("Kind",
      [["anchored", "Anchored"], ["discussions", "Discussions"], ["suggestions", "Suggestions"], ["all", "All"]],
      kindFilter, (value) => { kindFilter = value; blockFilter = null; }, renderExtension);
    filters.appendChild(kindGroup.group);
    selectKind = kindGroup.select;
    list = el("div", { id: "doc-comments-list" });
    panel.appendChild(header);
    panel.appendChild(status);
    panel.appendChild(truncationNote);
    panel.appendChild(actions);
    panel.appendChild(filters);
    panel.appendChild(list);
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) {
        event.preventDefault();
        closePanel();
      }
    });
    document.body.appendChild(panel);

    window.addEventListener("resize", schedulePlacement);
    window.addEventListener("hashchange", schedulePlacement);
    window.addEventListener("resize", removeTooltip);
    document.addEventListener("toggle", schedulePlacement, true);
    document.addEventListener("mouseup", selectionSettled);
    document.addEventListener("selectionchange", selectionChanged);
    document.addEventListener("keydown", writeKeydown, true);
    document.addEventListener("scroll", removeTooltip, true);
    document.addEventListener("doc:overlay", onOverlay);
    const fonts = document.fonts;
    if (fonts !== null && typeof fonts === "object" && fonts.ready !== null
      && typeof fonts.ready === "object" && typeof fonts.ready.then === "function") {
      fonts.ready.then(schedulePlacement, () => {});
    }
    return true;
  }

  /* `select` sets the pressed state without running `onSelect`, so a
     programmatic view change such as `window.doc.panel.open()` shows the same
     controls a click would have. */
  function filterGroup(label, options, selected, onSelect, after) {
    const group = el("div", { role: "group", "aria-label": label });
    const buttons = [];
    const select = (value) => {
      for (const [other, candidate] of buttons) candidate.setAttribute("aria-pressed", other === value ? "true" : "false");
    };
    for (const [value, text] of options) {
      const button = el("button", { type: "button", "aria-pressed": selected === value ? "true" : "false" }, text);
      button.addEventListener("click", () => {
        onSelect(value);
        select(value);
        applyFilters();
        if (after !== null) after();
      });
      buttons.push([value, button]);
      group.appendChild(button);
    }
    return { group, select };
  }

  function openPanel(invoker, threadId) {
    opener = invoker;
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    if (threadId !== null) {
      setActiveThread(threadId);
      paintDecoration();
      focusCard(threadId);
    } else {
      title.focus();
    }
    schedulePlacement();
  }

  /* Focus a thread heading; a card hidden by the current filters cannot take
     focus, so the panel heading is the fallback rather than the body. */
  function focusCard(threadId) {
    const card = cards.get(threadId);
    if (card !== undefined) card.heading.focus();
    if (card === undefined || document.activeElement !== card.heading) title.focus();
  }

  function rendered(element) {
    return element !== null && element.isConnected && !element.hidden && element.getClientRects().length > 0;
  }

  function closePanel() {
    if (panel === null || panel.hidden) return;
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    setActiveThread(null);
    paintDecoration();
    const target = rendered(opener) ? opener : toggle;
    opener = null;
    target.focus();
    schedulePlacement();
  }

  function selectThread(threadId) {
    setActiveThread(threadId);
    paintDecoration();
    schedulePlacement();
  }

  function setActiveThread(threadId) {
    const previous = cards.get(activeId);
    const next = cards.get(threadId);
    activeId = threadId;
    if (previous !== undefined && previous !== next) {
      previous.article.classList.remove("doc-comments-card-active");
      previous.article.removeAttribute("aria-current");
    }
    if (next !== undefined) {
      next.article.classList.add("doc-comments-card-active");
      next.article.setAttribute("aria-current", "true");
    }
  }

  /* --------------------------------------------------------- render */

  function render() {
    toggle.textContent = `Comments (${openCount()})`;
    renderActions();
    if (truncation === null) {
      truncationNote.hidden = true;
      truncationNote.textContent = "";
    } else {
      truncationNote.textContent = `Showing a partial view: ${truncation.threads} threads and ${truncation.comments} messages loaded; additional results may be available.`;
      truncationNote.hidden = false;
    }
    const active = document.activeElement;
    const focusedMarker = active !== null && rail.contains(active) ? active.getAttribute("data-thread-id") : null;
    renderMarkers();
    paintDecoration();
    renderList();
    if (focusedMarker !== null) {
      const replacement = markerButton(focusedMarker);
      if (replacement !== null) replacement.focus();
      if (replacement === null || document.activeElement !== replacement) toggle.focus();
    }
    schedulePlacement();
  }

  function stateSuffix(state) {
    if (state === "drifted") return ", text changed";
    if (state === "moved") return ", moved from its original block";
    return "";
  }

  /* Comment markers go through the same private registry a suggestion client
     reaches over `window.doc.rail`, so one placement pass declutters both
     kinds.  A repaint replaces only this module's own entries; a suggestion
     marker survives a comment refresh untouched. */
  function renderMarkers() {
    for (const token of markers.values()) railDrop(token);
    markers.clear();
    for (const entry of model) {
      if (!isOpenLive(entry)) continue;
      const count = entry.thread.comments.length;
      const label = `Comment by ${entry.thread.author.name}, ${count} ${count === 1 ? "message" : "messages"}${stateSuffix(entry.location.state)}`;
      let marker = null;
      const token = railRegister("comment", entryAid(entry), String(count), label, () => {
        if (marker === null) return;
        if (panel.hidden) openPanel(marker, entry.thread.id);
        else {
          opener = marker;
          selectThread(entry.thread.id);
          focusCard(entry.thread.id);
        }
      });
      if (token === null) continue;
      const record = railEntries.get(token);
      marker = record.button;
      record.entry = entry;
      marker.setAttribute("data-thread-id", entry.thread.id);
      markers.set(entry.thread.id, token);
    }
  }

  /* The rail focus restore in `render()` wants the button, not the token. */
  function markerButton(threadId) {
    const token = markers.get(threadId);
    if (token === undefined) return null;
    const record = railEntries.get(token);
    return record === undefined ? null : record.button;
  }

  /* Where a thread currently sits, which is where its marker is drawn.  A
     moved thread belongs to the block it landed in, not the one it was
     written against, so `open(aid)` shows exactly what that block's markers
     promised. */
  function entryAid(entry) {
    if (entry.location === null || entry.location.element === null) return null;
    return entry.location.element.getAttribute("data-aid");
  }

  function passesFilters(entry) {
    const thread = entry.thread;
    if (kindFilter === "suggestions") return false;
    if (blockFilter !== null && entryAid(entry) !== blockFilter) return false;
    if (statusFilter !== "all" && thread.status !== statusFilter) return false;
    if (kindFilter === "anchored" && thread.kind !== "comment") return false;
    if (kindFilter === "discussions" && thread.kind !== "discussion") return false;
    return true;
  }

  function renderList() {
    if (list === null) return;
    let focusedThread = null;
    let focusedInList = false;
    const active = document.activeElement;
    if (active !== null && list.contains(active)) {
      focusedInList = true;
      const article = active.closest("article");
      if (article !== null) focusedThread = article.getAttribute("data-thread-id");
    }

    cards.clear();
    const live = [];
    const orphans = [];
    const discussions = [];
    for (const entry of model) {
      if (entry.location === null) discussions.push(entry);
      else if (entry.location.state === "orphaned") orphans.push(entry);
      else live.push(entry);
    }
    live.sort(byLocation);
    orphans.sort(byCreated);
    discussions.sort(byCreated);

    const fragment = document.createDocumentFragment();
    if (live.length > 0) fragment.appendChild(group("Comments in the document", live));
    if (orphans.length > 0) fragment.appendChild(group(STATE_LABEL.orphaned, orphans));
    if (discussions.length > 0) fragment.appendChild(group("Discussions", discussions));
    fragment.appendChild(el("p", { class: "doc-comments-empty" }, "No comments match the current filters."));
    list.replaceChildren(fragment);
    applyFilters();
    renderExtension();

    if (focusedInList) {
      if (focusedThread === null) title.focus();
      else focusCard(focusedThread);
    }
  }

  /* Filters hide cards in place; every retained thread keeps its card and no
     stored thread changes. */
  function applyFilters() {
    if (list === null) return;
    let shown = 0;
    for (const section of list.querySelectorAll(".doc-comments-group")) {
      let visible = 0;
      for (const item of section.querySelectorAll(":scope > ul > li")) {
        const article = item.firstElementChild;
        const entry = article === null ? undefined : cards.get(article.getAttribute("data-thread-id"));
        const pass = entry !== undefined && passesFilters(entry.entry);
        item.hidden = !pass;
        if (pass) visible += 1;
      }
      section.hidden = visible === 0;
      shown += visible;
    }
    /* The Suggestions view is not a filtered comment list, so it does not
       claim that no comment matched. */
    const empty = list.querySelector(".doc-comments-empty");
    if (empty !== null) empty.hidden = shown > 0 || kindFilter === "suggestions";
  }

  function group(heading, entries) {
    const section = el("section", { class: "doc-comments-group" });
    section.appendChild(el("h3", undefined, heading));
    const items = el("ul");
    for (const entry of entries) items.appendChild(card(entry));
    section.appendChild(items);
    return section;
  }

  function card(entry) {
    const thread = entry.thread;
    const item = el("li");
    const article = el("article", { class: "doc-comments-card" });
    article.setAttribute("data-thread-id", thread.id);
    if (thread.id === activeId) {
      article.classList.add("doc-comments-card-active");
      article.setAttribute("aria-current", "true");
    }
    const heading = el("h4", { tabindex: "-1" }, thread.kind === "discussion" ? thread.title : `Comment by ${thread.author.name}`);
    article.appendChild(heading);

    const meta = el("p", { class: "doc-comments-meta" });
    meta.appendChild(el("span", { class: "doc-comments-status-label" }, thread.status === "open" ? "Open" : "Resolved"));
    meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(timeNode(thread.createdAt));
    if (thread.status === "resolved") {
      meta.appendChild(document.createTextNode(` · Resolved by ${thread.resolvedBy.name} `));
      meta.appendChild(timeNode(thread.resolvedAt));
    }
    article.appendChild(meta);

    if (entry.location !== null) {
      const state = entry.location.state;
      if (state !== "exact") article.appendChild(el("p", { class: "doc-comments-state" }, STATE_LABEL[state]));
      if (state === "drifted" || state === "orphaned") article.appendChild(el("blockquote", undefined, thread.anchor.exact));
    }

    const messages = el("ol", { class: "doc-comments-messages" });
    for (const comment of thread.comments) {
      const message = el("li", { tabindex: "-1" });
      const line = el("p", { class: "doc-comments-byline" });
      line.appendChild(el("span", { class: "doc-comments-author" }, comment.author.name));
      line.appendChild(document.createTextNode(" "));
      line.appendChild(timeNode(comment.createdAt));
      if (comment.editedAt !== null) {
        line.appendChild(document.createTextNode(" "));
        line.appendChild(el("span", { class: "doc-comments-edited" }, "edited"));
      }
      message.appendChild(line);
      message.appendChild(el("p", { class: "doc-comments-body" }, comment.body));
      messages.appendChild(message);
    }
    article.appendChild(messages);

    if (isLive(entry)) {
      const show = el("button", { type: "button", class: "doc-comments-show" }, "Show in document");
      show.addEventListener("click", () => showInDocument(entry));
      article.appendChild(show);
    }
    if (mayControl(thread)) article.appendChild(statusButton(entry, article));
    if (mayComment()) article.appendChild(replyForm(entry, article));
    item.appendChild(article);
    cards.set(thread.id, { article, heading, entry });
    return item;
  }

  function showInDocument(entry) {
    const host = entry.location.element;
    let details = host.closest("details");
    while (details !== null) {
      details.open = true;
      details = details.parentElement === null ? null : details.parentElement.closest("details");
    }
    selectThread(entry.thread.id);
    host.scrollIntoView({ block: "center", behavior: "auto" });
  }

  /* ----------------------------------------------------- decoration */

  function highlightRegistry() {
    if (typeof Highlight !== "function") return null;
    const css = window.CSS;
    if (css === null || typeof css !== "object") return null;
    const registry = css.highlights;
    if (registry === null || typeof registry !== "object") return null;
    if (typeof registry.set !== "function" || typeof registry.delete !== "function") return null;
    return registry;
  }

  function clearDecoration() {
    const registry = highlightRegistry();
    if (registry !== null) {
      registry.delete(OPEN_HIGHLIGHT);
      registry.delete(ACTIVE_HIGHLIGHT);
    }
    for (const block of decoratedBlocks) block.classList.remove(BLOCK_CLASS, BLOCK_ACTIVE_CLASS);
    decoratedBlocks.clear();
  }

  function paintDecoration() {
    clearDecoration();
    const registry = highlightRegistry();
    if (registry !== null) {
      const open = [];
      const active = [];
      for (const entry of model) {
        if (!isOpenLive(entry) || entry.location.range === null) continue;
        (entry.thread.id === activeId ? active : open).push(entry.location.range);
      }
      registry.set(OPEN_HIGHLIGHT, new Highlight(...open));
      registry.set(ACTIVE_HIGHLIGHT, new Highlight(...active));
      return;
    }
    for (const entry of model) {
      if (!isOpenLive(entry)) continue;
      const block = entry.location.element;
      block.classList.add(BLOCK_CLASS);
      if (entry.thread.id === activeId) block.classList.add(BLOCK_ACTIVE_CLASS);
      decoratedBlocks.add(block);
    }
  }

  /* ------------------------------------------------------- placement */

  function schedulePlacement() {
    if (placementFrame !== 0) return;
    placementFrame = requestAnimationFrame(() => {
      placementFrame = 0;
      placeMarkers();
    });
  }

  function disclosed(element) {
    let details = element.closest("details");
    while (details !== null) {
      if (!details.open) return false;
      details = details.parentElement === null ? null : details.parentElement.closest("details");
    }
    return true;
  }

  /* Every currently rendered block by aid, elements only.  A suggestion marker
     names a block it does not own, so the aid has to resolve to exactly one
     connected block at placement time or the marker is simply not drawn. */
  function blockElements() {
    const found = new Map();
    const elements = document.querySelectorAll("[data-aid]");
    for (let order = 0; order < elements.length; order += 1) {
      const element = elements[order];
      const id = element.getAttribute("data-aid");
      if (id === null || !AID.test(id)) continue;
      if (found.has(id)) found.set(id, null);
      else found.set(id, { element, order });
    }
    return found;
  }

  /* One entry's host block and the box the marker lines up with.  A comment
     uses the location P3-C resolved, including a range inside a block it moved
     to; a suggestion is whole-block by definition. */
  function railAnchorOf(record, blocks) {
    /* A comment marker this module made carries the entry P3-C resolved.  One
       a *caller* made through the public `add("comment", ...)` carries only an
       aid, so it is placed whole-block exactly like a suggestion rather than
       being hidden forever for want of an entry. */
    if (record.kind === "comment" && record.entry !== null) {
      const location = record.entry.location;
      if (location === null || location.element === null) return null;
      return { host: location.element, source: location.range === null ? location.element : location.range, order: location.order };
    }
    const found = blocks.get(record.aid);
    if (found === undefined || found === null || !found.element.isConnected) return null;
    return { host: found.element, source: found.element, order: found.order };
  }

  /* Ties are broken the same way whichever kinds collide: document order,
     then comments before suggestions, then P3-C's thread order, then the
     order the markers were registered in. */
  function byRail(a, b) {
    if (a.order !== b.order) return a.order - b.order;
    if (a.record.kind !== b.record.kind) return a.record.kind === "comment" ? -1 : 1;
    if (a.record.entry !== null && b.record.entry !== null) return byCreated(a.record.entry, b.record.entry);
    return a.record.seq - b.record.seq;
  }

  function placeMarkers() {
    if (rail === null || !rail.isConnected) return;
    let needsBlocks = false;
    for (const record of railEntries.values()) if (record.kind === "suggestion" || record.entry === null) needsBlocks = true;
    const blocks = needsBlocks ? blockElements() : new Map();

    const candidates = [];
    for (const record of railEntries.values()) {
      const marker = record.button;
      const placement = railAnchorOf(record, blocks);
      const visible = placement !== null && placement.host.isConnected && disclosed(placement.host);
      /* A stale right-edge position can itself inflate scrollWidth after a
         viewport narrows. Reset it in the batched write phase so the later
         document measurement describes the page, not the prior marker. */
      if (visible) marker.style.left = "0px";
      marker.hidden = !visible;
      if (visible) candidates.push({ marker, record, placement });
    }

    const railRect = rail.getBoundingClientRect();
    const scrollWidth = document.documentElement.scrollWidth;
    const measured = [];
    for (const { marker, record, placement } of candidates) {
      const host = placement.host;
      const hasBox = host.getClientRects().length > 0;
      const top = placement.source.getBoundingClientRect().top - railRect.top;
      const hostRect = host.getBoundingClientRect();
      const width = marker.offsetWidth;
      const left = Math.min(Math.max(hostRect.right - railRect.left + 8, 4), scrollWidth - width - 4);
      measured.push({ marker, record, order: placement.order, hasBox, top, left });
    }
    const visible = measured.filter((item) => item.hasBox);
    visible.sort((a, b) => {
      if (a.top !== b.top) return a.top - b.top;
      return byRail(a, b);
    });
    for (const item of measured) item.marker.hidden = !item.hasBox;
    let previous = -Infinity;
    for (const item of visible) {
      const top = Math.max(item.top, previous + MARKER_STEP);
      item.marker.style.top = `${top}px`;
      item.marker.style.left = `${item.left}px`;
      item.marker.classList.toggle("doc-comment-marker-active",
        item.record.entry !== null && item.record.entry.thread.id === activeId);
      previous = top;
    }
  }

  /* ==================================================== shared surfaces */

  const isThenable = (value) => value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof value.then === "function";

  /* 1 to 160 Unicode scalar values, no C0, no C1, no lone surrogate.  A label
     is drawn as text and read aloud, so anything that could carry a control
     sequence into either is refused rather than sanitised. */
  function validRailLabel(value) {
    if (typeof value !== "string" || value === "") return false;
    let scalars = 0;
    for (const unit of value) {
      const code = unit.codePointAt(0);
      if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false;
      if (code >= 0xd800 && code <= 0xdfff) return false;
      scalars += 1;
      if (scalars > MAX_RAIL_LABEL) return false;
    }
    return true;
  }

  /* The visible glyph inside a marker circle.  The contract fixes a
     suggestion label as `<N> suggestions`, so the count is the label's own
     leading digits; any other label draws an empty circle and keeps its
     complete accessible name. */
  function leadingCount(label) {
    const match = /^[0-9]+(?= )/.exec(label);
    return match === null ? "" : match[0];
  }

  /* Every marker on the rail is one entry here, whoever asked for it.  The key
     is the token handed back: `Object.freeze(Object.create(null))` has no
     data, no string form, no id and no authority, so holding one proves only
     that this controller created it. */
  function railRegister(kind, aid, text, label, onClick) {
    if (rail === null) return null;
    const button = el("button", {
      type: "button",
      class: `${MARKER_CLASS} ${RAIL_CLASS[kind]}`,
      "aria-label": label,
    }, text);
    button.hidden = true;
    railSeq += 1;
    const record = { kind, aid, button, onClick, entry: null, seq: railSeq };
    button.addEventListener("click", () => { fire(record); });
    const token = Object.freeze(Object.create(null));
    railEntries.set(token, record);
    rail.appendChild(button);
    return token;
  }

  /* A marker callback is private code collaboration, not a boundary this
     module trusts.  A throw or a rejection is contained here with no log and
     no retry, and the placement it would have scheduled still happens. */
  function fire(record) {
    try {
      const result = record.onClick();
      if (isThenable(result)) Promise.resolve(result).catch(() => {});
    } catch (error) {
      // Contained on purpose: a broken caller must not break the rail.
    }
    schedulePlacement();
  }

  function railDrop(token) {
    const record = railEntries.get(token);
    if (record === undefined) return false;
    railEntries.delete(token);
    if (record.button.parentNode !== null) record.button.parentNode.removeChild(record.button);
    return true;
  }

  /* -------------------------------------------------- window.doc.rail */

  function railAdd(kind, aid, label, onClick) {
    if (rail === null) return null;
    if (kind !== "comment" && kind !== "suggestion") return null;
    if (typeof aid !== "string" || !AID.test(aid)) return null;
    if (!validRailLabel(label)) return null;
    if (typeof onClick !== "function") return null;
    const found = blockElements().get(aid);
    if (found === undefined || found === null || !found.element.isConnected) return null;
    /* Suggestions are whole-block state: several suggestions on one block are
       one marker, so a second one for the same aid is refused rather than
       stacked. */
    if (kind === "suggestion") {
      for (const record of railEntries.values()) {
        if (record.kind === "suggestion" && record.aid === aid) return null;
      }
    }
    const token = railRegister(kind, aid, leadingCount(label), label, onClick);
    if (token === null) return null;
    schedulePlacement();
    return token;
  }

  /* Only the exact identity this controller returned names an entry.  A
     foreign object, a repeat, or anything else simply misses. */
  function railRemove(token) {
    return railDrop(token);
  }

  function railPlace() {
    schedulePlacement();
    return undefined;
  }

  /* ------------------------------------------------- window.doc.panel */

  function panelRegister(kind, renderFn) {
    if (kind !== "suggestion") return false;
    if (typeof renderFn !== "function") return false;
    if (extensionRenderer !== null) return false;
    extensionRenderer = renderFn;
    renderExtension();
    return true;
  }

  /* One ordinary repaint of the panel and one placement frame.  It reads
     nothing from the network and resolves no anchor.

     A renderer that calls back into this from inside its own repaint would
     otherwise recurse until the stack gave out, and the `try/catch` around the
     renderer would swallow that as an ordinary renderer failure, leaving the
     panel half rebuilt.  A nested repaint is simply refused instead. */
  function panelRepaint() {
    if (panel === null || rendering) return undefined;
    render();
    return undefined;
  }

  function panelOpen(aid) {
    if (panel === null || toggle === null || list === null) return false;
    if (aid !== null) {
      if (typeof aid !== "string" || !AID.test(aid)) return false;
      const found = blockElements().get(aid);
      if (found === undefined || found === null || !found.element.isConnected) return false;
    }
    blockFilter = aid;
    kindFilter = "all";
    if (selectKind !== null) selectKind("all");
    if (panel.hidden) openPanel(toggle, null);
    applyFilters();
    renderExtension();
    schedulePlacement();
    return true;
  }

  /* One empty section, rebuilt on each repaint, after the comment groups and
     before the panel's own empty note.  The renderer may append only its own
     UI; comments.js never reads what it appended and never hands it the
     comment model. */
  function renderExtension() {
    dropExtension();
    if (list === null) return;
    if (kindFilter !== "all" && kindFilter !== "suggestions") return;
    if (extensionRenderer === null) {
      if (kindFilter !== "suggestions") return;
      const note = mountExtension();
      note.appendChild(el("p", { class: "doc-panel-extension-empty" }, NO_SUGGESTIONS));
      return;
    }
    const section = mountExtension();
    let result;
    rendering = true;
    try {
      result = extensionRenderer(section, blockFilter);
    } catch (error) {
      // The renderer failed; the comments beside it stay usable.
      dropExtension();
      return;
    } finally {
      rendering = false;
    }
    if (isThenable(result)) {
      /* An async renderer would paint into a section this repaint no longer
         owns, so the return is treated as misuse rather than awaited. */
      Promise.resolve(result).catch(() => {});
      dropExtension();
    }
  }

  function mountExtension() {
    const section = el("section", { class: EXTENSION_CLASS });
    const empty = list.querySelector(".doc-comments-empty");
    if (empty === null) list.appendChild(section);
    else list.insertBefore(section, empty);
    extension = section;
    return section;
  }

  function dropExtension() {
    if (extension === null) return;
    if (extension.parentNode !== null) extension.parentNode.removeChild(extension);
    extension = null;
  }

  /* The two published surfaces.  The shorthand names are the contract's; the
     module-scope names differ because `refresh` here is already the network
     read.  Both the surface and the six functions are frozen: nothing about
     either can be replaced once the page has them. */
  function railSurface() {
    const add = Object.freeze(railAdd);
    const remove = Object.freeze(railRemove);
    const place = Object.freeze(railPlace);
    return Object.freeze({ add, remove, place });
  }

  function panelSurface() {
    const register = Object.freeze(panelRegister);
    const refresh = Object.freeze(panelRepaint);
    const open = Object.freeze(panelOpen);
    return Object.freeze({ register, refresh, open });
  }

  /* ------------------------------------------------ the overlay barrier */

  /* P4-B's barrier is optional and is *discovered*, never used.  An accessor
     at either level is a foreign object shaped like the seam, so only own data
     descriptors count and no getter is ever invoked. */
  function overlayBarrier() {
    const editDescriptor = Object.getOwnPropertyDescriptor(doc, "edit");
    if (editDescriptor === undefined || !hasOwn(editDescriptor, "value")) return null;
    const edit = editDescriptor.value;
    if (edit === null || typeof edit !== "object") return null;
    const readyDescriptor = Object.getOwnPropertyDescriptor(edit, "overlaysReady");
    if (readyDescriptor === undefined || !hasOwn(readyDescriptor, "value")) return null;
    const ready = readyDescriptor.value;
    if (!(ready instanceof Promise)) return null;
    /* `instanceof` only walks the prototype chain, so an ordinary object made
       with `Object.create(Promise.prototype)` passes it and then throws
       synchronously out of `then()` -- taking the session listener, and with
       it every comment on the page, down with it.  `then` needs the internal
       slot, so calling it here is the brand check.  The no-op reaction it
       leaves on a genuine Promise is harmless: this module ignores both the
       fulfillment value and the rejection anyway. */
    try {
      Promise.prototype.then.call(ready, () => {}, () => {});
    } catch (error) {
      return null;
    }
    return ready;
  }

  /* The first anchor resolution waits for the applied overlay so no Range is
     built against text about to be replaced -- but never past the guard, and
     never on the barrier's own value or failure.  A publisher that never
     settles costs this page 5.5 seconds, not its comments. */
  function awaitOverlays() {
    const ready = overlayBarrier();
    if (ready === null) return startRefresh();
    let timer = 0;
    const guard = new Promise((resolve) => { timer = setTimeout(resolve, BARRIER_DEADLINE_MS); });
    readiness = Promise.race([ready.then(() => undefined, () => undefined), guard]).then(() => {
      clearTimeout(timer);
      readiness = null;
      return startRefresh();
    });
    return readiness;
  }

  /* ------------------------------------------------- the overlay event */

  /* The one in-page signal that rendered block content changed.  Nothing is
     coerced and no getter runs: the detail is already the exact frozen shape
     the contract fixes, or the event does nothing at all. */
  function overlayAids(event) {
    const detail = event === null ? null : event.detail;
    if (!isPlain(detail) || !Object.isFrozen(detail)) return null;
    if (Object.getOwnPropertySymbols(detail).length !== 0) return null;
    const names = Object.getOwnPropertyNames(detail);
    if (names.length !== 1 || names[0] !== "aids") return null;
    const slot = Object.getOwnPropertyDescriptor(detail, "aids");
    if (!hasOwn(slot, "value") || slot.enumerable !== true) return null;
    const aids = slot.value;
    if (!Array.isArray(aids) || Object.getPrototypeOf(aids) !== Array.prototype) return null;
    if (!Object.isFrozen(aids)) return null;
    if (aids.length < 1 || aids.length > OVERLAY_MAX) return null;
    if (Object.getOwnPropertySymbols(aids).length !== 0) return null;
    if (Object.getOwnPropertyNames(aids).length !== aids.length + 1) return null;
    const blocks = blockElements();
    let previous = null;
    for (let at = 0; at < aids.length; at += 1) {
      const indexed = Object.getOwnPropertyDescriptor(aids, String(at));
      if (indexed === undefined || !hasOwn(indexed, "value") || indexed.enumerable !== true) return null;
      const aid = indexed.value;
      if (typeof aid !== "string" || !AID.test(aid)) return null;
      if (previous !== null && !(aid > previous)) return null;
      previous = aid;
      const found = blocks.get(aid);
      if (found === undefined || found === null || !found.element.isConnected) return null;
    }
    return aids;
  }

  function onOverlay(event) {
    if (!activated || panel === null) return;
    const aids = overlayAids(event);
    if (aids === null) return;
    enqueueOverlay(aids);
  }

  /* Several valid events in one task become one microtask with their sorted
     union.  A union past the bound is not dropped and not unbounded: the
     current batch runs and the remainder becomes the next finite one. */
  function enqueueOverlay(aids) {
    for (const aid of aids) {
      if (overlayBatch !== null && overlayBatch.has(aid)) continue;
      if (overlayNext !== null && overlayNext.has(aid)) continue;
      if (overlayBatch === null) overlayBatch = new Set();
      if (overlayBatch.size < OVERLAY_MAX) {
        overlayBatch.add(aid);
        continue;
      }
      if (overlayNext === null) overlayNext = new Set();
      overlayNext.add(aid);
    }
    if (overlayBatch !== null && !overlayScheduled) {
      overlayScheduled = true;
      queueMicrotask(flushOverlay);
    }
  }

  function flushOverlay() {
    overlayScheduled = false;
    const named = overlayBatch;
    overlayBatch = null;
    if (named !== null && named.size > 0) reconcile(named);
    const carry = overlayNext;
    overlayNext = null;
    if (carry !== null) enqueueOverlay(carry);
  }

  /* Repair after an overlay replaced the children of the named blocks.  Only
     the named text maps are walked again, and only a thread that could have
     changed state is located again: new text in a named block can turn a
     moved or orphaned quote into a different state, so a thread whose home
     block is missing is re-run too.  A thread anchored to another present
     block keeps the live range it already has, and no thread record and no
     discussion card changes. */
  function reconcile(named) {
    if (placementFrame !== 0 && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(placementFrame);
      placementFrame = 0;
    }
    const index = buildBlockIndex(blockIndex, named);
    if (index === null) return;
    blockIndex = index;
    model = model.map((entry) => {
      if (entry.location === null) return entry;
      const home = entry.thread.anchor.block;
      if (!named.has(home) && index.has(home)) return entry;
      return { thread: entry.thread, location: locate(entry.thread.anchor, index) };
    });
    if (activeId !== null && !model.some((entry) => entry.thread.id === activeId)) activeId = null;
    render();
  }

  /* ============================================================== writes */

  /* Presentation-only projection of P3-H's final session shape.  Everything
     below decides what to *show*; P3-A and P4-M decide what is allowed, and a
     server denial always wins over the cached hint. */
  function projectSession(detail) {
    if (!isPlain(detail) || !Object.isFrozen(detail)) return null;
    if (!exactKeys(detail, SESSION_KEYS)) return null;
    if (detail.doc !== docId) return null;
    if (typeof detail.sub !== "string" || !SUB.test(detail.sub)) return null;
    if (typeof detail.name !== "string" || typeof detail.email !== "string") return null;
    if (!ROLES.includes(detail.role)) return null;
    for (const flag of SESSION_FLAGS) if (typeof detail[flag] !== "boolean") return null;
    return { sub: detail.sub, role: detail.role, canComment: detail.canComment };
  }

  const mayComment = () => !writesDenied && session !== null && session.canComment === true;

  function mayControl(thread) {
    if (writesDenied || session === null) return false;
    if (session.role === "owner" || session.role === "editor") return true;
    if (session.role === "commenter") return thread.author.sub === session.sub;
    return false;
  }

  /* Exactly one history block carrying a valid seven-hex head, or no create.
     Ambiguous version metadata suppresses creation and nothing else. */
  function headVersion() {
    const blocks = document.querySelectorAll("#doc-history");
    if (blocks.length !== 1) return null;
    const head = blocks[0].getAttribute("data-head");
    return typeof head === "string" && DOC_VERSION.test(head) ? head : null;
  }

  /* The bounded discussion target list: every direct `main > section[id]` in
     document order.  One invalid or repeated id withdraws the whole action
     rather than offering a guess. */
  function sectionInventory() {
    const found = document.querySelectorAll("main > section[id]");
    const options = [];
    const seen = new Set();
    for (const section of found) {
      const id = section.getAttribute("id");
      if (typeof id !== "string" || id.length > 64 || !SECTION.test(id)) return null;
      if (seen.has(id)) return null;
      seen.add(id);
      let label = id;
      const labels = section.querySelectorAll(".sec-label");
      if (labels.length === 1) {
        const text = labels[0].textContent.trim();
        if (text !== "") label = text;
      }
      options.push({ id, label });
    }
    return options.length === 0 ? null : options;
  }

  function defaultSection(options) {
    const raw = location.hash.slice(1);
    let target = raw;
    try {
      target = decodeURIComponent(raw);
    } catch (error) {
      target = raw;
    }
    for (const option of options) if (option.id === target) return option.id;
    return options[0].id;
  }

  /* ------------------------------------------------- selection capture */

  function boundaryElement(node) {
    if (node === null || node === undefined) return null;
    if (node.nodeType === 1) return node;
    return node.parentElement;
  }

  /* The one block a boundary belongs to, or null.  A duplicate aid, an
     out-of-policy element, or a section outside P3-A's grammar is refused
     because choosing between candidates would misattach the thread. */
  function blockOf(element) {
    if (element === null || !element.isConnected) return null;
    if (typeof element.closest !== "function") return null;
    const block = element.closest("[data-aid]");
    if (block === null || !BLOCK.includes(block.localName)) return null;
    const aid = block.getAttribute("data-aid");
    if (aid === null || !AID.test(aid)) return null;
    /* A duplicated anchor id is ambiguous and refused.  `AID` has already
       constrained the value to `a` plus eight hex digits, so it is safe to ask
       the engine for just that id rather than walking every `[data-aid]` in the
       document on each of the two boundary resolutions per selection. */
    if (document.querySelectorAll(`[data-aid="${aid}"]`).length !== 1) return null;
    const section = block.closest("section[id]");
    if (section === null) return null;
    const id = section.getAttribute("id");
    if (typeof id !== "string" || id.length > 64 || !SECTION.test(id)) return null;
    return { element: block, aid, section: id };
  }

  /* Translate a DOM range into one half-open interval of the normalised text
     by taking every map span the range touches.  The touched indices must be
     one contiguous run; anything else is not a selection this anchor grammar
     can describe. */
  function intervalFor(map, range) {
    let first = -1;
    let last = -1;
    let count = 0;
    const probe = new Range();
    for (let i = 0; i < map.spans.length; i += 1) {
      const span = map.spans[i];
      try {
        probe.setStart(span.startNode, span.startOffset);
        probe.setEnd(span.endNode, span.endOffset);
      } catch (error) {
        return null;
      }
      if (probe.compareBoundaryPoints(Range.START_TO_END, range) <= 0) continue;
      if (probe.compareBoundaryPoints(Range.END_TO_START, range) >= 0) continue;
      if (first === -1) first = i;
      last = i;
      count += 1;
    }
    if (count === 0) return null;
    if (count !== last - first + 1) return null;
    return { start: first, end: last + 1 };
  }

  function splitsSurrogate(text, start, end) {
    const head = text.charCodeAt(start);
    if (start > 0 && head >= 0xdc00 && head <= 0xdfff) {
      const before = text.charCodeAt(start - 1);
      if (before >= 0xd800 && before <= 0xdbff) return true;
    }
    const tail = text.charCodeAt(end - 1);
    if (end < text.length && tail >= 0xd800 && tail <= 0xdbff) {
      const after = text.charCodeAt(end);
      if (after >= 0xdc00 && after <= 0xdfff) return true;
    }
    return false;
  }

  /* The inverse of P3-C's text map: a stable aid plus a normalised quote and
     its context.  No DOM path, source path or ordinal is ever recorded, and a
     range crossing two blocks is reported, never clamped. */
  function captureSelection() {
    if (typeof document.getSelection !== "function") return null;
    const selection = document.getSelection();
    if (selection === null || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    if (range === null || range.collapsed) return null;
    const startElement = boundaryElement(range.startContainer);
    const endElement = boundaryElement(range.endContainer);
    if (startElement === null || endElement === null) return null;
    if (!document.contains(startElement) || !document.contains(endElement)) return null;
    const startBlock = blockOf(startElement);
    const endBlock = blockOf(endElement);
    if (startBlock === null || endBlock === null) return null;
    if (startBlock.element !== endBlock.element) {
      return { multi: true, rect: range.getBoundingClientRect() };
    }

    const map = textMap(startBlock.element);
    const interval = intervalFor(map, range);
    if (interval === null) return null;
    const start = interval.start;
    const end = interval.end;
    if (splitsSurrogate(map.text, start, end)) return null;
    const exact = map.text.slice(start, end);
    if (exact.length === 0 || exact.length > MAX_EXACT) return null;
    const quote = {
      block: startBlock.aid,
      exact,
      prefix: map.text.slice(Math.max(0, start - CONTEXT_LIMIT), start),
      suffix: map.text.slice(end, Math.min(map.text.length, end + CONTEXT_LIMIT)),
      start,
    };
    if (!validAnchor(quote)) return null;
    return { multi: false, anchor: quote, section: startBlock.section, rect: range.getBoundingClientRect() };
  }

  /* ------------------------------------------------ selection tooltip */

  function removeTooltip() {
    if (tooltipTimer !== 0) {
      clearTimeout(tooltipTimer);
      tooltipTimer = 0;
    }
    if (tooltip === null) return;
    if (tooltip.parentNode !== null) tooltip.parentNode.removeChild(tooltip);
    tooltip = null;
  }

  /* This ticket owns no stylesheet, so the transient host carries only the
     positioning properties it cannot work without. */
  function placeTooltip(host, rect) {
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.margin = "0";
    document.body.appendChild(host);
    const width = host.offsetWidth;
    const height = host.offsetHeight;
    const left = Math.min(Math.max(rect.left, 0), Math.max(0, window.innerWidth - width));
    const above = rect.top - height - 8;
    const below = Math.min(rect.bottom + 8, Math.max(0, window.innerHeight - height));
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(above >= 0 ? above : below)}px`;
  }

  function showRefusal(rect) {
    removeTooltip();
    tooltip = el("div", { role: "status" }, MULTI_BLOCK);
    placeTooltip(tooltip, rect);
    tooltipTimer = setTimeout(removeTooltip, REFUSAL_MS);
  }

  function showCommentTooltip(capture, focusButton) {
    removeTooltip();
    const host = el("div");
    const button = el("button", { type: "button" }, "Comment");
    /* Keep the document selection alive across the press: the capture that
       justifies this button is the thing a focus change would destroy. */
    button.addEventListener("mousedown", (event) => { event.preventDefault(); });
    button.addEventListener("click", () => {
      removeTooltip();
      if (panel !== null && panel.hidden) openPanel(toggle, null);
      openDraft("comment", toggle, capture);
    });
    host.appendChild(button);
    tooltip = host;
    placeTooltip(host, capture.rect);
    /* A pointer user is already next to this button; a keyboard user reached
       it through Ctrl/Meta+Alt+M and would otherwise have to Tab past the rest
       of the document to a host that any scroll destroys.  `preventScroll`
       matters: scrolling here would fire the listener that removes it. */
    if (focusButton === true) button.focus({ preventScroll: true });
  }

  function evaluateSelection(focusButton) {
    if (!mayComment() || panel === null) {
      removeTooltip();
      return;
    }
    if (draft !== null) return;
    const capture = captureSelection();
    if (capture === null) {
      removeTooltip();
      return;
    }
    if (capture.multi) {
      showRefusal(capture.rect);
      return;
    }
    if (headVersion() === null) {
      removeTooltip();
      return;
    }
    showCommentTooltip(capture, focusButton);
  }

  function clearSelectionTimer() {
    if (selectionTimer === 0) return;
    clearTimeout(selectionTimer);
    selectionTimer = 0;
  }

  function scheduleSelection() {
    clearSelectionTimer();
    selectionTimer = setTimeout(() => {
      selectionTimer = 0;
      evaluateSelection();
    }, SELECTION_DELAY_MS);
  }

  function selectionChanged() {
    removeTooltip();
    scheduleSelection();
  }

  function selectionSettled() {
    clearSelectionTimer();
    evaluateSelection(false);
  }

  function selectionSettledByKey() {
    clearSelectionTimer();
    evaluateSelection(true);
  }

  function writeKeydown(event) {
    if (event.key === "Escape") {
      if (tooltip !== null) removeTooltip();
      return;
    }
    if (event.defaultPrevented || event.repeat) return;
    if (!(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey) return;
    if (event.code !== "KeyM" && event.key !== "m" && event.key !== "M") return;
    event.preventDefault();
    selectionSettledByKey();
  }

  /* -------------------------------------------------------- transport */

  function createEndpoint() {
    const endpoint = new URL("/api/threads", location.href);
    endpoint.searchParams.set("doc", docId);
    return endpoint;
  }

  /* `docId` comes from the document's own meta element and is the one value
     here that reaches a URL *path* rather than a query parameter, so encode
     it: `new URL` resolves `..` before the same-origin check below, which
     would therefore not catch a traversal.  Nothing can currently deliver one
     -- `validThread` refuses every thread unless `docId` matches P3-A's
     six-hex grammar, so a malformed id renders no thread and no control to
     press -- but that is an invariant two validators away from this line.
     `threadId` is already grammar-checked by `THREAD_ID`. */
  function threadEndpoint(threadId) {
    return new URL(`/api/threads/${encodeURIComponent(docId)}/${threadId}`, location.href);
  }

  /* One mutation, one five-second deadline, no retry.  Only P3-A's exact
     status and plain `{thread}` envelope are a success; 401 and 403 are the
     one response that changes what this module will ever offer again. */
  async function writeRequest(method, endpoint, payload, expected) {
    if (endpoint.origin !== location.origin) return { ok: false, denied: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WRITE_DEADLINE_MS);
    try {
      const response = await fetch(endpoint, {
        method,
        mode: "same-origin",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) return { ok: false, denied: true };
      if (response.status !== expected) return { ok: false, denied: false };
      const envelope = await response.json();
      if (!exactKeys(envelope, ENVELOPE_KEYS)) return { ok: false, denied: false };
      const thread = envelope.thread;
      if (!validThread(thread)) return { ok: false, denied: false };
      return { ok: true, denied: false, thread };
    } catch (error) {
      return { ok: false, denied: false };
    } finally {
      clearTimeout(timer);
    }
  }

  function beginWrite(controls, host) {
    writing = true;
    if (host !== null) host.setAttribute("aria-busy", "true");
    /* Disabling the control the reader just activated resets focus to the
       document body, and the write may take the full five seconds -- so a
       keyboard reader would lose their place, and Tab would restart from the
       top of the document.  Move focus onto the host carrying `aria-busy`
       before anything is disabled; the settlement paths move it on again. */
    if (host !== null && controls.indexOf(document.activeElement) !== -1) {
      if (!host.hasAttribute("tabindex")) host.setAttribute("tabindex", "-1");
      host.focus();
    }
    for (const control of controls) control.disabled = true;
    setStatus(WRITE_PENDING);
  }

  function endWrite(controls, host) {
    writing = false;
    for (const control of controls) if (control.isConnected) control.disabled = false;
    if (host !== null && host.isConnected) host.removeAttribute("aria-busy");
  }

  /* The permission-loss path.  Page-lifetime by construction: only a fresh
     navigation with a newly validated session can offer a write again. */
  function denyWrites() {
    writesDenied = true;
    closeDraft();
    removeTooltip();
    render();
    /* The repaint that suppresses every write control usually removes the very
       button `closeDraft` just restored focus to -- a draft's invoker is itself
       a create control -- which would drop the caret onto `body` and strand a
       keyboard reader mid-document.  Land it on the panel instead. */
    keepFocusInPanel();
    setStatus(WRITE_DENIED);
    refresh();
  }

  function keepFocusInPanel() {
    const active = document.activeElement;
    if (active !== null && active !== document.body && rendered(active)) return;
    if (rendered(title)) title.focus();
    else if (rendered(toggle)) toggle.focus();
  }

  function writeFailed(control) {
    setStatus(WRITE_FAILED);
    if (control !== null && rendered(control)) control.focus();
  }

  function sameAnchor(a, b) {
    if (a === null || b === null) return a === b;
    return a.block === b.block && a.exact === b.exact && a.prefix === b.prefix
      && a.suffix === b.suffix && a.start === b.start;
  }

  function matchesCreate(thread, request) {
    if (thread.kind !== request.kind) return false;
    if (thread.section !== request.section) return false;
    if (thread.docVersion !== request.docVersion) return false;
    if (!sameAnchor(thread.anchor, request.kind === "comment" ? request.anchor : null)) return false;
    if (thread.title !== (request.kind === "discussion" ? request.title : null)) return false;
    return thread.comments[0].body === request.body;
  }

  /* Replace or insert one validated record and repaint.  The response is the
     acknowledgement; nothing here waits for the list to agree. */
  function integrate(record) {
    const index = buildBlockIndex();
    if (index === null) return false;
    blockIndex = index;
    const entry = {
      thread: record,
      location: record.kind === "comment" ? locate(record.anchor, index) : null,
    };
    const at = model.findIndex((item) => item.thread.id === record.id);
    const next = model.slice();
    if (at === -1) next.push(entry);
    else next[at] = entry;
    model = next;
    render();
    return true;
  }

  /* ------------------------------------------------------------ drafts */

  function detachDraft() {
    if (draft === null) return null;
    const closing = draft;
    draft = null;
    if (closing.form.parentNode !== null) closing.form.parentNode.removeChild(closing.form);
    return closing;
  }

  function closeDraft() {
    const closing = detachDraft();
    if (closing === null) return;
    const target = rendered(closing.invoker) ? closing.invoker : (rendered(toggle) ? toggle : null);
    if (target !== null) target.focus();
  }

  function openDraft(kind, invoker, capture) {
    if (panel === null || !mayComment()) return;
    const version = headVersion();
    if (version === null) return;
    let options = null;
    if (kind === "discussion") {
      options = sectionInventory();
      if (options === null) return;
    }
    closeDraft();
    removeTooltip();

    const form = el("form", { class: "doc-comments-draft" });
    form.noValidate = true;
    form.appendChild(el("h3", undefined, kind === "comment" ? "New comment" : "New discussion"));

    let sectionSelect = null;
    let titleInput = null;
    if (kind === "comment") {
      form.appendChild(el("blockquote", undefined, capture.anchor.exact));
    } else {
      const sectionId = "doc-comments-draft-section";
      form.appendChild(el("label", { for: sectionId }, "Section"));
      sectionSelect = el("select", { id: sectionId, required: "" });
      for (const option of options) {
        const node = el("option", { value: option.id }, option.label);
        sectionSelect.appendChild(node);
      }
      sectionSelect.value = defaultSection(options);
      form.appendChild(sectionSelect);

      const titleId = "doc-comments-draft-title";
      form.appendChild(el("label", { for: titleId }, "Title"));
      titleInput = el("input", { id: titleId, type: "text", required: "" });
      titleInput.maxLength = MAX_TITLE;
      form.appendChild(titleInput);
    }

    const bodyId = "doc-comments-draft-body";
    form.appendChild(el("label", { for: bodyId }, "Message"));
    const body = el("textarea", { id: bodyId, required: "" });
    body.maxLength = MAX_BODY;
    form.appendChild(body);

    const submit = el("button", { type: "submit" }, kind === "comment" ? "Add comment" : "Start discussion");
    const cancel = el("button", { type: "button" }, "Cancel");
    cancel.addEventListener("click", () => { closeDraft(); });
    form.appendChild(submit);
    form.appendChild(cancel);

    const state = { form, invoker, kind, capture, sectionSelect, titleInput, body, submit, cancel };
    const send = () => { submitDraft(state); };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      send();
    });
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeDraft();
        return;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        send();
      }
    });

    panel.insertBefore(form, list);
    draft = state;
    body.focus();
  }

  function submitDraft(state) {
    if (draft !== state || writing || !mayComment()) return;
    const version = headVersion();
    if (version === null) return;
    const text = state.body.value;
    /* The `trim()` test is ours, not the spec's: P3-A's body grammar rejects a
       whitespace-only comment server-side, so sending one only burns the
       five-second deadline to render a failure the reader can't act on. */
    if (text.length === 0 || text.length > MAX_BODY || text.trim().length === 0) return;

    let request;
    if (state.kind === "comment") {
      request = {
        kind: "comment",
        section: state.capture.section,
        anchor: state.capture.anchor,
        docVersion: version,
        body: text,
      };
    } else {
      const section = state.sectionSelect.value;
      if (typeof section !== "string" || section.length > 64 || !SECTION.test(section)) return;
      const heading = state.titleInput.value;
      if (heading.length === 0 || heading.length > MAX_TITLE || heading.trim().length === 0) return;
      request = {
        kind: "discussion",
        section,
        anchor: null,
        title: heading,
        docVersion: version,
        body: text,
      };
    }
    runCreate(state, request);
  }

  async function runCreate(state, request) {
    const controls = [state.submit, state.cancel];
    beginWrite(controls, state.form);
    const result = await writeRequest("POST", createEndpoint(), request, 201);
    endWrite(controls, state.form);
    if (result.denied) {
      denyWrites();
      return;
    }
    if (!result.ok || !matchesCreate(result.thread, request) || !integrate(result.thread)) {
      writeFailed(draft === state ? state.body : null);
      return;
    }
    /* Only the draft that was submitted is taken down: the reader may have
       opened another one while this request was in flight. */
    if (draft === state) detachDraft();
    setStatus(WRITE_SAVED);
    focusCard(result.thread.id);
  }

  /* --------------------------------------------- replies and status */

  function replyForm(entry, host) {
    const threadId = entry.thread.id;
    const form = el("form", { class: "doc-comments-reply" });
    form.noValidate = true;
    const fieldId = `doc-comments-reply-${threadId}`;
    form.appendChild(el("label", { for: fieldId }, "Reply"));
    const body = el("textarea", { id: fieldId, required: "" });
    body.maxLength = MAX_BODY;
    form.appendChild(body);
    const submit = el("button", { type: "submit" }, "Reply");
    form.appendChild(submit);

    const send = () => {
      if (writing || !mayComment()) return;
      const text = body.value;
      if (text.length === 0 || text.length > MAX_BODY || text.trim().length === 0) return;
      runReply(threadId, text, [submit, body], form, host, body);
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      send();
    });
    form.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        send();
      }
    });
    return form;
  }

  async function runReply(threadId, text, controls, form, host, focusOnFailure) {
    beginWrite(controls, form);
    const result = await writeRequest("POST", threadEndpoint(threadId), { body: text }, 200);
    endWrite(controls, form);
    if (result.denied) {
      denyWrites();
      return;
    }
    if (!result.ok || session === null) {
      writeFailed(focusOnFailure);
      return;
    }
    const thread = result.thread;
    const last = thread.comments[thread.comments.length - 1];
    if (thread.id !== threadId || last.body !== text || last.author.sub !== session.sub) {
      writeFailed(focusOnFailure);
      return;
    }
    if (!integrate(thread)) {
      writeFailed(focusOnFailure);
      return;
    }
    setStatus(WRITE_SAVED);
    focusMessage(thread.id, thread.comments.length - 1);
  }

  function statusButton(entry, host) {
    const thread = entry.thread;
    const next = thread.status === "open" ? "resolved" : "open";
    const button = el("button", {
      type: "button",
      class: "doc-comments-status-action",
    }, thread.status === "open" ? "Resolve" : "Reopen");
    button.addEventListener("click", () => {
      if (writing || !mayControl(thread)) return;
      runStatus(thread.id, next, button, host);
    });
    return button;
  }

  async function runStatus(threadId, next, button, host) {
    beginWrite([button], host);
    const result = await writeRequest("PATCH", threadEndpoint(threadId), { status: next }, 200);
    endWrite([button], host);
    if (result.denied) {
      denyWrites();
      return;
    }
    if (!result.ok || result.thread.id !== threadId || result.thread.status !== next
      || !integrate(result.thread)) {
      writeFailed(button);
      return;
    }
    setStatus(WRITE_SAVED);
    focusCard(threadId);
  }

  /* A newly appended message is the thing the reader just wrote; the card
     heading, then the panel heading, are the fallbacks when a filter hides
     it. */
  function focusMessage(threadId, index) {
    const card = cards.get(threadId);
    if (card === undefined) {
      title.focus();
      return;
    }
    const items = card.article.querySelectorAll(".doc-comments-messages > li");
    const item = items[index];
    if (item === undefined) {
      focusCard(threadId);
      return;
    }
    item.focus();
    if (document.activeElement !== item) focusCard(threadId);
  }

  function renderActions() {
    if (actions === null) return;
    actions.replaceChildren();
    if (!mayComment()) return;
    if (headVersion() === null || sectionInventory() === null) return;
    const start = el("button", { type: "button", id: "doc-comments-start" }, "Start discussion");
    start.addEventListener("click", () => { openDraft("discussion", start, null); });
    actions.appendChild(start);
  }

  /* ------------------------------------------------------- lifecycle */

  /* Published before any listener, so a second client that loads later either
     sees both surfaces or sees the nulls P1-B left. */
  doc.rail = railSurface();
  doc.panel = panelSurface();

  document.addEventListener("session", (event) => {
    const detail = event.detail;
    if (detail === null || typeof detail !== "object") return;
    if (activated) return;
    session = projectSession(detail);
    activated = true;
    awaitOverlays();
  }, { once: true });

  /* Only visible edges after activation count toward the 30-second window;
     an edge before the session reveal must not consume the first eligible one. */
  function visibilityRefresh() {
    if (!activated || document.visibilityState !== "visible") return;
    const now = performance.now();
    if (lastVisibilityRefresh !== null && now - lastVisibilityRefresh < VISIBILITY_WINDOW_MS) return;
    lastVisibilityRefresh = now;
    refresh();
  }

  document.addEventListener("visibilitychange", visibilityRefresh);

  doc.comments = Object.freeze({ refresh });
}
