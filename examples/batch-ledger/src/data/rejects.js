// REJECTS: records the edit refused, with their reason codes.
// @store

const rejected = [];

export function write(rec, reason) {
  rejected.push({ ...rec, reason });
}

export function count() {
  return rejected.length;
}
