#!/usr/bin/env node
// ============================================================================
// verify-consumer-install.mjs
// ============================================================================
// v1.1 EPIC-07 F2.1 — proves css-is-awesome-mcp works the way a real
// consumer's `npx css-is-awesome-mcp` install does, not just a dev-tree
// `require('./server.cjs')` path (which resolves node_modules relative to
// THIS repo and would silently pass even if the packaged-install path were
// broken).
//
// This script used to copy server.cjs directly into the scratch dir instead
// of installing THIS package as a real npm dependency. That sidestepped the
// one thing a real `npx css-is-awesome-mcp` actually depends on: npm's `bin`
// symlink resolution. It's why this suite stayed green on 2026-09-11 while
// the real command was silently broken — core (`css-is-awesome`) still had
// its own `bin: { "css-is-awesome-mcp": "mcp/server.cjs" }` entry at the
// time, and because this package depends on core, npm links BOTH packages'
// identically-named bins into the same node_modules/.bin/ — core's silently
// won. Fixed there by removing core's colliding bin entry; fixed here by
// actually installing both packages as real dependencies and invoking the
// resolved bin, so a future name collision (or any other bin-resolution
// regression) fails this test instead of shipping unnoticed.
//
// Steps, in a scratch directory (not this repo):
//   1. `npm pack` the sibling css-is-awesome checkout (CIA_REPO_PATH env var,
//      default: ../css-is-awesome) — tests today's actual local source, not
//      whatever's currently on the npm registry.
//   2. `npm pack` THIS repo too.
//   3. Write a scratch package.json depending on both tarballs via `file:`
//      specifiers (+ sdk/zod), so npm resolves css-is-awesome-mcp's own
//      "css-is-awesome" dependency to the local tarball from step 1 instead
//      of the registry, and installs it — a real, from-scratch node_modules
//      tree with real `bin` symlinks, exactly like a fresh
//      `npx css-is-awesome-mcp`.
//   4. Assert `node_modules/.bin/css-is-awesome-mcp` resolves to THIS
//      package's own server.cjs, not core's.
//   5. Spawn it via that resolved bin (not a raw file path) over real stdio
//      JSON-RPC and call a handful of tools, asserting real content comes
//      back.
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
  const ciaPackOut = execFileSync("npm", ["pack", "--pack-destination", scratch, "--json"], {
    cwd: CIA_REPO_PATH,
    encoding: "utf8",
    ...NPM_OPTS,
  });
  const [{ filename: ciaFilename }] = JSON.parse(ciaPackOut);
  log(`packed: ${ciaFilename}`);

  // 2. Pack THIS repo too — this is the package whose bin resolution we're
  // actually testing, so it has to be installed for real, not file-copied.
  log(`packing ${REPO_ROOT}...`);
  const mcpPackOut = execFileSync("npm", ["pack", "--pack-destination", scratch, "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    ...NPM_OPTS,
  });
  const [{ filename: mcpFilename }] = JSON.parse(mcpPackOut);
  log(`packed: ${mcpFilename}`);

  // 3. A scratch package.json depending on both tarballs via `file:` specifiers.
  // css-is-awesome-mcp's own package.json still declares
  // "css-is-awesome": "^1.11.1" (a registry range) — npm dedupes that against
  // this top-level file: dependency instead of hitting the registry, as long
  // as the packed version satisfies the range.
  fs.writeFileSync(
    path.join(scratch, "package.json"),
    JSON.stringify(
      {
        name: "cia-mcp-verify-scratch",
        private: true,
        version: "0.0.0",
        dependencies: {
          "css-is-awesome-mcp": `file:./${mcpFilename}`,
          "css-is-awesome": `file:./${ciaFilename}`,
          "@modelcontextprotocol/sdk": sdkVersion,
          zod: zodVersion,
        },
      },
      null,
      2,
    ),
  );
  log("installing both tarballs + sdk + zod (real, from-scratch node_modules)...");
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: scratch,
    stdio: ["ignore", "pipe", "pipe"],
    ...NPM_OPTS,
  });

  // 4. The real regression check: the resolved bin must be THIS package's
  // own server.cjs, not core's (mcp/server.cjs) — see the header comment for
  // exactly how this broke silently before.
  //
  // npm's .bin entries are platform-shaped differently: on POSIX it's a real
  // symlink (lstat + readlink gives the target PATH without following it),
  // on Windows it's a generated shell/cmd wrapper SCRIPT whose text embeds
  // the resolved path. Reading a POSIX symlink with plain readFileSync
  // follows it and returns the target file's actual source code instead of
  // a path — which contains neither expected substring, so it always fails
  // this check regardless of which file it actually points to.
  const binPath = path.join(scratch, "node_modules", ".bin", "css-is-awesome-mcp");
  let binTarget = null;
  try {
    if (fs.lstatSync(binPath).isSymbolicLink()) {
      binTarget = fs.readlinkSync(binPath);
    } else {
      binTarget = fs.readFileSync(binPath, "utf8");
    }
  } catch {
    binTarget = null;
  }
  if (!binTarget) {
    fail(`node_modules/.bin/css-is-awesome-mcp was not created at all`);
  } else if (binTarget.includes("css-is-awesome/mcp/server.cjs")) {
    fail(`node_modules/.bin/css-is-awesome-mcp resolves to CORE's mcp/server.cjs, not this package's own server.cjs — bin name collision regressed`);
  } else if (!binTarget.includes("css-is-awesome-mcp") || !binTarget.includes("server.cjs")) {
    fail(`node_modules/.bin/css-is-awesome-mcp doesn't resolve to css-is-awesome-mcp's server.cjs — unexpected target: ${binTarget}`);
  } else {
    pass(`node_modules/.bin/css-is-awesome-mcp resolves to this package's own server.cjs`);
  }

  // 5. Spawn via the resolved bin (not a raw file path) over real stdio.
  const binCmd = process.platform === "win32" ? `${binPath}.cmd` : binPath;
  const proc = spawn(binCmd, [], {
    cwd: scratch,
    stdio: ["pipe", "pipe", "pipe"],
    ...NPM_OPTS,
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
  // A floor, not an exact match — core's own mcp-coverage.mjs is the
  // source of truth for the precise count. Pinning an exact number here
  // meant this check had to be hand-bumped on every tool addition (missed
  // once already, breaking CI for validate_theme); a floor still catches
  // "tools went missing" without needing a touch on every new tool.
  toolCount >= 30 ? pass(`server advertises ${toolCount} tools`) : fail(`expected at least 30 tools, got ${toolCount}`);

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
