/**
 * The last code map opened, kept in IndexedDB (maps outgrow sessionStorage)
 * so `?map=local` survives a reload.
 */

const open = (): Promise<IDBDatabase> =>
  new Promise((ok, fail) => {
    const r = indexedDB.open("codeworld", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("maps");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });

export async function keepMap(text: string): Promise<void> {
  const db = await open();
  await new Promise<void>((ok, fail) => {
    const tx = db.transaction("maps", "readwrite");
    tx.objectStore("maps").put(text, "local");
    tx.oncomplete = () => ok();
    tx.onerror = () => fail(tx.error);
  });
}

export async function keptMap(): Promise<string> {
  const db = await open();
  return new Promise((ok, fail) => {
    const r = db.transaction("maps").objectStore("maps").get("local");
    r.onsuccess = () => (typeof r.result === "string" ? ok(r.result) : fail(new Error("no code map opened yet")));
    r.onerror = () => fail(r.error);
  });
}
