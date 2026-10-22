// Stock comes in as CSV drops from the warehouse; a timer watches for shortages.

import { parseCsv } from "../lib/csv.js";
import { setStock, lowStock } from "../store/inventory.js";
import { enqueue } from "../notify/queue.js";

/**
 * Replace stock levels from a "sku,qty" CSV.
 * @inbox *.csv
 * @sample samples/inventory.csv
 */
export function importInventory(name, text) {
  const rows = parseCsv(text);
  for (const row of rows) setStock(row.sku, Number(row.qty));
  return { file: name, skus: rows.length };
}

/**
 * Every few seconds, tell purchasing what's running low.
 * @cron 8s
 */
export function restockReport() {
  const low = lowStock(5);
  if (low.length) enqueue({ to: "purchasing@example.com", subject: `Low stock: ${low.join(", ")}` });
  return low;
}
