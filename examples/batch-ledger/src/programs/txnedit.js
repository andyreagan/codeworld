// TXNEDIT: the edit rules. Returns a reject reason, or null when the record is clean.

import { readAcct } from "../data/accounts.js";

export function editRecord(rec) {
  if (!/^\d{8}$/.test(rec.account)) return "E01 BAD ACCOUNT NUMBER";
  if (rec.type !== "D" && rec.type !== "C") return "E02 BAD TXN TYPE";
  if (Number.isNaN(rec.cents) || rec.cents === 0) return "E03 BAD AMOUNT";
  if (!validDate(rec.date)) return "E04 BAD DATE";
  const acct = readAcct(rec.account);
  if (!acct) return "E05 ACCOUNT NOT ON FILE";
  if (acct.status === "FROZEN") return "E06 ACCOUNT FROZEN";
  return null;
}

function validDate(d) {
  const m = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  return /^\d{8}$/.test(d) && m >= 1 && m <= 12 && day >= 1 && day <= 31;
}
