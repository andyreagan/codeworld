// HTTP handlers for orders.

import { validateOrder } from "../domain/validate.js";
import { priceOrder } from "../domain/pricing.js";
import { reserveStock } from "../domain/fulfil.js";
import * as orders from "../store/orders.js";
import { sendConfirmation } from "../notify/email.js";

/**
 * Place an order: validate, price, reserve stock, save, confirm.
 * @route POST /orders
 * @example {"customer": "ada@example.com", "lines": [{"sku": "GEAR-01", "qty": 3}, {"sku": "BELT-02", "qty": 10}], "coupon": "FACTORY10"}
 */
export function createOrder(body) {
  const order = validateOrder(body);
  const priced = priceOrder(order);
  reserveStock(priced.lines);
  const saved = orders.insert(priced);
  sendConfirmation(saved);
  return { id: saved.id, total: saved.total };
}

/**
 * Look an order up by id.
 * @route GET /orders/:id
 * @example {}
 */
export function getOrder(body, params) {
  const order = orders.find(Number(params.id));
  if (!order) throw new Error(`no order ${params.id}`);
  return order;
}
