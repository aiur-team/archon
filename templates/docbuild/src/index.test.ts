/**
 * Unit coverage for the document-level version marker (P4-B): the builder has
 * to publish the head version on the embedded history block so a client can
 * resolve it without parsing the payload.
 *
 * Compiled by the existing package and run with Node's built-in test runner:
 *
 *     npm --prefix templates/docbuild run build
 *     node --test templates/docbuild/dist/index.test.js
 *
 * CI runs it alongside the other unit tests; see .github/workflows/check.yml.
 *
 * No runtime dependency, no package or tsconfig change. Tests build throwaway
 * roots in a temporary directory and never touch a committed document.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build, repoRoot, resolveBase } from "./index.js";

/** The seven-hex document version grammar the comment client accepts. */
const DOC_VERSION = /^[0-9a-f]{7}$/;

const SECTION = `<!--
id: problem
label: The problem
summary: A one-line summary.
nav: Problem
-->
<!-- body -->

<h2>A heading</h2>

<p>A paragraph.</p>
`;

const DOC_JSON = `${JSON.stringify(
  {
    id: "a2e912",
    slug: "sample",
    title: "Sample",
    heading: "Sample",
    lede: "A sample document.",
    meta: { Owner: "you" },
    footer: "Sample",
  },
  null,
  2,
)}\n`;

const historyJson = (head: string): string =>
  `${JSON.stringify(
    {
      doc: "sample",
      head,
      versions: [
        {
          sha: head,
          date: "2026-01-02T03:04:05.000Z",
          author: "A Person",
          subject: "A commit subject",
          url: "",
          // Empty on purpose: `changelogSection()` renders a changed-file stat
          // as `&minus;`, which the anchor scanner's named-entity table does
          // not know, so any non-empty `changed` fails the build today. That is
          // a separate pre-existing defect, not this test's subject.
          changed: [],
        },
      ],
    },
    null,
    2,
  )}\n`;

/**
 * A throwaway root carrying the real base assets and one instance, removed when
 * the test finishes. `history` seeds a committed history.json; omitting it is
 * the no-history-available case.
 */
const root = (t: { after: (fn: () => void) => void }, history?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "p4b-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const compiled = dirname(fileURLToPath(import.meta.url));
  cpSync(resolveBase(repoRoot(compiled)), join(dir, "templates", "base"), { recursive: true });

  const inst = join(dir, "sample");
  mkdirSync(join(inst, "sections"), { recursive: true });
  writeFileSync(join(inst, "doc.json"), DOC_JSON);
  writeFileSync(join(inst, "sections", "01-problem.html"), SECTION);
  if (history !== undefined) writeFileSync(join(inst, "history.json"), history);
  return dir;
};

/** Build the instance and return the document. */
const built = (dir: string): string => readFileSync(build(dir, "sample"), "utf8");

/**
 * Fresh generation is gated on the origin slug matching this variable, and the
 * committed-history fallback is the branch under test. Keep both off so the
 * result never depends on the repository the tests happen to run inside.
 */
const isolate = (t: { after: (fn: () => void) => void }): void => {
  const approved = process.env.DOCBUILD_PUBLIC_HISTORY_APPROVED;
  const netlify = process.env.NETLIFY;
  delete process.env.DOCBUILD_PUBLIC_HISTORY_APPROVED;
  delete process.env.NETLIFY;
  t.after(() => {
    if (approved === undefined) delete process.env.DOCBUILD_PUBLIC_HISTORY_APPROVED;
    else process.env.DOCBUILD_PUBLIC_HISTORY_APPROVED = approved;
    if (netlify === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = netlify;
  });
};

test("a document with history publishes the head version on the history block", (t) => {
  isolate(t);
  const html = built(root(t, historyJson("0a1b2c3")));

  // Exactly one block: a client that finds two cannot tell which version the
  // document is at, and treats the ambiguity as no version at all.
  const blocks = html.match(/<script type="application\/json" id="doc-history"[^>]*>/g);
  assert.ok(blocks, "expected an embedded history block");
  assert.equal(blocks.length, 1);
  const open = blocks[0]!;
  const head = open.match(/ data-head="([^"]*)"/);
  assert.ok(head, "expected the history block to carry data-head");
  assert.match(head[1]!, DOC_VERSION);
  assert.equal(head[1], "0a1b2c3");

  // The payload is still the same JSON, and it still agrees with the attribute.
  const embedded = html.match(
    /<script type="application\/json" id="doc-history"[^>]*>(.*?)<\/script>/s,
  );
  assert.ok(embedded);
  const parsed = JSON.parse(embedded[1]!.split("<\\/").join("</")) as { head: string };
  assert.equal(parsed.head, "0a1b2c3");
});

test("a document with no history available emits no history block and no version", (t) => {
  isolate(t);
  const html = built(root(t));

  // Anchor on real output first: two bare absence assertions would also pass
  // for a document that rendered nothing at all.
  assert.match(html, /<h2[^>]*>A heading<\/h2>/);
  assert.doesNotMatch(html, /<script[^>]*id="doc-history"/);
  // Scoped to attribute position: the built document inlines every base asset,
  // and a client that reads `#doc-history[data-head]` legitimately contains the
  // bare string.
  assert.doesNotMatch(html, /<[^>]*\sdata-head=/);
});

test("the section toggle names the next click's effect, not the current state", (t) => {
  isolate(t);
  const html = built(root(t));

  // Rendered closed (no `open` attribute), so the label at parse time reads
  // what a click will do from here: expand it.
  assert.match(html, /<span class="sec-toggle"><span>Expand<\/span>/);

  // The inlined toggle script flips the label to name the opposite action
  // once the section opens, and keeps aria-expanded in sync — it must not
  // hardcode "Expand" for both states.
  assert.match(html, /d\.open \? 'Collapse' : 'Expand'/);
  assert.match(html, /aria-expanded/);
});
