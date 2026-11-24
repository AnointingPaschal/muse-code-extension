import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame, NdjsonParser } from '../out/msp/framing.js';

test('encode/decode round-trips a JSON-RPC message', () => {
  const msg = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { client: 'test' } };
  const line = encodeFrame(msg);
  assert.ok(line.endsWith('\n'));
  assert.deepEqual(decodeFrame(line.trim()), msg);
});

test('NdjsonParser handles a line split across chunks', () => {
  const parser = new NdjsonParser();
  const part1 = parser.push('{"jsonrpc":"2.0","id":1,');
  assert.deepEqual(part1, []);
  const part2 = parser.push('"method":"initialize"}\n');
  assert.equal(part2.length, 1);
  assert.equal(part2[0].method, 'initialize');
});

test('NdjsonParser handles multiple lines in one chunk and CRLF', () => {
  const parser = new NdjsonParser();
  const out = parser.push('{"jsonrpc":"2.0","method":"a"}\r\n{"jsonrpc":"2.0","method":"b"}\n');
  assert.equal(out.length, 2);
  assert.equal(out[0].method, 'a');
  assert.equal(out[1].method, 'b');
});

test('NdjsonParser ignores blank lines', () => {
  const parser = new NdjsonParser();
  const out = parser.push('\n{"jsonrpc":"2.0","method":"a"}\n\n');
  assert.equal(out.length, 1);
});
