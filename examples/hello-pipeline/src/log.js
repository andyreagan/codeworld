// Everything we've said, in order.
// @store

const entries = [];

/** Append a message with a timestamp. */
export function record(message) {
  entries.push({ at: new Date().toISOString(), message });
}

export function count() {
  return entries.length;
}
