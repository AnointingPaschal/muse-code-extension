/**
 * Fake `muse serve` used by client.test.mjs.
 * Speaks newline-delimited JSON-RPC over stdio, with a tiny subset of MSP:
 * initialize, session/list, session/start, session/resume, turn/send.
 * NOT a real Muse Code server — test double only.
 */
import * as readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

rl.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      reply({ ok: true, protocolVersion: 'test' });
      break;
    case 'session/list':
      reply({ sessions: [{ id: 's1', title: 'Test session' }] });
      break;
    case 'session/start':
      reply({ session: { id: 's1', title: 'Test session' } });
      break;
    case 'session/resume':
      reply({ session: { id: msg.params?.sessionId ?? 's1', title: 'Test session' } });
      break;
    case 'turn/send': {
      const sessionId = msg.params?.sessionId ?? 's1';
      notify('item/started', { item: { id: 'i1', kind: 'message', text: '' } });
      notify('item/delta', { item: { id: 'i1', kind: 'message', text: 'hello ' } });
      notify('item/delta', { item: { id: 'i1', kind: 'message', text: 'from fake muse' } });
      notify('item/completed', { item: { id: 'i1', kind: 'message', text: 'hello from fake muse' } });
      notify('item/completed', { item: { id: 'i2', kind: 'toolCall', tool: 'write', filePath: 'src/foo.ts', summary: 'Wrote src/foo.ts' } });
      void sessionId;
      reply({});
      break;
    }
    case 'turn/cancel':
      reply({});
      break;
    default:
      reply({});
      break;
  }
});
