#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  guardedTempRoot,
  installSignalCleanup,
  retainEvidenceRoot,
  sweepStaleTempRoots,
} from "./lib/temp-roots.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function sandbox() {
  return mkdtempSync(join(tmpdir(), "temp-roots-test-"));
}

test("stale root sweeping removes only old matching directories", () => {
  const directory = sandbox();
  try {
    const old = join(directory, "p4a-old");
    const fresh = join(directory, "p4a-fresh");
    const unrelated = join(directory, "other-old");
    for (const root of [old, fresh, unrelated]) mkdirSync(root);
    const now = Date.now();
    const oldDate = new Date(now - 3 * 60 * 60 * 1000);
    utimesSync(old, oldDate, oldDate);
    utimesSync(unrelated, oldDate, oldDate);

    sweepStaleTempRoots(["p4a-"], { directory, now, maxAgeMs: 2 * 60 * 60 * 1000 });

    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(unrelated), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("P4-M stale sweeping removes legacy roots but preserves retained evidence", () => {
  const directory = sandbox();
  try {
    const legacy = join(directory, "p4m-legacy");
    const current = join(directory, "p4m-run-current");
    const evidence = join(directory, "p4m-evidence-retained");
    for (const root of [legacy, current, evidence]) mkdirSync(root);
    const now = Date.now();
    const oldDate = new Date(now - 3 * 60 * 60 * 1000);
    for (const root of [legacy, current, evidence]) utimesSync(root, oldDate, oldDate);

    sweepStaleTempRoots(["p4m-"], {
      directory,
      now,
      maxAgeMs: 2 * 60 * 60 * 1000,
      excludePrefixes: ["p4m-evidence-"],
    });

    assert.equal(existsSync(legacy), false);
    assert.equal(existsSync(current), false);
    assert.equal(existsSync(evidence), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("termination signal removes tracked roots before exit", async () => {
  const directory = sandbox();
  try {
    const fixture = join(directory, "signal-fixture.mjs");
    const helper = pathToFileURL(join(HERE, "lib", "temp-roots.mjs")).href;
    writeFileSync(fixture, `
      import { guardedTempRoot, installSignalCleanup } from ${JSON.stringify(helper)};
      const roots = [];
      const root = guardedTempRoot("signal-root-", { directory: process.env.TEST_TMP });
      roots.push(root);
      installSignalCleanup(roots);
      process.stdout.write(root + "\\n");
      setInterval(() => {}, 1000);
    `);

    const child = spawn(process.execPath, [fixture], {
      env: { ...process.env, TEST_TMP: directory },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const root = await new Promise((resolve, reject) => {
      let output = "";
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
        if (output.includes("\n")) resolve(output.trim());
      });
    });
    child.kill("SIGTERM");
    const result = await new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    assert.equal(result.code, 143);
    assert.equal(result.signal, null);
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("non-exiting signal cleanup removes roots while the supervisor stays alive", async () => {
  const directory = sandbox();
  let child;
  try {
    const fixture = join(directory, "non-exiting-signal-fixture.mjs");
    const helper = pathToFileURL(join(HERE, "lib", "temp-roots.mjs")).href;
    writeFileSync(fixture, `
      import { guardedTempRoot, installSignalCleanup } from ${JSON.stringify(helper)};
      const root = guardedTempRoot("signal-root-", { directory: process.env.TEST_TMP });
      installSignalCleanup([root], { exitAfterCleanup: false });
      process.on("SIGTERM", () => process.stdout.write("handled\\n"));
      process.stdout.write(root + "\\n");
      setInterval(() => {}, 1000);
    `);

    child = spawn(process.execPath, [fixture], {
      env: { ...process.env, TEST_TMP: directory },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    const nextLine = () => new Promise((resolve, reject) => {
      const consume = () => {
        const newline = output.indexOf("\n");
        if (newline === -1) return false;
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        resolve(line);
        return true;
      };
      if (consume()) return;
      const onData = (chunk) => {
        output += chunk.toString("utf8");
        if (consume()) child.stdout.off("data", onData);
      };
      child.stdout.on("data", onData);
      child.once("error", reject);
    });

    const root = await nextLine();
    child.kill("SIGTERM");
    assert.equal(await nextLine(), "handled");

    assert.equal(existsSync(root), false);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("close", resolve));
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("assertion failure removes the guarded root", () => {
  const directory = sandbox();
  try {
    const fixture = join(directory, "failure-fixture.mjs");
    const helper = pathToFileURL(join(HERE, "lib", "temp-roots.mjs")).href;
    writeFileSync(fixture, `
      import { guardedTempRoot, removeTempRoots } from ${JSON.stringify(helper)};
      const roots = [guardedTempRoot("failure-root-", { directory: process.env.TEST_TMP })];
      try {
        throw new Error("invented assertion failure");
      } finally {
        removeTempRoots(roots);
      }
    `);

    const result = spawnSync(process.execPath, [fixture], {
      env: { ...process.env, TEST_TMP: directory },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invented assertion failure/);
    assert.deepEqual(readdirSync(directory).filter((name) => name.startsWith("failure-root-")), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retained evidence is distinctly named and capped", () => {
  const directory = sandbox();
  try {
    for (let index = 0; index < 5; index += 1) {
      const root = guardedTempRoot("p4m-", { directory });
      writeFileSync(join(root, "sequence"), String(index));
      const date = new Date(Date.now() + index * 1000);
      utimesSync(root, date, date);
      const retained = retainEvidenceRoot(root, `failure ${index}`, {
        directory,
        prefix: "p4m-evidence-",
        maxCount: 3,
      });
      utimesSync(retained.locator, date, date);
    }

    const entries = readdirSync(directory).sort();
    const roots = entries.filter((name) => name.startsWith("p4m-evidence-") && !name.endsWith(".txt"));
    const locators = entries.filter((name) => name.startsWith("p4m-evidence-") && name.endsWith(".txt"));
    assert.equal(roots.length, 3);
    assert.equal(locators.length, 3);
    assert.deepEqual(
      roots.map((name) => readFileSync(join(directory, name, "sequence"), "utf8")).sort(),
      ["2", "3", "4"],
    );
    for (const name of [...roots, ...locators]) assert.equal(statSync(join(directory, name)).mode & 0o077, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Playwright supervisors use the shared lifecycle instead of abrupt failure exits", () => {
  for (const name of ["test-p4-a.mjs", "test-p4-q.mjs", "test-p4-l.mjs"]) {
    const source = readFileSync(join(HERE, name), "utf8");
    assert.match(source, /guardedTempRoot/);
    assert.match(source, /installSignalCleanup/);
    assert.match(source, /sweepStaleTempRoots/);
  }
  for (const name of ["test-p4-a.mjs", "test-p4-q.mjs", "test-p4-l.mjs"]) {
    const source = readFileSync(join(HERE, name), "utf8");
    const failureHelper = source.match(/function fail\([\s\S]*?\n}/)?.[0] ?? "";
    assert.doesNotMatch(failureHelper, /process\.exit\(/);
  }
  const retained = readFileSync(join(HERE, "test-p4-m.mjs"), "utf8");
  assert.match(retained, /retainEvidenceRoot/);
});
