/**
 * Locating the `muse` CLI and the user's own login.
 *
 * Credential policy (hard rule): this module never reads, stores, or sends
 * ~/.config/muse/auth.json, API keys, or tokens. Auth belongs to the
 * user's own `muse login`, run in a terminal they can see.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const COMMON_LOCATIONS = [
  path.join(os.homedir(), '.local', 'bin', 'muse'),
  '/opt/homebrew/bin/muse',
  '/usr/local/bin/muse',
  path.join(os.homedir(), '.local', 'bin', 'muse.exe'),
];

export function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Find `muse` on PATH (or via an explicit setting). Returns null if missing. */
export function findMuseOnPath(): string | null {
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, process.platform === 'win32' ? 'muse.exe' : 'muse');
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function findMuse(explicitPath?: string): string | null {
  if (explicitPath && explicitPath.trim()) {
    return isExecutable(explicitPath.trim()) ? explicitPath.trim() : null;
  }
  return findMuseOnPath() ?? COMMON_LOCATIONS.find((p) => isExecutable(p)) ?? null;
}

export type SetupStatus = { ok: true; executable: string } | { ok: false; reason: string };

export function checkSetup(explicitPath?: string): SetupStatus {
  const found = findMuse(explicitPath);
  if (found) {
    return { ok: true, executable: found };
  }
  return {
    ok: false,
    reason:
      'The `muse` CLI was not found on PATH or in common locations (~/.local/bin, /opt/homebrew/bin). Install Muse Code, then run `muse login`.',
  };
}

export const INSTALL_INSTRUCTIONS = {
  macLinux: 'curl -fsSL https://dev.meta.ai/install.sh | bash',
  windows: 'irm https://dev.meta.ai/install.ps1 | iex',
};
