/**
 * Beautify a minified JS region extracted from a Bun-compiled binary,
 * robust to truncated/embedded chunks (does not require a full parse).
 * Preserves string, template-literal (with ${} nesting), and comment
 * contents verbatim.
 */
export function beautify(src: string): string {
  const out: string[] = [];
  let indent = 0;
  const INDENT = "  ";

  const pushIndent = () => {
    out.push(INDENT.repeat(indent));
  };

  let i = 0;
  const n = src.length;
  let lineStart = true;

  const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

  while (i < n) {
    const c = src[i] as string;
    const c2 = src[i + 1] as string | undefined;

    if (c === "/" && c2 === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      if (lineStart) pushIndent();
      out.push(src.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }

    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      if (lineStart) pushIndent();
      out.push(src.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }

    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === q) break;
        j++;
      }
      j = Math.min(n, j + 1);
      if (lineStart) pushIndent();
      out.push(src.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }

    if (c === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "{") {
          depth++;
          j += 2;
          continue;
        }
        if (src[j] === "}" && depth > 0) {
          depth--;
          j++;
          continue;
        }
        if (src[j] === "`" && depth === 0) break;
        j++;
      }
      j = Math.min(n, j + 1);
      if (lineStart) pushIndent();
      out.push(src.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }

    if (isSpace(c)) {
      while (i < n && isSpace(src[i])) i++;
      if (lineStart) continue;
      out.push(" ");
      continue;
    }

    if (lineStart) {
      pushIndent();
      lineStart = false;
    }

    if (c === ";") {
      out.push(";\n");
      lineStart = true;
      i++;
      continue;
    }

    if (c === "{") {
      out.push(" {\n");
      indent++;
      lineStart = true;
      i++;
      continue;
    }

    if (c === "}") {
      while (out.length && (out[out.length - 1] === " " || out[out.length - 1] === "\n")) out.pop();
      if (indent > 0) indent--;
      out.push("\n");
      pushIndent();
      out.push("}");
      lineStart = false;
      i++;
      continue;
    }

    out.push(c);
    i++;
  }

  return out.join("");
}
