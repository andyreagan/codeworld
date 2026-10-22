// The outbound mail queue (a stand-in for SES/SQS).
// @store

const outbox = [];

export function enqueue(message) {
  outbox.push({ ...message, queuedAt: Date.now() });
}

export function count() {
  return outbox.length;
}
