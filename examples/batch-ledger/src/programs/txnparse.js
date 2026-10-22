// TXNPARSE: fixed-width transaction records.
//   cols 1-8 account, 9 type (D/C), 10-20 amount in cents, 21-28 yyyymmdd, 29-48 memo

/** Split a file into records, skipping the header and trailer. */
export function parseFile(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const body = lines.filter((l) => !l.startsWith("HDR") && !l.startsWith("TRL"));
  checkTrailer(lines, body.length);
  return body.map(parseRecord);
}

function parseRecord(line) {
  return {
    account: line.slice(0, 8),
    type: line.slice(8, 9),
    cents: unpackAmount(line.slice(9, 20)),
    date: line.slice(20, 28),
    memo: line.slice(28, 48).trim()
  };
}

function unpackAmount(field) {
  return /^\d{11}$/.test(field) ? Number(field) : NaN;
}

function checkTrailer(lines, n) {
  const trl = lines.find((l) => l.startsWith("TRL"));
  if (!trl) throw new Error("file has no trailer record");
  if (Number(trl.slice(3)) !== n) throw new Error(`trailer says ${Number(trl.slice(3))} records, file has ${n}`);
}
