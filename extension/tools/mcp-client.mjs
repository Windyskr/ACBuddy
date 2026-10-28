import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MCP_ENTRY = path.join(
  PROJECT_ROOT,
  'node_modules',
  'chrome-devtools-mcp',
  'build',
  'src',
  'bin',
  'chrome-devtools-mcp.js',
);
export const EXT_PATH = path.join(PROJECT_ROOT, '.output', 'chrome-mv3-dev');
export const PROFILE_DIR = path.join(PROJECT_ROOT, '.chrome-profile');
export const ARTIFACTS = path.join(PROJECT_ROOT, '.mcp-artifacts');

function execFileP(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr });
    });
  });
}

export async function killProfileChrome() {
  const ps = `
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
      Where-Object { $_.CommandLine -like '*${PROFILE_DIR.split('\\').join('\\\\')}*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  `.trim();
  await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps],
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class McpClient {
  constructor({ extraArgs = [] } = {}) {
    this.extraArgs = extraArgs;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
  }

  async start() {
    await killProfileChrome();
    this.proc = spawn(
      process.execPath,
      [
        MCP_ENTRY,
        `--user-data-dir=${PROFILE_DIR}`,
        `--workspace=${PROJECT_ROOT}`,
        '--experimentalIncludeAllPages=true',
        '--categoryExtensions=true',
        ...this.extraArgs,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`${msg.error.message ?? JSON.stringify(msg.error)}`));
          else resolve(msg.result);
        }
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      process.stderr.write(`[mcp] ${d}`);
    });
    this.proc.on('exit', (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`MCP server exited (code ${code})`));
      }
      this.pending.clear();
    });

    await this.request(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'wxt-test-driver', version: '1.0.0' },
      },
      90000,
    );
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
  }

  request(method, params, timeoutMs = 90000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout after ${timeoutMs}ms: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async call(name, args = {}, timeoutMs = 90000) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (res?.isError) {
      throw new Error(`${name} tool error: ${this.text(res).slice(0, 300)}`);
    }
    return res;
  }

  text(res) {
    return (res?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }

  async stop() {
    try {
      this.proc?.stdin.end();
    } catch {}
    await sleep(500);
    try {
      this.proc?.kill();
    } catch {}
    await sleep(1000);
    await killProfileChrome();
  }
}
