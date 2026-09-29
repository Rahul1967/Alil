import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpTransport, McpToolDef, McpCallResult, McpServerConfig } from "./types.ts";

/**
 * SDK-backed transports — the ONLY file that imports the MCP SDK, so protocol/subprocess/HTTP
 * details stay isolated behind the McpTransport interface. One `SdkMcpTransport` handles both
 * stdio (spawn a local subprocess) and Streamable HTTP (connect to a URL); the registry/tools never
 * change between them. A server can push `notifications/tools/list_changed`; we expose that via an
 * `onListChanged` callback so the registry can invalidate its cached schemas.
 */
export class SdkMcpTransport implements McpTransport {
  readonly server: string;
  readonly #config: McpServerConfig;
  #client: Client | null = null;
  #onListChanged: (() => void) | undefined;

  constructor(config: McpServerConfig, onListChanged?: () => void) {
    this.server = config.name;
    this.#config = config;
    this.#onListChanged = onListChanged;
  }

  connected(): boolean {
    return this.#client !== null;
  }

  async connect(): Promise<void> {
    if (this.#client) return;
    const client = new Client({ name: "alil", version: "0.1.0" }, { capabilities: {} });

    // Refresh hook: when the server's toolset changes, tell the registry to drop its cache.
    if (this.#onListChanged) {
      client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        async () => { this.#onListChanged?.(); },
      );
    }

    const transport = this.#buildTransport();
    await client.connect(transport);
    this.#client = client;
  }

  #buildTransport() {
    if (this.#config.transport === "http") {
      if (!this.#config.url) throw new Error(`mcp: http server "${this.server}" has no url`);
      return new StreamableHTTPClientTransport(new URL(this.#config.url));
    }
    if (!this.#config.command) throw new Error(`mcp: stdio server "${this.server}" has no command`);
    return new StdioClientTransport({
      command: this.#config.command,
      args: this.#config.args ?? [],
      ...(this.#config.env ? { env: this.#config.env } : {}),
    });
  }

  async listTools(): Promise<McpToolDef[]> {
    const client = this.#require();
    const res = await client.listTools();
    return (res.tools ?? []).map((t) => ({
      server: this.server,
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
      ...(t.annotations?.readOnlyHint !== undefined ? { readOnlyHint: t.annotations.readOnlyHint } : {}),
      ...(t.annotations?.destructiveHint !== undefined ? { destructiveHint: t.annotations.destructiveHint } : {}),
      ...(t.annotations?.idempotentHint !== undefined ? { idempotentHint: t.annotations.idempotentHint } : {}),
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    idempotencyKey?: string,
  ): Promise<McpCallResult> {
    const client = this.#require();
    // Pass an idempotency key in the request metadata (_meta) so a server that supports it can
    // dedupe a retried write. Harmless to servers that ignore _meta. This closes the classic
    // "timeout → retry → duplicate side effect" gap for non-idempotent tools.
    const params: { name: string; arguments: Record<string, unknown>; _meta?: Record<string, unknown> } = {
      name,
      arguments: args,
      ...(idempotencyKey ? { _meta: { idempotencyKey } } : {}),
    };
    const res = await client.callTool(params, undefined, { timeout: timeoutMs });
    const content = Array.isArray(res.content) ? res.content : [];
    const text = content
      .map((c) => {
        if (c.type === "text") return c.text;
        if (c.type === "image") return `[image ${c.mimeType ?? "?"}]`;
        if (c.type === "resource") return `[resource ${(c.resource as { uri?: string })?.uri ?? "?"}]`;
        return `[${c.type}]`;
      })
      .join("\n");
    return { isError: res.isError === true, text };
  }

  async close(): Promise<void> {
    if (!this.#client) return;
    try { await this.#client.close(); } finally { this.#client = null; }
  }

  #require(): Client {
    if (!this.#client) throw new Error(`mcp: server "${this.server}" is not connected`);
    return this.#client;
  }
}

/**
 * Factory the app wires into McpRegistry. Supports stdio + Streamable HTTP. The registry passes an
 * `onListChanged` callback so a server's tools/list_changed notification invalidates the cache.
 */
export function sdkTransportFactory(config: McpServerConfig, onListChanged?: () => void): McpTransport {
  return new SdkMcpTransport(config, onListChanged);
}

/** @deprecated stdio-only alias kept for the Phase-1 name. Prefer `sdkTransportFactory`. */
export function stdioTransportFactory(config: McpServerConfig): McpTransport {
  return new SdkMcpTransport(config);
}
