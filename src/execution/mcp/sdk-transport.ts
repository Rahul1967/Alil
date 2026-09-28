import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpTransport, McpToolDef, McpCallResult, McpServerConfig } from "./types.ts";

/**
 * SDK-backed stdio transport — the ONLY file that imports the MCP SDK, so the protocol/subprocess
 * details stay isolated behind the McpTransport interface. Spawns the configured command as a child
 * process and speaks JSON-RPC over its stdio. Streamable-HTTP is a Phase-2 addition (another adapter
 * implementing the same interface); the registry/tools never change.
 */
export class StdioMcpTransport implements McpTransport {
  readonly server: string;
  readonly #config: McpServerConfig;
  #client: Client | null = null;

  constructor(config: McpServerConfig) {
    this.server = config.name;
    this.#config = config;
  }

  connected(): boolean {
    return this.#client !== null;
  }

  async connect(): Promise<void> {
    if (this.#client) return;
    if (!this.#config.command) throw new Error(`mcp: stdio server "${this.server}" has no command`);
    const transport = new StdioClientTransport({
      command: this.#config.command,
      args: this.#config.args ?? [],
      ...(this.#config.env ? { env: this.#config.env } : {}),
    });
    const client = new Client({ name: "alil", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    this.#client = client;
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

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpCallResult> {
    const client = this.#require();
    // The SDK supports a per-call timeout; on expiry it rejects and sends a cancellation notification.
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
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

/** Factory the app wires into McpRegistry in production. Tests inject a mock factory instead. */
export function stdioTransportFactory(config: McpServerConfig): McpTransport {
  return new StdioMcpTransport(config);
}
