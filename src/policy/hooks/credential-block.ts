import type { ActionContract } from "../../core/types.ts";
import type { Verdict } from "../verdict.ts";
import { deny } from "../verdict.ts";
import { globMatch } from "../glob.ts";
import type { GuardHook } from "./types.ts";

const CREDENTIAL_GLOBS = [
  "**/.env",
  "**/.env.*",
  "**/.aws/**",
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/*credential*",
  "**/*secret*",
  "**/id_rsa",
  "**/id_ed25519",
  "**/*.pem",
  "**/*.key",
];

/**
 * Substring patterns for scanning free-form command strings (shell). A path-glob can't be
 * anchored against a whole command line, so credential references inside commands
 * (`cat .env`, `cp ~/.ssh/id_rsa /tmp`) are matched by these instead. Kept deliberately broad —
 * this is a hard deny, and a credential-named file has no business in a shell command.
 */
const CREDENTIAL_TOKENS: RegExp[] = [
  /(^|[\s'"=/])\.env(\.[\w-]+)?($|[\s'"/])/i,
  /\.aws(\/|\b)/i,
  /\.ssh(\/|\b)/i,
  /\.gnupg(\/|\b)/i,
  /\bid_rsa\b/i,
  /\bid_ed25519\b/i,
  /[\w./-]*credential[\w./-]*/i,
  /[\w./-]*secret[\w./-]*/i,
  /[\w./-]+\.pem\b/i,
  /[\w./-]+\.key\b/i,
];

// Arg keys treated as filesystem paths (exact glob match) vs. free-form command lines
// (token scan). Anything else is left alone — a `secret` substring in a message body or a
// memory note must NOT be hard-denied; only paths and command strings are.
const PATH_KEYS = new Set(["path", "cwd", "file", "src", "dest", "from", "to"]);
const COMMAND_KEYS = new Set(["command", "cmd", "script"]);

/**
 * Hard-blocks any action touching a credential-shaped path OR referencing one in a free-form
 * command string. Code-enforced and immune to config/mode loosening — this is the "must run on
 * every call" safety net (BEST_PRACTICES §5). Path-style args are glob-matched against the
 * protected patterns; command-style args are token-scanned, so the block cannot be bypassed by
 * routing credential access through the shell tool (`shell: cat .env`).
 */
export const credentialBlock: GuardHook = {
  name: "credential-block",
  check(action: ActionContract): Verdict | null {
    for (const [key, value] of Object.entries(action.args)) {
      if (typeof value !== "string") continue;
      if (PATH_KEYS.has(key)) {
        for (const g of CREDENTIAL_GLOBS) {
          if (globMatch(g, value)) {
            return deny("hook:credential-block", `${key} matches protected pattern "${g}"`);
          }
        }
      }
      if (COMMAND_KEYS.has(key)) {
        for (const tok of CREDENTIAL_TOKENS) {
          if (tok.test(value)) {
            return deny("hook:credential-block", `${key} references a credential file (pattern ${tok})`);
          }
        }
      }
    }
    return null;
  },
};
