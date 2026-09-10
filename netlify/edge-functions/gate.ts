import { identify } from "../lib/identity.mjs";
import {
  capabilitiesFor,
  resolveRole,
  validateAccessRow,
} from "../lib/access.mjs";
import {
  applicationOrigin,
  classifyHost,
  isApplicationPassThrough,
  isRenderPrefix,
  notFoundForeignHost,
  notFoundRenderer,
  rendererHeaders,
  rendererRewriteTarget,
  withApplicationHeaders,
} from "../lib/edge-host.mjs";

type GateContext = {
  next(request?: Request): Promise<Response>;
  rewrite(url: string | URL): Promise<Response>;
};

/** The two origin keys the gate reads to classify a request host. */
const HOST_ENV_KEYS = ["HOSTED_APP_ORIGIN", "HOSTED_RENDER_ORIGIN"] as const;

const PLAIN_TEXT = "text/plain; charset=utf-8";
const NO_STORE = { "Cache-Control": "private, no-store" };
const MAX_META_LINE_BYTES = 96;

const AUTH_UNAVAILABLE = "Authentication is temporarily unavailable.";
const ACCESS_UNAVAILABLE = "Document access is temporarily unavailable.";
const UNVERIFIED = "Document access could not be verified.";
const DENIED = "You do not have access to this document.";

const IDENTITY_KEYS = ["sub", "email", "name", "isOrg"];
const CONTENT_TYPE_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const CONTENT_TYPE_QUOTED = '"(?:[\\t !#-\\[\\]-~]|\\\\[\\t !-~])*"';
const CONTENT_TYPE_PARAMETER = `;[\\t ]*${CONTENT_TYPE_TOKEN}[\\t ]*=[\\t ]*(?:${CONTENT_TYPE_TOKEN}|${CONTENT_TYPE_QUOTED})[\\t ]*`;
const HTML_CONTENT_TYPE = new RegExp(
  `^[\\t ]*text/html[\\t ]*(?:${CONTENT_TYPE_PARAMETER})*$`,
  "i",
);

function plainResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": PLAIN_TEXT, ...NO_STORE },
  });
}

function exactMutableRecord(
  value: unknown,
  keys: readonly string[],
): null | Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some(
        (key, index) => typeof key !== "string" || key !== keys[index],
      )
    )
      return null;

    const record: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        !descriptor.writable ||
        !descriptor.configurable
      )
        return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function validIdentity(
  value: unknown,
): value is { sub: string; email: string; name: string; isOrg: boolean } {
  const record = exactMutableRecord(value, IDENTITY_KEYS);
  return (
    record !== null &&
    typeof record.sub === "string" &&
    typeof record.email === "string" &&
    typeof record.name === "string" &&
    typeof record.isOrg === "boolean"
  );
}

function validContentType(value: string | null): boolean {
  return value !== null && HTML_CONTENT_TYPE.test(value);
}

function isUnavailableError(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  try {
    const name = Object.getOwnPropertyDescriptor(value, "name");
    const code = Object.getOwnPropertyDescriptor(value, "code");
    const status = Object.getOwnPropertyDescriptor(value, "status");
    return (
      name !== undefined &&
      "value" in name &&
      name.value === "StoreError" &&
      code !== undefined &&
      "value" in code &&
      code.value === "unavailable" &&
      status !== undefined &&
      "value" in status &&
      status.value === 503
    );
  } catch {
    return false;
  }
}

async function cancelAndRelease(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cleanup failure must not change the authorization response.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The authorization response remains fail closed if cleanup is inaccessible.
    }
  }
}

async function cancelBody(
  body: ReadableStream<Uint8Array> | null | undefined,
): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Synthetic HEAD cleanup is best effort and cannot change the response.
  }
}

function replayResponse(
  status: number,
  statusText: string,
  downstreamHeaders: Headers,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  retained: Uint8Array[],
): Response {
  let terminal = false;
  const release = () => {
    if (terminal) return false;
    terminal = true;
    try {
      reader.releaseLock();
    } catch {
      // A terminal stream path cannot be replaced with another response.
    }
    return true;
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of retained) controller.enqueue(chunk);
      retained.length = 0;
    },
    async pull(controller) {
      if (terminal) return;
      try {
        const next = await reader.read();
        if (next.done) {
          if (release()) controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array))
          throw new TypeError("Invalid response stream chunk");
        controller.enqueue(next.value);
      } catch (error) {
        if (release()) controller.error(error);
      }
    },
    async cancel(reason) {
      if (terminal) return;
      try {
        await reader.cancel(reason);
      } catch {
        // Consumer cancellation still settles if upstream cancellation rejects.
      } finally {
        release();
      }
    },
  });

  const headers = new Headers(downstreamHeaders);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.delete("Transfer-Encoding");
  return new Response(body, {
    status,
    statusText,
    headers,
  });
}

/**
 * Read the two host-classification origins through the runtime-native narrow
 * environment API on Deno, falling back to `process.env` where the gate runs
 * transpiled on Node for its test harness.
 */
function readHostEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const netlify = (globalThis as { Netlify?: { env?: { get?(key: string): string | undefined } } }).Netlify;
  const runtime = netlify?.env;
  const node = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  for (const key of HOST_ENV_KEYS) {
    try {
      if (runtime !== undefined && runtime !== null && typeof runtime.get === "function") {
        env[key] = runtime.get(key);
        continue;
      }
    } catch {
      // A runtime that throws on read is treated as an unset value below.
    }
    try {
      env[key] = node?.env?.[key];
    } catch {
      env[key] = undefined;
    }
  }
  return env;
}

/**
 * The renderer host serves exactly the four shell files under an internal
 * rewrite and refuses everything else. It never calls `identify()`, never
 * resolves a role, never emits `Set-Cookie` and never emits a body on a
 * refusal, so an artifact-rendering origin holds no identity authority.
 */
async function renderHost(
  url: URL,
  context: GateContext,
  env: Record<string, string | undefined>,
): Promise<Response> {
  const target = rendererRewriteTarget(url.pathname, url.search);
  if (target === null) return notFoundRenderer();
  const appOrigin = applicationOrigin(env);
  /* Without a header-safe application origin there is no `frame-ancestors` to
     name, and serving the shell headerless would leave it framable by anyone.
     Refuse rather than serve a shell the renderer would then refuse to mount. */
  if (appOrigin === null) return notFoundRenderer();

  let response: Response;
  try {
    response = await context.rewrite(target);
    if (!(response instanceof Response))
      return plainResponse(503, ACCESS_UNAVAILABLE);
  } catch {
    return plainResponse(503, ACCESS_UNAVAILABLE);
  }
  try {
    const headers = response.headers;
    if (!(headers instanceof Headers))
      return plainResponse(503, ACCESS_UNAVAILABLE);
    for (const [name, value] of rendererHeaders(appOrigin))
      headers.set(name, value);
  } catch {
    return plainResponse(503, ACCESS_UNAVAILABLE);
  }
  return response;
}

/**
 * The application host serves the collaboration app, the hosted viewer and the
 * APIs. It refuses the renderer shell prefix, passes the API, assets, sign-in,
 * viewer, publish and invitation paths through with no session check, and
 * applies the existing session and access logic to everything else. Every
 * answer gains the application header set unless it already carries a CSP.
 */
async function applicationHost(
  req: Request,
  url: URL,
  context: GateContext,
): Promise<Response> {
  /* The renderer shell prefix is never a first-party page on the application
     origin, so it is a not-found before any session check. */
  if (isRenderPrefix(url.pathname)) {
    return withApplicationHeaders(
      new Response(null, {
        status: 404,
        headers: { "Content-Type": PLAIN_TEXT, ...NO_STORE },
      }),
    );
  }

  /* The paths that used to be `excludedPath` in TOML, decided in code now that
     the gate runs on every path: passed through with no session check. A
     function response keeps its own headers; a static one gains the set. The
     gate's own `/api/hosted/session` subrequest is one of these, so it cannot
     recurse into the session logic. */
  if (isApplicationPassThrough(url.pathname)) {
    let passed: Response;
    try {
      passed = await context.next();
      if (!(passed instanceof Response))
        return plainResponse(503, ACCESS_UNAVAILABLE);
    } catch {
      return plainResponse(503, ACCESS_UNAVAILABLE);
    }
    return withApplicationHeaders(passed);
  }

  return withApplicationHeaders(await sessionGate(req, url, context));
}

export default async function gate(
  req: Request,
  context: GateContext,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const env = readHostEnv();
  const host = classifyHost(url, env);

  /* A deploy preview or any other hostname is refused before any store read,
     with `X-Robots-Tag: noindex` so it is never indexed. */
  if (host === "other") return notFoundForeignHost();
  if (host === "render") return renderHost(url, context, env);
  return applicationHost(req, url, context);
}

/**
 * The application host's session and access gate: the pre-existing edge logic,
 * unchanged. Identity is validated, the document's `doc-id` meta line is read
 * from the first bytes of the body, the role is resolved and the response is
 * replayed only when the role can read.
 */
