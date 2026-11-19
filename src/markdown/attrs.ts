// Pandoc attribute parsing and small helpers shared by the Backlog extensions.

/** Parses Pandoc-style attributes: `.class #id key="value" key=value`. */
export function parsePandocAttributes(src: string): {
  id?: string;
  classes: string[];
  values: Record<string, string>;
} {
  const out: { id?: string; classes: string[]; values: Record<string, string> } = {
    classes: [],
    values: {},
  };
  const re =
    /([\w-]+)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"'\]}]*))|#([^\s\]}]+)|\.([^\s\]}]+)/g;
  for (const m of src.matchAll(re)) {
    if (m[1]) out.values[m[1]] = unescapeAttrValue(m[2] ?? m[3] ?? m[4] ?? "");
    else if (m[5]) out.id = m[5];
    else if (m[6]) out.classes.push(m[6]);
  }
  return out;
}

/** Backlog escapes `\ " newline` with backslashes and `{ }` as `%7B` / `%7D`. */
export function unescapeAttrValue(value: string): string {
  return value
    .replace(/%7B/g, "{")
    .replace(/%7D/g, "}")
    .replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
}

/** One shortcode attribute: `#id`, `.class`, `key="…"`, `key='…'` or `key=bare`. */
export const SHORTCODE_ATTR = String.raw`(?:[#.][\w-]+|[\w-]+=(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s"'\]]*))`;
export const SHORTCODE = new RegExp(
  String.raw`^\[[A-Za-z][\w-]*(?:[ \t]+${SHORTCODE_ATTR})+[ \t]*\](?![({])`,
);

/** Only pass through values that look like a CSS color, never arbitrary CSS. */
export function safeColor(value: string | undefined): string | undefined {
  return value && /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(rgb|hsl)a?\([\d\s.,%/]+\)|var\(--[\w-]+\))$/.test(value)
    ? value
    : undefined;
}

/** Returns the index just after the bracket that closes `src[0]`, or -1. */
export function matchBracket(src: string, open: string, close: string): number {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "\n" && src[i + 1] === "\n") return -1; // never span paragraphs
    if (open === "{" && c === '"') quoted = !quoted;
    if (quoted) continue;
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return -1;
}
