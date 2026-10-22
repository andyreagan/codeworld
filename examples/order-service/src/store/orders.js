// Placed orders.
// @store

const rows = new Map();
let lastId = 1000;

export function insert(order) {
  const saved = { ...order, id: nextId(), placedAt: new Date().toISOString() };
  rows.set(saved.id, saved);
  return saved;
}

export function find(id) {
  return rows.get(id) ?? null;
}

function nextId() {
  return ++lastId;
}

export function count() {
  return rows.size;
}
