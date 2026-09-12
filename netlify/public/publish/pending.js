/*
 * The pending list's bootstrap.
 *
 * Three requests and no decisions: read the session, ask what is waiting, and -
 * when the visitor presses Approve on a row - ask the claim route to re-issue
 * the browser binding for that publication before handing them to the approval
 * page. Nothing here approves anything, and nothing here chooses what may be
 * listed: the server filters on the claimant account and this file renders what
 * comes back.
 *
 * ## Why the Approve button calls the claim route at all
 *
 * The `__Host-archon_publish` binding lives for fifteen minutes and is bound to
 * one browser. The whole reason somebody is on this page is that they no longer
 * have it - different device, expired cookie, closed tab. So the button asks the
 * server to issue a fresh one for a publication this account has *already*
 * claimed, which is the third of the three proofs `claimPublication` accepts and
 * needs no capability the person does not already hold. If the claim is refused
 * the page says so and re-reads the list rather than navigating to an approval
 * screen that would have nothing to show.
 *
 * ## The handoff to /publish/authorize
 *
 * The approval page reads the publication id it is working on out of
 * `sessionStorage`, because a sign-in round trip loses everything else. This
 * page writes the same key before navigating, so the two agree without a query
 * string - the contract path carries no parameters, and an id in a URL would be
 * one more place it is written down.
 *
 * There is no `innerHTML` in this file. Every value that came from an agent is
 * written with `textContent`.
 */
(() => {
  "use strict";

  const status = document.getElementById("status");
  const retryRow = document.getElementById("retry-row");
  const retry = document.getElementById("retry");
  const list = document.getElementById("list");
  const rowTemplate = document.getElementById("row");
  const signin = document.getElementById("signin");

  /** The key the approval page reads its publication id from. */
  const STORAGE_KEY = "archon.publish.pending";

  function say(message, tone, { retryable = false } = {}) {
    status.textContent = message;
    status.dataset.tone = tone;
    retryRow.hidden = !retryable;
  }

  function clearList() {
    while (list.firstChild !== null) list.removeChild(list.firstChild);
  }

  /**
   * A byte count with thousands separators.
   *
   * Grouped by hand rather than through `toLocaleString`, exactly as the
   * approval page does it: the number beside a document about to be published
   * under someone's name should read the same everywhere.
   */
  function bytes(count) {
    return `${String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} bytes`;
  }

  /**
   * A deadline in the reader's own clock, with the minutes left beside it.
   *
   * The stored instant is UTC and a person cannot act on UTC. `toLocaleString`
   * is right here and wrong for the byte count above, because this value is
   * about the visitor's day rather than about comparing two screenshots.
   */
  function deadline(iso) {
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return "soon";
    const minutes = Math.max(0, Math.round((at - Date.now()) / 60000));
    const clock = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `${clock} — about ${minutes} ${minutes === 1 ? "minute" : "minutes"} left`;
  }

  /** One JSON call, returning `{ok, status, body}` and never throwing. */
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

  function codeOf(answer) {
    const code = answer.body?.error?.code;
    return typeof code === "string" ? code : "unavailable";
  }

  async function readSession() {
    const answer = await call("/api/hosted/session");
    return answer.ok && answer.body !== null ? answer.body : null;
  }

  function askToSignIn() {
    clearList();
    say("Sign in to see what is waiting for you.", "ok");
    signin.hidden = false;
  }

  /** Hand this publication to the approval page, which owns the decision. */
  function openApproval(publicationId) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, publicationId);
    } catch {
      /* The approval page can still be reached; it will say it is holding no
         pending publication, and this page is one Back press away. Refusing to
         navigate would be worse: the binding has already been issued. */
    }
    window.location.assign("/publish/authorize");
  }

  /**
   * Re-issue the binding for a row, then open the approval page.
   *
   * The id is sent with no other proof on purpose: the server accepts it only
   * because this account is already the claimant, which is a fact it looked up
   * rather than one this page asserted.
   */
  async function open(publicationId, session, button) {
    button.disabled = true;
    say("Opening…", "pending");
    const answer = await call("/api/hosted/publications/claim", {
      method: "POST",
      headers: { "content-type": "application/json", "x-archon-csrf": session.csrfToken },
      body: JSON.stringify({ publicationId }),
    });
    if (!answer.ok) {
      button.disabled = false;
      const code = codeOf(answer);
      if (code === "session_required") return askToSignIn();
      say(
        code === "unavailable"
          ? "Archon is not reachable right now. Select Try again."
          : "This publication is no longer waiting for you.",
        "error",
        { retryable: true },
      );
      return;
    }
    openApproval(answer.body.publicationId);
  }

  function renderRow(entry, session) {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".row-title").textContent = entry.title;
    row.querySelector(".row-size").textContent = bytes(entry.contentBytes);
    row.querySelector(".row-code").textContent = entry.userCode;
    row.querySelector(".row-expiry").textContent = deadline(entry.expiresAt);
    const button = row.querySelector(".row-open");
    button.addEventListener("click", () => open(entry.publicationId, session, button));
    list.appendChild(row);
  }

  async function start() {
    say("Checking…", "pending");
    signin.hidden = true;
    clearList();

    const session = await readSession();
    if (session === null) {
      say("Archon is not reachable right now. Select Try again.", "error", { retryable: true });
      return;
    }
    if (session.authenticated !== true) return askToSignIn();

    const answer = await call("/api/hosted/publications/pending");
    if (!answer.ok) {
      const code = codeOf(answer);
      if (code === "session_required") return askToSignIn();
      say("Archon could not list your publications. Select Try again.", "error", {
        retryable: true,
      });
      return;
    }

    const entries = Array.isArray(answer.body?.publications) ? answer.body.publications : [];
    if (entries.length === 0) {
      say(
        "Nothing is waiting for you. When an agent asks to publish, it appears here.",
        "ok",
      );
      return;
    }
    say(
      entries.length === 1
        ? "One publication is waiting for your approval."
        : `${entries.length} publications are waiting for your approval.`,
      "ok",
    );
    for (const entry of entries) renderRow(entry, session);
  }

  retry.addEventListener("click", () => start());

  start();
})();
