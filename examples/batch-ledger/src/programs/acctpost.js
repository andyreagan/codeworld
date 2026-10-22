// ACCTPOST: apply edited transactions to the account master.

import { readAcct, rewriteAcct } from "../data/accounts.js";

/** Post every record; return control totals. */
export function postBatch(records) {
  const totals = { count: 0, debits: 0, credits: 0, overdrawn: [] };
  for (const rec of records) postOne(rec, totals);
  return totals;
}

function postOne(rec, totals) {
  const acct = readAcct(rec.account);
  const delta = rec.type === "C" ? rec.cents : -rec.cents;
  const updated = { ...acct, balance: acct.balance + delta };
  if (updated.balance < 0) updated.balance -= overdraftFee(updated);
  rewriteAcct(updated);
  totals.count++;
  if (delta < 0) totals.debits += -delta;
  else totals.credits += delta;
  if (updated.balance < 0) totals.overdrawn.push(rec.account);
}

function overdraftFee(acct) {
  return acct.tier === "GOLD" ? 0 : 3500;
}
