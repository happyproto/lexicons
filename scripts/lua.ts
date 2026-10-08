/**
 * Helpers the tests share: finding a Lua toolchain, and a light Lua lexer.
 *
 * The lexer is not a parser. It knows exactly enough Lua to tell code from
 * comments and strings, and to track which `function`/`end` block a token is
 * in -- which is all the structure rules need, and far less to get wrong than
 * a grammar.
 */

/**
 * The first of `names` on PATH.
 *
 * Bun.which, not spawnSync: spawning a binary that does not exist THROWS
 * ENOENT rather than returning a failed result, so a probe loop built on it
 * dies on the first miss instead of trying the next name.
 */
function firstOnPath(names: string[]): string | null {
  for (const name of names) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return null;
}

/**
 * The luac binary, whatever it is called here.
 *
 * Homebrew installs a bare `luac`; Debian and Ubuntu's `lua5.4` package
 * installs `luac5.4` and no unversioned alias. Resolving the name keeps the
 * check working on a laptop and on a runner without either pretending to run.
 */
export function findLuac(): string | null {
  return firstOnPath(["luac", "luac5.4", "luac5.3", "luac5.5"]);
}

/**
 * The lua interpreter, resolved the same way as luac. The versioned name comes
 * first because HappyView targets 5.4, and a machine with several installed
 * should test against that one.
 */
export function findLua(): string | null {
  return firstOnPath(["lua5.4", "lua", "lua5.5", "lua5.3"]);
}

/**
 * Blank out comments and, unless `keepStrings`, string literals, replacing
 * every blanked character except newlines with a space.
 *
 * The output is the same length as the input, character for character, so an
 * index found in one is valid in the other and line numbers survive.
 */
export function stripLua(text: string, keepStrings = false): string {
  const out: string[] = [];
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  let i = 0;

  while (i < text.length) {
    const rest = text.slice(i);

    const longComment = rest.match(/^--\[(=*)\[/);
    if (longComment) {
      const close = `]${longComment[1]}]`;
      const end = text.indexOf(close, i + longComment[0].length);
      const stop = end === -1 ? text.length : end + close.length;
      out.push(blank(text.slice(i, stop)));
      i = stop;
      continue;
    }

    if (rest.startsWith("--")) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out.push(blank(text.slice(i, stop)));
      i = stop;
      continue;
    }

    const longString = rest.match(/^\[(=*)\[/);
    if (longString) {
      const close = `]${longString[1]}]`;
      const end = text.indexOf(close, i + longString[0].length);
      const stop = end === -1 ? text.length : end + close.length;
      const literal = text.slice(i, stop);
      out.push(keepStrings ? literal : blank(literal));
      i = stop;
      continue;
    }

    const quote = text[i];
    if (quote === '"' || quote === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== quote && text[j] !== "\n") {
        j += text[j] === "\\" ? 2 : 1;
      }
      const stop = Math.min(j + 1, text.length);
      const literal = text.slice(i, stop);
      out.push(keepStrings ? literal : blank(literal));
      i = stop;
      continue;
    }

    out.push(text[i]);
    i += 1;
  }

  return out.join("");
}

/** 1-based line number of `index` in `text`. */
export function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * Every top-level argument of the call whose `(` is at `open`, as source text
 * with strings intact. Brackets and commas are found in the string-stripped
 * copy, so a comma or paren inside a string literal cannot split an argument.
 */
export function callArguments(text: string, open: number): string[] {
  const code = stripLua(text);
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;

  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) {
        const last = text.slice(start, i).trim();
        if (last || args.length > 0) args.push(last);
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error(`unbalanced call at offset ${open}`);
}
