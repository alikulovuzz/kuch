/* One critical section at a time per key, in the order they were asked for.

   `lock(key, fn)` runs `fn` once every earlier section on `key` has settled, and answers what
   `fn` answers (its value, or its error). Sections on different keys do not wait for each other.
   A failed section does not hold up the next one. A key is dropped once nothing waits on it, so
   the map holds only the profiles with a write in flight.

   In process memory only: like everything else the API keeps in memory, it assumes one API
   process per data directory (docs/adr/0001-postgres-write-through-db.md). */
export function keyedLock() {
  const tails = new Map();   // key -> promise that settles when the last section queued on it has
  function lock(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    const run = prev.then(() => fn());
    const tail = run.then(() => {}, () => {});
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
  }
  Object.defineProperty(lock, 'size', { get: () => tails.size });
  return lock;
}
