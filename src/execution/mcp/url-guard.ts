import { resolveAndValidate } from "../tools/web-fetch.ts";

/**
 * SSRF guard for MCP servers that fetch URLs on Alil's behalf (a crawler such as Crawl4AI). The
 * server's own network egress is outside web.fetch's guard, so before the call every URL in the
 * arguments must be http(s) and resolve only to public addresses. Fail-closed: a URL-named arg
 * holding something that isn't an http(s) URL is refused, as is any string carrying another scheme
 * (file:, raw:, data:, javascript:...), since a crawler would happily open those too.
 *
 * Limit: a redirect the server follows itself, or a sub-resource a rendered page loads, is not seen
 * here. Run such a server network-isolated as well; this check stops the direct ask.
 */
export type HostCheck = (hostname: string) => Promise<unknown>;

const URL_KEY = /(^|_)(url|urls|href|link|links|uri|seed|seeds)$/i;
const SCHEME = /^\s*([a-z][a-z0-9+.-]*):/i;
const MAX_DEPTH = 8;

export async function guardUrlArgs(args: Record<string, unknown>, check: HostCheck = resolveAndValidate): Promise<void> {
  const found: { path: string; value: string; strict: boolean }[] = [];
  collect(args, "", false, 0, found);
  for (const f of found) await checkOne(f.path, f.value, f.strict, check);
}

function collect(v: unknown, path: string, urlKey: boolean, depth: number, out: { path: string; value: string; strict: boolean }[]): void {
  if (depth > MAX_DEPTH) throw new Error(`blocked: arguments nest deeper than ${MAX_DEPTH} levels; cannot vet URLs`);
  if (typeof v === "string") {
    if (urlKey || SCHEME.test(v)) out.push({ path, value: v, strict: urlKey });
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => collect(x, `${path}[${i}]`, urlKey, depth + 1, out));
    return;
  }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) collect(x, path ? `${path}.${k}` : k, URL_KEY.test(k), depth + 1, out);
  }
}

async function checkOne(path: string, value: string, strict: boolean, check: HostCheck): Promise<void> {
  const scheme = SCHEME.exec(value)?.[1]?.toLowerCase();
  if (!scheme) {
    if (strict) throw new Error(`blocked: \`${path}\` must be an absolute http(s) URL`);
    return;
  }
  // "note: see below" or "ratio 3:1" are not URLs; only judge strings that use a known scheme form.
  if (!strict && !/^\s*[a-z][a-z0-9+.-]*:(\/\/|[^\s]*$)/i.test(value)) return;
  if (scheme !== "http" && scheme !== "https") throw new Error(`blocked: \`${path}\` uses ${scheme}: (only http/https may be fetched)`);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`blocked: \`${path}\` is not a valid URL`);
  }
  if (url.username || url.password) throw new Error(`blocked: \`${path}\` embeds credentials`);
  await check(url.hostname.replace(/^\[|\]$/g, ""));
}
