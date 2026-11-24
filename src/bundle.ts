/**
 * Bundle Project for Muse: walk a folder and write muse-bundle.md with
 * every relevant source file. Skips node_modules, .git, dist, build output
 * and binary files. Pure fs — no VS Code dependency, so it is unit-testable.
 */
import * as fs from 'fs';
import * as path from 'path';

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.vscode-test', 'coverage', 'vendor']);
export const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tar', '.gz',
  '.mp4', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.eot', '.exe', '.dll', '.so', '.dylib', '.bin', '.vsix',
]);
const MAX_FILE_BYTES = 200_000;
const MAX_TOTAL_BYTES = 1_000_000;

export function shouldSkipFile(relPath: string): boolean {
  const parts = relPath.split(path.sep);
  if (parts.some((p) => SKIP_DIRS.has(p))) {
    return true;
  }
  if (SKIP_EXTENSIONS.has(path.extname(relPath).toLowerCase())) {
    return true;
  }
  return false;
}

export function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(full);
        }
      } else if (entry.isFile() && !shouldSkipFile(rel)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Build the bundle markdown for `root`. Returns { content, fileCount }. */
export function buildBundle(root: string): { content: string; fileCount: number } {
  const files = collectFiles(root);
  const lines: string[] = ['# Project bundle for Muse Code', '', `Root: ${root}`, `Files: ${files.length}`, ''];
  let total = 0;
  let included = 0;
  for (const file of files) {
    const rel = path.relative(root, file);
    let content: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_BYTES) {
        lines.push(`## ${rel}`, '', `_(skipped: ${stat.size} bytes, over the ${MAX_FILE_BYTES} byte per-file limit)_`, '');
        continue;
      }
      if (total + stat.size > MAX_TOTAL_BYTES) {
        lines.push(`## ${rel}`, '', '_(skipped: bundle size limit reached)_', '');
        continue;
      }
      content = fs.readFileSync(file, 'utf8');
      total += stat.size;
    } catch {
      continue;
    }
    const ext = path.extname(file).slice(1) || 'text';
    lines.push(`## ${rel}`, '', `\`\`\`${ext}`, content, '```', '');
    included++;
  }
  return { content: lines.join('\n'), fileCount: included };
}

export function writeBundle(root: string): string {
  const { content } = buildBundle(root);
  const outPath = path.join(root, 'muse-bundle.md');
  fs.writeFileSync(outPath, content, 'utf8');
  return outPath;
}
