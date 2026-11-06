#!/usr/bin/env node
// Project-specific architecture guard. It does not replace TypeScript checking.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const src = join(root, "src");
const failures = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".ts")) check(path);
  }
}

function check(path) {
  const rel = relative(root, path).replaceAll("\\", "/");
  const text = readFileSync(path, "utf8");
  if (rel.startsWith("src/core/") || rel.startsWith("src/io/")) {
    if (text.includes("@opencode/plugin") || text.includes("@opencode/client")) {
      failures.push(`${rel}: core/io must not import OpenCode APIs`);
    }
  }
  for (const forbidden of ["@opencode-ai/plugin", "tool.execute.before", "chat.message", "subtask"]) {
    if (text.includes(forbidden)) failures.push(`${rel}: legacy V1/DSH token ${JSON.stringify(forbidden)}`);
  }
  if (/(^|\n)\s*(debugger|console\.log)\s*[(;]/.test(text) && !rel.includes("/cli/") && rel !== "src/cli.ts") {
    failures.push(`${rel}: console/debugger output outside cli`);
  }
}

walk(src);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("architecture guards: ok");
