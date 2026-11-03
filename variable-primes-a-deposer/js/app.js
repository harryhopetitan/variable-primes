(() => {
  "use strict";
  const E = Engine;
  const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const MC = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const COLS = ["settings", "agences", "collabs", "ca", "perimetres", "mensuel", "agenceMois", "objectifs", "regs", "ajust", "clotures", "promos"];
  const raw = Object.fromEntries(COLS.map((c) => [c, {}]));
  const loaded = new Set();
  let db = null, dbState = "loading";
  let userCap = null, myId = null, journal = [], journalLoaded = false, profils = {}, muteLog = 0;
  const today = new Date();
  const ui = {
    tab: "paie", agence: null, paie: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`,
    sel: null, year: today.getFullYear(), regFilter: "ouvertes", regEdit: null, collabEdit: null, perimEdit: null,
    draftBaremes: null, importRows: null, importText: "",
  };
  try { const s = JSON.parse(localStorage.getItem("hh-ui") || "{}"); if (s.agence) ui.agence = s.agence; if (s.tab) ui.tab = s.tab; } catch (e) {}
  const saveUi = () => { try { localStorage.setItem("hh-ui", JSON.stringify({ agence: ui.agence, tab: ui.tab })); } catch (e) {} };

  /* ---------- utilitaires ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf2 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
  const eur = (v, dec = 2) => (v == null || Number.isNaN(v) ? "—" : (dec ? nf2 : nf0).format(v) + " €");
  const pct = (v) => (v == null ? "—" : new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(v * 100) + " %");
  const pm = (s) => { const [y, m] = s.split("-").map(Number); return { y, m }; };
  const labelM = (s, cap = true) => { const { y, m } = pm(s); const t = `${MOIS[m - 1]} ${y}`; return cap ? t[0].toUpperCase() + t.slice(1) : t; };
  const shortM = (s) => { const { y, m } = pm(s); return `${MC[m - 1]} ${String(y).slice(2)}`; };
  const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const slug = (s) => norm(s).replace(/ /g, "-") || "x";
  const numIn = (v) => { if (v == null) return null; const t = String(v).replace(/\s| |€/g, "").replace(",", "."); if (t === "") return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
  const typeChip = (t) => (t ? `<span class="chip ${t === "Type 1" ? "t1" : t === "Type 2" ? "t2" : t === "Type 3" ? "t3" : t === "Alt" ? "alt" : ""}">${esc(t === "Alt" ? "Alternant" : t)}</span>` : "");

  function toast(msg) {
    const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }
  function confirmBox(title, text, okLabel, onOk, danger) {
    const o = $("#overlay");
    o.innerHTML = `<div class="confirm" role="dialog" aria-modal="true"><div><h3>${esc(title)}</h3><p>${text}</p><div class="row" style="justify-content:flex-end"><button class="btn" id="cf-no">Annuler</button><button class="btn ${danger ? "danger" : "primary"}" id="cf-ok">${esc(okLabel)}</button></div></div></div>`;
    $("#cf-no").onclick = () => (o.innerHTML = "");
    $("#cf-ok").onclick = async () => { o.innerHTML = ""; await onOk(); };
    $("#cf-ok").focus();
  }
  const errMsg = (e) => (e && e.code === "invalid_argument" ? "Modification refusée : vous n'avez pas les droits d'écriture sur cet outil." : e && e.code === "quota_exceeded" ? "La base de l'outil est pleine : supprimez d'anciennes données." : "Enregistrement impossible pour le moment. Réessayez dans quelques secondes.");

  const before = (path) => { const [c, id] = path.split("/"); return raw[c] && raw[c][id] ? JSON.parse(JSON.stringify(raw[c][id])) : null; };
  async function put(path, data) { const b = before(path); try { await db.doc(path).set(data); logWrite("set", path, data, b); return true; } catch (e) { toast(errMsg(e)); return false; } }
  async function merge(path, patch) {
    const ref = db.doc(path);
    const b = before(path);
    try { if (b) await ref.update(patch); else await ref.set(patch); logWrite("merge", path, patch, b); return true; } catch (e) { toast(errMsg(e)); return false; } }
  async function del(path) { const b = before(path); try { await db.doc(path).delete(); logWrite("delete", path, null, b); return true; } catch (e) { toast(errMsg(e)); return false; } }

  /* ---------- journal des modifications ---------- */
  const ITEM_LABEL = { G: "variable CA", H: "variable manager/MDP", I: "régularisation", K: "prime perf.", L: "bonus recouvrement", M: "prime d'équipe", N: "prime trimestrielle", O: "prime semestrielle", P: "prime annuelle" };
  const fmtV = (v) => (v == null || v === "" ? "vide" : typeof v === "number" ? nf2.format(v) : String(v));
  async function journalAdd(entry) {
    if (!db) return;
    try { await db.collection("journal").add({ at: new Date().toISOString(), par: myId || null, ...entry }); } catch (e) { /* le journal ne bloque jamais une saisie */ }
  }
  function logWrite(op, path, data, b) {
    if (muteLog) return;
    const [col, id] = path.split("/");
    const e = describe(op, col, id, data, b);
    if (e) journalAdd(e);
  }
  function describe(op, col, id, data, b) {
    const ag = (cid) => (raw.collabs[cid] || {}).agence || null;
    if (col === "ca") {
      const cid = (data && data.collab) || id;
      const ch = Object.entries((data && data.valeurs) || {}).map(([m, v]) => `${shortM(m)} : ${fmtV(((b || {}).valeurs || {})[m])} → ${fmtV(v)}`);
      return { agence: ag(cid), action: "CA", texte: `CA de ${nameOf(cid)} — ${ch.join(" ; ")}` };
    }
    if (col === "mensuel") {
      const p = raw.perimetres[id] || {};
      const ch = Object.entries((data && data.valeurs) || {}).map(([m, o]) => Object.entries(o).filter(([k]) => k !== "source").map(([k, v]) => `${shortM(m)} ${k} : ${fmtV((((b || {}).valeurs || {})[m] || {})[k])} → ${fmtV(v)}`).join(" ; ")).filter(Boolean);
      if (!ch.length) return null;
      return { agence: p.agence || null, action: "Périmètre", texte: `${p.nom || id} — ${ch.join(" ; ")}` };
    }
    if (col === "ajust") {
      const [cid, paie] = [id.slice(0, id.lastIndexOf("_")), id.slice(id.lastIndexOf("_") + 1)];
      const ch = Object.entries(data || {}).filter(([k]) => ITEM_LABEL[k] || k === "note").map(([k, v]) => k === "note" ? `commentaire : « ${v || ""} »` : `${ITEM_LABEL[k]} : ${fmtV((b || {})[k])} → ${v == null ? "calcul automatique" : fmtV(v)}`);
      if (!ch.length) return null;
      return { agence: ag(cid), paie, action: "Ajustement", texte: `${nameOf(cid)}, paie ${labelM(paie, false)} — ${ch.join(" ; ")}` };
    }
    if (col === "clotures") {
      const [a, paie] = [id.slice(0, id.lastIndexOf("_")), id.slice(id.lastIndexOf("_") + 1)];
      if (op === "delete") return { agence: a, paie, action: "Réouverture", texte: `Paie ${labelM(paie, false)} rouverte (total figé : ${eur((b && b.totaux || {}).total)})` };
      return { agence: a, paie, action: "Clôture", texte: `Paie ${labelM(paie, false)} clôturée — ${Object.keys(data.lignes || {}).length} collaborateurs, total ${eur((data.totaux || {}).total)}` };
    }
    if (col === "regs") {
      const r = op === "delete" ? b : data; if (!r) return null;
      const verbe = op === "delete" ? "supprimée" : b ? "modifiée" : "créée";
      return { agence: ag(r.collab), action: "Régularisation", texte: `${r.type} de ${nameOf(r.collab)} ${verbe} — commission ${eur(r.commission)}, ${(r.mouvements || []).length} mouvement(s), statut ${r.statut}` };
    }
    if (col === "collabs") {
      const c = op === "delete" ? b : data; if (!c) return null;
      if (op === "delete") return { agence: c.agence, action: "Équipe", texte: `${c.prenom} ${c.nom} supprimé(e)` };
      if (!b) return { agence: c.agence, action: "Équipe", texte: `${c.prenom} ${c.nom} ajouté(e)` };
      const lab = { prenom: "prénom", nom: "nom", agence: "cabinet", pole: "pôle", division: "division", entree: "entrée", sortie: "sortie", idDashboard: "ID dashboard" };
      const ch = Object.keys(lab).filter((k) => (b[k] || null) !== (c[k] || null)).map((k) => `${lab[k]} : ${fmtV(b[k])} → ${fmtV(c[k])}`);
      if (JSON.stringify(b.postes || []) !== JSON.stringify(c.postes || [])) ch.push(`postes : ${(c.postes || []).map((p) => `${p.poste} (${shortM(p.depuis)})`).join(", ")}`);
      if (!ch.length) return null;
      return { agence: c.agence, action: "Équipe", texte: `${c.prenom} ${c.nom} — ${ch.join(" ; ")}` };
    }
    if (col === "perimetres") {
      const p = op === "delete" ? b : data; if (!p) return null;
      return { agence: p.agence, action: "Équipe", texte: `${p.nom} ${op === "delete" ? "supprimé" : b ? "modifié" : "créé"} (responsable ${nameOf(p.responsable)})` };
    }
    if (col === "objectifs") {
      const ch = Object.entries((data && data.periodes) || {}).map(([per, o]) => Object.entries(o).map(([k, v]) => `${per} ${k === "atteint" ? "décision" : k} : ${fmtV((((b || {}).periodes || {})[per] || {})[k])} → ${k === "atteint" ? (v == null ? "automatique" : v ? "forcé atteint" : "forcé non atteint") : fmtV(v)}`).join(" ; "));
      return { agence: id, action: "Objectifs", texte: ch.join(" ; ") };
    }
    if (col === "agenceMois") {
      const ch = Object.entries((data && data.valeurs) || {}).map(([m, o]) => Object.entries(o).map(([k, v]) => `${shortM(m)} ${k === "conditionsOk" ? "conditions" : k} : ${fmtV((((b || {}).valeurs || {})[m] || {})[k])} → ${fmtV(v)}`).join(" ; "));
      return { agence: id, action: "Recouvrement", texte: ch.join(" ; ") };
    }
    if (col === "settings") {
      const flat = (o, p = "", out = {}) => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) flat(v, p ? `${p}.${k}` : k, out); else out[p] = o; return out; };
      const A = flat((b || {}).data || E.DEFAULT_BAREMES), B = flat((data || {}).data);
      const ch = [...new Set([...Object.keys(A), ...Object.keys(B)])].filter((k) => A[k] !== B[k]);
      return { agence: null, action: "Barèmes", texte: ch.length ? `Barèmes modifiés (${ch.length} valeur(s)) : ${ch.slice(0, 8).map((k) => `${k} ${fmtV(A[k])} → ${fmtV(B[k])}`).join(" ; ")}${ch.length > 8 ? " …" : ""}` : "Barèmes enregistrés sans changement" };
    }
    if (col === "promos") {
      const ch = Object.entries(data || {}).filter(([k]) => k === "impayes" || k === "note").map(([k, v]) => `${k === "impayes" ? "factures échues impayées" : "commentaire"} : ${fmtV((b || {})[k])} → ${fmtV(v)}`);
      return ch.length ? { agence: ag(id), action: "Promotion", texte: `${nameOf(id)} — ${ch.join(" ; ")}` } : null;
    }
    if (col === "agences") return op === "delete" ? null : b ? null : { agence: id, action: "Cabinet", texte: `Cabinet ${data.nom} créé` };
    return null;
  }

  /* ---------- état moteur ---------- */
  let _S = null;
  function S() {
    if (_S) return _S;
    const flat = (col, keyName) => {
      const out = {};
      for (const [id, d] of Object.entries(raw[col])) for (const [k, v] of Object.entries(d.valeurs || d.periodes || {})) if (v) out[`${id}_${k}`] = { ...v, [keyName]: id };
      return out;
    };
    const st = raw.settings.baremes && raw.settings.baremes.data;
    _S = {
      baremes: st || E.DEFAULT_BAREMES,
      collabs: raw.collabs,
      ca: Object.fromEntries(Object.entries(raw.ca).map(([id, d]) => [d.collab || id, Object.fromEntries(Object.entries(d.valeurs || {}).filter(([, v]) => v != null))])),
      perimetres: raw.perimetres,
      mensuel: flat("mensuel", "perimetre"),
      agenceMois: flat("agenceMois", "agence"),
      objectifs: flat("objectifs", "agence"),
      regs: Object.values(raw.regs),
      ajust: raw.ajust,
      clotures: raw.clotures,
    };
    return _S;
  }
  const agences = () => Object.entries(raw.agences).map(([id, a]) => ({ id, ...a })).sort((a, b) => (a.nom || a.id).localeCompare(b.nom || b.id));
  const collabsOf = (ag) => Object.values(raw.collabs).filter((c) => c.agence === ag).sort((a, b) => a.nom.localeCompare(b.nom));
  const perimsOf = (ag) => Object.values(raw.perimetres).filter((p) => p.agence === ag).sort((a, b) => (a.kind === b.kind ? a.nom.localeCompare(b.nom) : a.kind === "bureau" ? -1 : 1));
  const nameOf = (cid) => { const c = raw.collabs[cid]; return c ? `${c.prenom} ${c.nom}` : cid || "—"; };
  const currentPoste = (c) => E.posteAt(c, `${ui.year}-12`) || "";

  /* ---------- rendu ---------- */
  let renderQueued = false, pendingWhileTyping = false;
  function scheduleRender() {
    _S = null;
    const a = document.activeElement;
    if (a && $("#view").contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { pendingWhileTyping = true; return; }
    if (renderQueued) return; renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  document.addEventListener("focusout", () => { if (pendingWhileTyping) { pendingWhileTyping = false; setTimeout(() => { const a = document.activeElement; if (!(a && $("#view").contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName))) render(); else pendingWhileTyping = true; }, 0); } });

  const TABS = [["synthese", "Vue d'ensemble"], ["paie", "Paie du mois"], ["ca", "Chiffre d'affaires"], ["regs", "Régularisations"], ["equipes", "Équipes"], ["promos", "Promotions"], ["agence", "Cabinet"], ["baremes", "Barèmes"], ["dashboard", "Dashboard & import"], ["journal", "Journal"]];

  function renderChrome(res) {
    const ags = agences();
    if (!ui.agence || !raw.agences[ui.agence]) ui.agence = ags[0] ? ags[0].id : null;
    $("#agence-sel").innerHTML = ags.map((a) => `<option value="${esc(a.id)}" ${a.id === ui.agence ? "selected" : ""}>${esc(a.nom || a.id)}</option>`).join("") || `<option>Aucun cabinet</option>`;
    $("#paie-label").textContent = `Paie ${labelM(ui.paie, false)}`;
    $("#ca-label").textContent = `CA de ${labelM(E.addM(ui.paie, -1), false)}`;
    const clo = ui.agence && raw.clotures[`${ui.agence}_${ui.paie}`];
    $("#status-pill").innerHTML = clo ? `<span class="pill closed">Clôturé</span>` : `<span class="pill open">Ouvert</span>`;
    const nAlert = res ? alertesPaie(res).length : 0;
    const nRegs = Object.values(raw.regs).filter((r) => (!ui.agence || (raw.collabs[r.collab] || {}).agence === ui.agence) && ["en cours", "à chiffrer"].includes(r.statut)).length;
    let nPromo = 0; try { if (ui.agence && loaded.size >= COLS.length) nPromo = promoRows().filter((r) => r.statut === "eligible").length; } catch (e) {}
    $("#tabs").innerHTML = TABS.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${ui.tab === k}">${l}${k === "paie" && nAlert ? `<span class="count">${nAlert}</span>` : ""}${k === "regs" && nRegs ? `<span class="count">${nRegs}</span>` : ""}${k === "promos" && nPromo ? `<span class="count ok">${nPromo}</span>` : ""}</button>`).join("");
  }

  function render() {
    _S = null;
    const v = $("#view");
    if (dbState === "absent") {
      renderChrome(null);
      v.innerHTML = `<div class="empty"><b>Base de données indisponible</b>La connexion à la base de données a échoué (${esc(Platform.backendName())}). Vérifiez la configuration dans <code>js/config.js</code> puis rechargez la page.</div>`;
      return;
    }
    if (loaded.size < COLS.length) { renderChrome(null); return; }
    if (!ui.agence || !raw.agences[ui.agence]) { const ags = agences(); ui.agence = ags[0] ? ags[0].id : null; }
    let res = null;
    try { if (ui.agence) res = E.computePaie(S(), ui.agence, ui.paie); } catch (e) { console.error(e); }
    renderChrome(res);
    if (!ui.agence && !["synthese", "agence", "dashboard", "baremes", "journal"].includes(ui.tab)) {
      v.innerHTML = `<div class="empty"><b>Aucun cabinet</b>Importez un fichier de commissions dans l'onglet Dashboard &amp; import, ou créez un cabinet dans l'onglet Cabinet.<div class="row" style="justify-content:center;margin-top:14px"><button class="btn primary" data-tab="dashboard">Importer un fichier</button></div></div>`;
      return;
    }
    const views = { synthese: viewSynthese, paie: () => viewPaie(res), ca: viewCA, regs: viewRegs, equipes: viewEquipes, promos: viewPromos, agence: viewAgence, baremes: viewBaremes, dashboard: viewDashboard, journal: viewJournal };
    v.innerHTML = (views[ui.tab] || views.paie)();
    if (ui.tab === "paie" && ui.sel) renderDrawer(res); else $("#overlay").innerHTML = $("#overlay").querySelector(".confirm") ? $("#overlay").innerHTML : "";
  }

  /* ---------- alertes de cohérence ---------- */
  /* ---------- Vue d'ensemble des cabinets ---------- */
  function syntheseData() {
    const st = S(), paie = ui.paie, mois = E.addM(paie, -1), y = pm(mois).y;
    const moisAnnee = Array.from({ length: pm(mois).m }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`);
    const keep = { agence: ui.agence };
    const rows = agences().map((ag) => {
      const cs = Object.values(raw.collabs).filter((c) => c.agence === ag.id);
      const caM = (m) => cs.reduce((s, c) => s + ((st.ca[c.id] || {})[m] || 0), 0);
      const serie = moisAnnee.map(caM);
      const caMois = caM(mois), caCumul = serie.reduce((s, v) => s + v, 0);
      let res = null, verseCumul = 0, alertes = 0, eligibles = 0;
      try {
        res = E.computePaie(st, ag.id, paie);
        for (const m of moisAnnee) { const p = E.addM(m, 1); verseCumul += p === paie ? res.totaux.total : E.computePaie(st, ag.id, p).totaux.total; }
        ui.agence = ag.id; alertes = alertesPaie(res).length; eligibles = promoRows().filter((r) => r.statut === "eligible").length;
      } catch (e) { console.error(e); }
      ui.agence = keep.agence;
      const eff = cs.filter((c) => E.presentMois(c, mois) && ["consultant", "mdp", "alternant"].includes(((st.baremes.postes[E.posteAt(c, mois)] || {}).role))).length;
      return { ag, serie, caMois, caCumul, eff, prod: eff ? caMois / eff : null, total: res ? res.totaux.total : 0, verseCumul, taux: caCumul ? verseCumul / caCumul : null, cloture: res && res.cloture, alertes, eligibles };
    });
    ui.agence = keep.agence;
    return { rows, mois, moisAnnee, paie, y };
  }
  function spark(serie, w = 120, h = 28) {
    if (!serie.length) return "";
    const max = Math.max(...serie, 1), n = serie.length, X = (i) => (n === 1 ? w / 2 : 2 + (i * (w - 4)) / (n - 1)), Y = (v) => h - 3 - (v / max) * (h - 6);
    const pts = serie.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polygon points="${X(0).toFixed(1)},${h - 3} ${pts} ${X(n - 1).toFixed(1)},${h - 3}" fill="var(--accent)" fill-opacity=".14"/><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/><circle cx="${X(n - 1).toFixed(1)}" cy="${Y(serie.at(-1)).toFixed(1)}" r="2.5" fill="var(--accent)"/></svg>`;
  }
  function viewSynthese() {
    const d = syntheseData(), sort = ui.syntheseTri || "caCumul";
    const rows = d.rows.slice().sort((a, b) => (sort === "nom" ? (a.ag.nom || a.ag.id).localeCompare(b.ag.nom || b.ag.id) : (b[sort] ?? -1) - (a[sort] ?? -1)));
    const T = (k) => d.rows.reduce((s, r) => s + (r[k] || 0), 0);
    const caCumul = T("caCumul"), verse = T("verseCumul"), nClos = d.rows.filter((r) => r.cloture).length;
    const maxCa = Math.max(...d.rows.map((r) => r.caCumul), 1);
    const tauxMoy = caCumul ? verse / caCumul : null;
    const th = (k, l, cls = "") => `<th class="${cls}"><button class="sortbtn ${sort === k ? "on" : ""}" data-tri="${k}">${l}${sort === k ? " ↓" : ""}</button></th>`;
    return `<div class="toolbar"><div class="grow"><h2>Vue d'ensemble des cabinets</h2><span class="muted">CA de ${esc(labelM(d.mois, false))} et cumul depuis janvier ${d.y} · paie de ${esc(labelM(d.paie, false))}</span></div></div>
      <div class="summary" style="grid-template-columns:repeat(5,minmax(0,1fr))">
        <div><div class="eyebrow">CA du mois</div><div class="v">${eur(T("caMois"), 0)}</div><div class="s">${d.rows.length} cabinets · ${T("eff")} producteurs</div></div>
        <div><div class="eyebrow">CA depuis janvier</div><div class="v">${eur(caCumul, 0)}</div><div class="s">${esc(MC[0])} → ${esc(shortM(d.mois))}</div></div>
        <div><div class="eyebrow">Variables et primes versés</div><div class="v">${eur(verse, 0)}</div><div class="s">paies de février à ${esc(labelM(d.paie, false))}</div></div>
        <div><div class="eyebrow">Variable / CA</div><div class="v">${tauxMoy == null ? "—" : pct(tauxMoy)}</div><div class="s">moyenne du réseau</div></div>
        <div><div class="eyebrow">Paie ${esc(labelM(d.paie, false))}</div><div class="v">${nClos} / ${d.rows.length}</div><div class="s">cabinets clôturés · ${eur(T("total"), 0)} à verser</div></div>
      </div>
      <div class="scroll"><table class="data synth"><thead><tr>${th("nom", "Cabinet")}<th>CA mensuel ${d.y}</th>${th("caMois", `CA ${shortM(d.mois)}`, "r")}${th("caCumul", "CA cumulé", "r")}${th("prod", "Productivité / tête", "r")}${th("total", "À verser ce mois", "r")}${th("verseCumul", "Versé depuis janvier", "r")}${th("taux", "Variable / CA", "r")}${th("alertes", "Points à vérifier", "r")}${th("eligibles", "Promotions", "r")}<th>Paie</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="click" data-goag="${esc(r.ag.id)}">
        <td><b>${esc(r.ag.nom || r.ag.id)}</b><div class="muted" style="font-size:12px">${r.eff} producteur${r.eff > 1 ? "s" : ""}</div></td>
        <td>${spark(r.serie)}</td>
        <td class="r num">${r.caMois ? eur(r.caMois, 0) : "—"}</td>
        <td class="r num"><div>${eur(r.caCumul, 0)}</div><div class="hbar"><span style="width:${((r.caCumul / maxCa) * 100).toFixed(1)}%"></span></div></td>
        <td class="r num">${r.prod == null ? "—" : eur(r.prod, 0)}</td>
        <td class="r num">${eur(r.total, 0)}</td>
        <td class="r num">${eur(r.verseCumul, 0)}</td>
        <td class="r num ${r.taux != null && tauxMoy != null && r.taux > tauxMoy * 1.25 ? "hi" : ""}">${r.taux == null ? "—" : pct(r.taux)}</td>
        <td class="r num">${r.alertes ? `<span class="pill warn">${r.alertes}</span>` : "—"}</td>
        <td class="r num">${r.eligibles ? `<span class="pill good">${r.eligibles}</span>` : "—"}</td>
        <td>${r.cloture ? `<span class="pill closed">Clôturé</span>` : `<span class="pill open">Ouvert</span>`}</td></tr>`).join("")}
      </tbody><tfoot><tr><td>Réseau</td><td></td><td class="r num">${eur(T("caMois"), 0)}</td><td class="r num">${eur(caCumul, 0)}</td><td class="r num">${T("eff") ? eur(T("caMois") / T("eff"), 0) : "—"}</td><td class="r num">${eur(T("total"), 0)}</td><td class="r num">${eur(verse, 0)}</td><td class="r num">${tauxMoy == null ? "—" : pct(tauxMoy)}</td><td class="r num">${T("alertes") || "—"}</td><td class="r num">${T("eligibles") || "—"}</td><td></td></tr></tfoot></table></div>
      <p class="note" style="margin-top:10px">Cliquez un cabinet pour ouvrir sa paie. Le CA est la somme du CA personnel des collaborateurs saisi dans l'outil (le CA bureau du dashboard peut inclure d'autres producteurs). « Variable / CA » rapporte les variables et primes versés au CA de la même période ; en gras, les cabinets à plus de 25 % au-dessus de la moyenne. Changez le mois avec les flèches en haut de la page.</p>`;
  }

  function alertesPaie(res) {
    const out = [], st = S(), ag = ui.agence, paie = ui.paie, mois = E.addM(paie, -1);
    if (!res) return out;
    const push = (niveau, texte, extra = {}) => out.push({ niveau, texte, ...extra });
    for (const l of res.lignes) for (const a of l.alertes || []) push("warn", `${l.nom} : ${a}`, { collab: l.collab });
    if (res.cloture) return out;
    for (const l of res.lignes) {
      const c = raw.collabs[l.collab] || {};
      const ca = l.ca;
      const prev = [1, 2, 3].map((k) => ((st.ca[l.collab] || {})[E.addM(mois, -k)])).filter((v) => v != null);
      const moy = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : null;
      if (ca != null && ca < 0) push("bad", `${l.nom} : CA négatif (${eur(ca, 0)}), à vérifier avant la paie`, { collab: l.collab });
      else if (ca != null && moy && ca >= 20000 && ca >= 2.5 * moy) push("warn", `${l.nom} : CA de ${eur(ca, 0)}, soit ${nf0.format(ca / moy)} fois sa moyenne des 3 mois précédents (${eur(moy, 0)})`, { collab: l.collab });
      else if (ca != null && moy && moy >= 15000 && ca <= 0.2 * moy) push("warn", `${l.nom} : CA de ${eur(ca, 0)}, très en dessous de sa moyenne des 3 mois précédents (${eur(moy, 0)})`, { collab: l.collab });
      if (c.sortie && c.sortie.slice(0, 7) < mois && l.total !== 0) push("bad", `${l.nom} : sorti(e) le ${new Date(c.sortie).toLocaleDateString("fr-FR")} mais ${eur(l.total)} à verser`, { collab: l.collab });
      if (l.poste && !st.baremes.postes[l.poste]) push("bad", `${l.nom} : poste « ${l.poste} » absent des barèmes, variable non calculé`, { collab: l.collab, tab: "baremes" });
      const adj = raw.ajust[`${l.collab}_${paie}`] || {};
      if (Object.keys(l.forces || {}).length && !(adj.note || "").trim()) push("warn", `${l.nom} : montant ajusté à la main sans commentaire`, { collab: l.collab });
    }
    const { y, m } = pm(mois);
    if (m % 3 === 0) {
      const o = (st.objectifs[`${ag}_${y}-T${m / 3}`]) || {};
      if (o.objectif == null && o.atteint == null) push("bad", `Objectif du T${m / 3} ${y} non saisi : la prime d'équipe ne sera pas versée`, { tab: "agence" });
    }
    const bureau = Object.values(raw.perimetres).find((p) => p.kind === "bureau" && p.agence === ag);
    if (bureau) {
      const rm = E.addM(paie, -2), rec = st.agenceMois[`${ag}_${rm}`];
      if (!rec || rec.reglees == null) push("warn", `Recouvrement de ${labelM(rm, false)} non saisi : pas de bonus pour ${nameOf(bureau.responsable)}`, { tab: "agence" });
      const pmn = st.mensuel[`${bureau.id}_${mois}`];
      if (!pmn || pmn.ca == null) push("warn", `CA du ${bureau.nom} pour ${labelM(mois, false)} calculé à partir des seuls collaborateurs de l'outil : saisissez le chiffre du dashboard s'il inclut d'autres producteurs`, { tab: "ca" });
    }
    for (const r of Object.values(raw.regs)) {
      if ((raw.collabs[r.collab] || {}).agence !== ag) continue;
      if (r.statut === "à chiffrer") push("bad", `Régularisation de ${nameOf(r.collab)} (${r.type}, placement ${r.periode ? shortM(r.periode) : "?"}) à chiffrer`, { tab: "regs" });
      else if (r.statut === "en cours") {
        const d = [r.periode, ...(r.mouvements || []).map((x) => x.paie)].filter(Boolean).sort()[0];
        if (d && E.addM(d, 3) < paie) push("warn", `${r.type} de ${nameOf(r.collab)} en cours depuis ${labelM(d, false)} : relancer ou solder`, { tab: "regs" });
      }
    }
    const ordre = { bad: 0, warn: 1 };
    return out.sort((a, b) => ordre[a.niveau] - ordre[b.niveau]);
  }

  /* ---------- Paie ---------- */
  const COLDEF = [
    ["G", "Variable CA"], ["H", "Variable manager / MDP"], ["I", "Régul."], ["J", "Total commissions"],
    ["K", "Perf. indiv."], ["L", "Recouvr."], ["M", "Équipe trim."], ["N", "Mgr trim."], ["O", "Mgr sem."], ["P", "Annuelle"],
  ];
  function cell(l, k) {
    const v = k === "J" ? l.items.J : l.items[k];
    const cls = [v === 0 ? "zero" : "", v < 0 ? "neg" : "", l.forces && l.forces[k] ? "forced" : "", k === "J" ? "tot" : "", k === "K" || k === "G" ? "sep" : ""].join(" ");
    return `<td class="${cls}">${v === 0 ? "–" : nf2.format(v)}</td>`;
  }
  function viewPaie(res) {
    if (!res) return `<div class="empty"><b>Calcul impossible</b>Vérifiez les barèmes et les données du cabinet.</div>`;
    const ag = raw.agences[ui.agence] || {};
    const als = alertesPaie(res), nAl = als.length, nBad = als.filter((a) => a.niveau === "bad").length;
    const clo = res.clotureInfo;
    const parCollab = {}; for (const a of als) if (a.collab) (parCollab[a.collab] ||= []).push(a.texte);
    const lines = res.lignes.map((l) => `<tr data-sel="${esc(l.collab)}" class="${ui.sel === l.collab ? "sel" : ""}">
      <td class="name"><div class="who">${esc(l.nom)}${parCollab[l.collab] ? `<span class="flag" title="${esc(parCollab[l.collab].join(" · "))}">▲</span>` : ""}</div><div class="sub">${esc(l.poste || "")} ${typeChip(l.type)}</div></td>
      <td class="${l.ca ? "" : "zero"}">${l.ca == null ? "—" : nf0.format(l.ca)}</td>
      ${COLDEF.map(([k]) => cell(l, k)).join("")}
      <td class="tot sep">${nf2.format(l.total)}</td></tr>`).join("");
    const t = res.totaux;
    return `
    <div class="toolbar"><div class="grow"><h2>Paie ${esc(labelM(ui.paie, false))} · ${esc(ag.nom || ui.agence)}</h2><span class="muted">Variables calculées sur le CA de ${esc(labelM(E.addM(ui.paie, -1), false))}</span></div>
      <button class="btn" data-action="export">Exporter pour la paie</button>
      ${clo ? `<button class="btn" data-action="reopen">Rouvrir le mois</button>` : `<button class="btn primary" data-action="close">Clôturer le mois</button>`}
    </div>
    ${clo ? `<div class="callout info" style="margin-bottom:14px">Mois clôturé${clo.at ? ` le ${new Date(clo.at).toLocaleDateString("fr-FR")}` : ""}${clo.source ? ` (${esc(clo.source)})` : ""}. Les montants affichés sont ceux qui ont été validés pour la paie ; rouvrez le mois pour les recalculer.</div>` : ""}
    <div class="summary">
      <div><div class="eyebrow">Commissions</div><div class="v">${eur(t.J)}</div><div class="s">dont régularisations ${eur(t.I)}</div></div>
      <div><div class="eyebrow">Primes</div><div class="v">${eur(t.primes)}</div><div class="s">perf., équipe, recouvrement, manager</div></div>
      <div><div class="eyebrow">Total à verser</div><div class="v">${eur(t.total)}</div><div class="s">${res.lignes.length} collaborateur${res.lignes.length > 1 ? "s" : ""}</div></div>
      <div><div class="eyebrow">Points à vérifier</div><div class="v ${nBad ? "bad" : nAl ? "warn" : ""}">${nAl}</div><div class="s">${nAl ? `${nBad ? `${nBad} bloquant${nBad > 1 ? "s" : ""}, ` : ""}détail ci-dessous` : "rien à signaler"}</div></div>
    </div>
    ${nAl ? `<details class="alerts" ${ui.alertsOpen !== false ? "open" : ""} data-alerts="1"><summary>${nAl} point${nAl > 1 ? "s" : ""} à vérifier avant de clôturer</summary><ul>${als.map((a) => `<li class="${a.niveau}"><span class="pill ${a.niveau}">${a.niveau === "bad" ? "Bloquant" : "À vérifier"}</span><span>${esc(a.texte)}</span>${a.collab ? `<button class="btn ghost" data-sel="${esc(a.collab)}">Voir</button>` : a.tab ? `<button class="btn ghost" data-tab="${a.tab}">Ouvrir</button>` : ""}</li>`).join("")}</ul></details>` : ""}
    ${res.lignes.length ? `<div class="scroll"><table class="reg">
      <thead><tr><th class="name" rowspan="2">Collaborateur</th><th rowspan="2">CA ${esc(shortM(E.addM(ui.paie, -1)))}</th><th class="grp sep" colspan="4">Commissions</th><th class="grp sep" colspan="6">Primes</th><th rowspan="2" class="sep">Total</th></tr>
      <tr>${COLDEF.map(([k, l]) => `<th class="${k === "G" || k === "K" ? "sep" : ""}">${l}</th>`).join("")}</tr></thead>
      <tbody>${lines}</tbody>
      <tfoot><tr><td class="name">Total cabinet</td><td>${nf0.format(res.lignes.reduce((s, l) => s + (l.ca || 0), 0))}</td>${COLDEF.map(([k]) => `<td class="${k === "G" || k === "K" ? "sep" : ""}">${nf2.format(t[k])}</td>`).join("")}<td class="sep">${nf2.format(t.total)}</td></tr></tfoot>
    </table></div>
    <div class="legend"><span class="lf">montant ajusté à la main</span><span class="lw">▲ point à vérifier</span><span>Cliquez une ligne pour voir le détail du calcul</span></div>`
    : `<div class="empty"><b>Aucun collaborateur pour ce mois</b>Ajoutez des collaborateurs dans l'onglet Équipes.</div>`}`;
  }

  function trancheTable(detail, perHead) {
    if (!detail || !detail.length) return `<div class="why">Aucune tranche atteinte.</div>`;
    return `<table class="mini"><tr><th>Tranche</th><th>Base</th><th>Taux</th><th>Montant</th></tr>${detail.map((d) => `<tr><td>${perHead ? "" : ""}${d.a === Infinity ? `> ${nf0.format(d.de)}` : `${nf0.format(d.de)} – ${nf0.format(d.a)}`}</td><td>${nf2.format(d.base)}</td><td>${pct(d.taux)}</td><td>${nf2.format(d.montant)}</td></tr>`).join("")}</table>`;
  }
  function overrideInput(l, k) {
    if (l.cloture) return "";
    const adj = raw.ajust[`${l.collab}_${ui.paie}`] || {};
    const on = adj[k] != null && adj[k] !== "";
    return `<div class="override ${on ? "on" : ""}"><label for="ov-${k}">Ajuster</label><input id="ov-${k}" type="number" step="0.01" data-ov="${k}" value="${on ? esc(adj[k]) : ""}" placeholder="${nf2.format(l.calcule ? l.calcule[k] : 0)}">${on ? `<button class="btn ghost" data-ovclear="${k}">Revenir au calcul</button>` : ""}</div>`;
  }
  function section(l, k, title, body, show = true) {
    if (!show) return "";
    return `<section><div class="line"><h3>${title}</h3><span class="amount ${l.forces && l.forces[k] ? "muted" : ""}">${eur(l.items[k])}</span></div>${body}${overrideInput(l, k)}</section>`;
  }
  function renderDrawer(res) {
    const l = res.lignes.find((x) => x.collab === ui.sel);
    const o = $("#overlay");
    if (!l) { o.innerHTML = ""; return; }
    const x = l.expl || {};
    let body = "";
    if (l.cloture) {
      body = `<section><div class="why">Mois clôturé : montants validés, sans détail de calcul.</div>${COLDEF.map(([k, t]) => `<div class="line" style="margin-top:6px"><span>${t}</span><span class="num">${eur(l.items[k])}</span></div>`).join("")}${l.note ? `<p class="why">${esc(l.note)}</p>` : ""}</section>`;
    } else {
      const g = x.G || {};
      body += section(l, "G", "Variable sur CA personnel", `<div class="why">CA ${esc(labelM(l.mois, false))} : <b class="num">${eur(l.ca)}</b> · barème ${esc(g.type === "Alt" ? "alternant (7 % dès le 1er euro)" : g.type || "aucun")}</div>${trancheTable(g.detail)}`);
      const hx = x.H || [];
      body += section(l, "H", "Variable manager / MDP", hx.map((p) => `<div class="why"><b>${esc(p.perimetre)}</b> · CA ${eur(p.ca, 0)} · effectif ${p.eff} · productivité ${p.eff ? eur(p.ca / p.eff, 0) : "—"} / tête <span class="chip">${esc(p.source)}</span></div>${trancheTable(p.detail)}`).join(""), hx.length || l.items.H);
      const ix = x.I || [];
      body += section(l, "I", "Régularisations", ix.length ? `<table class="mini"><tr><th>Dossier</th><th>Type</th><th>Montant</th></tr>${ix.map((m) => `<tr><td style="white-space:normal">${esc((m.reg.note || "").slice(0, 70))}</td><td>${esc(m.reg.type)}</td><td>${nf2.format(m.montant)}</td></tr>`).join("")}</table>` : `<div class="why">Aucun retrait ni reversement imputé sur cette paie. Gérez-les dans l'onglet Régularisations.</div>`);
      const k = x.K;
      body += section(l, "K", "Prime de performance individuelle", k ? `<div class="why">Fenêtre ${k.fenetre.map(shortM).join(" + ")} : <b class="num">${eur(k.total, 0)}</b> (paliers 60 / 75 / 90 k€). ${!k.eligible ? "Poste non éligible." : k.montant ? "Prime attribuée : ces 3 mois ne pourront plus être primés." : k.cas.some((v) => v == null) ? "CA incomplet sur la fenêtre." : k.bloques && k.bloques.length ? `Mois déjà primés : ${k.bloques.map(shortM).join(", ")}.` : "Seuil non atteint."}</div>` : `<div class="why">Pas d'historique de CA suffisant.</div>`);
      if (x.L) body += section(l, "L", "Bonus recouvrement", `<div class="why">Factures échues en ${esc(labelM(x.L.mois, false))} et réglées avant le 20 : <b>${x.L.reglees ?? "non saisi"}</b>${x.L.echues ? ` sur ${x.L.echues} (${pct(x.L.taux)})` : ""}. Paliers 5 / 16 / 30 factures → 100 / 175 / 250 €, si 90 % réglées.${x.L.conditionsOk ? "" : " Conditions non remplies (impayés > 60 j ou remplacement en cours)."}</div>`);
      if (x.M) body += section(l, "M", "Prime d'équipe trimestrielle", `<div class="why">${esc(x.M.trimestre)} · objectif ${x.M.objectif ? eur(x.M.objectif, 0) : "non saisi"}${x.M.caQ != null ? ` · CA bureau ${eur(x.M.caQ, 0)}` : ""} · ${x.M.atteint ? "objectif atteint" : "objectif non atteint"}${x.M.force ? " (forcé dans l'onglet Cabinet)" : ""}.${x.M.raison ? ` Non éligible : ${esc(x.M.raison)}.` : ""}</div>`);
      const perimPrime = (arr) => arr.map((p) => `<div class="why"><b>${esc(p.perimetre)}</b> · ${esc(p.periode)}${p.cat ? ` · catégorie ${p.cat} (effectif moyen ${nf2.format(p.effMoy)})` : ""}${p.prodApres != null ? ` · productivité ${eur(p.prodApres, 0)}` : ""}${p.profit !== undefined ? ` · profit ${p.profit == null ? "non saisi" : eur(p.profit, 0)}` : ""}${p.minOk === false ? " · un mois sous 5 000 € par tête, pas de prime trimestrielle" : ""}${p.ancOk === false ? ` · moins de ${p.anc} mois d'encadrement, pas de prime` : ""}</div>`).join("");
      if (x.N && x.N.length) body += section(l, "N", "Prime trimestrielle manager / MDP", perimPrime(x.N));
      if (x.O && x.O.length) body += section(l, "O", "Prime semestrielle manager", perimPrime(x.O));
      if (x.P && x.P.length) body += section(l, "P", "Prime annuelle", perimPrime(x.P));
      const adj = raw.ajust[`${l.collab}_${ui.paie}`] || {};
      body += `<section><label class="eyebrow" for="ov-note">Commentaire paie</label><textarea id="ov-note" rows="2" data-ovnote="1" placeholder="Visible dans l'export">${esc(adj.note || "")}</textarea></section>`;
    }
    o.innerHTML = `<div class="drawer-back" data-close="1"></div><aside class="drawer" role="dialog" aria-label="Détail du calcul">
      <header><div><div class="eyebrow">Détail · paie ${esc(labelM(ui.paie, false))}</div><h2>${esc(l.nom)}</h2><div class="row muted" style="margin-top:2px">${esc(l.poste || "")} ${typeChip(l.type)}</div>
      ${l.alertes && l.alertes.length ? `<div class="row" style="margin-top:6px">${l.alertes.map((a) => `<span class="pill warn">${esc(a)}</span>`).join("")}</div>` : ""}</div>
      <button class="btn ghost" data-close="1" aria-label="Fermer">✕</button></header>
      <div class="body">${body}</div>
      <div class="total"><span>Total à verser</span><span class="num">${eur(l.total)}</span></div></aside>`;
  }

  async function exportCsv() {
    const res = E.computePaie(S(), ui.agence, ui.paie);
    const head = ["Nom", "Prénom", "Poste", "Type", `CA ${labelM(E.addM(ui.paie, -1), false)}`, "Variable CA", "Variable manager/MDP", "Régularisation", "Total commissions", "Prime perf. individuelle", "Bonus recouvrement", "Prime équipe trimestrielle", "Prime trimestrielle manager", "Prime semestrielle manager", "Prime annuelle", "Total à verser", "Commentaire"];
    const f = (v) => (v == null ? "" : String(Math.round(v * 100) / 100).replace(".", ","));
    const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const rows = res.lignes.map((l) => { const c = raw.collabs[l.collab] || {}; const it = l.items; return [q(c.nom), q(c.prenom), q(l.poste), q(l.type), f(l.ca), f(it.G), f(it.H), f(it.I), f(it.J), f(it.K), f(it.L), f(it.M), f(it.N), f(it.O), f(it.P), f(l.total), q(l.note)].join(";"); });
    const csv = "﻿" + [head.map(q).join(";"), ...rows].join("\r\n");
    let dl = null; try { dl = await Platform.use("downloads"); } catch (e) {}
    if (!dl) { toast("L'export n'est pas disponible dans cette vue."); return; }
    try { const r = await dl.save({ filename: `variables_${ui.agence}_${ui.paie}.csv`, data: csv }); if (r && r.status === "saved") toast("Fichier exporté"); } catch (e) { if (e && e.code === "unavailable") toast("L'export n'est pas disponible dans cette vue."); else if (e && !["declined", "cancelled", "canceled", "dismissed"].includes(e.code)) toast("Export interrompu."); }
  }
  function closeMonth() {
    const res = E.computePaie(S(), ui.agence, ui.paie);
    const als = alertesPaie(res), nAl = als.length, nBad = als.filter((a) => a.niveau === "bad").length;
    confirmBox(`Clôturer la paie de ${labelM(ui.paie, false)} ?`, `Les montants de ${res.lignes.length} collaborateurs (${eur(res.totaux.total)}) seront figés. ${nBad ? `<b>${nBad} point(s) bloquant(s)</b> et ` : ""}${nAl ? `${nAl - nBad} point(s) à vérifier restent signalés.` : "Aucun point à vérifier."}`, "Clôturer", async () => {
      const lignes = {};
      for (const l of res.lignes) lignes[l.collab] = { poste: l.poste || null, type: l.type || null, ca: l.ca ?? null, ...Object.fromEntries("GHIKLMNOP".split("").map((k) => [k, l.items[k]])), note: l.note || "" };
      if (await put(`clotures/${ui.agence}_${ui.paie}`, { agence: ui.agence, paie: ui.paie, at: new Date().toISOString(), lignes, totaux: res.totaux, par: myId || null, alertes: nAl })) toast("Mois clôturé");
    });
  }

  /* ---------- CA ---------- */
  function viewCA() {
    const y = ui.year, months = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`);
    const cur = E.addM(ui.paie, -1);
    const isClosed = (m) => !!raw.clotures[`${ui.agence}_${E.addM(m, 1)}`];
    const people = collabsOf(ui.agence).filter((c) => (!c.entree || c.entree.slice(0, 4) <= String(y)) && (!c.sortie || c.sortie.slice(0, 4) >= String(y)));
    const st = S();
    const rowC = (c) => `<tr><td><b>${esc(c.prenom)} ${esc(c.nom)}</b><div class="muted" style="font-size:12px">${esc(currentPoste(c))}</div></td>${months.map((m) => { const d = raw.ca[c.id] || {}; const v = (d.valeurs || {})[m]; const src = (d.sources || {})[m]; return `<td class="${m === cur ? "cur" : ""} ${isClosed(m) ? "closed" : ""}"><input type="text" inputmode="decimal" class="num ${src && src !== "saisie" ? "src-import" : ""}" data-ca="${esc(c.id)}" data-m="${m}" value="${v == null ? "" : esc(nf0.format(v))}" aria-label="CA ${esc(c.prenom)} ${m}" title="${src ? `Source : ${esc(src)}` : ""}"></td>`; }).join("")}<td class="num"><b>${nf0.format(months.reduce((s, m) => s + ((raw.ca[c.id] || {}).valeurs || {})[m] || 0, 0))}</b></td></tr>`;
    const rowsP = perimsOf(ui.agence).map((p) => {
      const d = (raw.mensuel[p.id] || {}).valeurs || {};
      const line = (field, label) => `<tr><td>${label}</td>${months.map((m) => { const o = d[m] || {}; const calc = E.perimMois(st, p, m); const v = o[field]; const ph = field === "ca" ? (calc.hors ? "" : calc.ca == null ? "" : nf0.format(calc.ca)) : field === "effectif" ? (calc.hors ? "" : String(calc.eff)) : ""; return `<td class="${m === cur ? "cur" : ""}"><input type="text" inputmode="decimal" class="num ${o.source && o.source !== "saisie" ? "src-import" : ""}" data-pm="${esc(p.id)}" data-f="${field}" data-m="${m}" value="${v == null ? "" : esc(field === "effectif" ? String(v).replace(".", ",") : nf0.format(v))}" placeholder="${esc(ph)}" aria-label="${label} ${esc(p.nom)} ${m}"></td>`; }).join("")}<td></td></tr>`;
      return `<tr class="group"><td colspan="14">${esc(p.nom)} · ${p.kind === "bureau" ? "bureau (variable manager)" : "pôle (variable MDP)"} · responsable ${esc(nameOf(p.responsable))}${p.depuis ? ` · depuis ${esc(labelM(p.depuis, false))}` : ""}</td></tr>${line("ca", "CA périmètre")}${line("effectif", "Effectif producteurs")}${line("retraitement", "Retraitement")}`;
    }).join("");
    return `<div class="toolbar"><div class="grow"><h2>Chiffre d'affaires ${y}</h2><span class="muted">Saisie libre ou import depuis le dashboard. Les valeurs en couleur viennent d'un import.</span></div>
      <button class="btn ghost" data-year="-1">‹ ${y - 1}</button><button class="btn ghost" data-year="1">${y + 1} ›</button><button class="btn" data-tab="dashboard">Importer</button></div>
      <div class="scroll"><table class="cagrid"><thead><tr><th>Collaborateur</th>${months.map((m) => `<th class="${m === cur ? "cur" : ""}">${MC[pm(m).m - 1]}</th>`).join("")}<th>Total</th></tr></thead>
      <tbody><tr class="group"><td colspan="14">CA personnel (base du variable consultant)</td></tr>${people.map(rowC).join("") || `<tr><td colspan="14" class="muted">Aucun collaborateur.</td></tr>`}${rowsP}</tbody></table></div>
      <p class="note" style="margin-top:10px">Pour un bureau ou un pôle, laissez une case vide pour utiliser le calcul automatique (somme des membres présents, règle du 15 du mois), affiché en gris. Saisissez une valeur pour la remplacer, par exemple le CA bureau du dashboard qui inclut des producteurs hors de ce fichier. Le retraitement corrige la productivité utilisée pour les primes.</p>`;
  }

  /* ---------- Régularisations ---------- */
  const regRetire = (r) => (r.mouvements || []).filter((m) => m.montant < 0).reduce((s, m) => s + m.montant, 0);
  const regReverse = (r) => (r.mouvements || []).filter((m) => m.montant > 0).reduce((s, m) => s + m.montant, 0);
  function viewRegs() {
    const list = Object.values(raw.regs).filter((r) => (raw.collabs[r.collab] || {}).agence === ui.agence)
      .filter((r) => ui.regFilter === "toutes" || ["en cours", "à chiffrer"].includes(r.statut))
      .sort((a, b) => (b.periode || "").localeCompare(a.periode || ""));
    const pillFor = (s) => `<span class="pill ${s === "en cours" ? "warn" : s === "à chiffrer" ? "bad" : s === "reversée" ? "good" : "closed"}">${esc(s || "—")}</span>`;
    return `<div class="toolbar"><div class="grow"><h2>Régularisations</h2><span class="muted">Litiges, remplacements et avoirs : retraits puis reversements de commission.</span></div>
      <div class="row"><button class="btn ${ui.regFilter === "ouvertes" ? "primary" : ""}" data-regf="ouvertes">À suivre</button><button class="btn ${ui.regFilter === "toutes" ? "primary" : ""}" data-regf="toutes">Toutes</button></div>
      <button class="btn primary" data-action="reg-new">Nouvelle régularisation</button></div>
      ${ui.regEdit ? regForm() : ""}
      <div class="scroll"><table class="data"><thead><tr><th>Collaborateur</th><th>Placement</th><th>Type</th><th class="r">Montant avoir</th><th class="r">Commission</th><th class="r">Retiré</th><th class="r">Reversé</th><th>Statut</th><th>Commentaire</th></tr></thead>
      <tbody>${list.map((r) => `<tr class="click" data-reg="${esc(r.id)}"><td><b>${esc(nameOf(r.collab))}</b></td><td>${r.periode ? esc(shortM(r.periode)) : "—"}</td><td><span class="chip">${esc(r.type)}</span></td><td class="r num">${eur(r.montantAvoir, 0)}</td><td class="r num">${eur(r.commission)}</td><td class="r num">${eur(regRetire(r))}</td><td class="r num">${eur(regReverse(r))}</td><td>${pillFor(r.statut)}</td><td class="muted" style="max-width:340px;white-space:normal;font-size:12.5px">${esc(r.note || "")}</td></tr>`).join("") || `<tr><td colspan="9" class="muted">Aucune régularisation ${ui.regFilter === "ouvertes" ? "en cours" : ""}.</td></tr>`}</tbody></table></div>`;
  }
  function regForm() {
    const r = ui.regEdit;
    const opts = collabsOf(ui.agence).map((c) => `<option value="${esc(c.id)}" ${c.id === r.collab ? "selected" : ""}>${esc(c.prenom)} ${esc(c.nom)}</option>`).join("");
    return `<div class="panel" style="margin-bottom:16px"><div class="toolbar"><div class="grow"><h3>${raw.regs[r.id] ? "Modifier la régularisation" : "Nouvelle régularisation"}</h3></div>${raw.regs[r.id] ? `<button class="btn ghost danger" data-action="reg-del">Supprimer</button>` : ""}</div>
      <div class="form">
        <label>Collaborateur<select id="rg-collab" data-rg="collab">${opts}</select></label>
        <label>Mois du placement<input id="rg-periode" type="month" data-rg="periode" value="${esc(r.periode || "")}"></label>
        <label>Type<select id="rg-type" data-rg="type">${["LITIGE", "REMPLA", "AVOIR", "AUTRE"].map((t) => `<option ${t === r.type ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label>Statut<select id="rg-statut" data-rg="statut">${["à chiffrer", "en cours", "reversée", "soldée"].map((t) => `<option ${t === r.statut ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label>Montant initial du placement<input id="rg-mi" type="number" step="0.01" data-rg="montantInitial" value="${r.montantInitial ?? ""}"></label>
        <label>Montant de l'avoir / CA retiré<input id="rg-ma" type="number" step="0.01" data-rg="montantAvoir" value="${r.montantAvoir ?? ""}"></label>
        <label>Commission à régulariser<div class="row" style="flex-wrap:nowrap"><input id="rg-comm" type="number" step="0.01" data-rg="commission" value="${r.commission ?? ""}"><button class="btn" data-action="reg-calc" title="Écart de variable entre le CA du mois et le CA diminué de l'avoir">Calculer</button></div></label>
        <label class="wide">Commentaire<input id="rg-note" type="text" data-rg="note" value="${esc(r.note || "")}"></label>
      </div>
      <h3 style="margin-top:16px">Mouvements sur la paie</h3>
      <table class="data" style="margin-top:6px;max-width:520px"><thead><tr><th>Paie</th><th class="r">Montant</th><th></th></tr></thead><tbody>
      ${(r.mouvements || []).map((m, i) => `<tr><td><input type="month" id="mv-p-${i}" data-mv="${i}" data-mvf="paie" value="${esc(m.paie)}"></td><td class="r"><input type="number" step="0.01" id="mv-m-${i}" data-mv="${i}" data-mvf="montant" value="${m.montant}" style="width:120px"></td><td><button class="btn ghost" data-mvdel="${i}" aria-label="Retirer la ligne">✕</button></td></tr>`).join("")}
      </tbody></table>
      <div class="row" style="margin-top:8px"><button class="btn" data-action="mv-retrait">+ Retrait sur la paie de ${esc(labelM(ui.paie, false))}</button><button class="btn" data-action="mv-reverse">+ Reversement sur la paie de ${esc(labelM(ui.paie, false))}</button></div>
      <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn" data-action="reg-cancel">Annuler</button><button class="btn primary" data-action="reg-save">Enregistrer</button></div></div>`;
  }

  /* ---------- Équipes ---------- */
  function viewEquipes() {
    const people = collabsOf(ui.agence);
    const pers = perimsOf(ui.agence);
    return `<div class="toolbar"><div class="grow"><h2>Équipes</h2><span class="muted">Collaborateurs, historique de poste et rattachement aux pôles.</span></div><button class="btn primary" data-action="collab-new">Nouveau collaborateur</button></div>
      ${ui.collabEdit ? collabForm() : ""}
      <div class="scroll"><table class="data"><thead><tr><th>Collaborateur</th><th>Poste actuel</th><th>Variable</th><th>Pôle</th><th>Division</th><th>Entrée</th><th>Sortie</th><th>ID dashboard</th></tr></thead><tbody>
      ${people.map((c) => { const p = currentPoste(c); const t = E.typeAt(S(), c, `${ui.year}-12`).type; return `<tr class="click" data-collab="${esc(c.id)}"><td><b>${esc(c.prenom)} ${esc(c.nom)}</b></td><td>${esc(p)}</td><td>${typeChip(t)}</td><td>${c.pole ? esc((raw.perimetres[c.pole] || {}).nom || c.pole) : "—"}</td><td class="muted">${esc(c.division || "")}</td><td class="num">${c.entree ? new Date(c.entree).toLocaleDateString("fr-FR") : "—"}</td><td class="num">${c.sortie ? new Date(c.sortie).toLocaleDateString("fr-FR") : ""}</td><td class="num muted">${esc(c.idDashboard || "—")}</td></tr>`; }).join("") || `<tr><td colspan="8" class="muted">Aucun collaborateur dans ce cabinet.</td></tr>`}
      </tbody></table></div>
      <div class="toolbar" style="margin-top:28px"><div class="grow"><h2>Bureaux &amp; pôles</h2><span class="muted">Un bureau porte le variable et les primes du manager, un pôle ceux du manager de pôle.</span></div><button class="btn" data-action="perim-new">Nouveau périmètre</button></div>
      ${ui.perimEdit ? perimForm() : ""}
      <div class="scroll"><table class="data"><thead><tr><th>Périmètre</th><th>Nature</th><th>Responsable</th><th>Membres</th><th>Depuis</th></tr></thead><tbody>
      ${pers.map((p) => `<tr class="click" data-perim="${esc(p.id)}"><td><b>${esc(p.nom)}</b></td><td>${p.kind === "bureau" ? "Bureau" : "Pôle"}</td><td>${esc(nameOf(p.responsable))}</td><td class="muted">${p.kind === "bureau" ? "tout le cabinet" : esc(Object.values(raw.collabs).filter((c) => c.pole === p.id).map((c) => c.prenom + " " + c.nom).join(", ") || "—")}</td><td>${p.depuis ? esc(labelM(p.depuis, false)) : "—"}${p.fin ? ` → ${esc(labelM(p.fin, false))}` : ""}${p.taux ? `<div class="muted" style="font-size:12px">taux ${p.taux.map((x) => pct(x)).join(" / ")}</div>` : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Aucun bureau ni pôle.</td></tr>`}
      </tbody></table></div>`;
  }
  function collabForm() {
    const c = ui.collabEdit, B = S().baremes;
    const poles = perimsOf(c.agence || ui.agence).filter((p) => p.kind === "pole");
    return `<div class="panel" style="margin-bottom:16px"><div class="toolbar"><div class="grow"><h3>${raw.collabs[c.id] ? `${esc(c.prenom)} ${esc(c.nom)}` : "Nouveau collaborateur"}</h3></div>${raw.collabs[c.id] ? `<button class="btn ghost danger" data-action="collab-del">Supprimer</button>` : ""}</div>
      <div class="form">
        <label>Prénom<input id="cf-prenom" type="text" data-cf="prenom" value="${esc(c.prenom || "")}"></label>
        <label>Nom<input id="cf-nom" type="text" data-cf="nom" value="${esc(c.nom || "")}"></label>
        <label>Cabinet<select id="cf-agence" data-cf="agence">${agences().map((a) => `<option value="${esc(a.id)}" ${a.id === c.agence ? "selected" : ""}>${esc(a.nom || a.id)}</option>`).join("")}</select></label>
        <label>Pôle<select id="cf-pole" data-cf="pole"><option value="">Aucun</option>${poles.map((p) => `<option value="${esc(p.id)}" ${p.id === c.pole ? "selected" : ""}>${esc(p.nom)}</option>`).join("")}</select></label>
        <label>Division<input id="cf-division" type="text" data-cf="division" value="${esc(c.division || "")}"></label>
        <label>Date d'entrée<input id="cf-entree" type="date" data-cf="entree" value="${esc(c.entree || "")}"></label>
        <label>Date de sortie<input id="cf-sortie" type="date" data-cf="sortie" value="${esc(c.sortie || "")}"></label>
        <label>ID dashboard<input id="cf-iddash" type="text" data-cf="idDashboard" value="${esc(c.idDashboard || "")}" placeholder="pour l'import automatique"></label>
      </div>
      <h3 style="margin-top:16px">Historique de poste</h3>
      <table class="data" style="margin-top:6px;max-width:560px"><thead><tr><th>Depuis (mois de CA)</th><th>Poste</th><th></th></tr></thead><tbody>
      ${(c.postes || []).map((p, i) => `<tr><td><input type="month" id="ps-d-${i}" data-ps="${i}" data-psf="depuis" value="${esc(p.depuis)}"></td><td><select id="ps-p-${i}" data-ps="${i}" data-psf="poste">${Object.keys(B.postes).map((k) => `<option ${k === p.poste ? "selected" : ""}>${esc(k)}</option>`).join("")}</select></td><td><button class="btn ghost" data-psdel="${i}" aria-label="Retirer">✕</button></td></tr>`).join("")}
      </tbody></table>
      <button class="btn" style="margin-top:8px" data-action="ps-add">+ Promotion / changement de poste</button>
      <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn" data-action="collab-cancel">Annuler</button><button class="btn primary" data-action="collab-save">Enregistrer</button></div></div>`;
  }
  function perimForm() {
    const p = ui.perimEdit;
    return `<div class="panel" style="margin-bottom:16px"><div class="toolbar"><div class="grow"><h3>${raw.perimetres[p.id] ? esc(p.nom) : "Nouveau périmètre"}</h3></div>${raw.perimetres[p.id] ? `<button class="btn ghost danger" data-action="perim-del">Supprimer</button>` : ""}</div>
      <div class="form">
        <label>Nom<input id="pf-nom" type="text" data-pf="nom" value="${esc(p.nom || "")}"></label>
        <label>Nature<select id="pf-kind" data-pf="kind"><option value="bureau" ${p.kind === "bureau" ? "selected" : ""}>Bureau (manager)</option><option value="pole" ${p.kind === "pole" ? "selected" : ""}>Pôle (manager de pôle)</option></select></label>
        <label>Responsable<select id="pf-resp" data-pf="responsable">${collabsOf(ui.agence).map((c) => `<option value="${esc(c.id)}" ${c.id === p.responsable ? "selected" : ""}>${esc(c.prenom)} ${esc(c.nom)}</option>`).join("")}</select></label>
        <label>Prise de poste (mois de CA)<input id="pf-depuis" type="month" data-pf="depuis" value="${esc(p.depuis || "")}"></label>
        <label>Fin (dernier mois de CA)<input id="pf-fin" type="month" data-pf="fin" value="${esc(p.fin || "")}"></label>
      </div>
      <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn" data-action="perim-cancel">Annuler</button><button class="btn primary" data-action="perim-save">Enregistrer</button></div></div>`;
  }

  /* ---------- Promotions (consultants) ---------- */
  const ECHELLE = ["Consultant Junior 1", "Consultant Junior 2", "Consultant 1", "Consultant 2", "Consultant Sénior 1", "Consultant Sénior 2", "Consultant Sénior 3", "Consultant Sénior 4", "Consultant Principal 1", "Consultant Principal 2", "Consultant Expert 1", "Consultant Expert 2"];
  function posteInfo(p) { const cur = (S().baremes.postes || {})[p] || {}, def = E.DEFAULT_BAREMES.postes[p] || {}; return { fixe: cur.fixe ?? def.fixe ?? null, objectifAn: cur.objectifAn ?? def.objectifAn ?? null, objectif6: cur.objectif6 ?? def.objectif6 ?? null }; }
  const moisDiff = (a, b) => { const x = pm(a), y = pm(b); return (y.y - x.y) * 12 + (y.m - x.m) + 1; };
  function promoRows() {
    const st = S(), fin = E.addM(ui.paie, -1);
    return collabsOf(ui.agence).filter((c) => (!c.sortie || c.sortie.slice(0, 7) >= fin) && (!c.entree || c.entree.slice(0, 7) <= fin)).map((c) => {
      const poste = E.posteAt(c, fin);
      if (!ECHELLE.includes(poste)) return null;
      const ps = (c.postes || []).slice().sort((a, b) => a.depuis.localeCompare(b.depuis));
      const aVenir = ps.find((p) => p.depuis > fin && p.poste !== poste);
      const lastChange = ps.slice(1).filter((p) => p.depuis <= fin).map((p) => p.depuis).at(-1) || null;
      const cands = [c.dernierePromo && c.dernierePromo.slice(0, 7), c.promoPrecedente && c.promoPrecedente.slice(0, 7), lastChange].filter(Boolean).filter((m) => m <= fin);
      let debut = cands.sort().at(-1) || null;
      if (!debut) { const mois = Object.keys(st.ca[c.id] || {}).sort(); debut = c.entree ? c.entree.slice(0, 7) : mois[0] || fin; if (c.entree && dayOf(c.entree) > 15) debut = E.addM(debut, 1); }
      const n = Math.max(0, moisDiff(debut, fin));
      const months = Array.from({ length: n }, (_, i) => E.addM(debut, i));
      const cumul = months.reduce((s, m) => s + ((st.ca[c.id] || {})[m] || 0), 0);
      const manquants = months.filter((m) => (st.ca[c.id] || {})[m] == null).length;
      const pr = raw.promos[c.id] || {};
      const impayes = pr.impayes || 0;
      const nonEchu = (st.ca[c.id] || {})[fin] || 0;
      const valide = cumul - impayes;
      const info = posteInfo(poste), idx = ECHELLE.indexOf(poste), suivant = ECHELLE[idx + 1] || null;
      const cible = n <= 6 ? info.objectif6 : info.objectifAn, cibleLib = n <= 6 ? "objectif 6 mois" : "objectif 1 an";
      const rythme = n ? cumul / n : 0;
      let statut = "cours";
      if (aVenir) statut = "actee";
      else if (!suivant) statut = "max";
      else if (cible && valide >= cible) statut = "eligible";
      else if (cible && cumul >= cible) statut = "recouvrement";
      else if (cible && n < 6 && rythme * 6 >= info.objectif6) statut = "voie";
      else if (cible && n >= 6 && n < 12 && rythme * 12 >= info.objectifAn) statut = "voie";
      return { c, poste, aVenir, manquants, suivant, info, infoSuiv: suivant ? posteInfo(suivant) : null, debut, fin, n, cumul, impayes, valide, nonEchu, cible, cibleLib, rythme, statut, reste: cible ? Math.max(0, cible - valide) : null, note: pr.note || "" };
    }).filter(Boolean);
  }
  const dayOf = (iso) => Number(String(iso).slice(8, 10)) || 1;
  const STATUTS = { actee: ["good", "Promotion actée"], eligible: ["good", "Objectif atteint"], recouvrement: ["warn", "Atteint, sous réserve d'encaissement"], voie: ["open", "En bonne voie"], cours: ["closed", "En cours"], max: ["closed", "Dernier échelon"] };
  function viewPromos() {
    const rows = promoRows().sort((a, b) => ["eligible", "recouvrement", "actee", "voie", "cours", "max"].indexOf(a.statut) - ["eligible", "recouvrement", "actee", "voie", "cours", "max"].indexOf(b.statut) || (b.cible ? b.valide / b.cible : 0) - (a.cible ? a.valide / a.cible : 0));
    const fin = E.addM(ui.paie, -1), effet = ui.paie;
    const nEl = rows.filter((r) => r.statut === "eligible").length;
    const bar = (r) => { const p = r.cible ? Math.min(1, r.valide / r.cible) : 0, p2 = r.cible ? Math.min(1, r.cumul / r.cible) : 0; return `<div class="pbar" title="${pct(p)} de l'objectif"><span class="pend" style="width:${(p2 * 100).toFixed(1)}%"></span><span class="ok" style="width:${(p * 100).toFixed(1)}%"></span></div>`; };
    return `<div class="toolbar"><div class="grow"><h2>Promotions des consultants</h2><span class="muted">CA cumulé depuis la dernière promotion, à fin ${esc(labelM(fin, false))}, comparé à l'objectif du poste</span></div></div>
      <div class="summary" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div><div class="eyebrow">Objectif atteint</div><div class="v ${nEl ? "good" : ""}">${nEl}</div><div class="s">promotion possible au 1er ${esc(labelM(effet, false))}</div></div>
        <div><div class="eyebrow">Sous réserve d'encaissement</div><div class="v">${rows.filter((r) => r.statut === "recouvrement").length}</div><div class="s">factures échues à recouvrer avant le 15</div></div>
        <div><div class="eyebrow">En bonne voie</div><div class="v">${rows.filter((r) => r.statut === "voie").length}</div><div class="s">au rythme actuel, objectif atteint dans les délais</div></div>
      </div>
      ${rows.length ? `<div class="scroll"><table class="data promo"><thead><tr><th>Consultant</th><th>Depuis</th><th class="r">CA cumulé</th><th class="r">Échues impayées</th><th class="r">CA retenu</th><th>Objectif</th><th>Progression</th><th class="r">Reste à faire</th><th>Statut</th><th>Promotion</th></tr></thead><tbody>
      ${rows.map((r) => `<tr>
        <td><b>${esc(r.c.prenom)} ${esc(r.c.nom)}</b><div class="muted" style="font-size:12px">${esc(r.poste)}</div></td>
        <td class="num" style="white-space:nowrap">${esc(shortM(r.debut))}<div class="muted" style="font-size:12px">${r.n} mois</div>${r.manquants ? `<div class="flagtxt" title="Mois de la période sans CA dans l'outil (avant la reprise des fichiers) : le cumul est sous-estimé">${r.manquants} mois sans CA</div>` : ""}</td>
        <td class="r num">${eur(r.cumul, 0)}</td>
        <td class="r"><input type="text" inputmode="decimal" class="num" style="width:90px;text-align:right" id="pi-${esc(r.c.id)}" data-promo="${esc(r.c.id)}" data-pf="impayes" value="${r.impayes ? esc(nf0.format(r.impayes)) : ""}" placeholder="0" aria-label="Factures échues impayées ${esc(r.c.prenom)} ${esc(r.c.nom)}"></td>
        <td class="r num"><b>${eur(r.valide, 0)}</b></td>
        <td class="num" style="white-space:nowrap">${r.cible ? eur(r.cible, 0) : "—"}<div class="muted" style="font-size:12px">${esc(r.cibleLib)}</div></td>
        <td style="min-width:130px">${r.cible ? bar(r) : ""}<div class="muted num" style="font-size:12px">${r.cible ? pct(r.valide / r.cible) : ""}</div></td>
        <td class="r num">${r.reste == null ? "—" : r.reste === 0 ? "—" : eur(r.reste, 0)}</td>
        <td><span class="pill ${STATUTS[r.statut][0]}">${STATUTS[r.statut][1]}</span></td>
        <td>${r.aVenir ? `<div style="font-size:12.5px">${esc(r.aVenir.poste)} au 1er ${esc(labelM(r.aVenir.depuis, false))}</div>` : r.suivant ? `<div style="font-size:12.5px">${esc(r.suivant)}${r.infoSuiv && r.infoSuiv.fixe ? ` · ${eur(r.infoSuiv.fixe, 0)}` : ""}</div>${r.statut === "eligible" ? `<button class="btn primary" style="margin-top:4px" data-action="promo-acter" data-cid="${esc(r.c.id)}">Acter au 1er ${esc(labelM(effet, false))}</button>` : ""}` : `<span class="muted">—</span>`}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty"><b>Aucun consultant</b>Les consultants du cabinet apparaissent ici avec leur progression vers la promotion suivante.</div>`}
      <div class="callout info" style="margin-top:16px">
        <b>Règles appliquées</b> (procédure d'obtention de promotion)<br>
        • CA compté à partir du mois de la dernière promotion actée, ou de l'arrivée.<br>
        • Objectif 6 mois pendant les 6 premiers mois, objectif annuel ensuite.<br>
        • Seul le CA dont les factures arrivées à échéance (J+30) sont réglées compte : saisissez le montant des factures échues impayées pour le déduire. Le CA du dernier mois (${esc(shortM(fin))}) n'est pas encore échu, il n'est pas soumis à vérification.<br>
        • Promotion actée au 1er du mois si les factures échues sont réglées avant le 15 ; sinon au 1er du mois où elles sont recouvrées. Pas de rétroactivité.<br>
        • Le CA d'une nouvelle promotion repart de la date où celle-ci est actée.
      </div>
      ${rows.some((r) => r.manquants) ? `<p class="note" style="margin-top:8px">« Mois sans CA » : la période commence avant la reprise des fichiers (janvier 2026). Saisissez ces mois dans l'onglet Chiffre d'affaires pour un cumul exact.</p>` : ""}
      <p class="note" style="margin-top:8px">Point à confirmer : au-delà de 12 mois sans promotion, l'outil compare encore le CA cumulé depuis la dernière promotion à l'objectif annuel.</p>`;
  }
  function acterPromo(cid) {
    const r = promoRows().find((x) => x.c.id === cid); if (!r || !r.suivant) return;
    const effet = ui.paie;
    confirmBox(`Acter la promotion de ${r.c.prenom} ${r.c.nom} ?`, `${esc(r.poste)} → <b>${esc(r.suivant)}</b> au 1er ${esc(labelM(effet, false))}${r.infoSuiv && r.infoSuiv.fixe ? `, fixe annuel ${eur(r.infoSuiv.fixe, 0)}` : ""}. Le nouveau barème s'applique au CA à partir de ${esc(labelM(effet, false))}, et le compteur de la promotion suivante repart de cette date. Vérifiez auparavant que les factures échues sont réglées.`, "Acter la promotion", async () => {
      const c = clone(raw.collabs[cid]);
      c.postes = (c.postes || []).filter((p) => p.depuis < effet).concat([{ depuis: effet, poste: r.suivant }]).sort((a, b) => a.depuis.localeCompare(b.depuis));
      if (c.dernierePromo) c.promoPrecedente = c.dernierePromo;
      c.dernierePromo = `${effet}-01`;
      if (await put(`collabs/${cid}`, c)) { if ((raw.promos[cid] || {}).impayes) await merge(`promos/${cid}`, { impayes: null }); toast(`Promotion de ${c.prenom} ${c.nom} actée`); }
    });
  }

  /* ---------- Agence ---------- */
  function viewAgence() {
    const ag = ui.agence, y = ui.year, st = S(), B = st.baremes;
    const list = agences();
    const head = `<div class="toolbar"><div class="grow"><h2>Cabinets</h2></div></div>
      <div class="panel" style="margin-bottom:20px"><div class="row">${list.map((a) => `<span class="pill ${a.id === ag ? "open" : "closed"}">${esc(a.nom || a.id)}</span>`).join("")}
      <span style="margin-left:auto" class="row"><input id="ag-new" type="text" placeholder="Nom du nouveau cabinet" aria-label="Nom du nouveau cabinet"><button class="btn" data-action="ag-add">Ajouter</button></span></div></div>`;
    if (!ag) return head;
    const obj = (raw.objectifs[ag] || {}).periodes || {};
    const bureau = perimsOf(ag).find((p) => p.kind === "bureau");
    const caQ = (q) => { if (!bureau) return null; const ms = [1, 2, 3].map((i) => `${y}-${String((q - 1) * 3 + i).padStart(2, "0")}`); const v = ms.map((m) => E.perimMois(st, bureau, m).ca); return v.some((x) => x == null) ? null : v.reduce((a, b) => a + b, 0); };
    const quarters = [1, 2, 3, 4].map((q) => { const o = obj[`${y}-T${q}`] || {}; const ca = caQ(q); const seuil = o.objectif ? o.objectif * (1 + B.primeEquipe.marge) : null; const auto = seuil != null && ca != null ? ca >= seuil : null; const val = o.atteint != null ? o.atteint : auto;
      return `<tr><td><b>T${q}</b></td><td class="r"><input type="text" inputmode="decimal" class="num" id="ob-${q}" data-obj="${y}-T${q}" data-objf="objectif" value="${o.objectif != null ? nf0.format(o.objectif) : ""}" style="width:120px"></td><td class="r num">${seuil ? eur(seuil, 0) : "—"}</td><td class="r num">${ca != null ? eur(ca, 0) : "—"}</td>
      <td><select id="oba-${q}" data-obj="${y}-T${q}" data-objf="atteint"><option value="" ${o.atteint == null ? "selected" : ""}>Automatique</option><option value="1" ${o.atteint === true ? "selected" : ""}>Forcé : atteint</option><option value="0" ${o.atteint === false ? "selected" : ""}>Forcé : non atteint</option></select></td>
      <td>${val == null ? `<span class="pill closed">à saisir</span>` : val ? `<span class="pill good">250 € versés</span>` : `<span class="pill bad">pas de prime</span>`}</td></tr>`; }).join("");
    const pr = obj[String(y)] || {};
    const M = B.manager;
    const pal = (v, t) => { let o = 0; for (const [s, m] of t) if (v > s) o = m; return o; };
    const recV = (raw.agenceMois[ag] || {}).valeurs || {};
    const months = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`);
    const recRows = months.map((m) => { const r = recV[m] || {}; const taux = r.echues ? r.reglees / r.echues : null; const ok = r.reglees != null && (taux == null || taux >= B.recouvrement.tauxMin - 1e-9) && r.conditionsOk !== false; let bonus = 0; if (ok) for (const [s, v] of B.recouvrement.paliers) if (r.reglees >= s) bonus = v;
      return `<tr><td>${esc(labelM(m))}</td><td class="r"><input type="number" min="0" id="rc-e-${m}" data-rec="${m}" data-recf="echues" value="${r.echues ?? ""}" style="width:80px"></td><td class="r"><input type="number" min="0" id="rc-r-${m}" data-rec="${m}" data-recf="reglees" value="${r.reglees ?? ""}" style="width:80px"></td><td class="r num">${taux != null ? pct(taux) : "—"}</td><td><label class="check"><input type="checkbox" id="rc-c-${m}" data-rec="${m}" data-recf="conditionsOk" ${r.conditionsOk !== false ? "checked" : ""}> remplies</label></td><td class="r num">${r.reglees != null ? eur(bonus, 0) : "—"}</td><td class="muted">paie ${esc(labelM(E.addM(m, 2), false))}</td></tr>`; }).join("");
    return `${head}
      <div class="toolbar"><div class="grow"><h2>${esc((raw.agences[ag] || {}).nom || ag)} · ${y}</h2></div><button class="btn ghost" data-year="-1">‹ ${y - 1}</button><button class="btn ghost" data-year="1">${y + 1} ›</button></div>
      <div class="stack">
      <div class="panel"><h3>Objectifs trimestriels et prime d'équipe</h3><p class="note">La prime d'équipe (250 € par consultant présent sur tout le trimestre, hors alternants et manager de cabinet) est versée si le CA du bureau dépasse l'objectif de ${pct(B.primeEquipe.marge)}. Vous pouvez forcer le résultat.</p>
        <div class="scroll" style="border:0"><table class="data"><thead><tr><th>Trimestre</th><th class="r">Objectif bureau</th><th class="r">Seuil (+${pct(B.primeEquipe.marge)})</th><th class="r">CA bureau réalisé</th><th>Décision</th><th>Résultat</th></tr></thead><tbody>${quarters}</tbody></table></div></div>
      <div class="panel"><h3>Profit du bureau et prime annuelle du manager</h3><p class="note">Acomptes à 4 et 8 mois selon les paliers intermédiaires, solde en fin d'année (paie de janvier).</p>
        <div class="form" style="margin-top:10px">
          <label>Profit cumulé à fin avril<input type="text" inputmode="decimal" class="num" id="pr-4" data-obj="${y}" data-objf="profit4" value="${pr.profit4 != null ? nf0.format(pr.profit4) : ""}"><span class="num">→ ${pr.profit4 != null ? eur(pal(pr.profit4, M.acompte4), 0) : "—"}</span></label>
          <label>Profit cumulé à fin août<input type="text" inputmode="decimal" class="num" id="pr-8" data-obj="${y}" data-objf="profit8" value="${pr.profit8 != null ? nf0.format(pr.profit8) : ""}"><span class="num">→ ${pr.profit8 != null ? eur(pal(pr.profit8, M.acompte8), 0) : "—"}</span></label>
          <label>Profit annuel<input type="text" inputmode="decimal" class="num" id="pr-12" data-obj="${y}" data-objf="profit12" value="${pr.profit12 != null ? nf0.format(pr.profit12) : ""}"><span class="num">→ ${pr.profit12 != null ? eur(pal(pr.profit12 + 0.01, M.profitAnnuel), 0) : "—"}</span></label>
        </div></div>
      <div class="panel"><h3>Bonus recouvrement</h3><p class="note">Pour chaque mois d'échéance : nombre de factures échues et nombre réglées avant le 20 du mois suivant (hors contentieux et mentor). Bonus si au moins ${pct(B.recouvrement.tauxMin)} sont réglées, impayés à plus de 60 jours sous 3 % et aucun remplacement en cours avec facture impayée.</p>
        <div class="scroll" style="border:0"><table class="data"><thead><tr><th>Mois d'échéance</th><th class="r">Échues</th><th class="r">Réglées</th><th class="r">Taux</th><th>Conditions</th><th class="r">Bonus</th><th>Versé sur</th></tr></thead><tbody>${recRows}</tbody></table></div></div>
      </div>`;
  }

  /* ---------- Barèmes ---------- */
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function bnum(path, val, opt = {}) {
    const isPct = opt.pct;
    const shown = val == null ? "" : isPct ? String(Math.round(val * 100000) / 1000).replace(".", ",") : String(val).replace(".", ",");
    return `<input type="text" inputmode="decimal" class="num" style="width:${opt.w || 84}px;text-align:right" data-bpath="${esc(path)}" ${isPct ? 'data-bpct="1"' : ""} value="${esc(shown)}" aria-label="${esc(opt.label || path)}">${isPct ? " %" : ""}`;
  }
  function viewBaremes() {
    if (!ui.draftBaremes) ui.draftBaremes = clone(S().baremes);
    const B = ui.draftBaremes;
    const saved = raw.settings.baremes;
    const types = Object.keys(B.consultant.types);
    const cb = B.consultant.bornes;
    const consRows = [0, ...cb].map((b, i) => `<tr><td>${i === 0 ? `0 – ${bnum(`consultant.bornes.0`, cb[0], { w: 80, label: "borne 1" })}` : i < cb.length ? `${nf0.format(b)} – ${bnum(`consultant.bornes.${i}`, cb[i], { w: 80 })}` : `> ${nf0.format(b)}`}</td>${types.map((t) => `<td class="r">${bnum(`consultant.types.${t}.${i}`, B.consultant.types[t][i], { pct: true, w: 64 })}</td>`).join("")}</tr>`).join("");
    const pb = B.perimetre.bornesParTete;
    const perRows = B.perimetre.taux.map((t, i) => `<tr><td>${i === 0 ? "0" : nf0.format(pb[i - 1])} – ${i < pb.length ? bnum(`perimetre.bornesParTete.${i}`, pb[i], { w: 80 }) : "∞"}</td><td class="r">${bnum(`perimetre.taux.${i}`, t, { pct: true, w: 60 })}</td></tr>`).join("");
    const pairs = (path, arr, l1, l2) => `<table class="data"><thead><tr><th>${l1}</th><th class="r">${l2}</th></tr></thead><tbody>${arr.map((p, i) => `<tr><td>${bnum(`${path}.${i}.0`, p[0], { w: 100 })}</td><td class="r">${bnum(`${path}.${i}.1`, p[1], { w: 80 })} €</td></tr>`).join("")}</tbody></table>`;
    const grid = (path, g, cats) => `<table class="data"><thead><tr><th>Productivité ≥</th>${cats.map((c) => `<th class="r">Cat. ${c}</th>`).join("")}</tr></thead><tbody>${g.seuils.map((s, i) => `<tr><td>${bnum(`${path}.seuils.${i}`, s, { w: 90 })}</td>${cats.map((c) => `<td class="r">${bnum(`${path}.${c}.${i}`, g[c][i], { w: 70 })} €</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    const postes = Object.entries(B.postes).map(([k, p]) => `<tr><td>${esc(k)}</td><td><select data-bpath="postes.${esc(k)}.type" aria-label="Variable ${esc(k)}">${["Type 1", "Type 2", "Type 3", "Alt", ""].map((t) => `<option value="${t}" ${t === (p.type || "") ? "selected" : ""}>${t === "Alt" ? "Alternant" : t || "Aucun"}</option>`).join("")}</select></td><td><select data-bpath="postes.${esc(k)}.role" aria-label="Rôle ${esc(k)}">${["consultant", "mdp", "manager", "alternant", "interne"].map((t) => `<option ${t === p.role ? "selected" : ""}>${t}</option>`).join("")}</select></td><td><label class="check"><input type="checkbox" data-bpath="postes.${esc(k)}.sansPrimePerf" data-binv="1" ${p.sansPrimePerf ? "" : "checked"}> éligible</label></td><td><label class="check"><input type="checkbox" data-bpath="postes.${esc(k)}.sansPrimeEquipe" data-binv="1" ${p.sansPrimeEquipe ? "" : "checked"}> éligible</label></td>${p.role === "consultant" ? `<td class="r">${bnum(`postes.${k}.fixe`, posteInfo(k).fixe, { w: 80 })}</td><td class="r">${bnum(`postes.${k}.objectifAn`, posteInfo(k).objectifAn, { w: 86 })}</td><td class="r">${bnum(`postes.${k}.objectif6`, posteInfo(k).objectif6, { w: 86 })}</td>` : "<td></td><td></td><td></td>"}</tr>`).join("");
    return `<div class="toolbar"><div class="grow"><h2>Barèmes</h2><span class="muted">${saved && saved.at ? `Enregistrés le ${new Date(saved.at).toLocaleDateString("fr-FR")}` : "Valeurs d'origine du fichier Tours 2026"}</span></div>
      <button class="btn ghost" data-action="bar-reset">Rétablir les valeurs d'origine</button><button class="btn primary" data-action="bar-save">Enregistrer les barèmes</button></div>
      <div class="callout" style="margin-bottom:16px">Les barèmes s'appliquent à tous les cabinets et aux mois non clôturés. Les mois clôturés gardent leurs montants.</div>
      <div class="grid2">
        <div class="panel"><h3>Variable consultant, par tranche de CA mensuel</h3><div class="scroll" style="border:0"><table class="data"><thead><tr><th>Tranche de CA</th>${types.map((t) => `<th class="r">${t}</th>`).join("")}</tr></thead><tbody>${consRows}</tbody></table></div>
          <p class="note" style="margin-top:8px">Alternant : ${bnum("consultant.alternant", B.consultant.alternant, { pct: true, w: 60 })} dès le premier euro.</p></div>
        <div class="panel"><h3>Variable manager et MDP, par productivité par tête</h3><table class="data"><thead><tr><th>Productivité / tête</th><th class="r">Taux</th></tr></thead><tbody>${perRows}</tbody></table>
          <p class="note" style="margin-top:8px">Chaque tranche est multipliée par l'effectif du périmètre.</p></div>
        <div class="panel"><h3>Prime de performance individuelle</h3>${pairs("primePerf.paliers", B.primePerf.paliers, "CA sur 3 mois ≥", "Prime")}<p class="note" style="margin-top:8px">Fenêtre glissante de 3 mois ; les mois d'une fenêtre primée ne comptent plus.</p></div>
        <div class="panel"><h3>Prime d'équipe et recouvrement</h3><div class="form">
          <label>Prime d'équipe par personne<span>${bnum("primeEquipe.montant", B.primeEquipe.montant)} €</span></label>
          <label>Dépassement d'objectif requis<span>${bnum("primeEquipe.marge", B.primeEquipe.marge, { pct: true, w: 60 })}</span></label>
          <label>Taux de factures réglées requis<span>${bnum("recouvrement.tauxMin", B.recouvrement.tauxMin, { pct: true, w: 60 })}</span></label></div>
          <div style="margin-top:10px">${pairs("recouvrement.paliers", B.recouvrement.paliers, "Factures réglées ≥", "Bonus mensuel")}</div></div>
        <div class="panel"><h3>Primes manager de pôle</h3><p class="note">Catégorie B au-delà de ${bnum("mdp.seuilCategorieB", B.mdp.seuilCategorieB, { w: 50 })} producteurs en moyenne. Minimum ${bnum("mdp.minMensuel", B.mdp.minMensuel, { w: 70 })} € par tête chaque mois pour la prime trimestrielle. Primes versées après ${bnum("mdp.ancienneteMois", B.mdp.ancienneteMois ?? 6, { w: 44 })} mois d'encadrement.</p>
          <h3 style="margin-top:10px;font-size:13px">Trimestrielle</h3>${grid("mdp.trimestre", B.mdp.trimestre, ["A", "B"])}<h3 style="margin-top:10px;font-size:13px">Annuelle</h3>${grid("mdp.annuel", B.mdp.annuel, ["A", "B"])}</div>
        <div class="panel"><h3>Primes manager de bureau</h3><p class="note">Catégories : A sous ${bnum("manager.categories.0", B.manager.categories[0], { w: 44 })}, B jusqu'à ${bnum("manager.categories.1", B.manager.categories[1], { w: 44 })}, C au-delà.</p>
          <h3 style="margin-top:10px;font-size:13px">Trimestrielle</h3>${grid("manager.trimestre", B.manager.trimestre, ["A", "B", "C"])}<h3 style="margin-top:10px;font-size:13px">Semestrielle</h3>${grid("manager.semestre", B.manager.semestre, ["A", "B", "C"])}</div>
        <div class="panel"><h3>Prime annuelle sur le profit du bureau</h3>${pairs("manager.profitAnnuel", B.manager.profitAnnuel, "Profit annuel ≥", "Prime")}
          <div class="grid2" style="margin-top:10px"><div>${pairs("manager.acompte4", B.manager.acompte4, "Profit à 4 mois >", "Acompte")}</div><div>${pairs("manager.acompte8", B.manager.acompte8, "Profit à 8 mois >", "Acompte")}</div></div></div>
        <div class="panel"><h3>Postes</h3><div class="scroll" style="border:0"><table class="data"><thead><tr><th>Poste</th><th>Variable</th><th>Rôle</th><th>Prime perf.</th><th>Prime équipe</th><th class="r">Fixe annuel</th><th class="r">Objectif 1 an</th><th class="r">Objectif 6 mois</th></tr></thead><tbody>${postes}</tbody></table></div></div>
      </div>`;
  }
  function setPath(obj, path, val) {
    const ks = path.split("."); let o = obj;
    for (let i = 0; i < ks.length - 1; i++) { const k = /^\d+$/.test(ks[i]) ? Number(ks[i]) : ks[i]; o = o[k]; }
    const last = /^\d+$/.test(ks.at(-1)) ? Number(ks.at(-1)) : ks.at(-1);
    o[last] = val;
  }

  /* ---------- Journal ---------- */
  function viewJournal() {
    const f = ui.journalFiltre || "agence";
    const rows = journal.filter((j) => f === "toutes" || !j.agence || j.agence === ui.agence).filter((j) => !ui.journalAction || j.action === ui.journalAction);
    const actions = [...new Set(journal.map((j) => j.action))].sort();
    const qui = (id) => (id ? (profils[id] && profils[id].name) || (id === myId ? "Vous" : "Utilisateur") : "—");
    return `<div class="toolbar"><div class="grow"><h2>Journal des modifications</h2><span class="muted">Qui a changé quoi, et quand${journal.length >= 500 ? " (500 dernières modifications)" : ""}.</span></div>
      <select id="jr-f" aria-label="Cabinets"><option value="agence" ${f === "agence" ? "selected" : ""}>${esc((raw.agences[ui.agence] || {}).nom || "Cabinet")} et barèmes</option><option value="toutes" ${f === "toutes" ? "selected" : ""}>Tous les cabinets</option></select>
      <select id="jr-a" aria-label="Type de modification"><option value="">Tous les types</option>${actions.map((a) => `<option ${a === ui.journalAction ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></div>
      ${!journalLoaded ? `<div class="empty"><b>Chargement du journal…</b></div>` : rows.length ? `<div class="scroll"><table class="data"><thead><tr><th>Date</th><th>Par</th><th>Type</th>${f === "toutes" ? "<th>Cabinet</th>" : ""}<th>Modification</th></tr></thead><tbody>
      ${rows.map((j) => `<tr><td class="num" style="white-space:nowrap">${new Date(j.at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}</td><td style="white-space:nowrap">${esc(qui(j.par))}</td><td><span class="chip">${esc(j.action)}</span></td>${f === "toutes" ? `<td>${esc(j.agence ? (raw.agences[j.agence] || {}).nom || j.agence : "Toutes")}</td>` : ""}<td style="white-space:normal;max-width:720px">${esc(j.texte)}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty"><b>Aucune modification enregistrée</b>Les saisies, ajustements, clôtures et imports apparaîtront ici.</div>`}
      <p class="note" style="margin-top:10px">Le journal démarre à la mise en place de cette fonction : les données reprises du fichier de Tours n'y figurent pas.</p>`;
  }
  async function loadProfils() {
    if (!userCap) return;
    const ids = [...new Set(journal.map((j) => j.par).filter(Boolean))].filter((id) => !profils[id]);
    if (!ids.length) return;
    try { Object.assign(profils, await userCap.profiles(ids)); if (ui.tab === "journal") scheduleRender(); } catch (e) {}
  }

  /* ---------- Dashboard & import ---------- */
  function viewDashboard() {
    const rows = ui.importRows;
    return `<div class="toolbar"><div class="grow"><h2>Dashboard &amp; import</h2></div></div>
      <div class="grid2">
      <div class="panel"><h3>Connexion à dashboard.harry-hope.com</h3>
        <div class="row" style="margin-top:8px"><span class="pill warn">En attente des accès API</span></div>
        <p class="note" style="margin-top:10px">La synchronisation automatique écrira le CA mensuel de chaque collaborateur, et le CA et l'effectif des bureaux et pôles, directement dans cet outil. Elle sera branchée dès que l'adresse de l'API, son mode d'authentification et un exemple de réponse seront disponibles.</p>
        <p class="note">En attendant, exportez le CA depuis le dashboard et importez-le ci-contre : le résultat est le même.</p>
        <details class="rule" style="margin-top:10px"><summary>Format attendu</summary>
          <p class="note">Excel (.xlsx, .xls), CSV ou JSON. Deux dispositions acceptées : une ligne par collaborateur avec une colonne par mois (« janv. 2026 », « 2026-01 »…), ou une ligne par collaborateur et par mois. Colonnes reconnues : <code>id</code> (ID dashboard) ou <code>prenom</code> + <code>nom</code> ou <code>collaborateur</code> ; <code>mois</code> (2026-10, 10/2026 ou une date) ; <code>ca</code>. Pour un bureau ou un pôle : <code>perimetre</code> (son nom), <code>ca</code> et éventuellement <code>effectif</code>.</p>
          <pre class="num" style="font-size:12px;background:var(--sunk);padding:8px;border-radius:6px;overflow-x:auto">prenom;nom;mois;ca
Léna;PLUYAUD;2026-10;24500
perimetre;mois;ca;effectif
Bureau Tours;2026-10;182300;10</pre></details>
      </div>
      <div class="panel"><h3>Importer un fichier</h3><p class="note">Un fichier de commissions mensuel (même modèle que « 2026 - TOURS - Commissions 10.2026.xlsm ») ou un export de CA du dashboard, en Excel, CSV ou JSON.</p>
        <div class="row" style="margin-top:8px"><input type="file" id="imp-file" accept=".xlsx,.xlsm,.xls,.ods,.csv,.json,.txt" aria-label="Fichier à importer">${ui.importFile ? `<span class="muted">${esc(ui.importFile)}</span>` : ""}</div>
        <textarea id="imp-text" rows="7" style="margin-top:8px" placeholder="…ou collez ici le contenu CSV / JSON">${esc(ui.importText)}</textarea>
        <div class="row" style="margin-top:8px"><button class="btn" data-action="imp-preview">Analyser</button>${rows ? `<button class="btn primary" data-action="imp-apply" ${rows.filter((r) => r.ok).length ? "" : "disabled"}>Importer ${rows.filter((r) => r.ok).length} valeur(s)</button><button class="btn ghost" data-action="imp-clear">Effacer</button>` : ""}</div>
      </div></div>
      ${viewCommImport()}
      ${rows ? `<h3 style="margin:20px 0 8px">Aperçu de l'import</h3><div class="scroll"><table class="data"><thead><tr><th>Ligne</th><th>Cible</th><th>Mois</th><th class="r">CA</th><th class="r">Effectif</th><th class="r">Valeur actuelle</th><th>État</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="num muted">${r.n}</td><td>${esc(r.label)}</td><td class="num">${r.mois ? esc(shortM(r.mois)) : "—"}</td><td class="r num">${r.ca != null ? nf0.format(r.ca) : "—"}</td><td class="r num">${r.eff ?? ""}</td><td class="r num muted">${r.actuel != null ? nf0.format(r.actuel) : "—"}</td><td>${r.ok ? (r.actuel != null && r.actuel !== r.ca ? `<span class="pill warn">remplace</span>` : `<span class="pill good">prêt</span>`) : `<span class="pill bad">${esc(r.err)}</span>`}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
  }
  const MOIS_N = { janvier: 1, janv: 1, jan: 1, fevrier: 2, fevr: 2, fev: 2, feb: 2, mars: 3, mar: 3, avril: 4, avr: 4, apr: 4, mai: 5, may: 5, juin: 6, jun: 6, juillet: 7, juil: 7, jul: 7, aout: 8, aou: 8, aug: 8, septembre: 9, sept: 9, sep: 9, octobre: 10, oct: 10, novembre: 11, nov: 11, decembre: 12, dec: 12 };
  function parseMonth(v, defYear) {
    if (v == null || v === "") return null;
    if (v instanceof Date && !isNaN(v)) { const d = new Date(v.getTime() + 12 * 3600e3); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; }
    if (typeof v === "number" && v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 86400e3) + 12 * 3600e3); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})[-\/](\d{1,2})(?:\D|$)/); if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}`;
    m = s.match(/^(\d{1,2})[\/.-](\d{4})$/); if (m) return `${m[2]}-${m[1].padStart(2, "0")}`;
    const n = norm(s).split(" ");
    if (n[0] in MOIS_N) { const y = (n[1] || "").match(/^\d{2,4}$/) ? (n[1].length === 2 ? "20" + n[1] : n[1]) : defYear; if (y) return `${y}-${String(MOIS_N[n[0]]).padStart(2, "0")}`; }
    return null;
  }
  const K_CA = ["ca", "chiffre d affaires", "ca facture", "ca ht", "montant", "revenue", "total ca"];
  const K_MOIS = ["mois", "periode", "date", "month", "mois de facturation"];
  const K_NAME = ["collaborateur", "consultant", "nom complet", "name", "nom", "prenom", "id", "identifiant", "id dashboard", "perimetre", "bureau", "pole", "equipe"];
  /* Transforme un tableau (lignes de cellules) en objets {colonne: valeur}, format long ou large (un mois par colonne). */
  function tableToObjs(rows) {
    rows = rows.filter((r) => r && r.some((c) => c != null && String(c).trim() !== ""));
    const defYear = String(ui.year);
    for (let h = 0; h < Math.min(rows.length, 30); h++) {
      const keys = rows[h].map((c) => (c instanceof Date ? "" : norm(c)));
      if (keys.some((k) => K_CA.includes(k)) && keys.some((k) => K_MOIS.includes(k))) {
        return rows.slice(h + 1).map((r) => Object.fromEntries(keys.map((k, i) => [k || `col${i}`, r[i]])));
      }
      const monthCols = rows[h].map((c, i) => ({ i, m: parseMonth(c, defYear) })).filter((x) => x.m && !(typeof rows[h][x.i] === "number" && rows[h][x.i] < 20000));
      const nameCols = keys.map((k, i) => ({ k, i })).filter((x) => K_NAME.includes(x.k));
      if (monthCols.length >= 2 && (nameCols.length || !parseMonth(rows[h][0], defYear))) {
        const nc = nameCols.length ? nameCols : [{ k: "collaborateur", i: 0 }];
        const out = [];
        for (const r of rows.slice(h + 1)) {
          const base = Object.fromEntries(nc.map((x) => [x.k, r[x.i]]));
          if (nc.every((x) => r[x.i] == null || String(r[x.i]).trim() === "")) continue;
          if (/^total/.test(norm(Object.values(base)[0]))) continue;
          for (const mc of monthCols) if (r[mc.i] != null && String(r[mc.i]).trim() !== "") out.push({ ...base, mois: mc.m, ca: r[mc.i] });
        }
        return out;
      }
    }
    return [];
  }
  function csvRows(text) {
    return text.split(/\r?\n/).filter((l) => l.trim()).map((line) => { const sep = line.includes(";") ? ";" : line.includes("\t") ? "\t" : ","; return line.split(sep).map((c) => c.trim().replace(/^"|"$/g, "")); });
  }
  function parseImport(input) {
    let objs = [];
    if (Array.isArray(input)) { for (const sheet of input) { objs = tableToObjs(sheet); if (objs.length) break; } }
    else {
      const text = String(input || "").trim(); if (!text) return [];
      if (/^[\[{]/.test(text)) { let j = JSON.parse(text); if (!Array.isArray(j)) j = j.data || j.rows || j.items || Object.values(j).find(Array.isArray) || []; objs = j; }
      else {
        // plusieurs blocs possibles (collaborateurs puis périmètres) : on découpe à chaque nouvelle ligne d'en-tête
        const rows = csvRows(text); let block = [];
        const isHead = (r) => { const k = r.map(norm); return k.some((x) => K_CA.includes(x)) && k.some((x) => K_MOIS.includes(x)); };
        for (const r of rows) { if (isHead(r) && block.length) { objs.push(...tableToObjs(block)); block = []; } block.push(r); }
        objs.push(...tableToObjs(block));
      }
    }
    const pick = (o, names) => { for (const k of Object.keys(o)) if (names.includes(norm(k))) return o[k]; return undefined; };
    const people = Object.values(raw.collabs);
    const pers = Object.values(raw.perimetres);
    return objs.map((o, i) => {
      const r = { n: i + 1, ok: false };
      r.mois = parseMonth(pick(o, K_MOIS), String(ui.year));
      r.ca = typeof pick(o, K_CA) === "number" ? pick(o, K_CA) : numIn(pick(o, K_CA));
      r.eff = numIn(pick(o, ["effectif", "etp", "headcount"]));
      const pname = pick(o, ["perimetre", "bureau", "pole", "equipe"]);
      if (pname) {
        const p = pers.find((p) => norm(p.nom) === norm(pname) || p.id === pname);
        r.label = p ? p.nom : String(pname); r.perim = p && p.id;
        if (p) r.actuel = (((raw.mensuel[p.id] || {}).valeurs || {})[r.mois] || {}).ca ?? null;
        if (!p) r.err = "périmètre inconnu";
      } else {
        const id = pick(o, ["id", "identifiant", "id dashboard", "iddashboard", "consultant id"]);
        const full = pick(o, ["collaborateur", "consultant", "nom complet", "name"]);
        const pr = pick(o, ["prenom", "first name"]), nm = pick(o, ["nom", "last name"]);
        let c = id != null && id !== "" ? people.find((c) => String(c.idDashboard || "") === String(id)) : null;
        const key = norm(full || `${pr || ""} ${nm || ""}`);
        if (!c && key) c = people.find((c) => norm(`${c.prenom} ${c.nom}`) === key || norm(`${c.nom} ${c.prenom}`) === key);
        if (!c && key && !pr) c = people.find((c) => norm(c.nom) === key) || null;
        r.label = c ? `${c.prenom} ${c.nom}` : String(full || `${pr || ""} ${nm || ""}`.trim() || id || "?");
        r.collab = c && c.id;
        if (c) r.actuel = ((raw.ca[c.id] || {}).valeurs || {})[r.mois] ?? null;
        if (!c) r.err = "collaborateur inconnu";
      }
      if (!r.err && !r.mois) r.err = "mois illisible";
      if (!r.err && r.ca == null) r.err = "CA illisible";
      r.ok = !r.err;
      return r;
    });
  }
  function readExcel(file) {
    return new Promise((resolve, reject) => {
      if (typeof XLSX === "undefined") { reject(new Error("lib")); return; }
      const fr = new FileReader();
      fr.onerror = () => reject(fr.error);
      fr.onload = () => { try { const wb = XLSX.read(new Uint8Array(fr.result), { type: "array", cellDates: true }); resolve({ wb, sheets: wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null })) }); } catch (e) { reject(e); } };
      fr.readAsArrayBuffer(file);
    });
  }
  /* ---------- Reprise d'un fichier de commissions (format Excel « AAAA - AGENCE - Commissions MM.AAAA ») ---------- */
  const MOIS_SHEET = { janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12 };
  const isoDate = (v) => { if (v instanceof Date && !isNaN(v)) { const d = new Date(v.getTime() + 12 * 3600e3); return d.toISOString().slice(0, 10); } if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10); return null; };
  const cellNum = (v) => (typeof v === "number" ? v : numIn(v));
  function sheetRows(wb, name) { return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null }); }
  function isCommissionWorkbook(wb) { return wb.SheetNames.filter((n) => norm(n) in MOIS_SHEET).length >= 1 && wb.SheetNames.some((n) => { if (!(norm(n) in MOIS_SHEET)) return false; return sheetRows(wb, n).slice(0, 10).some((r) => r && r.map(norm).includes("prenom") && r.map(norm).includes("nom")); }); }
  function parseCommissionWorkbook(wb, fileName) {
    const ym = (y, m) => `${y}-${String(m).padStart(2, "0")}`;
    const yMatch = fileName.match(/(20\d{2})/); const year = yMatch ? Number(yMatch[1]) : ui.year;
    const agMatch = fileName.replace(/\.[^.]+$/, "").split(/\s+-\s+/).map((s) => s.trim()).find((s) => !/^\d{4}$/.test(s) && !/commission/i.test(s));
    const agenceNom = agMatch ? agMatch.charAt(0).toUpperCase() + agMatch.slice(1).toLowerCase() : "";
    const model = { _integ: {}, fileName, year, agenceNom, collabs: {}, ca: {}, lignes: {}, perimetres: [], mensuel: {}, recouvrement: {}, regs: [], warnings: [] };
    const months = wb.SheetNames.filter((n) => norm(n) in MOIS_SHEET).map((n) => ({ n, paie: ym(year, MOIS_SHEET[norm(n)]) })).sort((a, b) => a.paie.localeCompare(b.paie));
    const H = { nom: (k) => k === "nom", prenom: (k) => k === "prenom", poste: (k) => k === "poste", promo: (k) => k.startsWith("derniere promo"), type: (k) => k.startsWith("type de variable"), ca: (k) => /^ca /.test(k), G: (k) => k.startsWith("variable ca"), H: (k) => k.startsWith("variable manager") || k.startsWith("pourcentage pole"), I: (k) => k.startsWith("regularisation"), J: (k) => k.startsWith("total commission"), K: (k) => k.startsWith("prime de performance"), L: (k) => k.startsWith("bonus recouvrement"), M: (k) => k.startsWith("prime equipe"), N: (k) => k.startsWith("manager prime trimestrielle"), O: (k) => k.startsWith("manager prime semestrielle"), P: (k) => k.startsWith("manager prime annuelle"), division: (k) => k === "division", entree: (k) => k.startsWith("date d entree") };
    const postesConnus = Object.keys(S().baremes.postes);
    let lastSheet = null;
    for (const { n, paie } of months) {
      const rows = sheetRows(wb, n);
      const hi = rows.findIndex((r) => r && r.map(norm).includes("prenom") && r.map(norm).includes("nom"));
      if (hi < 0) continue;
      const keys = rows[hi].map(norm); const col = {};
      for (const [f, test] of Object.entries(H)) { const i = keys.findIndex((k) => k && test(k)); if (i >= 0) col[f] = i; }
      const caMonth = E.addM(paie, -1); const lignes = {};
      for (let r = hi + 1; r < rows.length; r++) {
        const row = rows[r] || []; const first = norm(row[0]);
        if (first === "fin" || first.startsWith("suivi du retrait") || first === "debut2") break;
        const nom = row[col.nom], prenom = row[col.prenom];
        if (!nom || !prenom || typeof nom !== "string" || typeof prenom !== "string") continue;
        const id = slug(`${prenom}-${nom}`);
        const c = (model.collabs[id] ||= { id, nom: nom.trim(), prenom: prenom.trim(), postes: [], division: null, entree: null, pole: null, idDashboard: null, sortie: null });
        let poste = col.poste != null && row[col.poste] ? String(row[col.poste]).trim() : null;
        const horsComm = !poste && col.M != null && String(row[col.M] ?? "").trim() === "/";
        if (poste && !postesConnus.includes(poste)) { const base = postesConnus.find((x) => norm(x) === norm(poste) || norm(x) === norm(poste.replace(/\s+\d+$/, ""))); if (base) poste = base; }
        if (horsComm) { poste = "Chargé de recrutement interne"; model.warnings.push(`${prenom} ${nom} : sans poste et marqué « / » en prime d'équipe, importé comme non commissionné (Chargé de recrutement interne).`); }
        if (poste && (!c.postes.length || c.postes.at(-1).poste !== poste)) c.postes.push({ depuis: caMonth, poste });
        if (poste && !postesConnus.includes(poste)) model.warnings.push(`Poste « ${poste} » (${prenom} ${nom}) absent des barèmes : ajoutez-le dans l'onglet Barèmes.`);
        if (col.division != null && row[col.division]) c.division = String(row[col.division]);
        const ent = col.entree != null ? isoDate(row[col.entree]) : null; if (ent) c.entree = ent;
        const pr = col.promo != null ? isoDate(row[col.promo]) : null; if (pr) c.dernierePromo = pr;
        const ca = col.ca != null ? cellNum(row[col.ca]) : null;
        if (ca != null) (model.ca[id] ||= {})[caMonth] = ca;
        const v = (f) => (col[f] != null ? cellNum(row[col[f]]) || 0 : 0);
        const G = v("G"), I = v("I"), J = col.J != null && cellNum(row[col.J]) != null ? cellNum(row[col.J]) : G + v("H") + I;
        lignes[id] = { poste, type: col.type != null ? row[col.type] || null : null, ca, G, H: E.r2(J - G - I), I, K: v("K"), L: v("L"), M: v("M"), N: v("N"), O: v("O"), P: v("P"), note: "" };
      }
      if (Object.keys(lignes).length) { model.lignes[paie] = lignes; lastSheet = { n, rows, hi }; }
    }
    // même personne écrite différemment selon les mois (nom d'usage, faute de frappe) : fusion
    model._alias = {};
    const presence = (id) => Object.keys(model.lignes).filter((p) => model.lignes[p][id]).sort();
    const proche = (x, y) => { x = norm(x); y = norm(y); if (x === y) return true; if (Math.abs(x.length - y.length) > 1) return false; let d = 0; for (let i = 0, j = 0; i < x.length || j < y.length; ) { if (x[i] === y[j]) { i++; j++; continue; } if (++d > 1) return false; if (x.length > y.length) i++; else if (y.length > x.length) j++; else { i++; j++; } } return true; };
    const ids = Object.keys(model.collabs);
    for (const a1 of ids) for (const b1 of ids) {
      const A = model.collabs[a1], B = model.collabs[b1];
      if (!A || !B || a1 === b1) continue;
      const pa = presence(a1), pb = presence(b1);
      if (!pa.length || !pb.length || pa.at(-1) >= pb[0]) continue;
      const na = norm(A.nom), nb = norm(B.nom);
      if (!(proche(A.prenom, B.prenom) && (na === nb || nb.startsWith(na + " ") || na.startsWith(nb + " ") || proche(na, nb)))) continue;
      // A (ancien) fusionné dans B (nom actuel)
      B.postes = [...A.postes, ...B.postes].filter((p, i, arr) => i === 0 || p.poste !== arr[i - 1].poste);
      B.entree = [A.entree, B.entree].filter(Boolean).sort()[0] || null;
      B.division = B.division || A.division; if (!B.dernierePromo && A.dernierePromo) B.dernierePromo = A.dernierePromo;
      model.ca[b1] = { ...(model.ca[a1] || {}), ...(model.ca[b1] || {}) }; delete model.ca[a1];
      for (const p of pa) { model.lignes[p][b1] = model.lignes[p][a1]; delete model.lignes[p][a1]; }
      model._alias[norm(`${A.prenom} ${A.nom}`)] = b1; model._alias[norm(`${A.nom} ${A.prenom}`)] = b1;
      if (A._mdp && !B._mdp) B._mdp = A._mdp;
      delete model.collabs[a1];
      model.warnings.push(`${A.prenom} ${A.nom} et ${B.prenom} ${B.nom} : même personne (mois successifs), fusionnés sous « ${B.prenom} ${B.nom} ».`);
    }
    for (const c of Object.values(model.collabs)) if (!c.postes.length) { c.postes.push({ depuis: months.length ? E.addM(months[0].paie, -1) : `${year}-01`, poste: "Consultant Junior 1" }); model.warnings.push(`${c.prenom} ${c.nom} : aucun poste dans le fichier, « Consultant Junior 1 » par défaut.`); }
    // départs : présent dans un mois mais plus dans le dernier
    const paies = Object.keys(model.lignes).sort(); model.dernierePaie = paies.at(-1) || null;
    for (const c of Object.values(model.collabs)) { const last = paies.filter((p) => model.lignes[p][c.id]).at(-1); if (last && last < model.dernierePaie) { const m = E.addM(last, -1); c.sortie = `${m}-${String(new Date(Number(m.slice(0, 4)), Number(m.slice(5)), 0).getDate()).padStart(2, "0")}`; } }
    const byName = (s) => Object.values(model.collabs).find((c) => norm(`${c.prenom} ${c.nom}`) === norm(s) || norm(`${c.nom} ${c.prenom}`) === norm(s)) || model.collabs[model._alias[norm(s)]];
    const grid = (name) => { const rows = sheetRows(wb, name); const out = {}; for (const r of rows) { const m = r && norm(r[0]) in MOIS_SHEET ? MOIS_SHEET[norm(r[0])] : null; if (!m) continue; const ca = cellNum(r[1]), eff = cellNum(r[2]), retr = cellNum(r[6]); if (ca == null && eff == null) continue; out[ym(year, m)] = { ca, effectif: eff, ...(retr ? { retraitement: retr } : {}), source: "fichier de commissions" }; }
      const t = (rows[5] || []).slice(15, 20).map(cellNum); const def = S().baremes.perimetre.taux;
      const taux = t.length === def.length && t.every((x) => x != null) && t.some((x, i) => Math.abs(x - def[i]) > 1e-9) ? t : null;
      return { rows, out, taux }; };
    for (const name of wb.SheetNames) {
      const k = norm(name);
      if (k.startsWith("bareme commissions manager")) {
        const { out, taux } = grid(name);
        if (!Object.keys(out).length) { model.warnings.push("Onglet manager vide : pas de variable ni de primes de manager de bureau calculés pour ce cabinet."); continue; }
        if (taux) model.warnings.push(`Bureau : taux propres à ce cabinet repris du fichier (${taux.map((x) => pct(x)).join(" / ")}).`);
        const resp = Object.values(model.collabs).find((c) => /manager de cabinet|business unit|directeur/i.test(c.postes.at(-1).poste)) || null;
        if (!resp) model.warnings.push("Bureau : aucun manager de cabinet trouvé, choisissez le responsable dans Équipes après l'import.");
        model.perimetres.push({ kind: "bureau", nom: `Bureau ${model.agenceNom || ""}`.trim(), responsable: resp && resp.id, depuis: Object.keys(out).sort()[0] || `${year}-01`, mensuel: out, ...(taux ? { taux } : {}) });
      } else if (k.startsWith("bareme commissions mdp")) {
        const { rows, out, taux } = grid(name);
        const who = (rows[0] || []).slice(5).find((v) => typeof v === "string" && /[a-z]/i.test(v) && !/manager|pole|team/i.test(v));
        const resp = who ? byName(who) : null;
        if (!Object.keys(out).length) { if (resp || who) model.warnings.push(`${name} vide : pas de variable de manager de pôle calculé${who ? ` pour ${who}` : ""}.`); continue; }
        if (!resp) { model.warnings.push(`${name} ignoré : son responsable « ${who || "?"} » ne fait pas partie des collaborateurs de ce fichier.`); continue; }
        model.perimetres.push({ kind: "pole", nom: `Pôle ${resp ? resp.prenom.charAt(0) + ". " + resp.nom.charAt(0) + resp.nom.slice(1).toLowerCase() : who || name}`, responsable: resp && resp.id, depuis: Object.keys(out).sort()[0] || `${year}-01`, mensuel: out, nomResp: who, ...(taux ? { taux } : {}) });
      } else if (k.startsWith("bonus recouvrement")) {
        for (const r of sheetRows(wb, name)) { const d = r && isoDate(r[5]); const nb = r && cellNum(r[2]); if (d && nb != null) model.recouvrement[d.slice(0, 7)] = { reglees: nb, conditionsOk: true }; }
      } else if (k.startsWith("effectifs mdp")) {
        for (const r of sheetRows(wb, name).slice(1)) { if (!r || !r[0] || !r[1] || !r[2]) continue; const m = byName(`${r[1]} ${r[2]}`); const integ = isoDate(r[7]); if (integ) { const k2 = norm(String(r[0])); if (!model._integ[k2] || integ < model._integ[k2]) model._integ[k2] = integ; } if (m) { m._mdp = String(r[0]); const de = isoDate(r[5]); if (de) m._entreeMdp = de; } }
      }
    }
    for (const c of Object.values(model.collabs)) {
      const mois = Object.entries(model.ca[c.id] || {}).filter(([, v]) => v).map(([m]) => m).sort();
      if (c.entree && mois.length && mois[0] < c.entree.slice(0, 7)) {
        const alt = c._entreeMdp && c._entreeMdp < c.entree ? c._entreeMdp : `${mois[0]}-01`;
        model.warnings.push(`${c.prenom} ${c.nom} : date d'entrée du fichier (${new Date(c.entree).toLocaleDateString("fr-FR")}) postérieure à son premier CA (${shortM(mois[0])}) ; ${new Date(alt).toLocaleDateString("fr-FR")} retenue.`);
        c.entree = alt;
      }
    }
    const dernierCa = Object.values(model.ca).flatMap((v) => Object.keys(v)).sort().at(-1);
    for (const p of model.perimetres) { const last = Object.keys(p.mensuel).sort().at(-1); if (last && dernierCa && last < dernierCa) { p.fin = last; model.warnings.push(`${p.nom} : aucun chiffre après ${shortM(last)} dans le fichier, considéré comme terminé à cette date.`); } }
    for (const p of model.perimetres) if (p.kind === "pole") { const resp = p.responsable && model.collabs[p.responsable]; const d = resp && model._integ[norm(`${resp.prenom} ${resp.nom}`)]; if (d && d.slice(0, 7) < p.depuis) p.priseDePoste = d.slice(0, 7); }
    for (const p of model.perimetres) if (p.kind === "pole") { const resp = p.responsable && model.collabs[p.responsable]; for (const c of Object.values(model.collabs)) if (c._mdp && resp && norm(c._mdp) === norm(`${resp.prenom} ${resp.nom}`)) c._pole = p; }
    // tableau de suivi des retraits (dernier onglet)
    if (lastSheet) {
      const { rows } = lastSheet; const hi = rows.findIndex((r) => r && norm(r[0]) === "prenom nom");
      if (hi >= 0) for (const r of rows.slice(hi + 1)) {
        if (!r || !r[0] || norm(r[0]) === "fin2") continue;
        const c = byName(String(r[0])); const comm = cellNum(r[6]), deja = cellNum(r[7]), reste = cellNum(r[8]);
        const per = r[2] instanceof Date ? isoDate(r[2]).slice(0, 7) : parseMonth(r[2], String(year));
        const typ = /rempla/i.test(r[3]) ? "REMPLA" : /litige/i.test(r[3]) ? "LITIGE" : "AVOIR";
        model.regs.push({ collab: c ? c.id : null, qui: String(r[0]), periode: per, type: typ, montantInitial: cellNum(r[4]), montantAvoir: cellNum(r[5]), commission: comm ?? deja ?? null, mouvements: [], statut: reste ? "en cours" : comm == null && deja == null ? "à chiffrer" : "soldée", note: [r[9] ? String(r[9]) : "", deja ? `Déjà retiré : ${nf2.format(deja)} €` : ""].filter(Boolean).join(" · ") });
      }
    }
    model.nbCa = Object.values(model.ca).reduce((s, v) => s + Object.keys(v).length, 0);
    return model;
  }
  function viewCommImport() {
    const m = ui.commImport; if (!m) return "";
    const ags = agences();
    const target = m.agenceId || "__new";
    const existing = target !== "__new" ? collabsOf(target).map((c) => c.id) : [];
    const nNew = Object.keys(m.collabs).filter((id) => !existing.includes(id)).length;
    const paies = Object.keys(m.lignes).sort();
    return `<div class="panel" style="margin-top:20px"><div class="toolbar"><div class="grow"><h3>Reprise du fichier de commissions</h3><span class="muted">${esc(m.fileName)}</span></div></div>
      <div class="form">
        <label>Cabinet de destination<select id="ci-ag" data-ci="agenceId"><option value="__new" ${target === "__new" ? "selected" : ""}>Nouveau cabinet…</option>${ags.map((a) => `<option value="${esc(a.id)}" ${a.id === target ? "selected" : ""}>${esc(a.nom || a.id)}</option>`).join("")}</select></label>
        ${target === "__new" ? `<label>Nom du nouveau cabinet<input id="ci-nom" type="text" data-ci="agenceNom" value="${esc(m.agenceNom)}"></label>` : ""}
        <label>Année du fichier<input id="ci-year" type="number" data-ci="year" value="${m.year}" disabled></label>
      </div>
      <table class="data" style="margin-top:14px;max-width:640px"><tbody>
        <tr><td>Collaborateurs</td><td class="r num">${Object.keys(m.collabs).length}</td><td class="muted">${nNew} nouveau(x), ${Object.keys(m.collabs).length - nNew} mis à jour</td></tr>
        <tr><td>Valeurs de CA mensuel</td><td class="r num">${m.nbCa}</td><td class="muted">${paies.length ? `de ${esc(shortM(E.addM(paies[0], -1)))} à ${esc(shortM(E.addM(paies.at(-1), -1)))}` : ""}</td></tr>
        <tr><td>Bureaux et pôles</td><td class="r num">${m.perimetres.length}</td><td class="muted">${esc(m.perimetres.map((p) => p.nom).join(", "))}</td></tr>
        <tr><td>Mois de paie repris</td><td class="r num">${paies.length}</td><td class="muted">${esc(paies.map(shortM).join(", "))}</td></tr>
        <tr><td>Régularisations suivies</td><td class="r num">${m.regs.length}</td><td></td></tr>
        <tr><td>Mois de recouvrement</td><td class="r num">${Object.keys(m.recouvrement).length}</td><td></td></tr>
      </tbody></table>
      <div class="stack" style="gap:6px;margin-top:12px">
        <label class="check"><input type="checkbox" id="ci-close" data-ci="closePast" ${m.closePast !== false ? "checked" : ""}> Clôturer les mois passés avec les montants versés du fichier</label>
        <label class="check"><input type="checkbox" id="ci-last" data-ci="closeLast" ${m.closeLast ? "checked" : ""}> Clôturer aussi ${paies.length ? esc(labelM(paies.at(-1), false)) : "le dernier mois"} (sinon il est recalculé par l'outil)</label>
      </div>
      ${m.warnings.length ? `<div class="callout" style="margin-top:12px">${[...new Set(m.warnings)].map(esc).join("<br>")}</div>` : ""}
      <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn ghost" data-action="ci-cancel">Annuler</button><button class="btn primary" data-action="ci-apply">Importer dans l'outil</button></div></div>`;
  }
  async function applyCommImport() {
    const m = ui.commImport; let ag = m.agenceId && m.agenceId !== "__new" ? m.agenceId : null;
    if (!ag) { const nom = (m.agenceNom || "").trim(); if (!nom) { toast("Donnez un nom au nouveau cabinet."); return; } ag = slug(nom); if (!raw.agences[ag] && !(await put(`agences/${ag}`, { nom }))) return; }
    toast("Import en cours…"); muteLog++;
    const idMap = {};
    for (const c of Object.values(m.collabs)) { let id = c.id; const ex = raw.collabs[id]; if (ex && ex.agence !== ag) id = `${id}-${ag}`; idMap[c.id] = id; }
    const perimIds = [];
    for (const p of m.perimetres) {
      const id = (p.kind === "bureau" ? `bureau-${ag}` : `pole-${slug(p.nomResp || p.nom)}`);
      perimIds.push(id);
      await put(`perimetres/${id}`, { id, kind: p.kind, agence: ag, nom: p.nom, responsable: p.responsable ? idMap[p.responsable] : null, depuis: p.depuis, ...(p.taux ? { taux: p.taux } : {}), ...(p.priseDePoste ? { priseDePoste: p.priseDePoste } : {}), ...(p.fin ? { fin: p.fin } : {}) });
      if (Object.keys(p.mensuel).length) await merge(`mensuel/${id}`, { perimetre: id, valeurs: p.mensuel });
      p._id = id;
    }
    for (const c of Object.values(m.collabs)) {
      const id = idMap[c.id]; const ex = raw.collabs[id] || {};
      const doc = { ...ex, id, nom: c.nom, prenom: c.prenom, agence: ag, division: c.division || ex.division || null, entree: c.entree || ex.entree || null, sortie: c.sortie || null, postes: c.postes, pole: c._pole ? c._pole._id : ex.pole || null, idDashboard: ex.idDashboard || null };
      if (c.dernierePromo) doc.dernierePromo = c.dernierePromo;
      await put(`collabs/${id}`, doc);
      if (m.ca[c.id]) await merge(`ca/${id}`, { collab: id, valeurs: m.ca[c.id], sources: Object.fromEntries(Object.keys(m.ca[c.id]).map((k) => [k, "fichier de commissions"])) });
    }
    const periodes = {};
    for (const [p, ls] of Object.entries(m.lignes)) { const cm = E.addM(p, -1); const mo = Number(cm.slice(5)); if (mo % 3 === 0 && Object.values(ls).some((l) => l.M > 0)) periodes[`${cm.slice(0, 4)}-T${mo / 3}`] = { atteint: true }; }
    if (Object.keys(periodes).length) await merge(`objectifs/${ag}`, { agence: ag, periodes });
    if (Object.keys(m.recouvrement).length) await merge(`agenceMois/${ag}`, { agence: ag, valeurs: m.recouvrement });
    for (const [i, r] of m.regs.entries()) await put(`regs/imp-${ag}-${m.year}-${i}`, { ...r, id: `imp-${ag}-${m.year}-${i}`, collab: r.collab ? idMap[r.collab] : null });
    const paies = Object.keys(m.lignes).sort();
    for (const p of paies) {
      const isLast = p === paies.at(-1);
      if (isLast ? !m.closeLast : m.closePast === false) continue;
      const lignes = Object.fromEntries(Object.entries(m.lignes[p]).map(([k, v]) => [idMap[k], v]));
      await put(`clotures/${ag}_${p}`, { agence: ag, paie: p, at: new Date().toISOString(), source: `reprise de ${m.fileName}`, lignes });
    }
    if (!m.closeLast && paies.length) { const last = paies.at(-1); for (const [k, v] of Object.entries(m.lignes[last])) if (v.I) await merge(`ajust/${idMap[k]}_${last}`, { collab: idMap[k], paie: last, I: v.I, note: "Régularisation reprise du fichier" }); }
    muteLog--; journalAdd({ agence: ag, action: "Import", texte: `Reprise du fichier ${m.fileName} — ${Object.keys(m.collabs).length} collaborateurs, ${m.nbCa} valeurs de CA, ${Object.keys(m.lignes).length} mois de paie` });
    ui.agence = ag; ui.commImport = null; saveUi();
    if (paies.length) { ui.paie = m.closeLast ? E.addM(paies.at(-1), 1) : paies.at(-1); ui.year = pm(E.addM(ui.paie, -1)).y; }
    ui.tab = "paie"; toast(`Fichier importé dans le cabinet ${(raw.agences[ag] || {}).nom || m.agenceNom}`); render();
  }

  async function applyImport() {
    const rows = (ui.importRows || []).filter((r) => r.ok);
    const byCollab = {}, byPerim = {};
    for (const r of rows) {
      if (r.collab) (byCollab[r.collab] ||= {})[r.mois] = r.ca;
      if (r.perim) (byPerim[r.perim] ||= {})[r.mois] = { ca: r.ca, ...(r.eff != null ? { effectif: r.eff } : {}), source: "import dashboard" };
    }
    let n = 0; muteLog++;
    for (const [cid, vals] of Object.entries(byCollab)) if (await merge(`ca/${cid}`, { collab: cid, valeurs: vals, sources: Object.fromEntries(Object.keys(vals).map((m) => [m, "import dashboard"])) })) n += Object.keys(vals).length;
    for (const [pid, vals] of Object.entries(byPerim)) if (await merge(`mensuel/${pid}`, { perimetre: pid, valeurs: vals })) n += Object.keys(vals).length;
    muteLog--; journalAdd({ agence: ui.agence, action: "Import", texte: `Import de CA${ui.importFile ? ` (${ui.importFile})` : ""} — ${n} valeur(s) : ${rows.slice(0, 6).map((r) => `${r.label} ${shortM(r.mois)} ${nf0.format(r.ca)}`).join(", ")}${rows.length > 6 ? " …" : ""}` });
    toast(`${n} valeur(s) importée(s)`);
    ui.importRows = null; ui.importText = ""; ui.importFile = null; render();
  }

  /* ---------- événements ---------- */
  document.addEventListener("click", async (ev) => {
    const t = ev.target.closest("[data-tri],[data-goag],[data-tab],[data-sel],[data-close],[data-action],[data-year],[data-regf],[data-reg],[data-collab],[data-perim],[data-mvdel],[data-psdel],[data-ovclear]");
    if (!t) return;
    const d = t.dataset;
    if (d.tri) { ui.syntheseTri = d.tri; render(); return; }
    if (d.goag) { ui.agence = d.goag; ui.tab = "paie"; ui.sel = null; saveUi(); render(); return; }
    if (d.tab) { ui.tab = d.tab; ui.sel = null; saveUi(); render(); return; }
    if (d.close) { ui.sel = null; $("#overlay").innerHTML = ""; render(); return; }
    if (d.sel) { ui.sel = d.sel; render(); return; }
    if (d.year) { ui.year += Number(d.year); render(); return; }
    if (d.regf) { ui.regFilter = d.regf; render(); return; }
    if (d.reg) { ui.regEdit = clone(raw.regs[d.reg]); render(); return; }
    if (d.collab) { ui.collabEdit = clone(raw.collabs[d.collab]); render(); return; }
    if (d.perim) { ui.perimEdit = clone(raw.perimetres[d.perim]); render(); return; }
    if (d.mvdel != null && ui.regEdit) { ui.regEdit.mouvements.splice(Number(d.mvdel), 1); render(); return; }
    if (d.psdel != null && ui.collabEdit) { ui.collabEdit.postes.splice(Number(d.psdel), 1); render(); return; }
    if (d.ovclear) { await merge(`ajust/${ui.sel}_${ui.paie}`, { [d.ovclear]: null }); return; }
    const a = d.action;
    if (a === "export") exportCsv();
    if (a === "promo-acter") acterPromo(t.dataset.cid);
    if (a === "close") closeMonth();
    if (a === "reopen") confirmBox(`Rouvrir la paie de ${labelM(ui.paie, false)} ?`, "Les montants seront recalculés avec les données et barèmes actuels. Les ajustements manuels sont conservés.", "Rouvrir", async () => { if (await del(`clotures/${ui.agence}_${ui.paie}`)) toast("Mois rouvert"); }, true);
    if (a === "reg-new") { const c = collabsOf(ui.agence)[0]; ui.regEdit = { id: "r" + Date.now().toString(36), collab: c ? c.id : null, periode: E.addM(ui.paie, -1), type: "LITIGE", statut: "à chiffrer", mouvements: [], note: "" }; render(); }
    if (a === "reg-cancel") { ui.regEdit = null; render(); }
    if (a === "reg-calc") {
      const r = ui.regEdit, c = raw.collabs[r.collab];
      const ca = ((raw.ca[r.collab] || {}).valeurs || {})[r.periode];
      if (!c || ca == null || !r.montantAvoir) { toast("Renseignez le collaborateur, le mois du placement (avec un CA connu) et le montant de l'avoir."); return; }
      const { type } = E.typeAt(S(), c, r.periode); const B = S().baremes;
      r.commission = E.r2(E.varConsultant(Math.max(0, ca - r.montantAvoir), type, B).total - E.varConsultant(ca, type, B).total);
      render(); toast(`Variable sur ${nf0.format(ca)} € moins variable sur ${nf0.format(ca - r.montantAvoir)} € (${type})`);
    }
    if (a === "mv-retrait" || a === "mv-reverse") {
      const r = ui.regEdit; r.mouvements ||= [];
      const reste = (r.commission || 0) - regRetire(r);
      const montant = a === "mv-retrait" ? E.r2(Math.min(0, reste)) : E.r2(-regRetire(r) - regReverse(r));
      r.mouvements.push({ paie: ui.paie, montant }); if (a === "mv-reverse") r.statut = "reversée"; else if (r.statut === "à chiffrer") r.statut = "en cours"; render();
    }
    if (a === "reg-save") { const r = ui.regEdit; if (!r.collab) { toast("Choisissez un collaborateur."); return; } if (await put(`regs/${r.id}`, r)) { toast("Régularisation enregistrée"); ui.regEdit = null; } }
    if (a === "reg-del") confirmBox("Supprimer cette régularisation ?", "Ses retraits et reversements disparaîtront des paies non clôturées.", "Supprimer", async () => { if (await del(`regs/${ui.regEdit.id}`)) { ui.regEdit = null; toast("Supprimée"); } }, true);
    if (a === "collab-new") { ui.collabEdit = { id: null, prenom: "", nom: "", agence: ui.agence, postes: [{ depuis: E.addM(ui.paie, -1), poste: "Consultant Junior 1" }], pole: null }; render(); }
    if (a === "collab-cancel") { ui.collabEdit = null; render(); }
    if (a === "ps-add") { ui.collabEdit.postes.push({ depuis: E.addM(ui.paie, -1), poste: (ui.collabEdit.postes.at(-1) || {}).poste || "Consultant Junior 1" }); render(); }
    if (a === "collab-save") {
      const c = ui.collabEdit; if (!c.nom || !c.prenom) { toast("Renseignez le prénom et le nom."); return; }
      if (!c.id) { let id = slug(`${c.prenom}-${c.nom}`), i = 2; while (raw.collabs[id]) id = slug(`${c.prenom}-${c.nom}`) + "-" + i++; c.id = id; }
      c.postes = (c.postes || []).filter((p) => p.depuis && p.poste).sort((a, b) => a.depuis.localeCompare(b.depuis));
      if (await put(`collabs/${c.id}`, c)) { toast("Collaborateur enregistré"); ui.collabEdit = null; }
    }
    if (a === "collab-del") confirmBox(`Supprimer ${ui.collabEdit.prenom} ${ui.collabEdit.nom} ?`, "Pour un départ, renseignez plutôt la date de sortie : l'historique reste ainsi disponible.", "Supprimer", async () => { if (await del(`collabs/${ui.collabEdit.id}`)) { ui.collabEdit = null; toast("Supprimé"); } }, true);
    if (a === "perim-new") { const c = collabsOf(ui.agence)[0]; ui.perimEdit = { id: null, nom: "", kind: "pole", agence: ui.agence, responsable: c ? c.id : null, depuis: E.addM(ui.paie, -1) }; render(); }
    if (a === "perim-cancel") { ui.perimEdit = null; render(); }
    if (a === "perim-save") { const p = ui.perimEdit; if (!p.nom) { toast("Donnez un nom au périmètre."); return; } if (!p.id) { let id = (p.kind === "bureau" ? "bureau-" : "pole-") + slug(p.nom), i = 2; while (raw.perimetres[id]) id += "-" + i++; p.id = id; } if (await put(`perimetres/${p.id}`, p)) { toast("Périmètre enregistré"); ui.perimEdit = null; } }
    if (a === "perim-del") confirmBox(`Supprimer ${ui.perimEdit.nom} ?`, "Le variable et les primes de son responsable ne seront plus calculés sur ce périmètre.", "Supprimer", async () => { if (await del(`perimetres/${ui.perimEdit.id}`)) { ui.perimEdit = null; toast("Supprimé"); } }, true);
    if (a === "ag-add") { const n = $("#ag-new").value.trim(); if (!n) return; let id = slug(n); if (raw.agences[id]) { toast("Ce cabinet existe déjà."); return; } if (await put(`agences/${id}`, { nom: n })) { ui.agence = id; saveUi(); toast("Cabinet créé"); } }
    if (a === "bar-save") { if (await put("settings/baremes", { data: ui.draftBaremes, at: new Date().toISOString() })) { toast("Barèmes enregistrés"); ui.draftBaremes = null; } }
    if (a === "bar-reset") confirmBox("Rétablir les barèmes d'origine ?", "Les modifications non enregistrées sont perdues. Enregistrez ensuite pour les appliquer.", "Rétablir", async () => { ui.draftBaremes = clone(E.DEFAULT_BAREMES); render(); });
    if (a === "imp-preview") { ui.importText = $("#imp-text").value; try { ui.importRows = parseImport(ui.importText); if (!ui.importRows.length) toast("Aucune ligne reconnue : vérifiez les en-têtes (mois, ca…)."); } catch (e) { toast("Contenu illisible : CSV ou JSON attendu."); ui.importRows = null; } render(); }
    if (a === "imp-apply") applyImport();
    if (a === "ci-apply") applyCommImport();
    if (a === "ci-cancel") { ui.commImport = null; ui.importFile = null; render(); }
    if (a === "imp-clear") { ui.importRows = null; ui.importText = ""; ui.importFile = null; render(); }
  });

  document.addEventListener("change", async (ev) => {
    const t = ev.target, d = t.dataset;
    if (t.id === "jr-f") { ui.journalFiltre = t.value; render(); return; }
    if (t.id === "jr-a") { ui.journalAction = t.value || null; render(); return; }
    if (t.id === "agence-sel") { ui.agence = t.value; ui.sel = null; ui.regEdit = ui.collabEdit = ui.perimEdit = null; saveUi(); render(); return; }
    if (t.id === "imp-file" && t.files[0]) {
      const f = t.files[0];
      if (/\.(xlsx|xlsm|xlsb|xls|ods)$/i.test(f.name)) {
        try { const { wb, sheets } = await readExcel(f); ui.importText = ""; ui.importFile = f.name; if (isCommissionWorkbook(wb)) { const mdl = parseCommissionWorkbook(wb, f.name); const ex = agences().find((a) => norm(a.nom || a.id) === norm(mdl.agenceNom)); mdl.agenceId = ex ? ex.id : "__new"; mdl.closePast = true; mdl.closeLast = false; ui.commImport = mdl; ui.importRows = null; render(); return; } ui.importRows = parseImport(sheets); if (!ui.importRows.length) toast("Aucun tableau de CA reconnu dans ce classeur : il faut une colonne de noms et des colonnes de mois, ou des colonnes Mois et CA."); }
        catch (e) { toast(e && e.message === "lib" ? "Lecture Excel indisponible (bibliothèque non chargée). Rechargez la page." : "Classeur illisible. Enregistrez-le en .xlsx ou .csv et réessayez."); }
        render(); return;
      }
      const fr = new FileReader(); fr.onload = () => { ui.importText = String(fr.result); ui.importFile = f.name; try { ui.importRows = parseImport(ui.importText); if (!ui.importRows.length) toast("Aucune ligne reconnue : vérifiez les en-têtes (mois, ca…)."); } catch (e) { toast("Fichier illisible : Excel, CSV ou JSON attendu."); } render(); }; fr.readAsText(f); return;
    }
    if (d.ci && ui.commImport) { ui.commImport[d.ci] = t.type === "checkbox" ? t.checked : t.value; if (d.ci === "agenceId") render(); return; }
    if (d.promo) { await merge(`promos/${d.promo}`, { collab: d.promo, [d.pf]: d.pf === "impayes" ? numIn(t.value) : t.value }); return; }
    if (d.ca) { const v = numIn(t.value); await merge(`ca/${d.ca}`, { collab: d.ca, valeurs: { [d.m]: v }, sources: { [d.m]: v == null ? null : "saisie" } }); return; }
    if (d.pm) { const v = numIn(t.value); await merge(`mensuel/${d.pm}`, { perimetre: d.pm, valeurs: { [d.m]: { [d.f]: v, ...(d.f === "ca" ? { source: v == null ? null : "saisie" } : {}) } } }); return; }
    if (d.ov) { const v = numIn(t.value); await merge(`ajust/${ui.sel}_${ui.paie}`, { collab: ui.sel, paie: ui.paie, [d.ov]: v }); return; }
    if (d.ovnote) { await merge(`ajust/${ui.sel}_${ui.paie}`, { collab: ui.sel, paie: ui.paie, note: t.value }); return; }
    if (d.obj) { let v; if (d.objf === "atteint") v = t.value === "" ? null : t.value === "1"; else v = numIn(t.value); await merge(`objectifs/${ui.agence}`, { agence: ui.agence, periodes: { [d.obj]: { [d.objf]: v } } }); return; }
    if (d.rec) { const v = d.recf === "conditionsOk" ? t.checked : numIn(t.value); await merge(`agenceMois/${ui.agence}`, { agence: ui.agence, valeurs: { [d.rec]: { [d.recf]: v } } }); return; }
    if (d.rg && ui.regEdit) { ui.regEdit[d.rg] = ["montantInitial", "montantAvoir", "commission"].includes(d.rg) ? numIn(t.value) : t.value; return; }
    if (d.mv != null && ui.regEdit) { ui.regEdit.mouvements[Number(d.mv)][d.mvf] = d.mvf === "montant" ? numIn(t.value) : t.value; return; }
    if (d.cf && ui.collabEdit) { ui.collabEdit[d.cf] = t.value || null; if (d.cf === "agence") render(); return; }
    if (d.ps != null && ui.collabEdit) { ui.collabEdit.postes[Number(d.ps)][d.psf] = t.value; return; }
    if (d.pf && ui.perimEdit) { ui.perimEdit[d.pf] = t.value || null; return; }
    if (d.bpath && ui.draftBaremes) {
      let v;
      if (t.type === "checkbox") v = d.binv ? !t.checked : t.checked;
      else if (t.tagName === "SELECT") v = t.value || null;
      else { v = numIn(t.value); if (v != null && d.bpct) v = Math.round(v * 1000) / 100000; }
      setPath(ui.draftBaremes, d.bpath, v); return;
    }
  });
  $("#prev-m").onclick = () => { ui.paie = E.addM(ui.paie, -1); ui.year = pm(E.addM(ui.paie, -1)).y; ui.sel = null; render(); };
  $("#next-m").onclick = () => { ui.paie = E.addM(ui.paie, 1); ui.year = pm(E.addM(ui.paie, -1)).y; ui.sel = null; render(); };
  document.addEventListener("toggle", (e) => { if (e.target.matches && e.target.matches("details[data-alerts]")) ui.alertsOpen = e.target.open; }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if ($(".confirm")) $("#overlay").innerHTML = ""; else if (ui.sel) { ui.sel = null; render(); } } });

  /* ---------- démarrage ---------- */
  ui.year = pm(E.addM(ui.paie, -1)).y;
  render();
  (async () => {
    try { db = await Platform.use("db"); } catch (e) { db = null; }
    if (!db) { dbState = "absent"; render(); return; }
    dbState = "ok";
    try { userCap = await Platform.use("user"); if (userCap) myId = await userCap.id(); } catch (e) { userCap = null; }
    db.collection("journal").orderBy("at", "desc").limit(500).onSnapshot((snap) => {
      journal = snap.docs.map((d) => ({ id: d.id, ...d.data() })); journalLoaded = true; loadProfils(); if (ui.tab === "journal") scheduleRender();
    }, () => { journalLoaded = true; });
    for (const col of COLS) {
      db.collection(col).onSnapshot((snap) => {
        raw[col] = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
        loaded.add(col); scheduleRender();
      }, (e) => { loaded.add(col); toast("Connexion à la base interrompue : rechargez la page."); scheduleRender(); });
    }
  })();
})();
