#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { homedir, platform } from 'os'
import { join, dirname } from 'path'
import { createInterface } from 'readline'
import { spawnSync } from 'child_process'

// ── ANSI ─────────────────────────────────────────────────────────────────────
const c = {
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  blue:   s => `\x1b[34m${s}\x1b[0m`,
}

// ── ARG PARSE ─────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2)
  const result = {}
  for (let i = 0; i < args.length; i++) {
    if      (args[i] === '--url')    result.url    = args[++i]
    else if (args[i] === '--key')    result.key    = args[++i]
    else if (args[i] === '--target') result.target = args[++i]
    else if (args[i] === '--help' || args[i] === '-h') result.help = true
  }
  return result
}

// ── PROMPTS ───────────────────────────────────────────────────────────────────
async function ask(question, defaultVal = '') {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    const hint = defaultVal ? ` ${c.dim(`[${defaultVal}]`)}` : ''
    rl.question(`${question}${hint} `, answer => {
      rl.close()
      resolve(answer.trim() || defaultVal)
    })
  })
}

async function askPassword(question = 'Password:') {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${question} `)
    let password = ''
    const onData = chunk => {
      const str = chunk.toString()
      for (const ch of str) {
        if (ch === '\r' || ch === '\n') {
          cleanup()
          process.stdout.write('\n')
          resolve(password)
          return
        } else if (ch === '') { // Ctrl+C
          cleanup()
          process.stdout.write('\n')
          process.exit(0)
        } else if (ch === '' || ch === '\b') { // backspace
          if (password.length > 0) {
            password = password.slice(0, -1)
            process.stdout.write('\b \b')
          }
        } else {
          password += ch
          process.stdout.write('*')
        }
      }
    }
    const cleanup = () => {
      try { process.stdin.setRawMode(false) } catch {}
      process.stdin.pause()
      process.stdin.removeListener('data', onData)
    }
    try {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.on('data', onData)
    } catch {
      // TTY not available (piped stdin) — fall back to plain readline
      cleanup()
      ask(question).then(resolve).catch(reject)
    }
  })
}

async function select(question, options) {
  console.log(`\n${c.bold(question)}`)
  options.forEach((opt, i) => {
    console.log(`  ${c.cyan(String(i + 1).padStart(2))}. ${opt.label.padEnd(18)} ${c.dim(opt.desc)}`)
  })
  const answer = await ask(`\nSelect (1-${options.length}):`)
  const idx = parseInt(answer) - 1
  if (isNaN(idx) || idx < 0 || idx >= options.length) {
    console.error(c.red('Invalid selection.'))
    process.exit(1)
  }
  return options[idx].value
}

async function confirm(question) {
  const ans = await ask(`${question} ${c.dim('(y/n)')}`)
  return ans.toLowerCase().startsWith('y')
}

// ── URL HELPERS ───────────────────────────────────────────────────────────────
function normalizeUrl(url) {
  return url.replace(/\/+$/, '')
}

function buildMcpUrl(url, key) {
  return `${normalizeUrl(url)}?api_key=${key}`
}

function getBaseUrl(mcpUrl) {
  // Strip /mcp path to get the API base
  // e.g. https://be-demo.dona.ai.in/mcp → https://be-demo.dona.ai.in
  try {
    const u = new URL(mcpUrl)
    return `${u.protocol}//${u.host}`
  } catch {
    return mcpUrl.replace(/\/mcp\/?.*$/, '')
  }
}

// ── FILE HELPERS ──────────────────────────────────────────────────────────────
function readJson(filePath) {
  if (!existsSync(filePath)) return {}
  try { return JSON.parse(readFileSync(filePath, 'utf8')) }
  catch { console.warn(c.yellow(`  Warning: could not parse ${filePath}, starting fresh`)); return {} }
}

function writeJson(filePath, data) {
  if (existsSync(filePath)) {
    const bak = filePath + '.bak'
    copyFileSync(filePath, bak)
    console.log(c.dim(`  Backed up → ${bak}`))
  }
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function home(...parts) { return join(homedir(), ...parts) }

// ── AUTH ──────────────────────────────────────────────────────────────────────
async function loginAndGetKey(baseUrl, username, password) {
  // 1. Login → JWT
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })

  if (!loginRes.ok) {
    if (loginRes.status === 401) throw new Error('Invalid username or password.')
    throw new Error(`Login failed: ${loginRes.status} ${loginRes.statusText}`)
  }

  const { access_token } = await loginRes.json()

  // 2. Create MCP API key
  const keyRes = await fetch(`${baseUrl}/api/user-api-keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${access_token}`,
    },
    body: JSON.stringify({ key_name: 'dona-mcp-cli' }),
  })

  if (!keyRes.ok) throw new Error(`Could not create API key: ${keyRes.status} ${keyRes.statusText}`)

  const { api_key } = await keyRes.json()
  return api_key
}

