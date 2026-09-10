#!/usr/bin/env node
/**
 * Refuse a site build whose `*.netlify.app` hostname answers with a redirect.
 *
 *   node scripts/check-site-hostname.mjs
 *
 * One site now serves two hosts. The application answers on the custom domain,
 * and the renderer shell under `/_render/` answers on the site's default
 * `<name>.netlify.app` hostname, which is a different registrable site from the
 * custom domain and is therefore cookie-free with respect to it. That
 * separation is the whole of the renderer's isolation: `frame-ancestors` names
 * the application origin, the application's own policy names the render origin,
 * and neither can see the other's cookies.
 *
 * A Netlify site can be configured to redirect its default hostname to its
 * primary domain. If that were ever switched on here, the renderer origin would
 * stop existing: a browser asked to frame `https://<name>.netlify.app/_render/`
 * would be sent to the custom domain, land on the same registrable site as the
 * application, and the isolation would be gone -- with every gate green, every
 * header correct, and nothing in the repository changed. It is a platform
 * setting, so no test of this code can hold it. What a build can do is look.
 *
 * The check therefore runs where the answer is knowable and is a plain skip
 * everywhere else. On Netlify, `SITE_NAME` names the site and the hostname is
 * derived from it. Off Netlify -- a laptop, a CI runner, an installed consumer
 * building their own repository -- there is no such site and nothing to ask, so
 * the build proceeds. `ARCHON_SITE_HOSTNAME` names a hostname explicitly, which
 * is how the tests drive it and how an operator can point it at one site while
 * building in another.
 *
 * Output contract: one `PASS` or `SKIP` line on stdout and exit 0, or one
 * `FAIL site hostname:` line on stderr and exit 1.
 */

/** Netlify's own build environment names the site; nothing else does. */
export function siteHostname(env) {
  const explicit = (env.ARCHON_SITE_HOSTNAME ?? "").trim();
  if (explicit !== "") return explicit;
  if (env.NETLIFY !== "true") return null;
  const name = (env.SITE_NAME ?? "").trim();
  if (name === "") return null;
  return `${name}.netlify.app`;
}

/** How long the one request gets before the build stops waiting on it. */
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * Ask one hostname whether it answers for itself.
 *
 * `redirect: "manual"` is the point: the default would follow the redirect and
 * report the custom domain's 200, which is precisely the failure being looked
 * for. A non-3xx status is not inspected any further -- a 404 is a site that has
 * not deployed this path yet, and a 5xx is an outage, and neither of them moves
 * the renderer origin anywhere.
 *
 * @param {string} hostname
 * @param {typeof fetch} fetchFn
 * @returns {Promise<{ok: true, status: number} | {ok: false, reason: string}>}
 */
export async function probeHostname(hostname, fetchFn) {
  const url = `https://${hostname}/`;
  let response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    /* Fail rather than warn. This runs on a deploy, where the hostname exists
       before the build starts, so "could not ask" is itself an answer that
       nobody should publish a renderer origin on top of. */
    return { ok: false, reason: `${url} could not be reached: ${error.message}` };
  }
  const status = response.status;
  if (status >= 300 && status < 400) {
    /* The Location value is not reported. It is operator-configured and lands
       in a deploy log that gets pasted into an issue; the hostname and the
       status are enough to act on. */
    return {
      ok: false,
      reason: `${url} answered ${status}: the site's default hostname is redirected, which moves the renderer origin`,
    };
  }
  return { ok: true, status };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetchFn
 * @returns {Promise<{code: number, line: string}>}
 */
export async function checkSiteHostname(env, fetchFn) {
  const hostname = siteHostname(env);
  if (hostname === null) {
    return { code: 0, line: "SKIP site hostname: no Netlify site to ask (SITE_NAME unset)" };
  }
  const result = await probeHostname(hostname, fetchFn);
  if (!result.ok) return { code: 1, line: `FAIL site hostname: ${result.reason}` };
  return { code: 0, line: `PASS site hostname: ${hostname} answered ${result.status} with no redirect` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, line } = await checkSiteHostname(process.env, fetch);
  (code === 0 ? process.stdout : process.stderr).write(`${line}\n`);
  process.exitCode = code;
}
