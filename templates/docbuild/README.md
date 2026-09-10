# @aiur-team/docbuild

Compose an architecture doc into one self-contained HTML file, and publish it
to a hosted service with browser approval by a human. No runtime dependencies;
Node 18 or later is the only requirement.

A document is a directory holding a `doc.json` and a `sections/` directory of
HTML fragments. The builder inlines every stylesheet and script into a single
file you can open, email, or host as a static asset.

## Install

```sh
npm install @aiur-team/docbuild
```

## Start a document

The package ships the same skeleton the repository uses. Copy it, then edit
`doc.json` — at minimum give the document a fresh six-hex `id`
(`openssl rand -hex 3`), a `slug`, and a `title`.

```sh
cp -R node_modules/@aiur-team/docbuild/dist/skeleton my-doc
```

## Build it

```sh
npx docbuild my-doc
```

The result is `my-doc/dist/my-doc.html`, a single self-contained file. Output is
named after the instance **directory**, not the `slug` in `doc.json`; the two
are often the same name, and only the directory decides the filename. The CLI
prints the path it wrote — read that line rather than guessing.

Run `npx docbuild --help` for the full synopsis, including `--site`, which
composes every document under the current directory into a static site.

## Build it for private hosted reading

```sh
npx docbuild my-doc --hosted
```

`--hosted` is an explicit profile, never inferred from the environment, the
document URL, or where the package is installed. It writes a second file,
`my-doc/dist/my-doc.hosted.html`, and leaves the normal `my-doc.html` alone, so
the two can be built from the same source in either order.

The hosted artifact keeps everything a reader needs offline — the inline theme
and component CSS, your `extra.css` and `extra.js`, the theme toggle, section
navigation, open/closed section behaviour, the generated anchors, and the local
changelog client. It leaves out:

- the Google Fonts `preconnect` and stylesheet links, so the generated chrome
  makes no network request. Text falls back to the local `ui-monospace` and
  `system-ui` stacks the theme already names. Remote references you authored in
  your sections, `extra.css` or `extra.js` are left exactly as written and are
  not covered by this profile.
- the session, comment, edit, realtime, presence and share client code, and the
  styles for their controls. A hosted document is read privately by its owner
  through a renderer that offers none of those endpoints.

A hosted artifact is built on demand for one private upload; this repository does not commit them,
and neither should yours.

The library form is the same switch:

```js
import { build } from "@aiur-team/docbuild";

build(root, "my-doc", { hosted: true });
```

This profile is not an HTML sanitizer, and it does not claim to be one. Content
you authored stays exactly as you wrote it, including `extra.js` and any remote
image, font or script your sections reference. The builder never fetches those
references, and a strict host renderer may refuse to load them — the generated
chrome stays usable when it does. Do not describe a hosted artifact as having
comments or inline editing enabled: it does not.

## Publish it to a hosted service

The package ships a second command, `archon-publish`, which uploads a built
`--hosted` artifact to an Archon hosted service **after a human approves it in
a browser**. The agent or script running the command never signs in, never sees
a GitHub credential or a browser cookie, and never keeps an account login — it
holds one capability for the single publication it started, and nothing else.

Because a person has to approve it, publishing is deliberately split across
separate command invocations. `start` returns immediately with a link and a
pairing code; `resume` picks the same publication up later, in a different
process, and uploads once approval has happened.

```sh
npx archon-publish start \
  --file my-doc/dist/my-doc.hosted.html \
  --title "My document" \
  --service https://docs.example.com \
  --json
# → exit 10, and one JSON object naming the browser URL, the pairing code and
#   the request file to resume from.

# The human opens the URL, checks the pairing code matches, signs in, reads the
# title and byte count, and approves. Then:
npx archon-publish resume --request <requestFile> --json
# → exit 0 and the server's receipt, including the document URL.
```

`status` observes once without uploading, and `cancel` cancels a publication
that has not completed. All three take `--request <file>` rather than a token,
so the capability never appears in `ps` output.

### Exit codes

| Code | Meaning |
| ---- | ------- |
| 0    | Complete. The server returned a durable receipt with the document URL. |
| 10   | **Checkpoint, not a failure.** Pending or approved; the command finished normally. Read `nextAction` and call again later. |
| 20   | The human denied it, or it was cancelled. Terminal. |
| 21   | The authorization window, or the 24-hour completion receipt, expired. |
| 22   | Local input, request-state or protocol error. Nothing was published. |
| 23   | A retryable service or network condition. Run the same command again. |

**Exit 10 is success.** It means the publication exists and is waiting on a
human. A wrapper that treats every non-zero status as a failure and retries
`start` will create a second publication for the same document.

### Output

`stdout` is one machine-readable JSON object and nothing else; progress,
warnings and the human-facing instructions go to `stderr`. No bearer token,
cookie, raw provider error or unfiltered HTTP body is ever written to either.
The resolved `serviceOrigin` appears in both, so the person approving can see
where the document is going.

A completion carries `{documentId, url, ownerAccountId, contentSha256,
contentBytes}` exactly as the server returned it. The command never guesses a
URL, an owner or a document identity from the title, the filename or a
username.

A failure under `--json` prints one object of the same shape with
`"state": "error"` plus `code` and a bounded `message`, so a wrapper reads the
outcome the same way whichever it gets. Error text is sanitized and length-
bounded before it is printed: a hostile service cannot use this command's
output as a channel.

### Where the destination comes from

`--service` wins, then `ARCHON_PUBLISH_SERVICE`, then the origin baked into the
release. Nothing else — in particular, not the document, the repository, or any
tool output the command was handed. Only HTTPS origins are accepted, except
under `--local-test`, which allows plain HTTP for a loopback host and nothing
else.

### Private request state

`start` writes a mode-0600 request file into a mode-0700 state directory
outside your repository: `ARCHON_PUBLISH_STATE_DIR` if set, otherwise
`$XDG_STATE_HOME/archon-publish`, otherwise `~/.local/state/archon-publish`.
`--state-dir` overrides it for one run. Both the flag and the environment
variable must name an absolute path: a relative one would put a capability
wherever the command happened to be run from, which inside a checkout means
writing a secret into the repository. The file pins the service origin, the
absolute input path, the approved descriptor and the operation capability, and
it survives interruption and error — nothing in this command deletes it or your
source HTML.

The bytes are re-read and re-hashed before every upload. If the file changed
after the descriptor was fixed, the upload is refused: publishing different
bytes under an approval a person gave for the old ones is not something a retry
should be able to do. Build again and start a new publication.

### If an upload answer is lost

The command asks the service rather than guessing. One status call with the
same capability returns the original receipt when the upload landed durably, so
a dropped connection does not become a second published document. If the
24-hour receipt window has passed the command exits 21 and prints a
`checkPublicationUrl` labelled *Check publication* — a place to sign in and
look, **not** a receipt and not a claim the document exists. Only owner
authentication in a browser settles that. No replacement publication is ever
started automatically.

## Assets

The builder resolves its base assets in this order, and uses the first that
exists:

1. `<cwd>/templates/base/` — a checkout that vendors the assets wins, so a
   repository always builds from the assets it has committed.
2. `dist/base/` inside this package — where the published tarball carries them.

Either layout builds both profiles. A `layout.html` staged before the
`{{FONT_LINKS}}` slot existed still carries the font markup literally, and a
`--hosted` build of it drops those lines rather than failing.

## License

MIT
