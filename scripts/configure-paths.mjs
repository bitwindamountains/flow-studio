// Points claude/mcp.json and .codex/config.toml at this studio folder, wherever the repo was cloned.
// The launcher runs it on every start; it writes a file only when a path actually changes.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const paths = { server: `${root}/engine/dist/index.js`, home: `${root}/data`, output: `${root}/projects` };

function update(file, change) {
  const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
  const before = readFileSync(path, "utf8");
  const after = change(before);
  if (after !== before) {
    writeFileSync(path, after);
    console.log(`Updated ${file} for ${root}`);
  }
}

// Text replacements keep each file's formatting, so an unchanged path leaves the file untouched.
update("claude/mcp.json", (text) => text
  .replace(/"args": \[".*?"\]/, `"args": ["${paths.server}"]`)
  .replace(/"FLOW_MCP_HOME": ".*?"/, `"FLOW_MCP_HOME": "${paths.home}"`)
  .replace(/"FLOW_MCP_OUTPUT": ".*?"/, `"FLOW_MCP_OUTPUT": "${paths.output}"`));

update(".codex/config.toml", (text) => text
  .replace(/^args = \[".*?"\]$/m, `args = ["${paths.server}"]`)
  .replace(/^FLOW_MCP_HOME = ".*?"$/m, `FLOW_MCP_HOME = "${paths.home}"`)
  .replace(/^FLOW_MCP_OUTPUT = ".*?"$/m, `FLOW_MCP_OUTPUT = "${paths.output}"`));