async function validateKey(mcpUrl) {
  // Hit the MCP endpoint with the key; 401 = invalid, anything else = reachable/valid
  try {
    const res = await fetch(mcpUrl, { method: 'GET', signal: AbortSignal.timeout(8000) })
    return res.status !== 401
  } catch {
    return null // server unreachable — don't block setup
  }
}

async function authFlow(baseUrl) {
  console.log(c.dim(`\n  Logging in to ${baseUrl} …`))
  const username = await ask('Username:')
  const password = await askPassword('Password:')

  try {
    const key = await loginAndGetKey(baseUrl, username, password)
    console.log(c.green(`\n  ✓ Logged in. API key generated: ${c.cyan(key)}`))
    console.log(c.dim('  Save this key somewhere safe — it won\'t be shown again.\n'))
    return key
  } catch (err) {
    console.error(c.red(`\n  ✗ ${err.message}`))
    const retry = await confirm('  Try again?')
    if (retry) return authFlow(baseUrl)
    process.exit(1)
  }
}

// ── TARGETS ───────────────────────────────────────────────────────────────────
const TARGETS = [
  { value: 'claude-desktop', label: 'Claude Desktop',  desc: 'Writes app config file' },
  { value: 'claude-code',    label: 'Claude Code CLI', desc: 'Runs `claude mcp add`' },
  { value: 'gemini',         label: 'Gemini CLI',      desc: '~/.gemini/settings.json' },
  { value: 'codex',          label: 'OpenAI Codex',    desc: '~/.codex/config.json' },
  { value: 'vscode',         label: 'VS Code',         desc: '.vscode/mcp.json (cwd)' },
  { value: 'claude-web',     label: 'Claude Web',      desc: 'claude.ai manual steps' },
]

