/* Session probe — the one silent capability reveal.
   Loading, signed out, malformed, and degraded states are visually identical
   to the static document: nothing is created, logged, or announced until a
   valid 200 response passes the exact content-type grammar and the session
   shape check below.  That one success sets data-session on the root and
   publishes the same recursively frozen parsed object to every module that
   attached its listener before this final script ran. */
document.documentElement.removeAttribute("data-session");
runSessionProbe();

/* Pure parser for the single accepted content-type grammar:
   OWS "application" "/" "json" OWS [ ";" OWS "charset" "=" ( "utf-8" |
   DQUOTE "utf-8" DQUOTE ) OWS ], ASCII-case-insensitive, OWS = SP/HTAB. */
function isJsonContentType(value) {
  if (typeof value !== "string") return false;
  const bytes = value;
  const length = bytes.length;
  let at = 0;
  const ows = () => {
    while (at < length) {
      const code = bytes.charCodeAt(at);
      if (code === 32 || code === 9) at += 1;
      else return;
    }
  };
  const lower = (code) => (code >= 65 && code <= 90 ? code + 32 : code);
  const word = (expected) => {
    if (at + expected.length > length) return false;
    for (let i = 0; i < expected.length; i += 1) {
      if (lower(bytes.charCodeAt(at)) !== expected.charCodeAt(i)) return false;
      at += 1;
    }
    return true;
  };
  const atEnd = () => at === length;

  ows();
  if (!word("application")) return false;
  if (at >= length || bytes.charCodeAt(at) !== 47) return false;
  at += 1;
  if (!word("json")) return false;
  ows();
  if (atEnd()) return true;
  if (bytes.charCodeAt(at) !== 59) return false;
  at += 1;
  ows();
  if (!word("charset")) return false;
  if (at >= length || bytes.charCodeAt(at) !== 61) return false;
  at += 1;
  if (at < length && bytes.charCodeAt(at) === 34) {
    at += 1;
    if (!word("utf-8")) return false;
    if (at >= length || bytes.charCodeAt(at) !== 34) return false;
    at += 1;
  } else {
    if (!word("utf-8")) return false;
  }
  ows();
  return atEnd();
}

const RESERVED_FINAL_FIELDS = [
  "doc", "role", "shared", "canSuggest", "canAccept", "canShare", "canSeeMembers",
];
const ROLES = ["owner", "editor", "commenter", "viewer", "none"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isContainer(value) {
  return value !== null && typeof value === "object";
}

/* Accept exactly one of two shapes.  Presence of any reserved final field
   commits to the complete P3-H shape and rejects every partial or mixed body;
   zero reserved fields selects the legacy P1-C shape. */
function validSession(body, docId) {
  if (!isRecord(body)) return null;
  let reservedPresent = 0;
  for (const field of RESERVED_FINAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) reservedPresent += 1;
  }
  if (typeof body.sub !== "string") return null;
  if (typeof body.email !== "string") return null;
  if (typeof body.name !== "string") return null;
  /* `roles` used to be checked here. It carried one of `member` or `guest`,
     derived from a site-wide organisation email suffix, and it was never
     authorization -- the document role below is. ACN-006 removed the suffix
     rule, which left the field with nothing to report, so it is gone from the
     body rather than always saying `guest`. A field that is always the same
     value is one a client eventually believes. */
  if (typeof body.canComment !== "boolean") return null;
  if (typeof body.canEdit !== "boolean") return null;
  if (reservedPresent === 0) return body;

  if (reservedPresent !== RESERVED_FINAL_FIELDS.length) return null;
  if (body.doc !== docId) return null;
  if (!ROLES.includes(body.role)) return null;
  if (typeof body.shared !== "boolean") return null;
  if (typeof body.canSuggest !== "boolean") return null;
  if (typeof body.canAccept !== "boolean") return null;
  if (typeof body.canShare !== "boolean") return null;
  if (typeof body.canSeeMembers !== "boolean") return null;
  return body;
}

/* Iterative deepest-first freeze over the parsed tree, never the call stack.
   JSON cannot carry cycles, so a plain work stack is exact for its domain. */
function deepFreeze(root) {
  if (!isContainer(root)) return root;
  const stack = [root];
  const ordered = [];
  while (stack.length > 0) {
    const current = stack.pop();
    ordered.push(current);
    for (const field of Object.keys(current)) {
      const child = current[field];
      if (isContainer(child)) stack.push(child);
    }
  }
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    Object.freeze(ordered[i]);
  }
  return root;
}

async function runSessionProbe() {
  const protocol = location.protocol;
  if (protocol !== "http:" && protocol !== "https:") return;

  const meta = document.querySelector('meta[name="doc-id"]');
  const content = meta === null ? null : meta.getAttribute("content");
  const docId = typeof content === "string" ? content.trim() : "";
  if (docId === "") return;

  if (typeof fetch !== "function"
    || typeof AbortController !== "function"
    || typeof CustomEvent !== "function"
    || typeof URL !== "function") {
    return;
  }

  const endpoint = new URL("/api/session", location.href);
  endpoint.searchParams.set("doc", docId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      mode: "same-origin",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status !== 200) return;
    const header = response.headers.get("content-type");
    if (header === null) return;
    if (!isJsonContentType(header)) return;
    const body = await response.json();
    const session = validSession(body, docId);
    if (session === null) return;
    deepFreeze(session);
    const maySuggest = Object.prototype.hasOwnProperty.call(session, "canSuggest")
      ? session.canSuggest
      : session.canEdit;
    document.documentElement.dataset.session = maySuggest ? "editor" : "reader";
    document.dispatchEvent(new CustomEvent("session", { detail: session }));
  } catch (error) {
    return;
  } finally {
    clearTimeout(timer);
  }
}
