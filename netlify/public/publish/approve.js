/*
 * The typeable approve page's bootstrap.
 *
 * One job: take a pairing code from a signed-in person, hand it to
 * `POST /api/hosted/publications/claim`, and on success send them to the
 * approval page with the binding the server just issued.
 *
 * ## One refusal, on purpose
 *
 * The server answers a wrong code, an unknown code, an already-decided
 * publication and one somebody else claimed with the same `not_found`, so this
 * file has one message for all of them. Reporting anything finer would rebuild
 * on the client the existence oracle the server refused to be - a signed-in
 * visitor could otherwise sit here typing codes and learn which ones name a real
 * publication. Only a storage outage is reported differently, because "Archon is
 * down" is not a fact about anybody's publication.
 *
 * ## The code is not logged, stored or put in a URL
 *
 * It goes into one request body and is cleared from the field afterwards. It is
 * never written to `sessionStorage`, never appended as a query parameter and
 * never echoed back into the status line: a code in an address bar is a code in
 * history, in a screen share and in a synced bookmark.
 *
 * There is no `innerHTML` in this file.
 */
(() => {
  "use strict";

  const status = document.getElementById("status");
  const form = document.getElementById("code-form");
  const field = document.getElementById("code");
  const submit = document.getElementById("submit");
  const signin = document.getElementById("signin");

  /** The key the approval page reads its publication id from. */
  const STORAGE_KEY = "archon.publish.pending";

  /** The account and token the page last read, and will act as. */
  let session = null;

  function say(message, tone) {
    status.textContent = message;
    status.dataset.tone = tone;
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
    form.hidden = true;
    signin.hidden = false;
    say("Sign in first, then type the code your agent gave you.", "ok");
  }

  async function start() {
    say("Checking…", "pending");
    form.hidden = true;
    signin.hidden = true;

    session = await readSession();
    if (session === null) {
      say("Archon is not reachable right now. Reload this page.", "error");
      return;
    }
    if (session.authenticated !== true) return askToSignIn();

    form.hidden = false;
    say("Type the pairing code your agent printed.", "ok");
    field.focus();
  }

  async function find(event) {
    event.preventDefault();
    const typed = field.value;
    if (typed.trim() === "") {
      say("Type the pairing code your agent printed.", "error");
      field.focus();
      return;
    }

    submit.disabled = true;
    say("Checking that code…", "pending");

    const answer = await call("/api/hosted/publications/claim", {
      method: "POST",
      headers: { "content-type": "application/json", "x-archon-csrf": session.csrfToken },
      body: JSON.stringify({ userCode: typed }),
    });

    /* Cleared whether or not it worked: a correct code has been spent on a
       binding, and an incorrect one has no reason to stay on the screen. */
    field.value = "";
    submit.disabled = false;

    if (!answer.ok) {
      const code = codeOf(answer);
      if (code === "session_required") return askToSignIn();
      if (code === "unavailable") {
        say("Archon is not reachable right now. Try that code again in a moment.", "error");
        return;
      }
      /* The one refusal. See the note at the top of this file: the server does
         not distinguish these cases and neither may this page. */
      say(
        "That code does not match a publication waiting for you. Check it with your agent, " +
          "or ask it to start the publication again.",
        "error",
      );
      field.focus();
      return;
    }

    try {
      window.sessionStorage.setItem(STORAGE_KEY, answer.body.publicationId);
    } catch {
      /* The approval page will say it is holding no pending publication, and
         this page is one Back press away. Not navigating would be worse: the
         binding has already been issued. */
    }
    window.location.assign("/publish/authorize");
  }

  form.addEventListener("submit", find);

  start();
})();
