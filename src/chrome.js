import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);

export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}

// Covers quoted whole arguments and Chrome's --key="value with spaces" form.
export function windowsArguments(commandLine) {
  return (commandLine.match(/(?:[^\s"]|"[^"]*")+/g) ?? []).map(arg => arg.replaceAll('"', ''));
}

export function validateEndpoint(text) {
  const [port, route] = text.trim().split(/\r?\n/);
  if (!/^\d+$/.test(port) || +port < 1 || +port > 65535 ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(route ?? '')) throw new Error('Invalid managed endpoint');
  return `ws://127.0.0.1:${port}${route}`;
}

export class Chrome {
  constructor(stateDir, { run = execute } = {}) {
    this.stateDir = stateDir;
    this.profile = path.join(stateDir, 'chrome-profile');
    this.metadataFile = path.join(stateDir, 'chrome.json');
    this.activePort = path.join(this.profile, 'DevToolsActivePort');
    this.run = run;
  }

  async inspect(pid) {
    if (process.platform !== 'win32') throw new Error('Windows required');
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid PID');
    // CIM supplies identity. The window handle is optional and can disappear during exit.
    const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $p) { $hwnd=$null; try { $w=Get-Process -Id ${pid} -ErrorAction Stop; $hwnd=$w.MainWindowHandle.ToInt64().ToString('X') } catch {} @{pid=[int]$p.ProcessId; created=$p.CreationDate.ToUniversalTime().ToString('o'); executable=$p.ExecutablePath; commandLine=$p.CommandLine; session=[int]$p.SessionId; hwnd=$hwnd} | ConvertTo-Json -Compress }`;
    const { stdout } = await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  }

  async identity() {
    const saved = await readJson(this.metadataFile);
    if (!saved) return null;
    const actual = await this.inspect(saved.pid);
    if (!actual) return null;
    if (actual.created !== saved.created ||
        actual.executable?.toLowerCase() !== saved.executable?.toLowerCase() ||
        !windowsArguments(actual.commandLine ?? '').includes(`--user-data-dir=${this.profile}`) ||
        !windowsArguments(actual.commandLine ?? '').includes('--remote-debugging-port=0')) {
      throw new Error('Managed Chrome identity mismatch');
    }
    return actual;
  }

  async executable() {
    const candidates = process.env.CHROME_DIALOG_CHROME_PATH ? [process.env.CHROME_DIALOG_CHROME_PATH] : [
      path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    ];
    for (const candidate of candidates) {
      try { await access(candidate); return candidate; } catch { /* Next standard install location. */ }
    }
    throw new Error('Chrome executable unavailable');
  }

  async ensure({ launchIfMissing = true } = {}) {
    if (process.platform !== 'win32') throw new Error('Windows required');
    // Confirm identity queries are permitted before starting a browser we could not track.
    await this.inspect(process.pid);
    await mkdir(this.profile, { recursive: true, mode: 0o700 });
    let actual = await this.identity();
    if (!actual) {
      if (!launchIfMissing) throw new Error('Managed Chrome no longer running');
      const configuredUrl = process.env.CHROME_DIALOG_START_URL;
      const startUrl = configuredUrl === undefined
        ? new URL('../assets/start.html', import.meta.url) : new URL(configuredUrl);
      if (configuredUrl !== undefined && !['http:', 'https:'].includes(startUrl.protocol)) {
        throw new Error('Configured startup URL must use HTTP or HTTPS');
      }
      await rm(this.activePort, { force: true });
      const child = spawn(await this.executable(), [
        `--user-data-dir=${this.profile}`, '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', startUrl.href,
      ], { detached: true, stdio: 'ignore', windowsHide: false });
      let spawnError;
      child.on('error', error => { spawnError = error; });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      actual = await this.inspect(child.pid);
      if (spawnError || !actual || !windowsArguments(actual.commandLine ?? '').includes(`--user-data-dir=${this.profile}`)) {
        throw new Error('Cannot identify launched Chrome');
      }
      await writeJson(this.metadataFile, { pid: actual.pid, created: actual.created, executable: actual.executable });
      const deadline = Date.now() + 15000;
      while (true) {
        if (spawnError || child.exitCode !== null) throw new Error('Managed Chrome exited');
        try { await access(this.activePort); break; }
        catch (error) { if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error; }
        await delay(100);
      }
    }
    // Match the persistent process identity again before trusting this profile's endpoint.
    actual = await this.identity();
    if (!actual) throw new Error('Managed Chrome disappeared');
    const endpoint = validateEndpoint(await readFile(this.activePort, 'utf8'));
    return { endpoint, identifiers: this.identifiers(actual) };
  }

  identifiers(actual) {
    return { status: 'ready', pid: actual.pid ?? null,
      hwnd: actual.hwnd && actual.hwnd !== '0' ? `0x${actual.hwnd}` : null,
      windows_session_id: actual.session ?? null };
  }

  async close() {
    const actual = await this.identity();
    if (!actual) return { status: 'not_running' };
    // Explicit close only. PID plus creation time and dedicated profile were verified above.
    try {
      await this.run('taskkill.exe', ['/PID', String(actual.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } catch (error) {
      // Chrome can exit after identity verification but before taskkill sees it.
      // Only a fresh, successful identity query may establish that it is gone.
      if (!await this.identity()) return { status: 'closed' };
      throw error;
    }
    if (!await this.waitForExit()) throw new Error('Managed Chrome did not exit');
    return { status: 'closed' };
  }

  async waitForExit(timeout = 5000) {
    const deadline = Date.now() + timeout;
    do {
      if (!await this.identity()) return true;
      await delay(100);
    } while (Date.now() < deadline);
    return false;
  }

}
