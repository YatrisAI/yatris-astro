---
'create-yatris': minor
'@yatris/astro': minor
---

Yatris MCP client configuration. Generated sites get a canonical `.yatris/mcp.json` descriptor plus credential-free Claude Code (`.mcp.json`) and Codex (`.codex/config.toml`) adapters derived from it, pointing at the platform's MCP URL (`https://app.yatris.jp/mcp/yatris`); people sign in with `claude mcp login yatris` / `codex mcp login yatris`. `yatris doctor` fails a missing descriptor, adapters that drift from it, and any credential in them. `AGENTS.md` tells agents to use only the Yatris MCP for live Yatris state.
