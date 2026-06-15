# dona-mcp

Add Dona AI MCP to any AI tool — Claude Desktop, Claude Code, Gemini CLI, Codex, VS Code, and more.

## Usage

```bash
npx dona-mcp
```

Interactive prompts walk you through: your instance URL → authentication → tool selection → config written.

## Options

| Flag | Description |
|------|-------------|
| `--url <url>` | Your Dona instance MCP URL (e.g. `https://yourcompany.dona.ai.in/mcp/`) |
| `--key <key>` | API key — skips login flow |
| `--target <target>` | Skip tool selection prompt |
| `--help` | Show help |

## Supported tools

| Target | What happens |
|--------|-------------|
| `claude-desktop` | Writes `claude_desktop_config.json` |
| `claude-code` | Runs `claude mcp add` |
| `gemini` | Writes `~/.gemini/settings.json` |
| `codex` | Writes `~/.codex/config.json` |
| `vscode` | Writes `.vscode/mcp.json` in current directory |
| `claude-web` | Prints manual setup steps for claude.ai |

## Non-interactive example

```bash
npx dona-mcp --url https://yourcompany.dona.ai.in/mcp/ --key sk-xxx --target claude-code
```

## Re-authentication

If your key expires, run `npx dona-mcp` again. If the key is rejected (401), the CLI prompts you to log in and auto-generates a new key.

## Requirements

Node.js 18+. No other dependencies.
