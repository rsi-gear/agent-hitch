import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SRC_ROOT = path.resolve("src");
const MODULES = new Set([
  "domain", "foundation", "adapters", "revisions", "artifacts", "controller-runtime",
  "images", "model-access", "trajectories", "feedback", "workspaces", "runs", "backends", "evals", "control-plane", "daemon", "cli",
]);
const ALLOWED = new Map<string, Set<string>>([
  ["domain", new Set()],
  ["foundation", new Set(["domain"])],
  ["adapters", new Set(["domain", "foundation"])],
  ["revisions", new Set(["domain", "foundation", "adapters"])],
  ["artifacts", new Set(["domain", "foundation", "adapters", "revisions"])],
  ["controller-runtime", new Set(["domain", "foundation"])],
  ["images", new Set(["domain", "foundation"])],
  ["model-access", new Set(["domain", "foundation"])],
  ["trajectories", new Set(["domain", "foundation", "adapters"])],
  ["feedback", new Set(["domain", "foundation", "trajectories"])],
  ["workspaces", new Set(["domain", "foundation"])],
  ["runs", new Set(["domain", "foundation", "adapters", "revisions", "artifacts", "workspaces", "trajectories", "model-access"])],
  ["backends", new Set(["domain", "foundation"])],
  ["evals", new Set(["domain", "foundation", "backends", "runs", "artifacts", "revisions", "controller-runtime", "workspaces", "trajectories"])],
  ["control-plane", new Set(["domain", "foundation", "adapters", "model-access", "evals", "images"])],
  ["daemon", new Set(["domain", "foundation", "runs", "workspaces", "control-plane"])],
  ["cli", new Set([...MODULES].filter((name) => name !== "cli"))],
]);

interface Violation {
  file: string;
  line: number;
  rule: string;
  message: string;
  suggestion: string;
}

interface ImportEdge {
  sourceFile: string;
  sourceModule: string;
  targetFile: string;
  targetModule: string;
  line: number;
}

const violations: Violation[] = [];
const edges: ImportEdge[] = [];
const files = await sourceFiles(SRC_ROOT);

for (const file of files) {
  const relative = slash(path.relative(SRC_ROOT, file));
  const content = await readFile(file, "utf8");
  const lines = content.split(/\r?\n/);
  const sourceModule = topModule(relative);

  if (!relative.includes("/")) {
    report(relative, 1, "root-source", "root-level source files are not allowed", "move the public API to the owning module facade");
  }
  if (lines.length - 1 > 500) {
    report(relative, 501, "file-size", `implementation has ${lines.length - 1} lines (maximum 500)`, "split by responsibility before adding more behavior");
  }
  if (path.basename(file) === "index.ts") checkFacade(relative, lines);

  for (const imported of imports(content)) {
    if (sourceModule === "domain" && imported.specifier.startsWith("node:")) {
      report(relative, imported.line, "domain-purity", `domain imports Node.js builtin ${imported.specifier}`, "move I/O or runtime behavior to foundation");
    }
    if (relative.startsWith("cli/commands/") && imported.specifier.startsWith("node:fs")) {
      report(relative, imported.line, "cli-command-io", `CLI command imports filesystem builtin ${imported.specifier}`, "move state access behind the owning module facade");
    }
    if (!imported.specifier.startsWith(".")) continue;
    const targetFile = resolveSource(file, imported.specifier);
    if (!targetFile.startsWith(`${SRC_ROOT}${path.sep}`)) continue;
    const targetRelative = slash(path.relative(SRC_ROOT, targetFile));
    const targetModule = topModule(targetRelative);
    if (!targetModule) continue;

    if (sourceModule && targetModule && sourceModule !== targetModule) {
      if (!ALLOWED.get(sourceModule)?.has(targetModule)) {
        report(relative, imported.line, "dependency-direction", `${sourceModule} may not depend on ${targetModule}`, `move the contract down or call ${targetModule}/index.ts from an allowed owner`);
      }
      if (targetRelative !== `${targetModule}/index.ts`) {
        report(relative, imported.line, "deep-import", `cross-module deep import targets ${targetRelative}`, `import from ${targetModule}/index.ts`);
      }
      edges.push({ sourceFile: relative, sourceModule, targetFile: targetRelative, targetModule, line: imported.line });
    }
  }
}

checkModuleCycles(edges);

if (violations.length > 0) {
  for (const item of violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule))) {
    process.stderr.write(`${item.file}:${item.line} [${item.rule}] ${item.message}; ${item.suggestion}\n`);
  }
  process.stderr.write(`architecture check failed with ${violations.length} violation(s)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`architecture check passed (${files.length} source files, ${edges.length} cross-module edges)\n`);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(candidate));
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(candidate);
  }
  return result.sort();
}

function imports(content: string): Array<{ specifier: string; line: number }> {
  const result: Array<{ specifier: string; line: number }> = [];
  const pattern = /(?:\bfrom\s+|\bimport\s*)["']([^"']+)["']/g;
  for (const match of content.matchAll(pattern)) {
    result.push({ specifier: match[1] as string, line: 1 + content.slice(0, match.index).split("\n").length - 1 });
  }
  return result;
}

function resolveSource(sourceFile: string, specifier: string): string {
  const raw = path.resolve(path.dirname(sourceFile), specifier);
  if (raw.endsWith(".js")) return `${raw.slice(0, -3)}.ts`;
  if (path.extname(raw)) return raw;
  return path.join(raw, "index.ts");
}

function topModule(relative: string): string | null {
  const [first, second] = relative.split("/");
  return second && first && MODULES.has(first) ? first : null;
}

function checkFacade(relative: string, lines: string[]): void {
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/**") || trimmed.startsWith("*") || trimmed.startsWith("*/") || trimmed.startsWith("export ")) return;
    report(relative, index + 1, "facade-logic", "index.ts contains non-export logic", "move logic to an implementation file and export its public symbol");
  });
}

function checkModuleCycles(importEdges: ImportEdge[]): void {
  const graph = new Map<string, Set<string>>();
  for (const edge of importEdges) {
    const targets = graph.get(edge.sourceModule) || new Set<string>();
    targets.add(edge.targetModule);
    graph.set(edge.sourceModule, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const emitted = new Set<string>();
  const visit = (module: string) => {
    if (visited.has(module)) return;
    if (visiting.has(module)) {
      const start = stack.indexOf(module);
      const cycle = [...stack.slice(start), module];
      const key = cycle.join(" -> ");
      if (!emitted.has(key)) {
        emitted.add(key);
        const edge = importEdges.find((item) => item.sourceModule === cycle.at(-2) && item.targetModule === module);
        report(edge?.sourceFile || `${module}/index.ts`, edge?.line || 1, "module-cycle", key, "invert the shared contract into domain or foundation");
      }
      return;
    }
    visiting.add(module);
    stack.push(module);
    for (const target of graph.get(module) || []) visit(target);
    stack.pop();
    visiting.delete(module);
    visited.add(module);
  };
  for (const module of MODULES) visit(module);
}

function report(file: string, line: number, rule: string, message: string, suggestion: string): void {
  violations.push({ file, line, rule, message, suggestion });
}

function slash(value: string): string {
  return value.split(path.sep).join("/");
}
