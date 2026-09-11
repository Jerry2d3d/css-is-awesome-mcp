# css-is-awesome-mcp

[![npm](https://img.shields.io/npm/v/css-is-awesome-mcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/css-is-awesome-mcp) [![CI](https://github.com/Jerry2d3d/css-is-awesome-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Jerry2d3d/css-is-awesome-mcp/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

The zero-install MCP server for [css-is-awesome](https://github.com/Jerry2d3d/css-is-awesome) ("cia") — a token-driven SCSS design system.

```bash
npx css-is-awesome-mcp
```

No manual `npm install @modelcontextprotocol/sdk zod` step first. This
package exists so that command alone gets an MCP client talking to cia's
real design system — mixin signatures, tokens, themes, recipes — in one
shot.

## Why a separate package

`css-is-awesome` ships **zero JavaScript runtime dependencies** in its own
npm package, by hard rule — most people who install it only want the CSS,
and they should never end up with `@modelcontextprotocol/sdk` and `zod` in
their dependency tree for a feature they didn't ask for. `sdk`/`zod` are
declared there as `optional` peer dependencies, so npm correctly never
auto-installs them — but that also means anyone who *does* want the MCP
server has to run a second, manual install first.

This package is that second install, pre-wired: `@modelcontextprotocol/sdk`
and `zod` are real `dependencies` **here**, and `npx` pulls them in
automatically the same way it pulls in any other CLI tool's dependencies.
`css-is-awesome`'s own manifest is completely untouched by this — installing
plain `css-is-awesome` still pulls zero JS, exactly as before.

## What it is

The exact same 30-tool MCP surface as the server bundled inside
`css-is-awesome` itself (`mcp/server.cjs` there) — same handlers, same
tools, same responses. The only difference is where it reads cia's source
data from: this package depends on `css-is-awesome` as a real npm
dependency and resolves everything (`scss/`, `scripts/theme-contract.json`,
themes, recipes) from wherever npm installed it — never a vendored
snapshot, so it always matches whatever version of cia you actually have
installed.

Tool families: themes, mixins, functions, tokens, animations, components,
recipes, doc readers (`read_llm_txt`, `read_changelog`, etc.), size
resolution (`resolve_size`), and prompt assembly (`assemble_prompt`). Full
tool-by-tool reference: [`/docs/mcp`](https://cssisawesome.com/docs/mcp/)
on the cia docs site (documents this same surface).

## Usage

In your MCP client's config (`.mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "css-is-awesome": {
      "command": "npx",
      "args": ["-y", "css-is-awesome-mcp"]
    }
  }
}
```

That's the whole setup. The first run downloads this package and its
dependencies (including `css-is-awesome` itself, for its source data);
subsequent runs are cached by npm.

Prefer a pinned version in your own `package.json`/lockfile instead of
whatever `npx` resolves at run time? Install it like any other dependency —
`npx` then runs the locally installed copy:

```bash
npm install css-is-awesome-mcp
```

## Local development

```bash
npm install
node server.cjs
```

Talks JSON-RPC 2.0 over stdio — pipe requests in, read responses out, same
as any MCP server. `npm run verify` runs `scripts/verify-consumer-install.mjs`,
which packs the current `css-is-awesome` checkout (if present as a sibling
directory) into a real tarball, installs it fresh, and calls a handful of
real tools end-to-end — the same shape a genuine `npx` install goes
through, not just the dev-tree `require()` path.

## Relationship to css-is-awesome

One-way dependency: this package depends on `css-is-awesome`, never the
reverse. It has no independent design-system logic of its own — it's a
thin packaging layer that exists purely to solve one DX problem (the
manual SDK install step). New tools, bug fixes to what the tools *return*,
and everything about the design system itself lives and ships from the
[`css-is-awesome`](https://github.com/Jerry2d3d/css-is-awesome) repo; this
repo only needs updates when the *packaging* — not the *surface* — needs
to change.

## License

MIT
