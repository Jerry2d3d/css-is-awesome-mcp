#!/usr/bin/env node
// ============================================================================
// verify-consumer-install.mjs
// ============================================================================
// v1.1 EPIC-07 F2.1 — proves css-is-awesome-mcp works the way a real
// consumer's `npx css-is-awesome-mcp` install does, not just the dev-tree
// `require('./server.cjs')` path (which resolves node_modules relative to
// THIS repo and would silently pass even if the packaged-install path were
// broken).
//
// Steps, in a scratch directory (not this repo):
//   1. `npm pack` the sibling css-is-awesome checkout into a real tarball
//      (CIA_REPO_PATH env var, default: ../css-is-awesome) — tests today's
//      actual local source, not whatever's currently on the npm registry.
//   2. Copy server.cjs + a minimal package.json into the scratch dir.
//   3. `npm install` the tarball + sdk + zod there — a real, from-scratch
//      node_modules tree, exactly like a fresh `npx css-is-awesome-mcp`.
//   4. Spawn server.cjs FROM the scratch dir over real stdio JSON-RPC and
//      call a handful of tools, asserting real content comes back.
//
// Usage: node scripts/verify-consumer-install.mjs
// ============================================================================

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const CIA_REPO_PATH = process.env.CIA_REPO_PATH || path.resolve(REPO_ROOT, "..", "css-is-awesome");
// npm ships as npm.cmd on Windows — execFileSync needs shell:true to resolve
// it via PATH the way a normal terminal invocation does.
const NPM_OPTS = { shell: process.platform === "win32" };

// Pin the EXACT versions already installed in this repo's own node_modules
// (npm install <range> here already resolved and proved these work) rather
// than re-resolving from the semver range in package.json for this one-off
// scratch install — a wide range can resolve a different, untested patch
// version on a second install (this bit once: a fresh `zod@^3.25.0` install
// resolved a 3.25.x build whose dist/ layout didn't match what
// @modelcontextprotocol/sdk's own require() paths expected, while the
// already-installed 3.25.76 here works fine).
function installedVersion(pkgName) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", ...pkgName.split("/"), "package.json"), "utf8")).version;
}
const sdkVersion = installedVersion("@modelcontextprotocol/sdk");
const zodVersion = installedVersion("zod");

function log(msg) {
  process.stderr.write(`  ${msg}\n`);
}

function fail(msg) {
  console.error(`FAIL - ${msg}`);
  process.exitCode = 1;
}

function pass(msg) {
  console.log(`PASS - ${msg}`);
}

if (!fs.existsSync(CIA_REPO_PATH)) {
  console.error(`css-is-awesome checkout not found at ${CIA_REPO_PATH}. Set CIA_REPO_PATH to override.`);
  process.exit(2);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cia-mcp-verify-"));
log(`scratch dir: ${scratch}`);

try {
  // 1. Pack the real, local css-is-awesome checkout.
  log(`packing ${CIA_REPO_PATH}...`);
  const packOut = execFileSync("npm", ["pack", "--pack-destination", scratch, "--json"], {
    cwd: CIA_REPO_PATH,
    encoding: "utf8",
    ...NPM_OPTS,
  });
  const [{ filename }] = JSON.parse(packOut);
  const tarballPath = path.join(scratch, filename);
  log(`packed: ${filename}`);

  // 2. Copy this package's server + a minimal package.json into the scratch dir.
  fs.copyFileSync(path.join(REPO_ROOT, "server.cjs"), path.join(scratch, "server.cjs"));
  fs.writeFileSync(
    path.join(scratch, "package.json"),
    JSON.stringify({ name: "cia-mcp-verify-scratch", private: true, version: "0.0.0" }, null, 2),
  );

  // 3. Install exactly what a real `npx css-is-awesome-mcp` would pull in.
  log("installing tarball + sdk + zod (real, from-scratch node_modules)...");
  execFileSync(
    "npm",
    ["install", tarballPath, `@modelcontextprotocol/sdk@${sdkVersion}`, `zod@${zodVersion}`, "--no-audit", "--no-fund"],
    { cwd: scratch, stdio: ["ignore", "pipe", "pipe"], ...NPM_OPTS },
  );

  // 4. Spawn the server from the scratch dir over real stdio and call tools.
  const proc = spawn(process.execPath, [path.join(scratch, "server.cjs")], {
    cwd: scratch,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.on("error", (err) => log(`spawn error: ${err.message}`));
  proc.on("exit", (code, sig) => log(`server process exited early: code=${code} sig=${sig}`));
  proc.stderr.on("data", (d) => log(`server stderr (live): ${d.toString().trim()}`));

  let buf = "";
  let id = 0;
  const pending = new Map();
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const reqId = ++id;
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`timed out waiting for a response to ${method} (id ${reqId})`));
      }, 10_000);
      pending.set(reqId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }) + "\n");
    });
  }
  async function callTool(name, args) {
    const res = await call("tools/call", { name, arguments: args || {} });
    if (res.error) throw new Error(`${name}: ${JSON.stringify(res.error)}`);
    return JSON.parse(res.result.content[0].text);
  }

  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify-consumer-install", version: "0.0.0" },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const toolsList = await call("tools/list", {});
  const toolCount = toolsList.result?.tools?.length ?? 0;
  toolCount === 30 ? pass(`server advertises 30 tools`) : fail(`expected 30 tools, got ${toolCount}`);

  const mixins = await callTool("list_mixins", {});
  mixins.total > 50 ? pass(`list_mixins returns real data (${mixins.total} mixins)`) : fail(`list_mixins.total suspiciously low: ${mixins.total}`);

  const theme = await callTool("get_theme", { name: "sketchbook" });
  theme.tokenCount > 100
    ? pass(`get_theme('sketchbook') returns real tokens (${theme.tokenCount})`)
    : fail(`get_theme tokenCount suspiciously low: ${theme.tokenCount}`);

  const recipes = await callTool("list_recipes", {});
  recipes.total > 15 ? pass(`list_recipes returns real recipes (${recipes.total})`) : fail(`list_recipes.total suspiciously low: ${recipes.total}`);

  proc.kill();
  // Windows doesn't release the child process's open file handles the
  // instant kill() is called — an immediate rmSync below can hit EBUSY.
  await new Promise((r) => setTimeout(r, 300));

  if (process.exitCode) {
    console.error("\nverify-consumer-install FAILED.");
  } else {
    console.log("\nverify-consumer-install passed — a real npx-shaped install works end to end.");
  }
} finally {
  // maxRetries/retryDelay: same Windows file-lock race as above — the OS can
  // take a moment to fully release handles after the child process exits.
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
