// The job stream (think JCL): receive files all day, run the batch on a timer.

import { parseFile } from "../programs/txnparse.js";
import { editRecord } from "../programs/txnedit.js";
import { postBatch } from "../programs/acctpost.js";
import { buildReport } from "../programs/rptgen.js";
import * as staging from "../data/staging.js";
import * as rejects from "../data/rejects.js";

/**
 * A transaction file arrives from the branch network: parse it and stage it.
 * @inbox *.dat
 * @sample samples/TXNS.dat
 */
export function receiveTransactions(name, text) {
  const records = parseFile(text);
  staging.stage(name, records);
  return { file: name, staged: records.length };
}

/**
 * STEP010 edit, STEP020 post, STEP030 report, over everything staged.
 * @cron 20s
 */
export function runNightly() {
  const batch = staging.takeAll();
  if (batch.length === 0) return { posted: 0 };
  const good = [];
  for (const rec of batch) {
    const reason = editRecord(rec);
    if (reason) rejects.write(rec, reason);
    else good.push(rec);
  }
  const totals = postBatch(good);
  return buildReport(totals, batch.length - good.length);
}
