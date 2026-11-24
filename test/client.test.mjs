import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MspClient } from '../out/msp/client.js';

/**
 * Build a fake `muse` executable: a small Node script with a shebang that
 * ignores the `serve` argument and runs fake-muse-serve.mjs. This is how
 * the test exercises MspClient end-to-end without a real Muse Code CLI.
 */
function makeFakeMuse() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-muse-'));
  const fakeServe = path.join(dir, 'fake-muse-serve.mjs');
  fs.copyFileSync(new URL('./fake-muse-serve.mjs', import.meta.url), fakeServe);
  const exe = path.join(dir, 'muse');
  fs.writeFileSync(exe, `#!/usr/bin/env node\nimport { spawn } from 'node:child_process';\nconst child = spawn(process.execPath, [${JSON.stringify(fakeServe)}], { stdio: 'inherit' });\nchild.on('exit', (c) => process.exit(c ?? 0));\n`, 'utf8');
  fs.chmodSync(exe, 0o755);
  return exe;
}

test('MspClient: initialize, list/start sessions, and stream a turn via fake muse serve', async () => {
  const exe = makeFakeMuse();
  const client = new MspClient({ executable: exe, cwd: os.tmpdir() });
  const items = [];
  client.on('item', (item, phase) => items.push({ item, phase }));
  try {
    await client.start();
    const sessions = await client.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, 's1');
    const session = await client.startSession();
    assert.equal(session.id, 's1');
    await client.sendTurn(session.id, 'hello');
    // Streaming is async; the turn response resolves after the fake server
    // has already sent its notifications, but give the event loop a tick.
    await new Promise((r) => setTimeout(r, 100));
    const texts = items.filter((i) => i.item.kind === 'message').map((i) => i.item.text ?? '');
    assert.ok(texts.join('').includes('hello'), `expected streamed text, got: ${JSON.stringify(texts)}`);
    const tool = items.find((i) => i.item.kind === 'toolCall');
    assert.ok(tool, 'expected a toolCall item');
    assert.equal(tool.item.filePath, 'src/foo.ts');
  } finally {
    client.dispose();
  }
});
