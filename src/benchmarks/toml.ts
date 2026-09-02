import { invalidInput } from "../foundation/index.js";

/** Deliberately bounded TOML dialect. Unsupported syntax fails before execution.
 * Handles tables, array tables, strings, finite numbers, booleans, arrays and
 * inline tables; dates, multiline strings and dotted assignments are rejected.
 */
export function parseBenchmarkToml(text: string): Record<string, unknown> {
  let offset = 0;
  const root: Record<string, unknown> = Object.create(null);
  let table = root;
  const fail = (): never => { throw invalidInput(`unsupported or invalid benchmark TOML near byte ${offset}`); };
  function whitespace(newlines = true): void {
    while (offset < text.length) {
      if (text[offset] === "#") { while (offset < text.length && text[offset] !== "\n") offset++; }
      else if ((newlines ? /\s/ : /[ \t\r]/).test(text[offset]!)) offset++;
      else break;
    }
  }
  function string(): string {
    const quote = text[offset++]!;
    let raw = "";
    while (offset < text.length) {
      const c = text[offset++]!;
      if (c === quote) {
        if (quote === "'") return raw;
        try { return JSON.parse(`"${raw}"`) as string; } catch { return fail(); }
      }
      if (c === "\n" || c === "\r") fail();
      raw += c;
      if (c === "\\" && quote === '"') raw += text[offset++] ?? fail();
    }
    return fail();
  }
  function key(): string {
    if (text[offset] === '"' || text[offset] === "'") return string();
    const found = /^[A-Za-z0-9_-]+/.exec(text.slice(offset));
    if (!found) return fail();
    offset += found[0].length;
    return found[0];
  }
  function assign(target: Record<string, unknown>, name: string, value: unknown): void {
    if (Object.hasOwn(target, name) || ["__proto__", "constructor", "prototype"].includes(name)) fail();
    target[name] = value;
  }
  function value(): unknown {
    whitespace();
    const c = text[offset];
    if (c === '"' || c === "'") return string();
    if (c === "[" || c === "{") {
      const array: unknown[] = [];
      const object: Record<string, unknown> = Object.create(null);
      const close = c === "[" ? "]" : "}";
      offset++;
      whitespace();
      while (text[offset] !== close) {
        if (c === "[") array.push(value());
        else {
          const name = key(); whitespace(false);
          if (text[offset++] !== "=") fail();
          assign(object, name, value());
        }
        whitespace();
        if (text[offset] === close) break;
        if (text[offset++] !== ",") fail();
        whitespace();
      }
      offset++;
      return c === "[" ? array : object;
    }
    const literal = /^[^\s,\]}#]+/.exec(text.slice(offset))?.[0];
    if (!literal) return fail();
    offset += literal.length;
    if (literal === "true" || literal === "false") return literal === "true";
    if (!/^[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(literal)) fail();
    const number = Number(literal);
    if (!Number.isFinite(number)) fail();
    return number;
  }
  const tables = new Set<string>();
  while (offset < text.length) {
    whitespace();
    if (offset === text.length) break;
    if (text[offset] === "[") {
      offset++;
      const isArray = text[offset] === "[";
      if (isArray) offset++;
      const keys = [key()];
      while (text[offset] === ".") { offset++; keys.push(key()); }
      if (text[offset++] !== "]" || (isArray && text[offset++] !== "]")) fail();
      const full = JSON.stringify(keys);
      if (!isArray && tables.has(full)) fail();
      if (!isArray) tables.add(full);
      table = root;
      for (let index = 0; index < keys.length; index++) {
        const name = keys[index]!;
        if (["__proto__", "constructor", "prototype"].includes(name)) fail();
        if (isArray && index === keys.length - 1) {
          table[name] ??= [];
          if (!Array.isArray(table[name])) fail();
          const next: Record<string, unknown> = Object.create(null);
          (table[name] as unknown[]).push(next); table = next;
        } else {
          table[name] ??= Object.create(null);
          const next = table[name];
          if (!next || typeof next !== "object" || Array.isArray(next)) fail();
          table = next as Record<string, unknown>;
        }
      }
    } else {
      const name = key(); whitespace(false);
      if (text[offset++] !== "=") fail();
      assign(table, name, value());
    }
    whitespace(false);
    if (offset < text.length && text[offset++] !== "\n") fail();
  }
  return root;
}