async function sessionGate(
  req: Request,
  url: URL,
  context: GateContext,
): Promise<Response> {
  let user: unknown;
  try {
    user = await identify(req);
  } catch {
    return plainResponse(503, AUTH_UNAVAILABLE);
  }

  if (user === null) {
    const next = encodeURIComponent(url.pathname + url.search);
    return new Response(null, {
      status: 302,
      headers: { Location: `/login/?next=${next}`, ...NO_STORE },
    });
  }
  if (!validIdentity(user)) return plainResponse(500, UNVERIFIED);

  const isHead = req.method === "HEAD";
  let downstream: Response;
  try {
    const nextRequest = isHead
      ? new Request(req, { method: "GET", body: null })
      : undefined;
    downstream = await context.next(nextRequest);
    if (!(downstream instanceof Response))
      return plainResponse(503, ACCESS_UNAVAILABLE);
  } catch {
    return plainResponse(503, ACCESS_UNAVAILABLE);
  }

  let status: number;
  let statusText: string;
  let headers: Headers;
  let body: ReadableStream<Uint8Array> | null = null;
  let bodyUsed: boolean;
  let responseType: ResponseType;
  try {
    body = downstream.body;
    status = downstream.status;
    statusText = downstream.statusText;
    headers = downstream.headers;
    bodyUsed = downstream.bodyUsed;
    responseType = downstream.type;
  } catch {
    if (isHead) await cancelBody(body);
    return plainResponse(503, ACCESS_UNAVAILABLE);
  }
  if (status === 0 || responseType === "opaque") {
    if (isHead) await cancelBody(body);
    return plainResponse(503, ACCESS_UNAVAILABLE);
  }
  if (
    typeof status !== "number" ||
    typeof statusText !== "string" ||
    !(headers instanceof Headers) ||
    typeof bodyUsed !== "boolean" ||
    (body !== null && !(body instanceof ReadableStream))
  ) {
    if (isHead) await cancelBody(body);
    return plainResponse(500, UNVERIFIED);
  }

  if (
    status === 204 ||
    status === 205 ||
    (status >= 300 && status <= 303) ||
    (status >= 305 && status <= 599)
  ) {
    if (!isHead) return downstream;
    let response: Response;
    try {
      response = new Response(null, {
        status,
        statusText,
        headers,
      });
    } catch {
      await cancelBody(body);
      return plainResponse(503, ACCESS_UNAVAILABLE);
    }
    await cancelBody(body);
    return response;
  }
  if (status !== 200) {
    if (isHead) await cancelBody(body);
    return plainResponse(500, UNVERIFIED);
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  let contentType: string | null;
  let bodyLocked: boolean | undefined;
  let getReader: (() => ReadableStreamDefaultReader<Uint8Array>) | undefined;
  try {
    contentType = headers.get("Content-Type");
    bodyLocked = body?.locked;
    getReader = body?.getReader;
  } catch {
    if (isHead) await cancelBody(body);
    return plainResponse(503, ACCESS_UNAVAILABLE);
  }
  if (
    !validContentType(contentType) ||
    body === null ||
    bodyUsed !== false ||
    bodyLocked !== false ||
    typeof getReader !== "function"
  ) {
    if (isHead) await cancelBody(body);
    return plainResponse(500, UNVERIFIED);
  }
  try {
    reader = getReader.call(body);
  } catch {
    if (isHead) await cancelBody(body);
    return plainResponse(503, ACCESS_UNAVAILABLE);
  }

  const retained: Uint8Array[] = [];
  const prefix: number[] = [];
  let firstLineFound = false;
  try {
    while (!firstLineFound) {
      const next = await reader.read();
      if (
        next.done ||
        !(next.value instanceof Uint8Array) ||
        next.value.byteLength === 0
      )
        throw new Error();
      retained.push(next.value);
      const inspectLength = Math.min(
        next.value.byteLength,
        MAX_META_LINE_BYTES - prefix.length,
      );
      for (let index = 0; index < inspectLength; index += 1) {
        const byte = next.value[index];
        prefix.push(byte);
        if (byte === 0x0a) {
          firstLineFound = true;
          break;
        }
      }
      if (!firstLineFound && prefix.length === MAX_META_LINE_BYTES)
        throw new Error();
    }

    const line = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(Uint8Array.from(prefix));
    const match = /^<meta name="doc-id" content="([0-9a-f]{6})">\n$/.exec(line);
    if (match === null) throw new Error();
    const docId = match[1];

    let resolved: unknown;
    try {
      resolved = await resolveRole(docId, user, { consumeInvitation: false });
    } catch (error) {
      await cancelAndRelease(reader);
      const unavailable = isUnavailableError(error);
      return plainResponse(
        unavailable ? 503 : 500,
        unavailable ? ACCESS_UNAVAILABLE : UNVERIFIED,
      );
    }

    // The eighth hand copy of the access-row check used to live here under a
    // third name, `validResolvedAccess()` (#135). It is the shared
    // `validateAccessRow()` now (#132): one definition, so a weakening lands
    // in one file rather than in whichever copy no gate exercises. The edge
    // path gains the checks the copy lacked -- the role must be a known role,
    // `threadControl` one of the three controls, every capability a boolean --
    // and loses the copy's demand that each own property be writable and
    // configurable, which the shared validator does not make.
    if (!validateAccessRow(resolved, capabilitiesFor)) {
      await cancelAndRelease(reader);
      return plainResponse(500, UNVERIFIED);
    }
    const access = resolved as Record<string, unknown>;
    if (access.canRead !== true) {
      await cancelAndRelease(reader);
      return plainResponse(403, DENIED);
    }

    if (isHead) {
      const response = new Response(null, {
        status,
        statusText,
        headers,
      });
      await cancelAndRelease(reader);
      return response;
    }
    return replayResponse(status, statusText, headers, reader, retained);
  } catch {
    await cancelAndRelease(reader);
    return plainResponse(500, UNVERIFIED);
  }
}
