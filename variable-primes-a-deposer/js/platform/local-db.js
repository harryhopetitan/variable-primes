/* Service « db » en mode local : base documentaire stockée dans le navigateur (IndexedDB).
 * Remplace claude.use("db") avec le même contrat (style Firestore) :
 *   db.doc("col/id").get() / set(data) / update(patch) / delete() / onSnapshot(next, err)
 *   db.collection("col").doc(id?) / add(data) / where() / orderBy() / limit() / get() / onSnapshot()
 * - set remplace le document ; update fusionne récursivement les objets (tableaux et null remplacent)
 *   et rejette { code: "invalid_argument" } si le document n'existe pas.
 * - Les onglets ouverts du même navigateur restent synchronisés (BroadcastChannel).
 * Limite : les données restent dans CE navigateur. Pour un usage partagé, brancher un vrai backend.
 *
 * Outils de secours accessibles depuis la console : HHLocalDB.exportJSON() / importJSON(obj).
 */
Platform.register("local", "db", async () => {
  "use strict";
  const DB_NAME = "hh-variables", STORE = "docs";
  const err = Platform.error;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  /* ---------- persistance IndexedDB (repli en mémoire si indisponible) ---------- */
  let idb = null;
  try {
    idb = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "path" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { console.warn("[local-db] IndexedDB indisponible : données conservées en mémoire uniquement.", e); }

  const tx = (mode, fn) => new Promise((resolve, reject) => {
    if (!idb) return resolve();
    const t = idb.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && out.result);
    t.onerror = t.onabort = () => {
      const e = t.error;
      reject(e && e.name === "QuotaExceededError" ? err("quota_exceeded", "Espace de stockage du navigateur plein.") : err("unavailable", (e && e.message) || "Écriture impossible."));
    };
  });

  /* ---------- état en mémoire : cols[collection] = Map(id -> data) ---------- */
  const cols = new Map();
  const colOf = (c) => { if (!cols.has(c)) cols.set(c, new Map()); return cols.get(c); };

  /* ---------- chemins ---------- */
  const SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
  function segments(path) {
    const s = String(path).split("/");
    for (const x of s) if (!SEG.test(x) || x === "." || x === "..") throw new TypeError(`Chemin invalide : « ${path} »`);
    return s;
  }
  function split(path) { const s = segments(path); if (s.length % 2) throw new TypeError(`Chemin de document attendu (nombre pair de segments) : « ${path} »`); return { col: s.slice(0, -1).join("/"), id: s[s.length - 1] }; }

  /* chargement initial des documents enregistrés */
  if (idb) {
    const all = await new Promise((resolve, reject) => {
      const r = idb.transaction(STORE).objectStore(STORE).getAll();
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    for (const row of all) { const { col, id } = split(row.path); colOf(col).set(id, row.data); }
  }

  /* ---------- abonnements ---------- */
  const listeners = new Set(); // { col, docId?, query?, next }
  function notify(col) {
    for (const l of listeners) if (l.col === col) deliver(l);
  }
  function deliver(l) {
    try {
      if (l.docId != null) l.next(docSnap(l.docId, colOf(l.col).get(l.docId)));
      else l.next(querySnap(run(l.col, l.query)));
    } catch (e) { console.error(e); }
  }
  const meta = { fromCache: false, hasPendingWrites: false };
  function docSnap(id, data) { const d = clone(data); return { id, exists: data !== undefined, data: () => d, metadata: meta }; }
  function querySnap(rows) {
    const docs = rows.map(([id, data]) => docSnap(id, data));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((doc, i) => ({ type: "added", doc, oldIndex: -1, newIndex: i })), metadata: meta };
  }

  /* ---------- requêtes ---------- */
  const OPS = {
    "==": (a, b) => a === b, "!=": (a, b) => a !== b, "<": (a, b) => a < b, "<=": (a, b) => a <= b,
    ">": (a, b) => a > b, ">=": (a, b) => a >= b, in: (a, b) => b.includes(a), "not-in": (a, b) => !b.includes(a),
    "array-contains": (a, b) => Array.isArray(a) && a.includes(b),
  };
  function run(col, q) {
    let rows = [...colOf(col).entries()].filter(([, d]) => q.where.every(([f, op, v]) => OPS[op] && OPS[op](d[f], v)));
    if (q.orderBy) {
      const [f, dir] = q.orderBy, s = dir === "desc" ? -1 : 1;
      rows.sort((a, b) => { const x = a[1][f], y = b[1][f]; if (x === y) return 0; if (x === undefined) return 1; if (y === undefined) return -1; return (x < y ? -1 : 1) * s; });
    } else rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return q.limit ? rows.slice(0, q.limit) : rows;
  }

  /* ---------- écritures ---------- */
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(DB_NAME) : null;
  if (channel) channel.onmessage = (ev) => {
    const { col, id, data } = ev.data || {};
    if (data === null) colOf(col).delete(id); else colOf(col).set(id, data);
    notify(col);
  };
  async function commit(path, data) {
    const { col, id } = split(path);
    const prev = colOf(col).get(id);
    if (data === null) colOf(col).delete(id); else colOf(col).set(id, data);
    notify(col);
    try { await tx("readwrite", (s) => (data === null ? s.delete(path) : s.put({ path, data }))); }
    catch (e) { if (prev === undefined) colOf(col).delete(id); else colOf(col).set(id, prev); notify(col); throw e; }
    if (channel) channel.postMessage({ col, id, data });
  }
  function deepMerge(base, patch) {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : clone(v);
    return out;
  }
  const checkBody = (d) => { if (!isObj(d)) throw err("invalid_argument", "Le document doit être un objet."); };
  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  /* ---------- références ---------- */
  function docRef(path) {
    const { col, id } = split(path);
    return {
      id, path,
      async get() { return docSnap(id, colOf(col).get(id)); },
      async set(data) { checkBody(data); await commit(path, clone(data)); },
      async update(patch) {
        checkBody(patch);
        const cur = colOf(col).get(id);
        if (cur === undefined) throw err("invalid_argument", `Document inexistant : ${path}`);
        await commit(path, deepMerge(cur, patch));
      },
      async delete() { if (colOf(col).has(id)) await commit(path, null); },
      onSnapshot(next) { const l = { col, docId: id, next }; listeners.add(l); setTimeout(() => listeners.has(l) && deliver(l)); return () => listeners.delete(l); },
      collection(sub) { return colRef(`${path}/${sub}`); },
    };
  }
  function query(col, q) {
    return {
      where(f, op, v) { return query(col, { ...q, where: [...q.where, [f, op, v]] }); },
      orderBy(f, dir = "asc") { return query(col, { ...q, orderBy: [f, dir] }); },
      limit(n) { return query(col, { ...q, limit: n }); },
      async get() { return querySnap(run(col, q)); },
      onSnapshot(next) { const l = { col, query: q, next }; listeners.add(l); setTimeout(() => listeners.has(l) && deliver(l)); return () => listeners.delete(l); },
    };
  }
  function colRef(path) {
    if (segments(path).length % 2 === 0) throw new TypeError(`Chemin de collection attendu (nombre impair de segments) : « ${path} »`);
    return Object.assign(query(path, { where: [], orderBy: null, limit: null }), {
      path,
      doc(id) { return docRef(`${path}/${id || newId()}`); },
      async add(data) { const r = docRef(`${path}/${newId()}`); await r.set(data); return r; },
    });
  }

  /* ---------- sauvegarde / restauration (console) ---------- */
  window.HHLocalDB = {
    exportJSON() { const o = {}; for (const [c, m] of cols) for (const [id, d] of m) (o[c] ||= {})[id] = clone(d); return o; },
    async importJSON(obj) { for (const [c, docs] of Object.entries(obj || {})) for (const [id, d] of Object.entries(docs)) await commit(`${c}/${id}`, clone(d)); },
  };

  /* ---------- données initiales embarquées (déchiffrées par gate.js) : appliquées une fois par navigateur ---------- */
  const seed = window.HH_SEED;
  if (seed && seed.id && (colOf("_meta").get("donnees") || {}).id !== seed.id) {
    await window.HHLocalDB.importJSON(seed.data);
    await commit("_meta/donnees", { id: seed.id, at: new Date().toISOString() });
    try { localStorage.setItem("hh-donnees-appliquees", seed.id); } catch (e) {}
  } else if (seed && seed.id) { try { localStorage.setItem("hh-donnees-appliquees", seed.id); } catch (e) {} }
  delete window.HH_SEED;

  return { doc: docRef, collection: colRef };
});
