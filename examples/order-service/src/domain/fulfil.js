// Fulfilment: take stock off the shelf for each line, all or nothing.

import { getStock, decrement } from "../store/inventory.js";

/** Reserve every line's stock, refusing the whole order if any line is short. */
export function reserveStock(lines) {
  for (const line of lines) {
    if (getStock(line.sku) < line.qty) throw new Error(`only ${getStock(line.sku)} ${line.sku} left`);
  }
  lines.forEach(allocateLine);
}

function allocateLine(line) {
  decrement(line.sku, line.qty);
}
