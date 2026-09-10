/* Direct-edit client and pending-overlay barrier.

   Two jobs, in this order. First, every authenticated reader applies the
   server's bounded pending receipts over the built text, so what everyone sees
   is the same overlay; `window.doc.edit.overlaysReady` is the one promise that
   says when that first pass is done, and P4-Q waits on it before the comments
   client resolves its first anchor. Second, and only for a session that says
   it may edit, each build-approved block gets an Edit control that turns the
   block into plaintext with three inline marks and POSTs it to /api/edit.

   The page is never the authority. The control is a presentation hint from the
   session projection; the server decides. Outside HTTP(S), without the document
   id, the anchor core, the platform primitives, or with a namespace another
   owner already filled, the module installs nothing and the static document is
   unchanged.

   P4-I adds one advisory layer on top: entering the direct editor announces a
   frozen local `doc:edit-state` and publishes one `edit.claim` through P3-F,
   and every way out of the editor publishes one matching `edit.release`. It is
   a hint for peers, never a lock -- the block hash still decides.

   Amendment chain: P4-B (this initial overlay/direct-edit client) -> P4-I ->
   P4-P. The four converter declarations below are byte-compatible with P2-D's
   `inline_md` twin on purpose; P4-C extracts them and runs the parity gate. */

/** Replace every exact `needle` in `input` with `replacement`. */
const replaceLiteral = (input, needle, replacement) =>
  input.split(needle).join(replacement);

/**
 * One `untag` pass: scan left to right for the next exact `<tag>`. When no
 * exact `</tag>` follows that opening tag, append the untouched remainder and
 * stop the pass. Otherwise the first following close wins: append the preceding
 * bytes, `open`, the bytes between the two tags unchanged, and `close`, then
 * resume immediately after the close.
 */
function untag(input, tag, open, close) {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  let out = "";
  let rest = input;
  for (;;) {
    const openAt = rest.indexOf(openTag);
    if (openAt === -1) return out + rest;
    const closeAt = rest.indexOf(closeTag, openAt + openTag.length);
    if (closeAt === -1) return out + rest;
    out += rest.slice(0, openAt);
    out += open;
    out += rest.slice(openAt + openTag.length, closeAt);
    out += close;
    rest = rest.slice(closeAt + closeTag.length);
  }
}

/**
 * One `wrap` pass. Find the next delimiter from left to right and let `run` be
 * the bytes after it through, but not including, the first occurrence of the
 * delimiter's single character. Wrap only when `run` is nonempty and the bytes
 * immediately following `run` start with the complete delimiter; on success
 * append `<tag>run</tag>` and resume after the closing delimiter. On failure
 * append through the opening delimiter unchanged and resume after it.
 */
function wrap(input, delimiter, tag) {
  const single = delimiter[0];
  let out = "";
  let rest = input;
  for (;;) {
    const openAt = rest.indexOf(delimiter);
    if (openAt === -1) return out + rest;
    const runStart = openAt + delimiter.length;
    const singleAt = rest.indexOf(single, runStart);
    if (singleAt === -1) {
      out += rest.slice(0, runStart);
      rest = rest.slice(runStart);
      continue;
    }
    const run = rest.slice(runStart, singleAt);
    if (run !== "" && rest.startsWith(delimiter, singleAt)) {
      out += rest.slice(0, openAt);
      out += `<${tag}>`;
      out += run;
      out += `</${tag}>`;
      rest = rest.slice(singleAt + delimiter.length);
    } else {
      out += rest.slice(0, runStart);
      rest = rest.slice(runStart);
    }
  }
}

/** Convert an inner-HTML string to editable text. */
function toMd(html) {
  let out = untag(untag(untag(html, "code", "`", "`"), "strong", "**", "**"), "em", "*", "*");
  out = replaceLiteral(out, "&lt;", "<");
  out = replaceLiteral(out, "&gt;", ">");
  out = replaceLiteral(out, "&amp;", "&");
  return out;
}

/** Convert editable text to an inner-HTML string. */
function toHtml(text) {
  let out = replaceLiteral(text, "&", "&amp;");
  out = replaceLiteral(out, "<", "&lt;");
  out = replaceLiteral(out, ">", "&gt;");
  out = wrap(out, "`", "code");
  out = wrap(out, "**", "strong");
  out = wrap(out, "*", "em");
  return out;
}

installEdit();

