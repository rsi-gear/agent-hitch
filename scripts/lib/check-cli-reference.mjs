import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function hasSelector(node) {
  let found = false;
  walk(node, (child) => {
    if (ts.isIdentifier(child) && ["action", "dimension"].includes(child.text)) found = true;
  });
  return found;
}

function subcommands(source) {
  const names = new Set();
  walk(source, (node) => {
    if (ts.isSwitchStatement(node) && hasSelector(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) names.add(clause.expression.text);
      }
    }
    if (ts.isBinaryExpression(node)
      && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) {
      for (const [selector, value] of [[node.left, node.right], [node.right, node.left]]) {
        if (ts.isIdentifier(selector) && hasSelector(selector) && ts.isStringLiteral(value)) names.add(value.text);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "includes" && ts.isArrayLiteralExpression(node.expression.expression)
      && node.arguments.some(hasSelector)) {
      for (const value of node.expression.expression.elements) if (ts.isStringLiteral(value)) names.add(value.text);
    }
  });
  return names;
}

// Check dispatch and parser source, including commands absent from terminal help.
export async function checkCliReference(root, documents) {
  const cli = path.join(root, "src/cli");
  const files = ["main.ts", "arguments.ts", ...(await readdir(path.join(cli, "commands")))
    .filter((file) => file.endsWith(".ts")).map((file) => `commands/${file}`)];
  const sources = new Map(await Promise.all(files.map(async (file) => [file,
    ts.createSourceFile(file, await readFile(path.join(cli, file), "utf8"), ts.ScriptTarget.Latest, true)])));
  const commands = new Set();
  walk(sources.get("main.ts"), (node) => {
    if (!ts.isCaseClause(node) || !ts.isStringLiteral(node.expression)) return;
    const command = node.expression.text;
    const source = sources.get(`commands/${command}.ts`);
    const children = source ? subcommands(source) : new Set();
    if (children.size) for (const child of children) commands.add(`hitch ${command} ${child}`);
    else commands.add(`hitch ${command}`);
  });
  const options = new Set();
  for (const source of sources.values()) walk(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)
      || !["takeOption", "takeFlag", "takeRepeatedOption", "requiredOption", "durationOption", "assign"].includes(node.expression.text)) return;
    for (const value of node.arguments) {
      if (ts.isStringLiteral(value) && /^(--[a-z][a-z0-9-]*|-[a-zA-Z])$/.test(value.text)
        && !value.text.startsWith("--internal-")) options.add(value.text);
    }
  });
  for (const [file, markdown] of documents) {
    for (const token of [...commands, ...options]) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.ok(new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(markdown), `${file} is missing CLI reference entry: ${token}`);
    }
  }
  return { commands: commands.size, options: options.size };
}
