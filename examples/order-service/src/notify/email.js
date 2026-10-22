// Customer emails, rendered here and handed to the outbound queue.

import { enqueue } from "./queue.js";

/** Tell the customer their order is in. */
export function sendConfirmation(order) {
  enqueue({ to: order.customer, subject: `Order ${order.id} confirmed`, body: render(order) });
}

function render(order) {
  const lines = order.lines.map((l) => `  ${l.qty} x ${l.sku} @ $${l.price.toFixed(2)}`).join("\n");
  return `Thanks for your order!\n${lines}\nTotal: $${order.total.toFixed(2)}`;
}