function installEdit() {
  const protocol = location.protocol;
  if (protocol !== "http:" && protocol !== "https:") return;

  const metas = document.querySelectorAll('meta[name="doc-id"]');
  if (metas.length !== 1) return;
  const content = metas[0].getAttribute("content");
  const docId = typeof content === "string" ? content.trim() : "";
  if (!/^[0-9a-f]{6}$/.test(docId)) return;

  const doc = window.doc;
  if (doc === null || typeof doc !== "object") return;
  if (doc.edit !== null && doc.edit !== undefined) return;
  const anchor = doc.anchor;
  if (anchor === null || typeof anchor !== "object") return;
  if (!Array.isArray(anchor.BLOCK) || typeof anchor.norm !== "function" ||
      typeof anchor.scanBlocks !== "function") {
    return;
  }

  if (typeof fetch !== "function" ||
      typeof AbortController !== "function" ||
      typeof CustomEvent !== "function" ||
      typeof Range !== "function" ||
      typeof URL !== "function") {
    return;
  }

  /* ------------------------------------------------------------ constants */

  const AID = /^a[0-9a-f]{8}$/;
  const SUB = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
  const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const SUGGESTION_ID = /^s_[a-z0-9]{1,48}_[0-9a-f]{8}$/;
  const HASH = /^[0-9a-f]{64}$/;
  const SECTION = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
  const DOC_VERSION = /^[0-9a-f]{7,64}$/;
  const EMAIL_LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
  const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

  const MAX_TEXT = 4000;
  const MAX_NOTE = 280;
  const MAX_NAME = 200;
  const OVERLAY_TIMEOUT_MS = 5000;
  const SAVE_TIMEOUT_MS = 5000;
  const READ_LIMIT = 67_108_864;
  const MAX_SUGGESTIONS = 10_000;
  const VISIBILITY_WINDOW_MS = 30_000;
  const BATCH = 50;

  const PENDING_CLASS = "doc-edit-pending";
  const EDITING_CLASS = "doc-edit-editing";
  const CONFLICT_MESSAGE = "This block changed. Review the current text and try again.";
  const FAILED_MESSAGE = "The edit was not saved.";
  const SAVING_MESSAGE = "Saving…";
  const BUSY_MESSAGE = "Another block is saving. Try again in a moment.";
  const EDITING_MESSAGE = "Editing. Ctrl+Enter saves, Escape cancels.";

  const ROLES = ["owner", "editor", "commenter", "viewer", "none"];

  const ENTRY_KEYS = ["text", "by", "at", "pr"];
  const ACTOR_KEYS = ["sub", "name", "email"];
  const SESSION_KEYS = [
    "sub", "email", "name", "canComment", "canEdit", "doc", "role",
    "shared", "canSuggest", "canAccept", "canShare", "canSeeMembers",
  ];
  const SUGGESTION_KEYS = [
    "v", "id", "docId", "aid", "section", "text", "note", "by", "at",
    "baseHash", "baseText", "docVersion",
  ];
  const SUGGESTION_LIST_KEYS = SUGGESTION_KEYS.concat(["state"]);

  /* ------------------------------------------------------------- the blocks */

  const found = document.querySelectorAll("[data-editable][data-aid]");
  const blocks = [];
  const byAid = new Map();
  for (const element of found) {
    const aid = element.getAttribute("data-aid");
    if (!anchor.BLOCK.includes(element.localName) || typeof aid !== "string" || !AID.test(aid)) return;
    if (byAid.has(aid)) return;
    byAid.set(aid, element);
    blocks.push({ aid, element });
  }

  /* --------------------------------------------------------------- helpers */

  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function exactKeys(value, keys) {
    if (!isRecord(value)) return false;
    const names = Object.keys(value);
    if (names.length !== keys.length || Object.getOwnPropertySymbols(value).length !== 0) return false;
    return keys.every((key, index) => names[index] === key && hasOwn(value, key));
  }

  function exactFrozen(value, keys) {
    if (!exactKeys(value, keys) || Object.getPrototypeOf(value) !== Object.prototype ||
        !Object.isFrozen(value)) return false;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !hasOwn(descriptor, "value") ||
          descriptor.enumerable !== true || descriptor.writable !== false ||
          descriptor.configurable !== false) return false;
    }
    return true;
  }

  function safeScalar(value, max) {
    if (typeof value !== "string" || value.length > max) return false;
    for (let at = 0; at < value.length; at += 1) {
      const unit = value.charCodeAt(at);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        if (at + 1 >= value.length) return false;
        const low = value.charCodeAt(at + 1);
        if (low < 0xdc00 || low > 0xdfff) return false;
        at += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
      else if ((unit < 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d) ||
          (unit >= 0x7f && unit <= 0x9f)) return false;
    }
    return true;
  }

  function isTimestamp(value) {
    if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
    try {
      return new Date(value).toISOString() === value;
    } catch (error) {
      return false;
    }
  }

  function isActor(value) {
    if (!exactKeys(value, ACTOR_KEYS)) return false;
    return typeof value.sub === "string" && SUB.test(value.sub) &&
      safeScalar(value.name, MAX_NAME) && isEmail(value.email);
  }

  function sameActor(left, right) {
    return left.sub === right.sub && left.name === right.name && left.email === right.email;
  }

  function isEmail(value) {
    if (typeof value !== "string") return false;
    if (value === "") return true;
    if (value.length > 254 || !safeScalar(value, 254)) return false;
    const at = value.indexOf("@");
    if (at < 1 || value.indexOf("@", at + 1) !== -1) return false;
    const local = value.slice(0, at);
    const labels = value.slice(at + 1).split(".");
    return local.length <= 64 && EMAIL_LOCAL.test(local) && labels.length >= 2 &&
      labels.every((label) => DNS_LABEL.test(label));
  }

  /** Text is displayable only when the twin converters reproduce it exactly:
     the same admission gate the server applies before it will write. */
  function isEditableText(value) {
    if (typeof value !== "string" || value.length > MAX_TEXT) return false;
    const html = toHtml(value);
    return toMd(html) === value && toHtml(toMd(html)) === html;
  }

  function isSuggestionText(value) {
    return safeScalar(value, MAX_TEXT) && isEditableText(value);
  }

  function isNote(value) {
    return safeScalar(value, MAX_NOTE);
  }

  async function hashText(text) {
    const bytes = new TextEncoder().encode(toHtml(text));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    if (!(digest instanceof ArrayBuffer) || digest.byteLength !== 32) throw new Error("invalid digest");
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (!HASH.test(hash)) throw new Error("invalid digest");
    return hash;
  }

  async function effectiveBase(element) {
    const text = editableText(element);
    if (!isSuggestionText(text)) throw new Error("invalid base");
    return { text, hash: await hashText(text) };
  }

  /** Pure content-type grammar for `application/json` with an optional
     `charset=utf-8` parameter, ASCII-case-insensitive. */
  function isJsonContentType(value) {
    if (typeof value !== "string") return false;
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "application/json") return true;
    const semicolon = trimmed.indexOf(";");
    if (semicolon === -1) return false;
    if (trimmed.slice(0, semicolon).trim() !== "application/json") return false;
    const parameter = trimmed.slice(semicolon + 1).trim();
    return parameter === "charset=utf-8" || parameter === 'charset="utf-8"';
  }

  function validSuggestion(value, withState) {
    const keys = withState ? SUGGESTION_LIST_KEYS : SUGGESTION_KEYS;
    if (!exactKeys(value, keys) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    if (value.v !== 1 || typeof value.id !== "string" || !SUGGESTION_ID.test(value.id) ||
        value.docId !== docId || typeof value.aid !== "string" || !AID.test(value.aid) ||
        typeof value.section !== "string" || !SECTION.test(value.section) ||
        !isSuggestionText(value.text) || !isNote(value.note) || !isActor(value.by) ||
        !isTimestamp(value.at) || typeof value.baseHash !== "string" || !HASH.test(value.baseHash) ||
        !isSuggestionText(value.baseText) || typeof value.docVersion !== "string" ||
        !DOC_VERSION.test(value.docVersion)) return null;
    if (withState && value.state !== "open" && value.state !== "superseded") return null;
    return value;
  }

  function compareSuggestions(left, right) {
    if (left.at !== right.at) return left.at < right.at ? -1 : 1;
    if (left.id !== right.id) return left.id < right.id ? -1 : 1;
    if (left.aid !== right.aid) return left.aid < right.aid ? -1 : 1;
    return 0;
  }

  function validSuggestionList(value) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > MAX_SUGGESTIONS || Object.keys(value).length !== value.length) return null;
    const seen = new Set();
    let previous = null;
    for (let at = 0; at < value.length; at += 1) {
      if (!hasOwn(value, at)) return null;
      const record = validSuggestion(value[at], true);
      if (record === null) return null;
      const tuple = `${record.id}\u0000${record.aid}`;
      if (seen.has(tuple) || (previous !== null && compareSuggestions(previous, record) >= 0)) return null;
      seen.add(tuple);
      previous = record;
    }
    return value;
  }

  async function boundedJson(response, limit, active) {
    if (!isJsonContentType(response.headers.get("content-type"))) throw new Error("invalid content type");
    const body = response.body;
    if (body === null || typeof body !== "object" || typeof body.getReader !== "function") {
      throw new Error("unbounded body");
    }
    const reader = body.getReader();
    active.reader = reader;
    const chunks = [];
    let length = 0;
    let done = false;
    try {
      for (;;) {
        const item = await reader.read();
        if (item === null || typeof item !== "object" || typeof item.done !== "boolean") {
          throw new Error("invalid stream");
        }
        if (item.done) {
          done = true;
          break;
        }
        if (!(item.value instanceof Uint8Array)) throw new Error("invalid stream");
        length += item.value.byteLength;
        if (length > limit) throw new Error("oversized body");
        chunks.push(item.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally {
      if (!done) {
        try { await reader.cancel(); } catch (error) { /* contained */ }
      }
      try { reader.releaseLock(); } catch (error) { /* contained */ }
      if (active.reader === reader) active.reader = null;
    }
  }

  function abortRead(active) {
    if (active === null) return;
    try { active.controller.abort(); } catch (error) { /* contained */ }
    if (active.reader !== null) {
      try { Promise.resolve(active.reader.cancel()).catch(ignore); } catch (error) { /* contained */ }
    }
  }

  function freezeDetail(aids) {
    return Object.freeze({ aids: Object.freeze(aids) });
  }

  /* ------------------------------------------------------------- the session */

  /** P4-P consumes only the complete recursively frozen P3-H projection. */
  function validSession(body) {
    if (!exactFrozen(body, SESSION_KEYS)) return null;
    if (typeof body.sub !== "string") return null;
    if (typeof body.email !== "string") return null;
    if (typeof body.name !== "string") return null;
    /* The frozen one-element `roles` array was validated here descriptor by
       descriptor. It reported `member` or `guest` from a site-wide organisation
       email suffix, which ACN-006 removed, so the field is gone from the body
       and `body.role` -- the document role, which was always the authority --
       is the only role this page reads. */
    if (typeof body.canComment !== "boolean") return null;
    if (typeof body.canEdit !== "boolean") return null;
    if (body.doc !== docId) return null;
    if (!ROLES.includes(body.role)) return null;
    if (typeof body.shared !== "boolean") return null;
    if (typeof body.canSuggest !== "boolean") return null;
    if (typeof body.canAccept !== "boolean") return null;
    if (typeof body.canShare !== "boolean") return null;
    if (typeof body.canSeeMembers !== "boolean") return null;
    return Object.freeze({
      sub: body.sub,
      canSuggest: body.canSuggest,
      canEdit: body.canEdit,
      canAccept: body.canAccept,
    });
  }

  /* -------------------------------------------------------- pending overlays */

  /** One entry of P3-E's projection. The suggestion fields are accepted and
     validated here so a document already carrying P4-N state still overlays,
     but this ticket writes only the direct shape. */
  function validEntry(value) {
    if (!isRecord(value)) return null;
    const via = hasOwn(value, "via") ? value.via : undefined;
    let keys = ENTRY_KEYS;
    if (via === "edit") keys = ENTRY_KEYS.concat(["via"]);
    else if (via === "suggestion") {
      keys = ENTRY_KEYS.concat(["via", "sugId", "acceptedBy", "acceptedAt"]);
    } else if (via !== undefined) return null;
    if (!exactKeys(value, keys)) return null;
    if (!isEditableText(value.text)) return null;
    if (!isActor(value.by)) return null;
    if (!isTimestamp(value.at)) return null;
    if (!(value.pr === null || (Number.isSafeInteger(value.pr) && value.pr > 0))) return null;
    if (via === "suggestion") {
      if (typeof value.sugId !== "string" || !SUGGESTION_ID.test(value.sugId)) return null;
      if (!isActor(value.acceptedBy)) return null;
      if (!isTimestamp(value.acceptedAt)) return null;
    }
    return value;
  }

  function validDirectReceipt(value, aid) {
    if (!exactKeys(value, ["aid", "text", "by", "at", "pr", "via"])) return null;
    if (value.aid !== aid || !isEditableText(value.text) || !isActor(value.by) ||
        !isTimestamp(value.at) || !(value.pr === null || (Number.isSafeInteger(value.pr) && value.pr > 0)) ||
        value.via !== "edit") return null;
    return value;
  }

  function validApplyReceipt(value, aid) {
    const keys = ["v", "aid", "text", "by", "at", "baseHash", "pr", "via", "sugId", "acceptedBy", "acceptedAt"];
    if (!exactKeys(value, keys) || value.v !== 1 || value.aid !== aid || !isEditableText(value.text) ||
        !isActor(value.by) || !isTimestamp(value.at) || typeof value.baseHash !== "string" ||
        !HASH.test(value.baseHash) || !(value.pr === null || (Number.isSafeInteger(value.pr) && value.pr > 0)) ||
        value.via !== "suggestion" || typeof value.sugId !== "string" || !SUGGESTION_ID.test(value.sugId) ||
        !isActor(value.acceptedBy) || !isTimestamp(value.acceptedAt)) return null;
    return value;
  }

  /** The complete projection, or null. One bad entry rejects the response:
     a partial overlay would be a different document for different readers. */
  function validOverlay(body) {
    if (!isRecord(body) || Object.getPrototypeOf(body) !== Object.prototype) return null;
    const overlay = new Map();
    for (const aid of Object.keys(body)) {
      if (!AID.test(aid)) return null;
      const entry = validEntry(body[aid]);
      if (entry === null) return null;
      overlay.set(aid, entry);
    }
    return overlay;
  }

  /** Paint one block from exact plaintext and keep `data-md` in step, so a
     later edit reads the overlay rather than stale built text. */
  function paint(element, text) {
    element.innerHTML = toHtml(text);
    element.setAttribute("data-md", text);
  }

  /** Consecutive frozen batches of 1 through 50 aids, dispatched
     synchronously. No empty, duplicate, unsorted, or oversized batch. */
  function announce(aids) {
    for (let at = 0; at < aids.length; at += BATCH) {
      const slice = aids.slice(at, at + BATCH);
      document.dispatchEvent(new CustomEvent("doc:overlay", { detail: freezeDetail(slice) }));
    }
  }

  let pendingActive = null;
  let pendingDirty = false;
  let pendingGeneration = 0;
  let pendingDeferred = false;
  let pendingApplied = [];
  let suspended = false;
  const writingAids = new Map();

  function beginWrite(aid) {
    writingAids.set(aid, (writingAids.get(aid) || 0) + 1);
  }

  function endWrite(aid) {
    const count = writingAids.get(aid) || 0;
    if (count <= 1) writingAids.delete(aid);
    else writingAids.set(aid, count - 1);
  }

  /** Repeatable, bounded and single-flight. Every call settles to a boolean. */
  function refreshPending() {
    if (suspended) return Promise.resolve(false);
    if (pendingActive !== null) {
      pendingDirty = true;
      return pendingActive.promise;
    }
    const generation = ++pendingGeneration;
    const controller = new AbortController();
    const active = { controller, reader: null, promise: null };
    pendingActive = active;
    active.promise = (async () => {
      let timer = null;
      try {
        const endpoint = new URL("/api/pending", location.href);
        endpoint.searchParams.set("doc", docId);
        timer = setTimeout(() => controller.abort(), OVERLAY_TIMEOUT_MS);
        const response = await fetch(endpoint, {
          method: "GET",
          mode: "same-origin",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (response.status !== 200) return false;
        const overlay = validOverlay(await boundedJson(response, READ_LIMIT, active));
        if (overlay === null || generation !== pendingGeneration || suspended) return false;

        const changed = [];
        for (const block of blocks) {
          const entry = overlay.get(block.aid);
          if (entry === undefined || !block.element.isConnected) continue;
          if (activeEditor === block.aid || writingAids.has(block.aid)) {
            pendingDeferred = true;
            continue;
          }
          if (editableText(block.element) === entry.text) continue;
          paint(block.element, entry.text);
          block.element.classList.add(PENDING_CLASS);
          changed.push(block.aid);
        }
        changed.sort();
        pendingApplied = changed;
        for (const aid of changed) {
          try {
            const base = await effectiveBase(byAid.get(aid));
            if (generation === pendingGeneration && !suspended) applyLocalBase(aid, base.hash);
          } catch (error) {
            // A later authoritative suggestion read repairs local state.
          }
        }
        if (generation !== pendingGeneration || suspended) return false;
        if (changed.length > 0) announce(changed);
        return true;
      } catch (error) {
        return false;
      } finally {
        if (timer !== null) clearTimeout(timer);
        if (pendingActive === active) pendingActive = null;
        const trailing = pendingDirty;
        pendingDirty = false;
        if (trailing && !suspended) queueMicrotask(() => { void refreshPending(); });
      }
    })();
    return active.promise;
  }

  function finishDeferredPending() {
    if (!pendingDeferred || suspended) return;
    pendingDeferred = false;
    void refreshPending();
  }

  /* ------------------------------------------------------------ the soft lock */

  /* P4-I's advisory editing claim. It is presentation state for peers and
     nothing else: the server's block hash stays the only write authority, so
     a lost, delayed, duplicated or reordered claim can never change what a
     save is allowed to do. At most one local block is claimed at a time.

     P1-B loads this module before realtime, so the transport surface cannot
     be captured here. It is proved at publish time instead, by exactly the
     shape P3-F promises: a frozen object whose only own property is a
     non-writable, non-configurable, enumerable `publish` function. */

  let claimedAid = null;

  /* The block whose editor is currently open, and how to re-announce it. A
     `pagehide` releases the claim without closing the editor, so a BFCache
     restore comes back to a live `contenteditable` whose claim is gone: the
     heartbeat would say `reading` while the reader is still typing, and a peer
     claim on that block would no longer be excluded from the editing host.
     Re-running the claim edge on restore is what keeps the two in step. */
  let activeEditor = null;

  function ignore() {}

  function realtimeSurface() {
    try {
      const surface = window.doc.realtime;
      if (surface === null || typeof surface !== "object") return null;
      if (!Object.isFrozen(surface)) return null;
      if (Object.getOwnPropertySymbols(surface).length !== 0) return null;
      const names = Object.getOwnPropertyNames(surface);
      if (names.length !== 1 || names[0] !== "publish") return null;
      const descriptor = Object.getOwnPropertyDescriptor(surface, "publish");
      if (descriptor === undefined || !hasOwn(descriptor, "value")) return null;
      if (typeof descriptor.value !== "function") return null;
      if (descriptor.enumerable !== true) return null;
      if (descriptor.writable !== false || descriptor.configurable !== false) return null;
      return surface;
    } catch (error) {
      return null;
    }
  }

  /* Exactly one attempt, never awaited and never retried. An absent surface,
     a synchronous throw, a rejection and a resolved false are the same
     non-event: the editor keeps working, it is simply undecorated for peers.
     Nothing here creates a timer, and no save ever waits on it. */
  function publishClaim(event) {
    const surface = realtimeSurface();
    if (surface === null) return;
    try {
      Promise.resolve(surface.publish(event)).then(ignore, ignore);
    } catch (error) {
      // A transport failure is silence, not a broken editor.
    }
  }

  /** The one local signal P3-G listens for. Freshly created and frozen each
     time, so a listener can trust the shape without copying it. */
  function announceEditState(aid) {
    document.dispatchEvent(new CustomEvent("doc:edit-state", {
      detail: Object.freeze({ aid }),
    }));
  }

  function claimBlock(aid) {
    // Moving straight from one editor to another releases the old block
    // first, so peers never see this tab holding two claims at once.
    if (claimedAid !== null) releaseBlock(null);
    claimedAid = aid;
    announceEditState(aid);
    publishClaim({ t: "edit.claim", aid });
  }

  /* Idempotent. `expected` names the block that is finishing, or `null` to
     release whatever is active, which is what the page-lifecycle path needs.
     The aid is captured and cleared before either side effect, so an
     overlapping finish — a blur that follows Escape, or a pagehide during a
     save — publishes nothing a second time. A block whose claim has already
     been taken over by another editor releases nothing. */
  function releaseBlock(expected) {
    if (claimedAid === null) return;
    if (expected !== null && claimedAid !== expected) return;
    const captured = claimedAid;
    claimedAid = null;
    announceEditState(null);
    publishClaim({ t: "edit.release", aid: captured });
  }

  // Registered during module evaluation. P1-B loads edit before presence, so
  // this runs ahead of P3-G's own `pagehide` listener and peers see the
  // release before the bye. No `unload` or `beforeunload` listener is added.
  try {
    window.addEventListener("pagehide", () => {
      releaseBlock(null);
      suspendReconciliation();
    });
    // The mirror of that release. Only a genuine BFCache restore re-claims: a
    // normal navigation builds a fresh page whose editors are all closed.
    window.addEventListener("pageshow", (event) => {
      let persisted = false;
      try {
        persisted = event.persisted === true;
      } catch (error) {
        return;
      }
      if (persisted && activeEditor !== null && claimedAid === null) claimBlock(activeEditor);
      resumeReconciliation(event);
    });
  } catch (error) {
    // A host without the page lifecycle simply never fires it.
  }

  /* -------------------------------------------------------------- the editor */

  let saving = false;

  function probePlaintextOnly(element) {
    try {
      element.setAttribute("contenteditable", "plaintext-only");
      if (element.contentEditable === "plaintext-only") return true;
    } catch (error) {
      // A host that rejects the value simply does not support it.
    }
    element.setAttribute("contenteditable", "true");
    return false;
  }

  function makeControls(block, wantSuggest, wantEdit) {
    const controls = document.createElement("div");
    controls.className = "doc-edit-controls";
    let suggestButton = null;
    let editButton = null;
    if (wantSuggest) {
      suggestButton = document.createElement("button");
      suggestButton.type = "button";
      suggestButton.className = "doc-suggest-button";
      suggestButton.textContent = "Suggest";
      controls.appendChild(suggestButton);
    }
    if (wantEdit) {
      editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "doc-edit-button";
      editButton.textContent = "Edit";
      controls.appendChild(editButton);
    }
    const status = document.createElement("span");
    status.className = "doc-edit-status";
    status.setAttribute("role", "status");
    controls.appendChild(status);
    block.element.insertAdjacentElement("afterend", controls);
    return { controls, suggestButton, editButton, status };
  }

  function editableText(element) {
    const md = element.getAttribute("data-md");
    return md === null ? element.textContent : md;
  }

  function attachDirect(block, controlSet) {
    const { element, aid } = block;
    const { controls, editButton: button, status } = controlSet;

    let priorHtml = "";
    let priorMd = null;
    let priorMdPresent = false;
    let startText = "";
    let editing = false;
    let plaintextOnly = false;
    let entryBaseHash = null;

    const setStatus = (text) => {
      status.textContent = text;
    };

    const onPaste = (event) => {
      if (plaintextOnly) return;
      event.preventDefault();
      const clipboard = event.clipboardData;
      const text = clipboard === null || clipboard === undefined
        ? "" : clipboard.getData("text/plain");
      if (typeof text !== "string" || text === "") return;
      document.execCommand("insertText", false, text);
    };

    const stopEditing = () => {
      // Before the save request, the restore, or the programmatic blur: peers
      // learn this block is free ahead of any write or navigation work.
      releaseBlock(aid);
      if (activeEditor === aid) activeEditor = null;
      editing = false;
      element.removeAttribute("contenteditable");
      element.classList.remove(EDITING_CLASS);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("paste", onPaste);
      element.removeEventListener("blur", onBlur);
      button.disabled = false;
      controls.classList.remove("doc-edit-controls-busy");
    };

    const restore = () => {
      element.innerHTML = priorHtml;
      if (priorMdPresent) element.setAttribute("data-md", priorMd);
      else element.removeAttribute("data-md");
    };

    const cancel = () => {
      stopEditing();
      restore();
      setStatus("");
      finishDeferredPending();
    };

    async function save() {
      // Another block is mid-flight. Stay in editing mode and keep what the
      // reader typed: discarding their text and calling it a failed save
      // would lose work this block never even tried to send.
      if (saving) {
        // The reader has already left this editor, so peers must not keep
        // seeing it claimed while another block finishes its request. The
        // text stays put; focusing the retry editor publishes a fresh claim.
        releaseBlock(aid);
        setStatus(BUSY_MESSAGE);
        return;
      }
      const text = element.textContent;
      beginWrite(aid);
      stopEditing();
      saving = true;
      button.disabled = true;
      controls.classList.add("doc-edit-saving");
      controls.classList.remove("doc-edit-conflict", "doc-edit-failed");
      setStatus(SAVING_MESSAGE);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SAVE_TIMEOUT_MS);
      let response = null;
      let body = null;
      try {
        response = await fetch(new URL("/api/edit", location.href), {
          method: "POST",
          mode: "same-origin",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ docId, aid, text, baseHash: entryBaseHash }),
          signal: controller.signal,
        });
        if (isJsonContentType(response.headers.get("content-type"))) {
          body = await response.json();
        }
      } catch (error) {
        response = null;
      } finally {
        clearTimeout(timer);
        saving = false;
        endWrite(aid);
        button.disabled = false;
        controls.classList.remove("doc-edit-saving");
        finishDeferredPending();
      }

      if (response !== null && response.status === 200 && isRecord(body) &&
          exactKeys(body, ["receipt"])) {
        const receipt = validDirectReceipt(body.receipt, aid);
        // The receipt carries no document id: the request's already validated
        // context is what binds this response to this block.
        if (receipt !== null && receipt.text === text) {
          paint(element, receipt.text);
          element.classList.add(PENDING_CLASS);
          setStatus("");
          announce([aid]);
          try {
            const next = await effectiveBase(element);
            applyLocalBase(aid, next.hash);
          } catch (error) {
            // The durable edit stays applied; the next list read repairs state.
          }
          return;
        }
        if (editableText(element) === startText) restore();
        setStatus(FAILED_MESSAGE);
        controls.classList.add("doc-edit-failed");
        return;
      }

      if (response !== null && response.status === 409) {
        const current = isRecord(body) && hasOwn(body, "current") ? body.current : null;
        if (isEditableText(current)) paint(element, current);
        else if (editableText(element) === startText) restore();
        setStatus(CONFLICT_MESSAGE);
        controls.classList.add("doc-edit-conflict");
        return;
      }

      if (editableText(element) === startText) restore();
      setStatus(FAILED_MESSAGE);
      controls.classList.add("doc-edit-failed");
    }

    function onBlur() {
      if (!editing) return;
      // A blur that changed nothing is not an edit and never becomes a request.
      if (element.textContent === startText) cancel();
      else void save();
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
        // `cancel()` releases synchronously, so a peer claim that presence was
        // holding back for this block can appear and hide this very button
        // before the focus call. Focusing a hidden element silently does
        // nothing and strands the reader on `body`, so fall back to the
        // controls wrapper, which is always still there.
        try {
          if (!button.hasAttribute("hidden")) button.focus();
          else {
            controls.setAttribute("tabindex", "-1");
            controls.focus();
          }
        } catch (error) {
          // A host without focus management leaves the caret where it was.
        }
        return;
      }
      if (event.key !== "Enter") return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        void save();
        return;
      }
      // Enter alone stays text. Native plaintext-only already does that; the
      // fallback would otherwise insert structural markup, and every modifier
      // combination the browser treats as a newline has to be caught, not just
      // the unmodified key.
      if (!plaintextOnly) {
        event.preventDefault();
        document.execCommand("insertText", false, "\n");
      }
    }

    button.addEventListener("click", () => {
      if (editing || saving) return;
      button.disabled = true;
      void (async () => {
        try {
          let captured = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const before = editableText(element);
            captured = await effectiveBase(element);
            if (element.isConnected && before === captured.text && editableText(element) === before) break;
            captured = null;
          }
          if (captured === null) throw new Error("moving base");
          priorHtml = element.innerHTML;
          priorMdPresent = element.hasAttribute("data-md");
          priorMd = priorMdPresent ? element.getAttribute("data-md") : null;
          startText = captured.text;
          entryBaseHash = captured.hash;
          element.textContent = startText;
          plaintextOnly = probePlaintextOnly(element);
          element.classList.add(EDITING_CLASS);
          controls.classList.remove("doc-edit-conflict", "doc-edit-failed");
          editing = true;
          activeEditor = aid;
          claimBlock(aid);
          element.addEventListener("keydown", onKeyDown);
          element.addEventListener("paste", onPaste);
          element.addEventListener("blur", onBlur);
          setStatus(EDITING_MESSAGE);
          element.focus();
        } catch (error) {
          setStatus("Editing is unavailable for this block.");
        } finally {
          if (!editing) button.disabled = false;
        }
      })();
    });
  }

  /* ---------------------------------------------------------- suggestions */

  let currentSession = null;
  let railSurface = null;
  let panelSurface = null;
  let suggestionOpen = false;
  let suggestionActive = null;
  let suggestionDirty = false;
  let suggestionGeneration = 0;
  let suggestionEpoch = 0;
  let suggestions = [];
  let suggestionMessage = "";
  let draft = null;
  let draftOpening = false;
  let rejectDraft = null;
  let mutationActive = null;
  let lastVisibilityRefresh = null;
  const controlSets = new Map();
  const railTokens = new Map();
  const chips = new Map();

  function callableSurface(value, keys) {
    if (!exactFrozen(value, keys)) return null;
    for (const key of keys) {
      if (typeof value[key] !== "function" || !Object.isFrozen(value[key])) return null;
    }
    return value;
  }

  function suggestionSurfaces() {
    try {
      const rail = callableSurface(window.doc.rail, ["add", "remove", "place"]);
      const panel = callableSurface(window.doc.panel, ["register", "refresh", "open"]);
      return rail === null || panel === null ? null : { rail, panel };
    } catch (error) {
      return null;
    }
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className !== "") element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function setSuggestionMessage(text) {
    suggestionMessage = text;
    repaintSuggestions();
  }

  function removeSuggestionChrome() {
    for (const [aid, token] of railTokens) {
      try { railSurface.remove(token); } catch (error) { /* contained */ }
      railTokens.delete(aid);
    }
    for (const [aid, chip] of chips) {
      if (chip.parentNode !== null) chip.parentNode.removeChild(chip);
      chips.delete(aid);
    }
    for (const block of blocks) block.element.removeAttribute("data-suggest");
  }

  function repaintSuggestions() {
    if (railSurface === null || panelSurface === null) return;
    removeSuggestionChrome();
    if (suggestionOpen) {
      const counts = new Map();
      for (const record of suggestions) {
        if (record.state === "open") counts.set(record.aid, (counts.get(record.aid) || 0) + 1);
      }
      for (const block of blocks) {
        const count = counts.get(block.aid) || 0;
        if (count === 0 || !block.element.isConnected) continue;
        const label = count === 1 ? "1 suggestion" : `${count} suggestions`;
        block.element.setAttribute("data-suggest", String(count));
        const chip = node("span", "doc-suggest-chip", label);
        const controls = controlSets.get(block.aid);
        if (controls !== undefined && controls.controls.isConnected) {
          controls.controls.insertAdjacentElement("afterend", chip);
        } else {
          block.element.insertAdjacentElement("afterend", chip);
        }
        chips.set(block.aid, chip);
        try {
          const token = railSurface.add("suggestion", block.aid, label, () => panelSurface.open(block.aid));
          if (token !== null) railTokens.set(block.aid, token);
        } catch (error) {
          // A marker is optional presentation; the panel model remains usable.
        }
      }
    }
    try { railSurface.place(); } catch (error) { /* contained */ }
    try { panelSurface.refresh(); } catch (error) { /* contained */ }
  }

  function appendField(parent, label, value, empty, extraClass = "") {
    const field = node("div", "doc-suggest-field");
    if (extraClass !== "") field.classList.add(extraClass);
    field.appendChild(node("strong", "doc-suggest-label", label));
    if (value === "" && empty) field.appendChild(node("em", "doc-suggest-empty", "Empty block"));
    else field.appendChild(node("div", "doc-suggest-text", value));
    parent.appendChild(field);
  }

  function renderDraft(extension) {
    if (draft === null) return;
    const form = node("div", "doc-suggest-draft");
    const heading = node("h4", "doc-suggest-draft-title", draft.reproposal ? "Re-propose suggestion" : "New suggestion");
    form.appendChild(heading);
    const textLabel = node("label", "doc-suggest-label", "Proposed text");
    const text = node("textarea", "doc-suggest-textarea");
    text.maxLength = MAX_TEXT;
    text.value = draft.text;
    textLabel.appendChild(text);
    form.appendChild(textLabel);
    const noteLabel = node("label", "doc-suggest-label", "Note (optional)");
    const note = node("textarea", "doc-suggest-note");
    note.maxLength = MAX_NOTE;
    note.value = draft.note;
    noteLabel.appendChild(note);
    form.appendChild(noteLabel);
    const status = node("div", "doc-suggest-status", draft.message || "");
    status.setAttribute("aria-live", "polite");
    form.appendChild(status);
    const actions = node("div", "doc-suggest-actions");
    const save = node("button", "doc-suggest-save", "Save");
    save.type = "button";
    const cancel = node("button", "doc-suggest-cancel", "Cancel");
    cancel.type = "button";
    const busy = mutationActive !== null && mutationActive.target === "draft";
    save.disabled = busy;
    text.disabled = busy;
    note.disabled = busy;
    text.addEventListener("input", () => { draft.text = text.value; });
    note.addEventListener("input", () => { draft.note = note.value; });
    const rememberFocus = (name, element) => {
      draft.focus = name;
      draft.selectionStart = element.selectionStart;
      draft.selectionEnd = element.selectionEnd;
    };
    text.addEventListener("focus", () => rememberFocus("text", text));
    note.addEventListener("focus", () => rememberFocus("note", note));
    const keys = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeDraft(true);
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
        void submitDraft();
      }
    };
    text.addEventListener("keydown", keys);
    note.addEventListener("keydown", keys);
    save.addEventListener("click", () => { draft.text = text.value; draft.note = note.value; void submitDraft(); });
    cancel.addEventListener("click", () => closeDraft(true));
    actions.appendChild(save);
    actions.appendChild(cancel);
    if (draft.stale) {
      const retry = node("button", "doc-suggest-retry", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => { void retryDraft(); });
      actions.appendChild(retry);
    }
    form.appendChild(actions);
    extension.appendChild(form);
    if (draft.focus === "text" || draft.focus === "note") {
      const target = draft.focus === "text" ? text : note;
      queueMicrotask(() => {
        if (!target.isConnected) return;
        target.focus();
        try { target.setSelectionRange(draft.selectionStart, draft.selectionEnd); } catch (error) { /* contained */ }
      });
    }
  }

  function renderSuggestions(extension, aidFilter) {
    const heading = node("h3", "doc-suggest-heading", "Suggestions");
    heading.tabIndex = -1;
    extension.appendChild(heading);
    const status = node("div", "doc-suggest-status", suggestionMessage);
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    extension.appendChild(status);
    if (draft !== null && (aidFilter === null || draft.aid === aidFilter)) renderDraft(extension);
    let shown = 0;
    for (const record of suggestions) {
      if (aidFilter !== null && record.aid !== aidFilter) continue;
      shown += 1;
      const card = node("article", `doc-suggest-card doc-suggest-${record.state}`);
      card.setAttribute("data-suggestion-id", record.id);
      const title = node("h4", "doc-suggest-card-title", `Suggestion for ${record.section}`);
      title.tabIndex = -1;
      card.appendChild(title);
      const by = record.by.name === "" ? "Reader" : record.by.name;
      const meta = node("p", "doc-suggest-meta");
      meta.appendChild(document.createTextNode(`${by} · `));
      const time = node("time", "", record.at);
      time.dateTime = record.at;
      meta.appendChild(time);
      card.appendChild(meta);
      if (record.note !== "") card.appendChild(node("p", "doc-suggest-note-text", record.note));
      card.appendChild(node("p", `doc-suggest-state doc-suggest-state-${record.state}`,
        record.state === "open" ? "Open" : "Superseded"));
      const details = node("details", "doc-suggest-current");
      details.appendChild(node("summary", "", "Current text"));
      appendField(details, "Current text", record.baseText, true);
      card.appendChild(details);
      appendField(card, "Proposed text", record.text, true, "doc-suggest-proposed");
      renderCardActions(card, record);
      extension.appendChild(card);
    }
    if (shown === 0 && draft === null) extension.appendChild(node("p", "doc-suggest-empty-model", "No suggestions."));
  }

  function renderCardActions(card, record) {
    const actions = node("div", "doc-suggest-actions");
    const add = (label, action) => {
      const button = node("button", `doc-suggest-${action}`, label);
      button.type = "button";
      button.disabled = mutationActive !== null && mutationActive.target === record.id;
      button.addEventListener("click", () => {
        if (action === "reject") {
          rejectDraft = { id: record.id, reason: "" };
          repaintSuggestions();
        } else if (action === "repropose") void openDraft(record.aid, button, record);
        else void runAction(record, action, "");
      });
      actions.appendChild(button);
    };
    if (record.state === "open" && currentSession.canAccept) {
      add("Accept", "accept");
      add("Reject", "reject");
    }
    if (record.by.sub === currentSession.sub) add("Withdraw", "withdraw");
    if (record.state === "superseded" && currentSession.canSuggest) add("Re-propose", "repropose");
    if (rejectDraft !== null && rejectDraft.id === record.id) {
      const label = node("label", "doc-suggest-label", "Reason for rejection");
      const reason = node("textarea", "doc-suggest-reason");
      reason.maxLength = MAX_NOTE;
      reason.value = rejectDraft.reason;
      reason.addEventListener("input", () => { rejectDraft.reason = reason.value; });
      reason.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); rejectDraft = null; repaintSuggestions();
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault(); event.stopPropagation(); void runAction(record, "reject", reason.value);
        }
      });
      label.appendChild(reason);
      actions.appendChild(label);
      const confirm = node("button", "doc-suggest-reject-confirm", "Reject suggestion");
      confirm.type = "button";
      confirm.addEventListener("click", () => { void runAction(record, "reject", reason.value); });
      actions.appendChild(confirm);
    }
    if (actions.childNodes.length > 0) card.appendChild(actions);
  }

  function closeDraft(restoreFocus) {
    if (draft === null) return;
    const invoker = draft.invoker;
    draft = null;
    repaintSuggestions();
    if (restoreFocus && invoker !== null && invoker.isConnected) {
      try { invoker.focus(); } catch (error) { /* contained */ }
    }
  }

  async function openDraft(aid, invoker, record = null) {
    if (!suggestionOpen || mutationActive !== null || draftOpening || draft !== null) return;
    draftOpening = true;
    if (invoker !== null) invoker.disabled = true;
    try {
      const base = await effectiveBase(byAid.get(aid));
      if (!suggestionOpen || editableText(byAid.get(aid)) !== base.text) return;
      if (panelSurface.open(aid) !== true) {
        terminalSuggestions();
        return;
      }
      draft = {
        aid,
        text: record === null ? base.text : record.text,
        note: record === null ? "" : record.note,
        baseText: base.text,
        baseHash: base.hash,
        invoker,
        reproposal: record !== null,
        stale: false,
        message: "",
        focus: "text",
        selectionStart: 0,
        selectionEnd: record === null ? base.text.length : record.text.length,
      };
      repaintSuggestions();
    } catch (error) {
      const controls = controlSets.get(aid);
      if (controls !== undefined) controls.status.textContent = "Editing is unavailable for this block.";
    } finally {
      draftOpening = false;
      if (invoker !== null && invoker.isConnected) invoker.disabled = false;
    }
  }

  async function retryDraft() {
    if (draft === null || mutationActive !== null) return;
    const target = draft;
    try {
      const base = await effectiveBase(byAid.get(target.aid));
      if (draft !== target) return;
      target.baseText = base.text;
      target.baseHash = base.hash;
      target.stale = false;
      target.message = "";
      repaintSuggestions();
    } catch (error) {
      if (draft !== target) return;
      target.message = "Editing is unavailable for this block.";
      repaintSuggestions();
    }
  }

  async function mutationFetch(path, body, target) {
    const controller = new AbortController();
    const active = { controller, reader: null, target };
    mutationActive = active;
    repaintSuggestions();
    const timer = setTimeout(() => controller.abort(), SAVE_TIMEOUT_MS);
    try {
      const response = await fetch(new URL(path, location.href), {
        method: "POST",
        mode: "same-origin",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let value = null;
      try { value = await boundedJson(response, READ_LIMIT, active); } catch (error) { value = null; }
      return { response, value };
    } catch (error) {
      return { response: null, value: null };
    } finally {
      clearTimeout(timer);
      if (mutationActive === active) mutationActive = null;
    }
  }

  async function submitDraft() {
    if (draft === null || mutationActive !== null || !suggestionOpen) return;
    if (!isSuggestionText(draft.text) || !isNote(draft.note)) {
      draft.message = "The suggestion was not saved.";
      repaintSuggestions();
      return;
    }
    if (draft.text === draft.baseText) {
      draft.message = "Change the text before saving.";
      repaintSuggestions();
      return;
    }
    const captured = draft;
    beginWrite(captured.aid);
    const result = await mutationFetch("/api/suggestions", {
      docId, aid: captured.aid, text: captured.text, note: captured.note,
      baseHash: captured.baseHash, baseText: captured.baseText,
    }, "draft");
    endWrite(captured.aid);
    finishDeferredPending();
    if (!suggestionOpen || draft !== captured) return;
    if (result.response !== null && terminalResponse(result.response.status, result.value)) {
      terminalSuggestions();
      return;
    }
    if (result.response !== null && result.response.status === 201) {
      const record = validSuggestion(result.value, false);
      if (record !== null && record.aid === captured.aid && record.text === captured.text &&
          record.note === captured.note && record.baseHash === captured.baseHash &&
          record.baseText === captured.baseText && record.by.sub === currentSession.sub &&
          !suggestions.some((entry) => entry.id === record.id)) {
        suggestions.push({ ...record, state: "open" });
        suggestions.sort(compareSuggestions);
        suggestionEpoch += 1;
        draft = null;
        suggestionMessage = "";
        repaintSuggestions();
        focusSuggestion(record.id);
        return;
      }
    }
    if (result.response !== null && result.response.status === 409 &&
        exactError(result.value, "conflict", "The block changed since this document was built", true)) {
      if (await applyConflictCurrent(captured.aid, result.value)) {
        captured.stale = true;
        captured.message = "The block changed. Try again against the current text.";
      } else captured.message = "The suggestion was not saved.";
    } else if (result.response !== null && result.response.status === 409 &&
        exactError(result.value, "suggestion-limit", "Decide the open suggestions first", false)) {
      captured.message = "Decide the open suggestions first.";
    } else captured.message = "The suggestion was not saved.";
    repaintSuggestions();
  }

  function exactError(body, code, message, withCurrent) {
    const keys = withCurrent ? ["error", "current"] : ["error"];
    return exactKeys(body, keys) && exactKeys(body.error, ["code", "message"]) &&
      body.error.code === code && body.error.message === message;
  }

  function terminalResponse(status, body) {
    if (status === 401) return exactError(body, "unauthenticated", "Authentication required", false);
    if (status === 403) return exactError(body, "forbidden", "Suggestion access denied", false);
    return false;
  }

  async function applyConflictCurrent(aid, body) {
    if (!exactError(body, "conflict", "The block changed since this document was built", true) ||
        !exactKeys(body.current, ["hash", "text"])) return false;
    const current = body.current;
    if (typeof current.hash !== "string" || !HASH.test(current.hash)) return false;
    if (current.text === null) return true;
    if (!isSuggestionText(current.text)) return false;
    try {
      if (await hashText(current.text) !== current.hash) return false;
    } catch (error) {
      return false;
    }
    const element = byAid.get(aid);
    if (element === undefined || !element.isConnected || activeEditor === aid) return false;
    paint(element, current.text);
    element.classList.add(PENDING_CLASS);
    applyLocalBase(aid, current.hash);
    announce([aid]);
    return true;
  }

  function applyLocalBase(aid, hash) {
    let changed = false;
    for (const record of suggestions) {
      if (record.aid === aid && record.baseHash !== hash && record.state !== "superseded") {
        record.state = "superseded";
        changed = true;
      }
    }
    if (draft !== null && draft.aid === aid && draft.baseHash !== hash) {
      draft.stale = true;
      draft.message = "The block changed. Try again against the current text.";
      changed = true;
    }
    if (changed) {
      suggestionEpoch += 1;
      repaintSuggestions();
    }
  }

  function focusSuggestion(id) {
    queueMicrotask(() => {
      const cards = document.querySelectorAll(".doc-suggest-card");
      for (const card of cards) {
        const heading = card.querySelector(".doc-suggest-card-title");
        if (card.getAttribute("data-suggestion-id") === id && heading !== null) {
          heading.focus(); return;
        }
      }
      const heading = document.querySelector(".doc-suggest-heading");
      if (heading !== null) heading.focus();
    });
  }

  function nextSuggestionId(id) {
    const index = suggestions.findIndex((record) => record.id === id);
    return index >= 0 && index + 1 < suggestions.length ? suggestions[index + 1].id : null;
  }

  async function runAction(record, action, reason) {
    if (mutationActive !== null || !suggestionOpen) return;
    if (action === "reject" && (!isNote(reason) || reason.length === 0)) {
      setSuggestionMessage("Enter a reason before rejecting.");
      return;
    }
    beginWrite(record.aid);
    const result = await mutationFetch("/api/suggestion", {
      docId, aid: record.aid, sugId: record.id, action, reason,
    }, record.id);
    endWrite(record.aid);
    finishDeferredPending();
    if (!suggestionOpen) return;
    if (result.response !== null && terminalResponse(result.response.status, result.value)) {
      terminalSuggestions(); return;
    }
    if (result.response !== null && result.response.status === 200) {
      if ((action === "reject" || action === "withdraw") && exactKeys(result.value, ["ok"]) && result.value.ok === true) {
        const nextId = nextSuggestionId(record.id);
        removeSuggestion(record.id);
        suggestionMessage = "";
        rejectDraft = null;
        repaintSuggestions();
        focusSuggestion(nextId);
        return;
      }
      if (action === "accept" && await applyAcceptance(record, result.value)) return;
    }
    if (result.response !== null && result.response.status === 404) {
      const nextId = nextSuggestionId(record.id);
      removeSuggestion(record.id);
      suggestionMessage = "This suggestion is no longer available.";
      repaintSuggestions();
      focusSuggestion(nextId);
      return;
    } else if (result.response !== null && result.response.status === 409 &&
        exactError(result.value, "conflict", "The block changed since this document was built", true)) {
      if (await applyConflictCurrent(record.aid, result.value)) {
        record.state = "superseded";
        suggestionEpoch += 1;
        suggestionMessage = "The block changed. Re-propose against the current text.";
      } else suggestionMessage = "The suggestion change was not saved.";
    } else suggestionMessage = "The suggestion change was not saved.";
    repaintSuggestions();
    focusSuggestion(record.id);
  }

  function removeSuggestion(id) {
    const next = suggestions.filter((record) => record.id !== id);
    if (next.length !== suggestions.length) {
      suggestions = next;
      suggestionEpoch += 1;
    }
  }

  async function applyAcceptance(record, body) {
    if (!exactKeys(body, ["receipt", "pr"])) return false;
    const receipt = validApplyReceipt(body.receipt, record.aid);
    if (receipt === null || receipt.sugId !== record.id || receipt.text !== record.text ||
        body.pr !== receipt.pr || !sameActor(receipt.by, record.by)) return false;
    const element = byAid.get(record.aid);
    if (element === undefined || !element.isConnected || activeEditor === record.aid) return false;
    paint(element, receipt.text);
    element.classList.add(PENDING_CLASS);
    removeSuggestion(record.id);
    try { applyLocalBase(record.aid, (await effectiveBase(element)).hash); } catch (error) { /* next GET repairs */ }
    suggestionMessage = body.pr === null ? "Applied" : "Pending repository review";
    announce([record.aid]);
    repaintSuggestions();
    focusSuggestion(record.id);
    return true;
  }

  function terminalSuggestions() {
    if (!suggestionOpen) return;
    suggestionOpen = false;
    suggestionGeneration += 1;
    pendingGeneration += 1;
    suggestionEpoch += 1;
    suggestionDirty = false;
    pendingDirty = false;
    pendingDeferred = false;
    abortRead(suggestionActive);
    abortRead(pendingActive);
    abortRead(mutationActive);
    suggestions = [];
    draft = null;
    rejectDraft = null;
    removeSuggestionChrome();
    for (const controls of controlSets.values()) {
      if (controls.suggestButton !== null && controls.suggestButton.parentNode !== null) {
        controls.suggestButton.parentNode.removeChild(controls.suggestButton);
      }
    }
    try { panelSurface.refresh(); } catch (error) { /* contained */ }
  }

  function refreshSuggestions() {
    if (!suggestionOpen || suspended) return Promise.resolve(false);
    if (suggestionActive !== null) {
      suggestionDirty = true;
      return suggestionActive.promise;
    }
    const generation = ++suggestionGeneration;
    const epoch = suggestionEpoch;
    const controller = new AbortController();
    const active = { controller, reader: null, promise: null };
    suggestionActive = active;
    active.promise = (async () => {
      const timer = setTimeout(() => controller.abort(), OVERLAY_TIMEOUT_MS);
      try {
        const endpoint = new URL("/api/suggestions", location.href);
        endpoint.searchParams.set("doc", docId);
        const response = await fetch(endpoint, {
          method: "GET", mode: "same-origin", credentials: "same-origin", cache: "no-store",
          redirect: "error", headers: { Accept: "application/json" }, signal: controller.signal,
        });
        const body = await boundedJson(response, READ_LIMIT, active);
        if (terminalResponse(response.status, body)) {
          terminalSuggestions();
          return false;
        }
        if (response.status !== 200) throw new Error("read failed");
        const model = validSuggestionList(body);
        if (model === null) throw new Error("invalid model");
        if (!suggestionOpen || suspended || generation !== suggestionGeneration || epoch !== suggestionEpoch) return false;
        suggestions = model;
        suggestionMessage = "";
        repaintSuggestions();
        return true;
      } catch (error) {
        if (suggestionOpen && !suspended && generation === suggestionGeneration) {
          suggestionMessage = "Suggestions could not be loaded.";
          repaintSuggestions();
        }
        return false;
      } finally {
        clearTimeout(timer);
        if (suggestionActive === active) suggestionActive = null;
        const trailing = suggestionDirty;
        suggestionDirty = false;
        if (trailing && suggestionOpen && !suspended) queueMicrotask(() => { void refreshSuggestions(); });
      }
    })();
    return active.promise;
  }

  function validServerEvent(event) {
    try {
      const detail = event === null ? null : event.detail;
      return exactFrozen(detail, ["source", "t", "aid", "hash"]) &&
        detail.source === "server" && detail.t === "edit.saved" &&
        typeof detail.aid === "string" && AID.test(detail.aid) &&
        typeof detail.hash === "string" && HASH.test(detail.hash);
    } catch (error) {
      return false;
    }
  }

  function reconcile() {
    if (suspended || !suggestionOpen) return;
    void refreshPending();
    void refreshSuggestions();
  }

  function suspendReconciliation() {
    suspended = true;
    pendingGeneration += 1;
    suggestionGeneration += 1;
    pendingDirty = false;
    pendingDeferred = false;
    suggestionDirty = false;
    abortRead(pendingActive);
    abortRead(suggestionActive);
  }

  function resumeReconciliation(event) {
    let persisted = false;
    try { persisted = event.persisted === true; } catch (error) { return; }
    if (!persisted) return;
    suspended = false;
    if (document.visibilityState === "visible") reconcile();
  }

  /* ------------------------------------------------------------ composition */

  let settle = null;
  const overlaysReady = new Promise((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const finish = (applied, available) => {
    if (settled) return;
    settled = true;
    settle(Object.freeze({ applied: Object.freeze(applied), available }));
  };

  window.doc.edit = Object.freeze({ overlaysReady });

  let started = false;
  document.addEventListener("session", (event) => {
    if (started) return;
    let session = null;
    try { session = validSession(event === null ? null : event.detail); } catch (error) { session = null; }
    if (session === null) {
      // The reveal happened but this module cannot read it. Staying pending
      // would strand P4-Q on a promise nothing will ever settle, so the pass
      // ends here with the built text intact.
      started = true;
      finish([], false);
      return;
    }
    started = true;
    currentSession = session;
    void (async () => {
      pendingApplied = [];
      let available = false;
      try {
        available = await refreshPending();
      } catch (error) {
        available = false;
      }
      // The barrier settles before anything else observes the pass, and it
      // never rejects: a failed read is an empty overlay, not a broken page.
      finish(pendingApplied, available);

      const sharedReady = typeof TextEncoder === "function" && typeof crypto === "object" &&
        crypto !== null && crypto.subtle !== null &&
        typeof crypto.subtle === "object" && typeof crypto.subtle.digest === "function";
      if (!sharedReady) return;

      const surfaces = typeof TextDecoder === "function" ? suggestionSurfaces() : null;
      if (surfaces !== null) {
        railSurface = surfaces.rail;
        panelSurface = surfaces.panel;
        try {
          suggestionOpen = panelSurface.register("suggestion", renderSuggestions) === true;
        } catch (error) {
          suggestionOpen = false;
        }
      }

      for (const block of blocks) {
        if (!block.element.isConnected || !isSuggestionText(editableText(block.element))) continue;
        const wantSuggest = suggestionOpen && session.canSuggest;
        const wantEdit = session.canEdit;
        if (!wantSuggest && !wantEdit) continue;
        const controls = makeControls(block, wantSuggest, wantEdit);
        controlSets.set(block.aid, controls);
        if (controls.editButton !== null) attachDirect(block, controls);
        if (controls.suggestButton !== null) {
          controls.suggestButton.addEventListener("click", () => {
            if (draft !== null || mutationActive !== null) return;
            void openDraft(block.aid, controls.suggestButton);
          });
        }
      }

      if (suggestionOpen) {
        document.addEventListener("doc:event", (hint) => {
          if (validServerEvent(hint)) reconcile();
        });
        document.addEventListener("visibilitychange", () => {
          if (!suggestionOpen || suspended || document.visibilityState !== "visible") return;
          const now = performance.now();
          if (lastVisibilityRefresh !== null && now - lastVisibilityRefresh < VISIBILITY_WINDOW_MS) return;
          lastVisibilityRefresh = now;
          reconcile();
        });
        await refreshSuggestions();
      }
    })();
  });
}
