// ACCTMAST: the account master file (a VSAM KSDS, keyed by account number).
// @store

const master = new Map(
  [
    ["10000001", "STANDARD", 125000], ["10000002", "GOLD", 9800000], ["10000003", "STANDARD", 4200],
    ["10000004", "STANDARD", 0], ["10000005", "GOLD", 15000]
  ].map(([account, tier, balance]) => [account, { account, tier, balance, status: "OPEN" }])
);
master.get("10000004").status = "FROZEN";

export function readAcct(account) {
  return master.get(account) ?? null;
}

export function rewriteAcct(acct) {
  master.set(acct.account, acct);
}

export function count() {
  return master.size;
}
