// STAGING: transactions received today, waiting for the batch window.
// @store

let pending = [];

export function stage(file, records) {
  for (const r of records) pending.push({ ...r, file });
}

/** Hand everything to the batch and empty the staging area. */
export function takeAll() {
  const all = pending;
  pending = [];
  return all;
}

export function count() {
  return pending.length;
}
