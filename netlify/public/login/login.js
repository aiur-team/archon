/*
 * The sign-in bootstrap.
 *
 * It has exactly one responsibility: obtain the pre-login CSRF binding by
 * calling `GET /api/hosted/session`, which issues it as a `__Host-` cookie, and
 * put the page into a state that matches the answer. It handles no credential,
 * touches no provider endpoint and reads no cookie — it cannot, since every
 * cookie this deployment sets is HttpOnly.
 *
 * Everything it reports goes through one live region so a screen reader
 * announces state changes, and every failure leaves a button the visitor can
 * press again. A failed bootstrap must never silently fall through to a sign-in
 * attempt: the attempt would be refused, and a refusal the visitor did not cause
 * is not an actionable retry path.
 */
(() => {
  "use strict";

  const form = document.getElementById("signin");
  const submit = document.getElementById("submit");
  const status = document.getElementById("status");
  const account = document.getElementById("account");
  const accountText = document.getElementById("account-text");
  const csrf = document.getElementById("csrf");

  /* The same three shapes the server allows, checked here too so a hostile link
     cannot even put a rejected value into the form: `/publish/authorize`, a
     `/docs/<32 hex>` document, and a single collaboration slug that is not a
     reserved route name. The server validates it again and is the authority;
     this is only about not submitting garbage. */
  const RESERVED = new Set(["login", "invite", "publish", "docs", "api", "_assets", "_render"]);
  function destinationAllowed(value) {
    if (value === "/publish/authorize") return true;
    if (/^\/docs\/[0-9a-f]{32}$/.test(value)) return true;
    const slug = /^\/([a-z0-9-]{1,64})\/$/.exec(value);
    return slug !== null && !RESERVED.has(slug[1]);
  }

  /* The closed set of words the callback may land back here with. Anything else
     in the URL is ignored rather than rendered, so the query string cannot
     become a way to put chosen text on a trusted page. */
  const LANDING = {
    denied: "You cancelled the sign-in. You can try again.",
    expired: "That sign-in attempt expired or could not be verified. Please try again.",
    unavailable: "Archon could not reach the sign-in service just now. Please try again in a moment.",
  };

  function say(message, tone) {
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function applyDestination() {
    const wanted = new URL(window.location.href).searchParams.get("destination");
    if (wanted === null || !destinationAllowed(wanted)) return;
    for (const id of ["destination", "switch-destination"]) {
      document.getElementById(id).value = wanted;
    }
  }

  async function bootstrap() {
    submit.disabled = true;
    say("Preparing sign-in…", "pending");
    let session;
    try {
      const response = await fetch("/api/hosted/session", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("unavailable");
      session = await response.json();
    } catch {
      /* The button becomes the retry rather than a second control, so there is
         one thing to press and it is the one already focused. */
      say("Archon is not reachable right now. Select Try again.", "error");
      submit.textContent = "Try again";
      submit.disabled = false;
      form.dataset.mode = "retry";
      return;
    }

    form.dataset.mode = "signin";
    submit.textContent = "Sign in";
    submit.disabled = false;

    if (session.authenticated === true) {
      accountText.textContent = `You are signed in to Archon as @${session.login}.`;
      csrf.value = session.csrfToken;
      account.hidden = false;
      say("Continue to authorise, or choose a different account.", "ok");
      return;
    }
    account.hidden = true;
    const landing = LANDING[new URL(window.location.href).searchParams.get("status")];
    if (landing !== undefined) say(landing, "error");
    else say("", "ok");
  }

  form.addEventListener("submit", (event) => {
    if (form.dataset.mode === "retry") {
      event.preventDefault();
      bootstrap();
    }
  });

  applyDestination();
  bootstrap();
})();
