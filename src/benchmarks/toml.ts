import { parse } from "smol-toml";
import { invalidInput } from "../foundation/index.js";

/** Native Harbor tasks use multiline strings and nested array tables. Keep TOML
 * parsing separate from protocol and capability validation. */
export function parseBenchmarkToml(text: string): Record<string, unknown> {
  try { return parse(text) as Record<string, unknown>; }
  catch (error) { throw invalidInput(`invalid benchmark TOML: ${(error as Error).message}`); }
}
