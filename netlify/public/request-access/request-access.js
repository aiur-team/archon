/*
 * The request-access form's behaviour.
 *
 * It posts JSON rather than submitting as a form, for the same reason the
 * sign-in and invite forms do: `application/json` is a media type a cross-origin
 * form cannot send without a preflight, and a `fetch` carries a real `Origin`
 * header the route checks exactly. The body is only the note — the address the
 * request is attributed to is the verified one the sign-in left in a one-time
 * cookie, read server-side, so this page never sends and never sees it.
 *
 * The page tells the visitor nothing the server did not say, and the server
 * answers the same thing whoever asks, so there is no membership answer to read
 * out of it.
 */
(function () {
  "use strict";
  var form = document.getElementById("request");
  var message = document.getElementById("message");
  var submit = document.getElementById("submit");
  var status = document.getElementById("status");
  if (!form || !message || !submit || !status) return;

  function say(text, tone) {
    status.textContent = text;
    status.dataset.tone = tone;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    submit.disabled = true;
    say("Sending…", "pending");

    fetch("/api/hosted/access-request", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ v: 1, message: message.value })
    })
      .then(function (response) {
        return response.json().catch(function () { return null; }).then(function (body) {
          if (response.ok) {
            form.reset();
            /* Leave the button disabled after success: one request is enough,
               and a second is only ever a duplicate for the same operator. */
            say("Thanks — an administrator will be in touch.", "ok");
            return;
          }
          submit.disabled = false;
          var detail = body && body.error && body.error.message;
          say(detail || "That request could not be sent. Please try again later.", "error");
        });
      })
      .catch(function () {
        submit.disabled = false;
        say("That request could not be sent. Please try again later.", "error");
      });
  });
})();
