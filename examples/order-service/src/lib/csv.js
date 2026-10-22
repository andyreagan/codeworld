// A small CSV reader: a header row, then values. No quoting.

/** Parse CSV text into one object per row, keyed by the header. */
export function parseCsv(text) {
  const [header, ...rows] = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (!header) throw new Error("empty CSV");
  const keys = splitLine(header);
  return rows.map((r) => {
    const vals = splitLine(r);
    if (vals.length !== keys.length) throw new Error(`row has ${vals.length} fields, header has ${keys.length}`);
    return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  });
}

function splitLine(line) {
  return line.split(",").map((s) => s.trim());
}
