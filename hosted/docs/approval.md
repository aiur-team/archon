# Approving a publication

An agent asked to publish one document. Archon will not publish it until you say
so, on a page served by Archon, while signed in to the GitHub account that will
own it.

This page explains what you are being asked, what Archon can and cannot tell
you, and what each outcome means.

## What happens

1. Your agent prints a link ending in `/publish/authorize#…` and a short pairing
   code. Only the browser you open that link in can approve this publication.
2. Opening the link removes the token from the address bar immediately and
   exchanges it with Archon for a cookie. From that point the token is gone from
   your history, your bookmarks and anything you screen-share.
3. Archon asks you to sign in with GitHub, if you have not already. It requests
   no repository, organisation or email permission, sees no password, and
   discards GitHub's tokens as soon as it has confirmed who you are.
4. You see the document's title, its exact size, the pairing code, and the
   account that will own it.
5. You press **Approve** or **Deny**. Nothing is written either way until you do.

## Check the pairing code

The code on the page must be the code your agent printed.

Archon cannot tell you *which* program asked. Anyone who can reach the service
can start a publication and choose any title they like, so a familiar-looking
title is not evidence and a claim to be a particular tool is not evidence. The
pairing code is the one thing that ties the page in front of you to the process
that printed the link. If the two do not match, deny.

Archon has no lookup by code: you cannot type it in, and nobody can use it to
find your publication. It exists only to be compared.

## The account is the owner

Whatever account the page names is the account that will own the document,
permanently. It is your GitHub account's numeric id that decides this, not your
username, so renaming your GitHub account later keeps your documents and taking
over somebody's old username does not.

If the wrong account is shown, choose **Use a different GitHub account**. That
signs you out of Archon — not out of GitHub — asks GitHub which account to use,
and returns you to this same pending publication. Your approval is still
waiting.

If the account changes between the page loading and your click, Archon refuses
the decision rather than publishing under the new one. The click meant "publish
as the account I can see".

## What Archon does not do here

- It does not show you the document. The artifact is arbitrary HTML from an
  agent; it is only ever rendered on a separate origin that holds no account
  cookie, and never on this page.
- It does not check the document. Archon does not claim to have inspected or
  sanitised what an agent produced.
- It does not let you choose an owner, share the document, or grant anyone
  standing permission. Approving publishes one document, once.

## Outcomes

| What you see | What it means |
| --- | --- |
| **Approved** | The owner is fixed and your agent has ten minutes to upload the exact document it described. Nothing else can be uploaded in its place. |
| **Denied** | Nothing was published, and nothing can be. The request is over. |
| **The agent cancelled this publication** | Your agent withdrew the request before you answered. |
| **This request expired** | Fifteen minutes passed before it was approved. Ask your agent to start again; nothing was published. |
| **This document is already published** | The upload finished. Your agent has the link. |
| **No pending publication** | This browser is not holding a request — the link was already answered, it expired, or it was opened in a different browser. Open the link your agent printed again, on this device. |
| **This link cannot be used** | The token in the link does not match any waiting publication. Ask your agent for a new one. |
| **Archon is not reachable** | A temporary fault. Nothing was decided; select **Try again**. |

Denial, cancellation and expiry are all normal answers. Your agent is told which
one happened, and none of them is a failure you need to retry.

## One publication per browser at a time

The page holds a single pending request. Opening a second link replaces the
first, and the first then reads as "no pending publication" — it is not denied,
so its agent still sees it as waiting until it expires. Answer one before
opening the next.

## If JavaScript is off

The page cannot work. The one-time token has to be exchanged with Archon before
anything can be shown, and there is no way to do that from a static document.
The page says so rather than presenting a button that would be refused.
