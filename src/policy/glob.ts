/**
 * Minimal, safe glob → RegExp for path matching in policy rules.
 * Supports `**` (any depth, incl. across `/`), `*` (within a segment), and a `**​/`
 * prefix that matches zero or more leading directories. All other regex metacharacters
 * are escaped, so patterns are literal outside the wildcards.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` → optional leading dirs; bare `**` → anything incl. `/`
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function globMatch(glob: string, value: string): boolean {
  return globToRegExp(glob).test(value);
}
