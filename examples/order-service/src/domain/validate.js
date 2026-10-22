// Request checking: nothing malformed gets past here.

/** Check an order request and normalise it. */
export function validateOrder(body) {
  if (!body || typeof body.customer !== "string" || !body.customer.includes("@")) throw new Error("customer email is required");
  if (!Array.isArray(body.lines) || body.lines.length === 0) throw new Error("an order needs lines");
  return { customer: body.customer, coupon: body.coupon ?? null, lines: body.lines.map(validateLine) };
}

function validateLine(line) {
  if (!isSku(line.sku)) throw new Error(`bad sku: ${line.sku}`);
  const qty = Number(line.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw new Error(`bad qty for ${line.sku}`);
  return { sku: line.sku, qty };
}

function isSku(s) {
  return typeof s === "string" && /^[A-Z]+-\d{2}$/.test(s);
}
