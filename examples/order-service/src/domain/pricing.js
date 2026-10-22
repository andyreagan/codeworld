// Money: list prices, coupons and tax.

const PRICES = { "GEAR-01": 4.5, "BELT-02": 1.25, "PIPE-03": 2.0, "CHIP-04": 12.0 };
const COUPONS = { FACTORY10: 0.1, BULK25: 0.25 };
const TAX = 0.0625; // Massachusetts

/** Price every line, then discount and tax the order. */
export function priceOrder(order) {
  const lines = order.lines.map(lineTotal);
  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  const discounted = applyDiscount(subtotal, order.coupon);
  const total = round(discounted + tax(discounted));
  return { ...order, lines, subtotal: round(subtotal), total };
}

function lineTotal(line) {
  const price = PRICES[line.sku];
  if (price === undefined) throw new Error(`no price for ${line.sku}`);
  return { ...line, price, total: round(price * line.qty) };
}

function applyDiscount(amount, coupon) {
  if (!coupon) return amount;
  const off = COUPONS[coupon];
  if (off === undefined) throw new Error(`unknown coupon ${coupon}`);
  return amount * (1 - off);
}

function tax(amount) {
  return round(amount * TAX);
}

function round(x) {
  return Math.round(x * 100) / 100;
}
