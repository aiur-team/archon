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

The result is `my-doc/dist/<slug>.html`, a single self-contained file.

Run `npx docbuild --help` for the full synopsis, including `--site`, which
composes every document under the current directory into a static site.

## Assets

The builder resolves its base assets in this order, and uses the first that
exists:

1. `<cwd>/templates/base/` — a checkout that vendors the assets wins, so a
   repository always builds from the assets it has committed.
2. `dist/base/` inside this package — where the published tarball carries them.

## License

MIT
