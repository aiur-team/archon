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
 * The one thing it must not do is cry wolf. This site redirects for its own
 * reasons -- the edge gate sends an unauthenticated visitor to `/login/`, and a
 * build-time probe carries no session -- so the check is written against the
 * redirect *target's host*, not against the status. See `probeHostname`.
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

import { fileURLToPath } from "node:url";

/**
 * The hostname to ask about, `null` when there is no site to ask, or an `Error`
 * when there is one and it cannot be named.
 *
 * The three cases are deliberately distinct. Off Netlify there is no site and
 * skipping is correct. On Netlify there is always a site, so a missing
 * `SITE_NAME` is not "nothing to check" -- it is this gate losing its subject,
 * and returning `null` there would turn every deploy into a silent skip on one
 * unset variable. That is the failure this whole file exists to prevent, so it
 * is an error rather than a shrug.
 */
export function siteHostname(env) {
  const explicit = (env.ARCHON_SITE_HOSTNAME ?? "").trim();
  /* Off a Netlify build only. On a deploy the site names itself, and an
     override there would be a way to point this gate at a hostname that is not
     the one the renderer is served from: an operator who set it to the primary
     domain would get a permanent PASS while the default hostname was redirected
     and the renderer origin had collapsed. That is the failure being checked
     for, spelled as a configuration. */
  if (env.NETLIFY !== "true") return explicit === "" ? null : explicit;
  const name = (env.SITE_NAME ?? "").trim();
  if (name === "") {
    return new Error("SITE_NAME is unset on a Netlify build; set ARCHON_SITE_HOSTNAME to name the site");
  }
  return `${name}.netlify.app`;
}

/** How long the one request gets before the build stops waiting on it. */
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * Ask one hostname whether it still answers for itself.
 *
 * `redirect: "manual"` is the point: the default would follow the redirect and
 * report the custom domain's 200, which is precisely the failure being looked
 * for.
 *
 * What makes this delicate is that the site redirects on its own account all the
 * time. The edge gate sends an unauthenticated visitor to `/login/`, and this
 * probe carries no session, so a 3xx is the *ordinary* answer here. Failing on
 * the status alone would fail every correct deploy, and a check that fails
 * correct deploys gets switched off — after which the setting it existed for is
 * unguarded again.
 *
 * So the question is not "did it redirect" but "did it redirect *off this
 * hostname*". A platform-level default-domain redirect points at the primary
 * domain, a different host; the gate's own redirect is a path on this one. Only
 * the first moves the renderer origin, and only the first fails.
 *
 * A non-3xx status is not inspected any further -- a 404 is a path that has not
 * deployed yet and a 5xx is an outage, and neither of them moves the origin.
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
  if (status < 300 || status >= 400) return { ok: true, status };

  const location = response.headers?.get?.("location") ?? null;
  if (location === null || location === "") {
    return { ok: false, reason: `${url} answered ${status} with no Location, which is not an answer to publish on` };
  }
  let target;
  try {
    target = new URL(location, url);
  } catch {
    return { ok: false, reason: `${url} answered ${status} with a Location that is not a URL` };
  }
  if (target.hostname === hostname) return { ok: true, status };
  /* The target host is named because it *is* the finding -- an operator reading
     this has to know which domain the hostname was folded into. The path and
     query are dropped: a redirect on this site can carry a `next` parameter
     naming a private document path, and a deploy log gets pasted into issues. */
  return {
    ok: false,
    reason:
      `${url} answered ${status} to another host (${target.hostname}): the site's default hostname is ` +
      "redirected, which moves the renderer origin onto the application's site",
  };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetchFn
 * @returns {Promise<{code: number, line: string}>}
 */
export async function checkSiteHostname(env, fetchFn) {
  const hostname = siteHostname(env);
  if (hostname instanceof Error) return { code: 1, line: `FAIL site hostname: ${hostname.message}` };
  if (hostname === null) {
    return { code: 0, line: "SKIP site hostname: not a Netlify build, so there is no site to ask" };
  }
  const result = await probeHostname(hostname, fetchFn);
  if (!result.ok) return { code: 1, line: `FAIL site hostname: ${result.reason}` };
  return { code: 0, line: `PASS site hostname: ${hostname} answered ${result.status} with no redirect` };
}

/* Compared as paths rather than as a URL string. `file://${process.argv[1]}`
   is not the URL of a path containing a space or a non-ASCII character, so a
   checkout under one would leave this script a silent no-op: run as a build
   step, it would exit 0 having asked nothing. */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { code, line } = await checkSiteHostname(process.env, fetch);
  (code === 0 ? process.stdout : process.stderr).write(`${line}\n`);
  process.exitCode = code;
}
