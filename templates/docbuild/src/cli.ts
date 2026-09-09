#!/usr/bin/env node
import { relative } from "node:path";
import { build, BuildError, check, repoRoot, USAGE } from "./index.js";
import { buildSite } from "./site.js";

const args = process.argv.slice(2);

// The site mode is documented here rather than in index.ts's shared USAGE:
// index.ts is owned by the shared builder, and this file owns the --site
// dispatch and its help integration. The one synopsis lists <instance> first
// so the single-document command stays the headline, then the hosted profile,
// then the --site form.
const INSTANCE_SYNOPSIS = "    docbuild <instance>\n    docbuild <instance> --hosted\n";
const SITE_SYNOPSIS = `${INSTANCE_SYNOPSIS}    docbuild --site\n`;
const HELP = `${USAGE.replace(INSTANCE_SYNOPSIS, SITE_SYNOPSIS)}
In site mode (docbuild --site), docbuild discovers every publishable document
in this repository, composes each one through the shared builder, and writes a
clean-URL Netlify site into _site/: hosted copies, a deterministic root index,
permanent /d/<id> and alias redirects, and a preview-only noindex header when
CONTEXT is not production.
`;

/** Print help and leave, with 0 only when help is what was asked for. */
const usage = (message?: string): never => {
  if (message !== undefined) console.error(`error: ${message}`);
  const stream = message === undefined ? process.stdout : process.stderr;
  stream.write(HELP);
  process.exit(message === undefined ? 0 : 2);
};

// Help is the whole request or it is a mistake. `docbuild <instance> --help`
// exited 2 before this parser existed, and a build script of the shape
// `docbuild "$doc" $FLAGS && upload "$doc/dist/..."` depends on that: succeeding
// with exit 0 while writing nothing would send the previous run's artifact.
const helpAt = args.findIndex((arg) => arg === "-h" || arg === "--help");
if (helpAt !== -1) {
  if (args.length === 1) usage();
  usage(`${args[helpAt]} takes no other arguments`);
}

// One argument parse for both modes, so an unknown or repeated flag fails the
// same way whichever mode it was aimed at. Anything that is not a recognised
// flag is a positional; more than one positional is as wrong as none.
let site = false;
let hosted = false;
const positionals: string[] = [];
for (const arg of args) {
  if (arg === "--site") {
    if (site) usage("--site given twice");
    site = true;
  } else if (arg === "--hosted") {
    if (hosted) usage("--hosted given twice");
    hosted = true;
  } else if (arg.startsWith("-") && arg !== "-") {
    usage(`unknown option: ${arg}`);
  } else {
    positionals.push(arg);
  }
}

// --site composes every document into a static site and --hosted composes one
// document for a private hosted reader. There is no artifact both would
// produce, so the combination is a mistake rather than a default.
if (site && hosted) usage("--site and --hosted cannot be combined");
if (site && positionals.length > 0) usage(`--site takes no instance: ${positionals[0]}`);
if (!site && positionals.length !== 1) {
  usage(positionals.length === 0 ? "missing <instance>" : "expected exactly one <instance>");
}

const root = repoRoot();

try {
  if (site) {
    const result = buildSite(root);
    console.log(`built ${result.documents.length} documents into ${relative(root, result.outDir)}/`);
    for (const doc of result.documents) console.log(`  /${doc.slug}/`);
  } else {
    const instance = positionals[0]!.replace(/\/+$/, "");
    const out = build(root, instance, { hosted });
    console.log(`built ${relative(root, out) || out}`);
    const result = check(out);
    for (const line of result.lines) console.log(line);
    if (!result.ok) {
      console.error("error: unbalanced tags in the built document");
      process.exit(1);
    }
  }
} catch (e) {
  if (e instanceof BuildError) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
