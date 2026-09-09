/**
 * A module-resolution hook that records what Node actually resolved.
 *
 * `scripts/check-hosted-modules.mjs` used to answer "what does this module
 * import?" by scanning the source text. That is the wrong tool and it failed in
 * both directions: a regular expression has no state for regex literals, so
 * `/\/\//` made the scanner treat the rest of the line as a comment and drop a
 * real import, while `/["']/` flipped it into string state and turned a
 * sentence in a doc comment into a phantom specifier. One of those hides a
 * hosted module reaching into the legacy `netlify/` tree; the other fails a
 * build over prose.
 *
 * Asking the resolver is exact by construction. This hook sits in front of
 * Node's own resolution and appends one JSON line per resolve to a journal
 * file, recording the specifier, the module that asked for it, and the URL Node
 * settled on. The gate then reasons about resolved URLs rather than about text.
 *
 * The journal is a file rather than a `MessagePort` on purpose: hooks run on a
 * separate thread, so a port would deliver messages asynchronously and the gate
 * would have to guess when the last one had arrived. `appendFileSync` is
 * ordered and complete by the time the import that triggered it returns.
 *
 * Registered by the gate; not useful on its own.
 */

import { appendFileSync } from "node:fs";

/** Where to append resolution records. Set by `initialize`. */
let journal = null;

export async function initialize(data) {
  journal = data?.journal ?? null;
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (journal !== null) {
    appendFileSync(
      journal,
      `${JSON.stringify({
        specifier,
        parentURL: context.parentURL ?? null,
        url: result.url,
      })}\n`,
    );
  }
  return result;
}
