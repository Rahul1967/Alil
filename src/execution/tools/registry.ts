import type { AnyTool } from "./types.ts";
import { fsRead } from "./fs-read.ts";
import { fsList } from "./fs-list.ts";
import { fsGlob } from "./fs-glob.ts";
import { fsGrep } from "./fs-grep.ts";
import { fsEdit } from "./fs-edit.ts";
import { fsWrite } from "./fs-write.ts";
import { docRead } from "./doc-read.ts";
import { shell } from "./shell.ts";
import { webFetch } from "./web-fetch.ts";
import { webSearch } from "./web-search.ts";
import { memoryRead } from "./memory-read.ts";
import { memoryWrite } from "./memory-write.ts";
import { memoryForget } from "./memory-forget.ts";
import { memoryQuery } from "./memory-query.ts";
import { memoryProcedureSearch } from "./memory-procedure-search.ts";
import { memoryProcedureFetch } from "./memory-procedure-fetch.ts";
import { memoryProcedureCreate } from "./memory-procedure-create.ts";
import { memoryProcedureUpdate } from "./memory-procedure-update.ts";
import { remindCreate } from "./remind-create.ts";
import { remindList } from "./remind-list.ts";
import { remindCancel } from "./remind-cancel.ts";
import { sendFile } from "./send-file.ts";

/** name → tool. Adding a tool = one entry here (plus its file). */
export class ToolRegistry {
  readonly #tools = new Map<string, AnyTool>();

  constructor(tools: AnyTool[] = DEFAULT_TOOLS) {
    for (const t of tools) this.#tools.set(t.name, t);
  }

  get(name: string): AnyTool | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }
}

export const DEFAULT_TOOLS: AnyTool[] = [
  fsRead,
  fsList,
  fsGlob,
  fsGrep,
  fsEdit,
  fsWrite,
  docRead,
  shell,
  webFetch,
  webSearch,
  memoryRead,
  memoryWrite,
  memoryForget,
  memoryQuery,
  memoryProcedureSearch,
  memoryProcedureFetch,
  memoryProcedureCreate,
  memoryProcedureUpdate,
  remindCreate,
  remindList,
  remindCancel,
  sendFile,
];
