/* keyedLock: one critical section at a time per key. PUT /api/data's compare-and-write runs
   under it once the store is async (store/index.js), so a second write for the same profile
   cannot read the revision the first is about to replace. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyedLock } from '../keyed-lock.js';

const tick = () => new Promise(r => setImmediate(r));

test('two sections on one key run one after the other, in call order', async () => {
  const lock = keyedLock();
  const seen = [];
  const section = name => async () => { seen.push(name + ' in'); await tick(); await tick(); seen.push(name + ' out'); return name; };
  const [a, b] = await Promise.all([lock('u1', section('a')), lock('u1', section('b'))]);
  assert.equal(a, 'a');
  assert.equal(b, 'b');
  assert.deepEqual(seen, ['a in', 'a out', 'b in', 'b out']);
});

test('sections on different keys do not wait for each other', async () => {
  const lock = keyedLock();
  const seen = [];
  const section = name => async () => { seen.push(name + ' in'); await tick(); seen.push(name + ' out'); };
  await Promise.all([lock('u1', section('a')), lock('u2', section('b'))]);
  assert.deepEqual(seen, ['a in', 'b in', 'a out', 'b out']);
});

test('a section that throws hands its error to its caller and still lets the next one in', async () => {
  const lock = keyedLock();
  const first = lock('u1', async () => { await tick(); throw new Error('disk full'); });
  const second = lock('u1', async () => 'ran');
  await assert.rejects(first, /disk full/);
  assert.equal(await second, 'ran');
});

test('a synchronous throw is a rejection, not an exception out of the call', async () => {
  const lock = keyedLock();
  const p = lock('u1', () => { throw new Error('bad'); });
  assert.ok(p instanceof Promise);
  await assert.rejects(p, /bad/);
  assert.equal(await lock('u1', () => 'next'), 'next');
});

test('a key is forgotten once nothing waits on it', async () => {
  const lock = keyedLock();
  await lock('u1', async () => { await tick(); });
  await lock('u2', () => { throw new Error('x'); }).catch(() => {});
  await tick();
  assert.equal(lock.size, 0);
});
