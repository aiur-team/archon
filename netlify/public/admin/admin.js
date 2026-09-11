/*
 * The admin console's behaviour.
 *
 * The page it runs on is byte-identical for every admin and holds no data, so
 * everything here is a fetch against a route that authorises independently. Two
 * rules shape the whole file:
 *
 *  - **Text is set through `textContent`, never through `innerHTML`.** Every
 *    value rendered here comes from somewhere a person typed - a document title
 *    chosen by an agent, an address typed by an admin - and the one reliable way
 *    to keep that from being markup is to never have a parser involved. There is
 *    no string of HTML built in this file.
 *  - **Every mutation carries the session-derived CSRF token.** It comes from
 *    `/api/hosted/session`, which derives it from the session cookie the browser
 *    already holds, so it cannot be minted by a page that does not have one.
 */

(() => {
  const documentsStatus = document.querySelector("[data-archon-documents-status]");
  const documentsTable = document.querySelector("[data-archon-documents]");
  const documentsBody = document.querySelector("[data-archon-documents-body]");
  const allowlistStatus = document.querySelector("[data-archon-allowlist-status]");
  const allowlistEntries = document.querySelector("[data-archon-allowlist-entries]");
  const allowlistForm = document.querySelector("[data-archon-allowlist-form]");
  const allowlistInput = document.querySelector("[data-archon-allowlist-input]");
  const allowlistAdd = document.querySelector("[data-archon-allowlist-add]");

  let csrfToken = null;

  function say(node, message, tone) {
    node.textContent = message;
    node.dataset.tone = tone;
    node.hidden = message === "";
  }

  /** A cell holding text, never markup. */
  function cell(row, text) {
    const td = document.createElement("td");
    td.textContent = text;
    row.append(td);
    return td;
  }

  /** An ISO instant as the reader's local date, or the raw value if unparseable. */
  function shortDate(value) {
    if (typeof value !== "string") return "—";
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? value : at.toLocaleString();
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /** The message from a C3 error envelope, or a fallback naming nothing. */
  function errorMessage(body, fallback) {
    const message = body?.error?.message;
    return typeof message === "string" && message !== "" ? message : fallback;
  }

  async function loadSession() {
    const response = await fetch("/api/hosted/session", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("unavailable");
    const session = await response.json();
    if (session.authenticated !== true) throw new Error("unavailable");
    csrfToken = session.csrfToken;
  }

  async function loadDocuments() {
    say(documentsStatus, "Loading…", "pending");
    let response;
    try {
      response = await fetch("/api/hosted/admin/documents", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
    } catch {
      say(documentsStatus, "Could not reach the server. Reload to try again.", "error");
      return;
    }
    const body = await readJson(response);
    if (!response.ok) {
      say(documentsStatus, errorMessage(body, "The document list is unavailable."), "error");
      return;
    }

    documentsBody.replaceChildren();
    const documents = Array.isArray(body?.documents) ? body.documents : [];
    for (const entry of documents) {
      const row = document.createElement("tr");
      if (entry.unreadable === true) {
        /* A record this version of the software cannot interpret. It is shown
           rather than omitted, and it is shown as what it is rather than as a
           document with an empty title. */
        cell(row, "(unreadable record)").dataset.tone = "error";
        cell(row, entry.documentId);
        cell(row, "—");
        cell(row, "—");
        cell(row, "—");
        cell(row, "—");
      } else {
        cell(row, entry.title);
        cell(row, entry.documentId);
        cell(row, entry.ownerEmail ?? entry.ownerAccountId ?? "(no owner yet)");
        cell(row, shortDate(entry.createdAt));
        cell(row, entry.state);
        cell(
          row,
          entry.allowedDomains?.length > 0
            ? entry.allowedDomains.join(", ")
            : "owner only",
        );
      }
      documentsBody.append(row);
    }

    documentsTable.hidden = documents.length === 0;
    const truncated = body?.truncated === true ? " (list truncated)" : "";
    say(
      documentsStatus,
      documents.length === 0
        ? "No documents yet."
        : `${documents.length} document${documents.length === 1 ? "" : "s"}${truncated}.`,
      "ok",
    );
  }

  function renderAllowlist(body) {
    allowlistEntries.replaceChildren();
    const entries = Array.isArray(body?.entries) ? body.entries : [];
    for (const entry of entries) {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.className = "entry-value";
      label.textContent = entry.value;
      item.append(label);

      const kind = document.createElement("span");
      kind.className = "entry-kind";
      kind.textContent = entry.kind === "domain" ? "whole domain" : "one address";
      item.append(kind);

      if (entry.source === "environment") {
        /* Seeded entries have no remove button, because the page cannot write to
           the environment and a control that appeared to work and did not is
           worse than no control. */
        const seeded = document.createElement("span");
        seeded.className = "entry-seeded";
        seeded.textContent = "set by ARCHON_PLATFORM_ALLOWLIST";
        item.append(seeded);
      } else {
        if (typeof entry.addedBy === "string" && entry.addedBy !== "") {
          const added = document.createElement("span");
          added.className = "entry-added";
          added.textContent = `added by ${entry.addedBy}${entry.addedAt === null ? "" : ` on ${shortDate(entry.addedAt)}`}`;
          item.append(added);
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => void edit("remove", entry.value));
        item.append(remove);
      }
      allowlistEntries.append(item);
    }

    const enforced = body?.enforced === true;
    say(
      allowlistStatus,
      entries.length === 0
        ? enforced
          ? "The allowlist is empty and enforced: only administrators can sign in."
          : "The allowlist is empty and is not being enforced."
        : enforced
          ? `${entries.length} entr${entries.length === 1 ? "y" : "ies"}. Sign-in is restricted to them.`
          : `${entries.length} entr${entries.length === 1 ? "y" : "ies"}, recorded but not enforced — set ARCHON_PLATFORM_ALLOWLIST_ENFORCED=true to enforce.`,
      enforced ? "ok" : "warn",
    );
  }

  async function loadAllowlist() {
    say(allowlistStatus, "Loading…", "pending");
    let response;
    try {
      response = await fetch("/api/hosted/admin/allowlist", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
    } catch {
      say(allowlistStatus, "Could not reach the server. Reload to try again.", "error");
      return;
    }
    const body = await readJson(response);
    if (!response.ok) {
      say(allowlistStatus, errorMessage(body, "The allowlist is unavailable."), "error");
      return;
    }
    renderAllowlist(body);
  }

  async function edit(action, entry) {
    if (csrfToken === null) {
      say(allowlistStatus, "Your session could not be confirmed. Reload the page.", "error");
      return;
    }
    allowlistAdd.disabled = true;
    say(allowlistStatus, action === "add" ? "Adding…" : "Removing…", "pending");
    let response;
    try {
      response = await fetch("/api/hosted/admin/allowlist", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-archon-csrf": csrfToken,
        },
        body: JSON.stringify({ v: 1, action, entry }),
      });
    } catch {
      allowlistAdd.disabled = false;
      say(allowlistStatus, "Could not reach the server. Try again.", "error");
      return;
    }
    allowlistAdd.disabled = false;
    const body = await readJson(response);
    if (!response.ok) {
      say(allowlistStatus, errorMessage(body, "That change was refused."), "error");
      return;
    }
    if (action === "add") allowlistInput.value = "";
    renderAllowlist(body);
  }

  allowlistForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const entry = allowlistInput.value.trim();
    if (entry === "") return;
    void edit("add", entry);
  });

  async function start() {
    try {
      await loadSession();
    } catch {
      say(allowlistStatus, "Your session could not be confirmed. Reload the page.", "error");
      say(documentsStatus, "Your session could not be confirmed. Reload the page.", "error");
      return;
    }
    await Promise.all([loadAllowlist(), loadDocuments()]);
  }

  void start();
})();
