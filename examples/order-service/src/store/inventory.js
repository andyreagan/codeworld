// Stock on hand, per SKU.
// @store

const stock = new Map([["GEAR-01", 40], ["BELT-02", 120], ["PIPE-03", 6], ["CHIP-04", 3]]);

export function getStock(sku) {
  return stock.get(sku) ?? 0;
}

export function setStock(sku, qty) {
  stock.set(sku, qty);
}

export function decrement(sku, qty) {
  stock.set(sku, getStock(sku) - qty);
}

/** SKUs with fewer than `threshold` on hand. */
export function lowStock(threshold) {
  return [...stock].filter(([, q]) => q < threshold).map(([s]) => s);
}

export function count() {
  return [...stock.values()].reduce((a, b) => a + b, 0);
}
