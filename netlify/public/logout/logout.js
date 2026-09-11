/*
 * The /logout page's behaviour: obtain the session-bound CSRF token, then
 * submit the real sign-out form.
 *
 * One request, to `/api/hosted/session`, same-origin — the same one the splash
 * nav makes, and for the same reason: the sign-out route's token is derived
 * from an `HttpOnly` cookie, so a JSON body is the only shape a page can read
 * it in. The answer decides which of the two panels the page shows, and nothing
 * else on the page depends on it.
 *
 * The submit happens here rather than waiting for a click because visiting the
 * URL *is* the request to be signed out. It is still a form navigation the
 * visitor's own browser performs from this origin, carrying the token: a
 * third-party page that embeds this URL loads this page in its own frame or
 * image slot and gets nothing — the framing denial and the `HttpOnly` cookie's
 * `SameSite` rule mean no token is ever read there, so no POST is ever made.
 * That is what keeps a hittable address from becoming a CSRF sign-out.
 *
 * `form.submit()` rather than `button.click()`: the form is submitted once, and
 * a programmatic click would run the submit handlers of a page that has none.
 */
(function () {
  "use strict";
  var form = document.getElementById("logout");
  var csrf = document.getElementById("csrf");
  var signedOut = document.getElementById("signed-out");
  var status = document.getElementById("status");
  if (!form || !csrf || !signedOut || !status) return;

  function say(text, tone) {
    status.textContent = text;
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
  }

  /* Shown when the session route could not be reached. The form stays hidden:
     without a token the route refuses the post, and a visitor who is told the
     sign-out failed can reload, which is the one action that could work. */
  function unavailable() {
    signedOut.hidden = true;
    form.hidden = true;
    say("Archon could not check your session just now. Reload to try again.", "error");
  }

  function showSignedOut() {
    form.hidden = true;
    signedOut.hidden = false;
    say("");
  }

  function signOut(token) {
    csrf.value = token;
    signedOut.hidden = true;
    form.hidden = false;
    say("");
    /* The button is the fallback for a browser that will not run this line;
       everywhere else the navigation starts now. */
    form.submit();
  }

  fetch("/api/hosted/session", {
    credentials: "same-origin",
    headers: { accept: "application/json" }
  })
    .then(function (response) {
      if (!response.ok) throw new Error("unavailable");
      return response.json();
    })
    .then(function (session) {
      var token =
        session !== null &&
        typeof session === "object" &&
        session.authenticated === true &&
        typeof session.csrfToken === "string"
          ? session.csrfToken
          : "";
      if (token === "") showSignedOut();
      else signOut(token);
    })
    .catch(unavailable);
})();