function claudeDesktopConfigPath() {
  if (platform() === 'win32')
    return join(process.env.APPDATA || home('AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  if (platform() === 'linux')
    return home('.config', 'Claude', 'claude_desktop_config.json')
  return home('Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
}

function targetClaudeDesktop(mcpUrl) {
  const filePath = claudeDesktopConfigPath()
  const config = readJson(filePath)
  config.mcpServers = config.mcpServers || {}
  config.mcpServers['dona-ai'] = { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl] }
  writeJson(filePath, config)
  console.log(c.green(`\n✓ Written to:\n  ${filePath}`))
  console.log(c.dim('  Fully restart Claude Desktop to activate.'))
}

function targetClaudeCode(mcpUrl) {
  let hasClaude = false
  try { hasClaude = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0 } catch {}

  if (!hasClaude) {
    console.log(c.yellow('\n`claude` not found in PATH. Run manually:'))
    console.log(c.cyan(`\n  claude mcp add dona-ai npx -- -y mcp-remote "${mcpUrl}"\n`))
    return
  }

  const result = spawnSync('claude', ['mcp', 'add', 'dona-ai', 'npx', '--', '-y', 'mcp-remote', mcpUrl], {
    stdio: 'inherit', shell: false,
  })
  if (result.status === 0) {
    console.log(c.green('\n✓ MCP server added to Claude Code'))
  } else {
    console.error(c.red('\n✗ `claude mcp add` failed. Run manually:'))
    console.log(c.cyan(`\n  claude mcp add dona-ai npx -- -y mcp-remote "${mcpUrl}"\n`))
  }
}

function targetGemini(mcpUrl) {
  const filePath = home('.gemini', 'settings.json')
  const config = readJson(filePath)
  config.mcpServers = config.mcpServers || {}
  config.mcpServers['dona-ai'] = { httpUrl: mcpUrl }
  writeJson(filePath, config)
  console.log(c.green(`\n✓ Written to:\n  ${filePath}`))
}

function targetCodex(mcpUrl) {
  const filePath = home('.codex', 'config.json')
  const config = readJson(filePath)
  config.mcpServers = config.mcpServers || {}
  config.mcpServers['dona-ai'] = { type: 'streamable-http', url: mcpUrl }
  writeJson(filePath, config)
  console.log(c.green(`\n✓ Written to:\n  ${filePath}`))
}

function targetVscode(mcpUrl) {
  const filePath = join(process.cwd(), '.vscode', 'mcp.json')
  const config = readJson(filePath)
  config.servers = config.servers || {}
  config.servers['dona-ai'] = { type: 'http', url: mcpUrl }
  writeJson(filePath, config)
  console.log(c.green(`\n✓ Written to:\n  ${filePath}`))
  console.log(c.dim('  Reload VS Code window to activate (Cmd+Shift+P → "Reload Window").'))
}

function targetClaudeWeb(mcpUrl) {
  console.log(`
${c.bold('Claude Web (claude.ai) — Manual Setup')}

${c.dim('Requires a paid Claude plan with Integrations enabled.')}

1. Open ${c.cyan('https://claude.ai')} → avatar → ${c.bold('Settings')} → ${c.bold('Integrations')}
2. Click ${c.bold('Add Integration')} → ${c.bold('Custom MCP Server')}
3. Fill in:
     Name:  ${c.cyan('dona-ai')}
     URL:   ${c.cyan(mcpUrl)}
4. Save and refresh the page
`)
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs()

  if (args.help) {
    console.log(`
${c.bold('dona-mcp')} — Add Dona AI MCP to your AI tools

${c.bold('Usage:')}
  npx dona-mcp [options]

${c.bold('Options:')}
  --url <url>        Your Dona instance MCP URL  ${c.dim('e.g. https://yourcompany.dona.ai.in/mcp/')}
  --key <key>        API key (skip login flow)
  --target <target>  Target tool (skip selection prompt)
  --help             Show this help

${c.bold('Targets:')}
${TARGETS.map(t => `  ${t.value.padEnd(16)} ${t.desc}`).join('\n')}

${c.bold('Examples:')}
  npx dona-mcp
  npx dona-mcp --url https://mycompany.dona.ai.in/mcp/ --key sk-xxx --target claude-code
`)
    process.exit(0)
  }

  console.log(`\n${c.bold('◆ Dona AI MCP Setup')}\n`)
  console.log(c.dim('  Each Dona instance has its own URL — check your admin dashboard.\n'))

  // ── Step 1: URL ─────────────────────────────────────────────────────────────
  let rawUrl = args.url
  if (!rawUrl) {
    rawUrl = await ask(`Your Dona MCP URL ${c.dim('(e.g. https://yourcompany.dona.ai.in/mcp/)')}:`)
    if (!rawUrl) {
      console.error(c.red('\nURL required. Find it in your Dona dashboard → MCP Setup.'))
      process.exit(1)
    }
  }
  const baseUrl = getBaseUrl(rawUrl)

  // ── Step 2: API key ─────────────────────────────────────────────────────────
  let apiKey = args.key

  if (!apiKey) {
    const AUTH_OPTS = [
      { value: 'key',   label: 'I have an API key', desc: 'Enter it directly' },
      { value: 'login', label: 'Log in',             desc: 'Username + password → auto-generate key' },
    ]
    const authChoice = await select('How would you like to authenticate?', AUTH_OPTS)

    if (authChoice === 'key') {
      apiKey = await ask('API key:')
      if (!apiKey) {
        console.error(c.red('\nAPI key required.'))
        process.exit(1)
      }
    } else {
      apiKey = await authFlow(baseUrl)
    }
  }

  // ── Step 3: Validate key ─────────────────────────────────────────────────────
  const mcpUrlForValidation = buildMcpUrl(rawUrl, apiKey)
  process.stdout.write(c.dim('  Validating API key … '))
  const valid = await validateKey(mcpUrlForValidation)

  if (valid === null) {
    console.log(c.yellow('server unreachable, skipping validation'))
  } else if (valid === false) {
    console.log(c.red('invalid'))
    console.log(c.red('\n  ✗ API key rejected (401).'))
    const reauth = await confirm('  Log in to generate a new key?')
    if (!reauth) { console.log(c.dim('  Aborted.')); process.exit(1) }
    apiKey = await authFlow(baseUrl)
  } else {
    console.log(c.green('valid ✓'))
  }

  // ── Step 4: Target ───────────────────────────────────────────────────────────
  const target = args.target || await select('Which tool to configure?', TARGETS)

  if (!TARGETS.find(t => t.value === target)) {
    console.error(c.red(`Unknown target: ${target}`))
    console.error(`Valid: ${TARGETS.map(t => t.value).join(', ')}`)
    process.exit(1)
  }

  // ── Step 5: Write config ─────────────────────────────────────────────────────
  const mcpUrl = buildMcpUrl(rawUrl, apiKey)

  switch (target) {
    case 'claude-desktop': targetClaudeDesktop(mcpUrl); break
    case 'claude-code':    targetClaudeCode(mcpUrl);    break
    case 'gemini':         targetGemini(mcpUrl);        break
    case 'codex':          targetCodex(mcpUrl);         break
    case 'vscode':         targetVscode(mcpUrl);        break
    case 'claude-web':     targetClaudeWeb(mcpUrl);     break
  }

  console.log(c.dim('\n  To re-authenticate or switch tools: npx dona-mcp\n'))
}

main().catch(err => {
  console.error(c.red(`\nError: ${err.message}`))
  process.exit(1)
})
