/**
 * A deterministic stand-in for the blob provider, with real conditional-write
 * semantics and injectable faults.
 *
 * The point of this double is the part a naive fake gets wrong. A `Map` that
 * accepts every write proves nothing about a design whose entire safety argument
 * is compare-and-set, so this one refuses an unconditional write outright,
 * implements `onlyIfNew` and `onlyIfMatch` against a real per-key ETag that
 * changes on every commit, and - crucially - can *commit a write and then throw*,
 * which is the failure mode the adapter's readback exists for and the one that
 * cannot be reproduced by any fake that only knows how to fail.
 *
 * What it does not claim: this is deterministic adapter verification, not
 * evidence about Netlify's real concurrency semantics. The live capstone owns
 * that, and no number of green tests here substitutes for it.
 */

/**
 * @returns {{
 *   getStore: (options: object) => object,
 *   opened: Array<object>,
 *   calls: Array<object>,
 *   keys: () => Array<string>,
 *   raw: (key: string) => {data: string, etag: string} | null,
 *   put: (key: string, data: string) => void,
 *   failNextRead: (fault: object) => void,
 *   failNextWrite: (fault: object) => void,
 *   beforeWrite: (hook: null | ((key: string, value: object, options: object) => Promise<void>)) => void,
 * }}
 */
export function createProviderDouble() {
  /** key -> `{data, etag}`. `data` is the exact string the provider would hold. */
  const blobs = new Map();
  let sequence = 0;
  const readFaults = [];
  const writeFaults = [];
  const opened = [];
  const calls = [];
  let onBeforeWrite = null;

  const nextEtag = () => {
    sequence += 1;
    /* Quoted, like a real one, so the adapter is held to passing the ETag
       through opaquely rather than to any format it might have assumed. */
    return `"pub-${sequence}"`;
  };

  const store = {
    async getWithMetadata(key, options = {}) {
      calls.push({ op: "get", key, options });
      const fault = readFaults.shift();
      if (fault?.throws) throw new Error("provider read failure");
      const entry = blobs.get(key);
      if (entry === undefined) return null;
      if (fault?.omitEtag) return { data: entry.data, etag: "", metadata: {} };
      if (fault?.data !== undefined) return { data: fault.data, etag: entry.etag, metadata: {} };
      if (fault?.unusable) return { data: null, etag: entry.etag, metadata: {} };
      return { data: entry.data, etag: entry.etag, metadata: {} };
    },

    async setJSON(key, value, options = {}) {
      calls.push({ op: "set", key, options });
      const conditional =
        options.onlyIfNew === true || typeof options.onlyIfMatch === "string";
      if (!conditional) {
        /* An unconditional write is the one thing this design must never do, so
           the double refuses it rather than modelling it. */
        throw new Error("unconditional write refused: publication writes are always conditional");
      }

      if (onBeforeWrite !== null) {
        const hook = onBeforeWrite;
        onBeforeWrite = null;
        await hook(key, value, options);
      }

      const existing = blobs.get(key);
      const permitted =
        options.onlyIfNew === true
          ? existing === undefined
          : existing !== undefined && existing.etag === options.onlyIfMatch;

      const fault = writeFaults.shift();
      if (!permitted) return { modified: false };

      if (fault?.throwsBeforeCommit) throw new Error("provider write failure");

      const etag = nextEtag();
      blobs.set(key, { data: JSON.stringify(value), etag });

      if (fault?.throwsAfterCommit) throw new Error("provider write failure");
      if (fault?.result !== undefined) return fault.result;
      return { modified: true, etag };
    },
  };

  return {
    getStore(options) {
      opened.push(options);
      return store;
    },
    opened,
    calls,
    keys: () => [...blobs.keys()],
    raw: (key) => {
      const entry = blobs.get(key);
      return entry === undefined ? null : { ...entry };
    },
    /** Plant a byte-exact stored value, for the malformed-record cases. */
    put(key, data) {
      blobs.set(key, { data, etag: nextEtag() });
    },
    failNextRead(fault) {
      readFaults.push(fault);
    },
    failNextWrite(fault) {
      writeFaults.push(fault);
    },
    /** Run `hook` once, immediately before the next write is evaluated. */
    beforeWrite(hook) {
      onBeforeWrite = hook;
    },
  };
}

/**
 * A clock a test moves by hand.
 *
 * Every deadline in this design is `now` compared to a stored instant, so a test
 * that could not move `now` could only ever assert the shape of a deadline and
 * never its effect.
 */
export function createClock(startIso) {
  let milliseconds = Date.parse(startIso);
  return {
    now: () => milliseconds,
    advanceSeconds(seconds) {
      milliseconds += seconds * 1000;
      return milliseconds;
    },
    setIso(iso) {
      milliseconds = Date.parse(iso);
      return milliseconds;
    },
  };
}

/**
 * A random source that is deterministic and distinct per call.
 *
 * Each byte comes from a counter, so two draws never collide and a replay of the
 * same test produces the same ids and secrets.
 */
export function sequentialRandomBytes(start = 1) {
  let counter = start;
  return (size) => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) {
      counter = (counter + 1) % 251;
      bytes[index] = counter;
    }
    return bytes;
  };
}

/**
 * A random source whose *identifiers* collide but whose secrets do not.
 *
 * This is what makes the create-collision path reachable: every attempt proposes
 * the same publication id, so the store's `onlyIfNew` refusal happens for real
 * rather than being simulated. The larger draws stay sequential, because a
 * source that returned one constant for everything would also mint two
 * identical capabilities and would be testing a condition that cannot occur.
 */
export function collidingIdRandomBytes({ idSize = 16, byte = 7 } = {}) {
  const varying = sequentialRandomBytes(31);
  return (size) => (size === idSize ? new Uint8Array(size).fill(byte) : varying(size));
}
