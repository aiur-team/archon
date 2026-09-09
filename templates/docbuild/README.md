# @aiur-team/docbuild

Compose an architecture doc into one self-contained HTML file. No runtime
dependencies; Node 18 or later is the only requirement.

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

- the Google Fonts `preconnect` and stylesheet links, so the document makes no
  network request at all. Text falls back to the local `ui-monospace` and
  `system-ui` stacks the theme already names.
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
