/** A crawler MCP server (Crawl4AI) fetches URLs outside web.fetch's guard: Alil vets every URL first. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { McpRegistry } from "../src/execution/mcp/registry.ts";
import { guardUrlArgs } from "../src/execution/mcp/url-guard.ts";
import { expandHeaders } from "../src/execution/mcp/sdk-transport.ts";
import { isPrivateHost, isPrivateIp } from "../src/execution/tools/web-fetch.ts";
import type { McpServerConfig, McpTransport } from "../src/execution/mcp/types.ts";

/** Stand-in for DNS: these names resolve to private space, everything else is public. */
const PRIVATE_NAMES = new Set(["intranet.example", "rebind.example"]);
async function fakeCheck(host: string): Promise<string> {
  if (isPrivateHost(host) || PRIVATE_NAMES.has(host)) throw new Error(`blocked: "${host}" is private`);
  return "93.184.216.34";
}

function crawlerRegistry(guardUrls = true) {
  const calls: Record<string, unknown>[] = [];
  const cfg: McpServerConfig = { name: "crawl4ai", transport: "sse", url: "http://127.0.0.1:11235/mcp/sse", guardUrls };
  const transport: McpTransport = {
    server: "crawl4ai",
    connected: () => true,
    connect: async () => {},
    listTools: async () => [{ server: "crawl4ai", name: "md", description: "page to markdown", inputSchema: { type: "object" } }],
    callTool: async (_n, args) => { calls.push(args); return { isError: false, text: "# page" }; },
    close: async () => {},
  };
  const reg = new McpRegistry({ configs: [cfg], transportFactory: () => transport, hostCheck: fakeCheck });
  return { reg, calls };
}

test("public http(s) URLs pass through to the crawler", async () => {
  const { reg, calls } = crawlerRegistry();
  await reg.call("crawl4ai", "md", { url: "https://docs.example.com/guide" });
  await reg.call("crawl4ai", "md", { urls: ["https://a.example/x", "http://b.example/y"], f: "fit" });
  assert.equal(calls.length, 2);
});

test("internal targets never reach the crawler (adversarial)", async () => {
  const { reg, calls } = crawlerRegistry();
  const bad: Record<string, unknown>[] = [
    { url: "http://127.0.0.1:8787/api/approvals" },           // Alil's own UI
    { url: "http://localhost:11235/config" },                  // the crawler itself
    { url: "http://169.254.169.254/latest/meta-data/" },       // cloud metadata
    { url: "http://[::ffff:169.254.169.254]/" },               // IPv4-mapped
    { url: "http://[64:ff9b::a9fe:a9fe]/" },                   // NAT64-embedded metadata
    { url: "http://[2002:a9fe:a9fe::1]/" },                    // 6to4-embedded metadata
    { url: "http://2130706433/" },                             // decimal 127.0.0.1
    { url: "http://0x7f.1/" },                                 // hex shorthand
    { url: "http://192.168.1.1/admin" },
    { url: "http://intranet.example/" },                       // public-looking name, private address
    { url: "file:///etc/passwd" },
    { url: "raw:<img src='http://169.254.169.254/'>" },
    { url: "javascript:alert(1)" },
    { url: "https://user:pass@example.com/" },                 // credentials in the URL
    { url: "docs.example.com" },                               // not absolute
    { urls: ["https://ok.example/", "http://10.0.0.5/"] },     // one bad item sinks the call
    { crawler_config: { params: { seed_url: "http://172.20.0.1/" } } }, // nested URL-named key
    { scripts: ["fetch('http://x')"], target: "gopher://127.0.0.1:6379/_FLUSHALL" }, // other scheme anywhere
  ];
  for (const args of bad) {
    await assert.rejects(reg.call("crawl4ai", "md", args), /blocked/, JSON.stringify(args));
  }
  assert.equal(calls.length, 0, "the crawler was never asked to fetch an internal target");
});

test("ordinary text that merely contains a colon is not mistaken for a URL", async () => {
  await guardUrlArgs({ url: "https://example.com/", q: "Note: compare ratio 3:1 and 10:30 times" }, fakeCheck);
});

test("the guard is opt-in per server: an unguarded server is called as before", async () => {
  const { reg, calls } = crawlerRegistry(false);
  await reg.call("crawl4ai", "md", { url: "http://127.0.0.1/" });
  assert.equal(calls.length, 1);
});

test("IPv6 transition prefixes are judged by the IPv4 they embed", () => {
  assert.equal(isPrivateIp("64:ff9b::a9fe:a9fe"), true);
  assert.equal(isPrivateIp("64:ff9b::7f00:1"), true);
  assert.equal(isPrivateIp("64:ff9b:1::1"), true, "local-use NAT64 prefix");
  assert.equal(isPrivateIp("2002:c0a8:0101::"), true, "6to4 of 192.168.1.1");
  assert.equal(isPrivateIp("64:ff9b::5db8:d822"), false, "NAT64 of a public IPv4 stays allowed");
  assert.equal(isPrivateIp("2002:5db8:d822::1"), false);
  assert.equal(isPrivateIp("2606:4700::1111"), false, "ordinary global IPv6");
});

test("header secrets come from the environment, and a missing one fails loudly", () => {
  assert.deepEqual(expandHeaders("c", { Authorization: "Bearer ${TOK}" }, { TOK: "abc" }), { Authorization: "Bearer abc" });
  assert.throws(() => expandHeaders("c", { Authorization: "Bearer ${TOK}" }, {}), /TOK/);
  assert.equal(expandHeaders("c", undefined, {}), undefined);
});

test("shipped config: crawl4ai is loopback-only, token from env, guarded, and execute_js stays gated", () => {
  const cfg = JSON.parse(readFileSync("config/mcp.json", "utf8")) as { servers: McpServerConfig[] };
  const c = cfg.servers.find((s) => s.name === "crawl4ai");
  assert.ok(c, "crawl4ai configured");
  assert.equal(c.transport, "sse");
  assert.match(c.url!, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(c.guardUrls, true);
  assert.equal(c.headers?.["Authorization"], "Bearer ${CRAWL4AI_API_TOKEN}", "no literal secret in config");
  assert.equal(c.tools?.["execute_js"], undefined, "running page JS is never pre-cleared (stays execute/high)");
  for (const name of ["screenshot", "pdf"]) assert.equal(c.tools?.[name], undefined, `${name} returns a base64 blob as text; keep it execute/high`);
  for (const name of ["md", "html", "crawl"]) assert.equal(c.tools?.[name]?.effect, "network", `${name} is gated like web.fetch`);
});
