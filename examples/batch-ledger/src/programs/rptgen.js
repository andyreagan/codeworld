// RPTGEN: the control report operations reads in the morning.

/** Build the control report from posting totals. */
export function buildReport(totals, rejected) {
  const lines = [
    "ACCTPOST CONTROL REPORT",
    formatLine("RECORDS POSTED", String(totals.count)),
    formatLine("RECORDS REJECTED", String(rejected)),
    formatLine("TOTAL DEBITS", money(totals.debits)),
    formatLine("TOTAL CREDITS", money(totals.credits)),
    formatLine("OVERDRAWN", totals.overdrawn.join(" ") || "NONE")
  ];
  return { report: lines.join("\n") };
}

function formatLine(label, value) {
  return label.padEnd(24, ".") + value.padStart(16);
}

function money(cents) {
  return (cents / 100).toFixed(2);
}
