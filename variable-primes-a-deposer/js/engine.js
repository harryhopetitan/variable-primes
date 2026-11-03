/* Moteur de calcul des variables & primes — Harry Hope.
   Fonctions pures : (état, agence, mois de paie) -> lignes de paie détaillées. */
const Engine = (() => {
  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const ym = (y, m) => `${y}-${String(m).padStart(2, "0")}`;
  const parse = (s) => { const [y, m] = s.split("-").map(Number); return { y, m }; };
  const addM = (s, n) => { const { y, m } = parse(s); const t = y * 12 + (m - 1) + n; return ym(Math.floor(t / 12), (t % 12) + 1); };
  const qOf = (s) => { const { y, m } = parse(s); return { y, q: Math.ceil(m / 3) }; };
  const qMonths = (y, q) => [1, 2, 3].map((i) => ym(y, (q - 1) * 3 + i));
  const sMonths = (y, s) => [1, 2, 3, 4, 5, 6].map((i) => ym(y, (s - 1) * 6 + i));
  const yMonths = (y) => Array.from({ length: 12 }, (_, i) => ym(y, i + 1));
  const moisEntre = (a, b) => { const x = parse(a), y = parse(b); return (y.y - x.y) * 12 + (y.m - x.m) + 1; };
  const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);

  const DEFAULT_BAREMES = {
    version: 1,
    consultant: {
      bornes: [5000, 8000, 15000, 25000, 35000],
      types: {
        "Type 1": [0, 0.06, 0.125, 0.135, 0.145, 0.18],
        "Type 2": [0, 0.06, 0.135, 0.145, 0.16, 0.18],
        "Type 3": [0, 0.06, 0.16, 0.17, 0.18, 0.2],
      },
      alternant: 0.07,
    },
    perimetre: { bornesParTete: [10500, 12000, 13500, 15000], taux: [0.01, 0.02, 0.03, 0.04, 0.05] },
    primePerf: { paliers: [[60000, 1000], [75000, 1500], [90000, 2000]], fenetre: 3 },
    primeEquipe: { montant: 250, marge: 0.05 },
    mdp: {
      seuilCategorieB: 2,
      ancienneteMois: 6,
      minMensuel: 5000,
      trimestre: { seuils: [10500, 12500, 13500], A: [250, 500, 750], B: [500, 750, 1000] },
      annuel: { seuils: [10500, 12500, 13500], A: [750, 1000, 1500], B: [1000, 1250, 1750] },
    },
    manager: {
      categories: [6, 10],
      minMensuel: 5000,
      trimestre: { seuils: [10500, 12000, 13500, 15000], A: [500, 1000, 1500, 2000], B: [750, 1250, 1750, 2250], C: [1000, 1500, 2000, 2500] },
      semestre: { seuils: [10500, 12000, 13500, 15000], A: [500, 1000, 1500, 2000], B: [750, 1250, 1750, 2250], C: [1000, 1500, 2000, 2500] },
      profitAnnuel: [[30000, 2000], [50000, 5000], [100000, 7500], [200000, 10000], [300000, 15000], [400000, 20000]],
      acompte4: [[12000, 400], [20000, 1000], [40000, 1500], [80000, 2000], [120000, 3000], [160000, 4000]],
      acompte8: [[21000, 400], [35000, 1000], [70000, 1500], [140000, 2000], [210000, 3000], [280000, 4000]],
    },
    recouvrement: { tauxMin: 0.9, paliers: [[5, 100], [16, 175], [30, 250]] },
    postes: {
      "Consultant Junior 1": { type: "Type 1", role: "consultant", fixe: 27000, objectifAn: 70000, objectif6: 52500 },
      "Consultant Junior 2": { type: "Type 1", role: "consultant", fixe: 28000, objectifAn: 80000, objectif6: 60000 },
      "Consultant 1": { type: "Type 1", role: "consultant", fixe: 29000, objectifAn: 100000, objectif6: 75000 },
      "Consultant 2": { type: "Type 2", role: "consultant", fixe: 30000, objectifAn: 120000, objectif6: 90000 },
      "Consultant Sénior 1": { type: "Type 2", role: "consultant", fixe: 31000, objectifAn: 150000, objectif6: 112500 },
      "Consultant Sénior 2": { type: "Type 2", role: "consultant", fixe: 32000, objectifAn: 170000, objectif6: 127500 },
      "Consultant Sénior 3": { type: "Type 2", role: "consultant", fixe: 33000, objectifAn: 190000, objectif6: 142500 },
      "Consultant Sénior 4": { type: "Type 2", role: "consultant", fixe: 34000, objectifAn: 210000, objectif6: 157500 },
      "Consultant Principal 1": { type: "Type 3", role: "consultant", fixe: 35000, objectifAn: 230000, objectif6: 172500 },
      "Consultant Principal 2": { type: "Type 3", role: "consultant", fixe: 36000, objectifAn: 250000, objectif6: 187500 },
      "Consultant Expert 1": { type: "Type 3", role: "consultant", fixe: 37000, objectifAn: 270000, objectif6: 202500 },
      "Consultant Expert 2": { type: "Type 3", role: "consultant", fixe: 39000, objectifAn: 300000, objectif6: 225000 },
      "Manager de Pôle": { type: "Type 2", role: "mdp" },
      "Team Manager": { type: "Type 3", role: "mdp", sansPrimePerf: true },
      "Team Manager Sénior": { type: "Type 3", role: "mdp", sansPrimePerf: true },
      "Manager de Cabinet": { type: "Type 3", role: "manager", sansPrimePerf: true, sansPrimeEquipe: true },
      "Business Unit Manager": { type: "Type 3", role: "manager", sansPrimePerf: true, sansPrimeEquipe: true },
      "Alternant": { type: "Alt", role: "alternant", sansPrimeEquipe: true },
      "Chargé de recrutement interne": { type: null, role: "interne", sansPrimePerf: true, sansPrimeEquipe: true },
    },
  };

  /* Variable par tranches : renvoie {total, detail:[{de,a,base,taux,montant}]} */
  function tranches(montant, bornes, taux) {
    const edges = [0, ...bornes, Infinity];
    const detail = [];
    let total = 0;
    for (let i = 0; i < taux.length; i++) {
      const base = Math.max(0, Math.min(montant, edges[i + 1]) - edges[i]);
      if (base <= 0) continue;
      const m = base * taux[i];
      total += m;
      detail.push({ de: edges[i], a: edges[i + 1], base, taux: taux[i], montant: m });
    }
    return { total: r2(total), detail };
  }

  function varConsultant(ca, type, B) {
    if (!ca || ca <= 0 || !type) return { total: 0, detail: [] };
    if (type === "Alt") return { total: r2(ca * B.consultant.alternant), detail: [{ de: 0, a: Infinity, base: ca, taux: B.consultant.alternant, montant: ca * B.consultant.alternant }] };
    const t = B.consultant.types[type];
    if (!t) return { total: 0, detail: [] };
    if (ca < B.consultant.bornes[0]) return { total: 0, detail: [] };
    return tranches(ca, B.consultant.bornes, t);
  }

  function varPerimetre(ca, eff, B, taux) {
    if (!ca || !eff) return { total: 0, detail: [] };
    const bornes = B.perimetre.bornesParTete.map((b) => b * eff);
    return tranches(ca, bornes, Array.isArray(taux) && taux.length === B.perimetre.taux.length ? taux : B.perimetre.taux);
  }

  const palier = (v, paliers) => { let out = 0; for (const [s, m] of paliers) if (v >= s) out = m; return out; };

  /* ---------- Accès à l'état ---------- */
  function posteAt(c, mois) {
    let p = null;
    for (const x of (c.postes || []).slice().sort((a, b) => a.depuis.localeCompare(b.depuis))) if (x.depuis <= mois) p = x.poste;
    if (!p && c.postes && c.postes.length) p = c.postes[0].poste;
    return p;
  }
  function typeAt(S, c, mois) {
    const p = posteAt(c, mois);
    const def = S.baremes.postes[p];
    return { poste: p, type: c.typeForce || (def ? def.type : null), def: def || {} };
  }
  const dayOf = (iso) => (iso ? Number(iso.slice(8, 10)) : 1);
  /* Règle du 15 : présent un mois s'il est entré au plus tard le 15 et n'est pas sorti avant le 15. */
  function presentMois(c, mois) {
    if (c.entree) { const e = c.entree.slice(0, 7); if (e > mois || (e === mois && dayOf(c.entree) > 15)) return false; }
    if (c.sortie) { const s = c.sortie.slice(0, 7); if (s < mois || (s === mois && dayOf(c.sortie) < 15)) return false; }
    return true;
  }
  const actifPaie = (c, paie) => !c.sortie || c.sortie.slice(0, 7) >= addM(paie, -1);
  const caOf = (S, cid, mois) => { const v = S.ca[cid] && S.ca[cid][mois]; return v == null ? null : v; };

  /* Chiffres d'un périmètre (bureau / pôle) pour un mois : saisie/import prioritaire, sinon somme des membres. */
  function perimMois(S, p, mois) {
    if (p.fin && mois > p.fin) return { ca: null, eff: 0, retr: 0, source: "terminé", membres: 0, hors: true };
    if (p.depuis && mois < p.depuis) return { ca: null, eff: 0, retr: 0, source: "hors période", membres: 0, hors: true };
    const o = S.mensuel[`${p.id}_${mois}`] || {};
    const membres = Object.values(S.collabs).filter((c) => (p.kind === "bureau" ? c.agence === p.agence && c.id !== p.responsable : c.pole === p.id));
    const presents = membres.filter((c) => presentMois(c, mois));
    const caCalc = sum(presents.map((c) => caOf(S, c.id, mois)));
    const hasCa = presents.some((c) => caOf(S, c.id, mois) != null);
    const ca = o.ca != null ? o.ca : hasCa ? caCalc : null;
    const eff = o.effectif != null ? o.effectif : presents.length;
    const retr = o.retraitement || 0;
    return { ca, eff, retr, source: o.ca != null ? o.source || "saisie" : "calculé", membres: presents.length };
  }

  /* ---------- Primes de périmètre ---------- */
  function categorieMdp(effMoy, B) { return effMoy > B.mdp.seuilCategorieB ? "B" : "A"; }
  function categorieMgr(effMoy, B) { const [b, c] = B.manager.categories; return effMoy >= c ? "C" : effMoy >= b ? "B" : "A"; }
  function grille(val, cfg, cat, strict) {
    let out = 0, idx = -1;
    cfg.seuils.forEach((s, i) => { if (strict ? val > s : val >= s) { out = cfg[cat][i]; idx = i; } });
    return { montant: out, palier: idx };
  }
  function statsPeriode(S, p, months) {
    const rows = months.map((m) => ({ m, ...perimMois(S, p, m) })).filter((r) => !r.hors);
    months = rows.map((r) => r.m);
    if (!rows.length) return { rows, complet: false, effMoy: 0, prod: 0, prodApres: 0, minOk: false };
    const ca = sum(rows.map((r) => r.ca)), retr = sum(rows.map((r) => r.retr)), eff = sum(rows.map((r) => r.eff));
    const complet = rows.every((r) => r.ca != null && r.eff > 0);
    return {
      rows, complet, effMoy: eff / months.length,
      prod: eff ? ca / eff : 0, prodApres: eff ? (ca + retr) / eff : 0,
      minOk: rows.every((r) => r.eff > 0 && (r.ca + r.retr) / r.eff >= 5000 - 1e-9),
    };
  }

  /* ---------- Calcul d'une ligne de paie ---------- */
  function computeLigne(S, c, paie, ctx) {
    const B = S.baremes;
    const mois = addM(paie, -1); // CA du mois M payé en M+1
    const { poste, type, def } = typeAt(S, c, mois);
    const ca = caOf(S, c.id, mois);
    const out = { collab: c.id, nom: `${c.prenom} ${c.nom}`, poste, type, mois, paie, ca, items: {}, expl: {}, alertes: [] };

    // G — variable sur CA personnel
    const vc = varConsultant(ca || 0, type, B);
    out.items.G = vc.total;
    out.expl.G = { kind: "tranches", base: ca || 0, detail: vc.detail, type };
    if (ca == null && !["manager", "interne"].includes(def.role)) out.alertes.push(`CA ${mois} manquant`);

    // H — variable manager / MDP sur périmètre
    let H = 0; const hExpl = [];
    for (const p of Object.values(S.perimetres).filter((p) => p.responsable === c.id)) {
      const pm = perimMois(S, p, mois);
      const v = varPerimetre(pm.ca || 0, pm.eff, B, p.taux);
      H += v.total;
      hExpl.push({ perimetre: p.nom, kind: p.kind, ca: pm.ca, eff: pm.eff, source: pm.source, detail: v.detail, total: v.total });
      if (pm.ca == null) out.alertes.push(`CA ${p.nom} ${mois} manquant`);
    }
    out.items.H = r2(H); out.expl.H = hExpl;

    // I — régularisations (mouvements imputés sur ce mois de paie)
    const mv = [];
    for (const r of S.regs) if (r.collab === c.id) for (const m of r.mouvements || []) if (m.paie === paie) mv.push({ reg: r, ...m });
    out.items.I = r2(sum(mv.map((m) => m.montant))); out.expl.I = mv;

    // K — prime de performance individuelle (fenêtre glissante de 3 mois, mois non déjà primés)
    out.items.K = 0; out.expl.K = ctx.perf[c.id] ? ctx.perf[c.id][paie] : null;
    if (out.expl.K && out.expl.K.montant) out.items.K = out.expl.K.montant;

    // L — bonus recouvrement (responsable du bureau, paie M+2)
    out.items.L = 0;
    const bureau = Object.values(S.perimetres).find((p) => p.kind === "bureau" && p.responsable === c.id);
    if (bureau) {
      const rm = addM(paie, -2);
      const rec = S.agenceMois[`${bureau.agence}_${rm}`] || {};
      const n = rec.reglees;
      const taux = rec.echues ? n / rec.echues : null;
      const ok = n != null && (taux == null || taux >= B.recouvrement.tauxMin - 1e-9) && rec.conditionsOk !== false;
      out.items.L = ok ? palier(n, B.recouvrement.paliers) : 0;
      out.expl.L = { mois: rm, reglees: n, echues: rec.echues, taux, conditionsOk: rec.conditionsOk !== false };
    }

    // M — prime d'équipe trimestrielle (paie qui suit la fin d'un trimestre)
    out.items.M = 0;
    const { y: my, m: mm } = parse(mois);
    if (mm % 3 === 0) {
      const q = Math.ceil(mm / 3);
      const debutQ = ym(my, (q - 1) * 3 + 1);
      const obj = S.objectifs[`${c.agence}_${my}-T${q}`] || {};
      const caQ = ctx.caAgenceQ(c.agence, my, q);
      const seuil = obj.objectif ? obj.objectif * (1 + B.primeEquipe.marge) : null;
      const atteint = obj.atteint != null ? obj.atteint : seuil != null && caQ != null ? caQ >= seuil : false;
      const presentDebut = !c.entree || c.entree.slice(0, 10) <= `${debutQ}-15`;
      const finQ = `${ym(my, q * 3)}-31`;
      const presentFin = !c.sortie || c.sortie > finQ.replace(/-31$/, "-" + String(new Date(my, q * 3, 0).getDate()).padStart(2, "0"));
      const eligible = !def.sansPrimeEquipe && type !== "Alt" && presentDebut && presentFin;
      out.items.M = atteint && eligible ? B.primeEquipe.montant : 0;
      out.expl.M = { trimestre: `T${q} ${my}`, objectif: obj.objectif, seuil, caQ, atteint, force: obj.atteint != null, eligible, raison: !presentDebut ? `entré(e) après le 15 ${debutQ}` : !presentFin ? "sorti(e) avant la fin du trimestre" : def.sansPrimeEquipe ? "poste non éligible" : type === "Alt" ? "alternant" : null };
    }

    // N/O/P — primes de périmètre (MDP / manager)
    out.items.N = 0; out.items.O = 0; out.items.P = 0; out.expl.N = []; out.expl.O = []; out.expl.P = [];
    for (const p of Object.values(S.perimetres).filter((p) => p.responsable === c.id)) {
      const isMgr = p.kind === "bureau";
      const anc = B.mdp.ancienneteMois ?? 6;
      const debutPoste = p.priseDePoste || p.depuis;
      const ancOk = (finPeriode) => isMgr || !debutPoste || moisEntre(debutPoste, finPeriode) >= anc;
      if (mm % 3 === 0) {
        const q = Math.ceil(mm / 3);
        const st = statsPeriode(S, p, qMonths(my, q));
        const cat = isMgr ? categorieMgr(st.effMoy, B) : categorieMdp(st.effMoy, B);
        const cfg = isMgr ? B.manager.trimestre : B.mdp.trimestre;
        const okA = ancOk(ym(my, q * 3));
        const g = st.minOk && okA ? grille(st.prodApres, cfg, cat, false) : { montant: 0, palier: -1 };
        out.items.N += g.montant;
        out.expl.N.push({ perimetre: p.nom, periode: `T${q} ${my}`, cat, effMoy: st.effMoy, prod: st.prod, prodApres: st.prodApres, minOk: st.minOk, ancOk: okA, anc, complet: st.complet, montant: g.montant, rows: st.rows });
      }
      if (isMgr && mm % 6 === 0) {
        const s = mm / 6;
        const st = statsPeriode(S, p, sMonths(my, s));
        const cat = categorieMgr(st.effMoy, B);
        const g = grille(st.prodApres, B.manager.semestre, cat, true);
        out.items.O += g.montant;
        out.expl.O.push({ perimetre: p.nom, periode: `S${s} ${my}`, cat, effMoy: st.effMoy, prod: st.prod, prodApres: st.prodApres, montant: g.montant });
      }
      if (!isMgr && mm === 12) {
        const st = statsPeriode(S, p, yMonths(my));
        const cat = categorieMdp(st.effMoy, B);
        const okA = ancOk(ym(my, 12));
        const g = okA ? grille(st.prodApres, B.mdp.annuel, cat, false) : { montant: 0 };
        out.items.P += g.montant;
        out.expl.P.push({ perimetre: p.nom, periode: `Année ${my}`, cat, effMoy: st.effMoy, prodApres: st.prodApres, ancOk: okA, anc, montant: g.montant });
      }
      if (isMgr && (mm === 4 || mm === 8 || mm === 12)) {
        const pr = S.objectifs[`${p.agence}_${my}`] || {};
        const M = B.manager;
        const a4 = pr.profit4 != null ? palier(pr.profit4 + 0.01, M.acompte4) : 0;
        const a8 = pr.profit8 != null ? palier(pr.profit8 + 0.01, M.acompte8) : 0;
        let montant = 0, label = "", base = null;
        if (mm === 4) { montant = a4; label = "Acompte 4 mois"; base = pr.profit4; }
        if (mm === 8) { montant = Math.max(0, a8 - a4); label = "Acompte 8 mois"; base = pr.profit8; }
        if (mm === 12) { const an = pr.profit12 != null ? palier(pr.profit12, M.profitAnnuel) : 0; montant = pr.profit12 != null ? Math.max(0, an - Math.max(a4, a8)) : 0; label = "Solde annuel"; base = pr.profit12; }
        out.items.P += montant;
        out.expl.P.push({ perimetre: p.nom, periode: `${label} ${my}`, profit: base, montant });
        if (base == null) out.alertes.push(`Profit ${label.toLowerCase()} ${my} non saisi`);
      }
    }

    // Ajustements manuels (priorité sur le calcul)
    const adj = S.ajust[`${c.id}_${paie}`] || {};
    out.calcule = { ...out.items };
    out.forces = {};
    for (const k of Object.keys(out.items)) if (adj[k] != null && adj[k] !== "") { out.items[k] = Number(adj[k]); out.forces[k] = true; }
    out.note = adj.note || "";
    for (const k of Object.keys(out.items)) out.items[k] = r2(out.items[k]);
    out.items.J = r2(out.items.G + out.items.H + out.items.I);
    out.primes = r2(out.items.K + out.items.L + out.items.M + out.items.N + out.items.O + out.items.P);
    out.total = r2(out.items.J + out.primes);
    return out;
  }

  /* Prime perf individuelle : parcours chronologique, une fenêtre primée "consomme" ses mois. */
  function perfHistory(S, upTo) {
    const B = S.baremes, res = {};
    const allMonths = new Set();
    for (const cid in S.ca) for (const m in S.ca[cid]) allMonths.add(m);
    const sorted = [...allMonths].sort();
    if (!sorted.length) return res;
    const start = addM(sorted[0], 1);
    for (const c of Object.values(S.collabs)) {
      res[c.id] = {};
      const used = new Set();
      for (let p = start; p <= upTo; p = addM(p, 1)) {
        const m = addM(p, -1);
        const win = [addM(m, -2), addM(m, -1), m];
        const clo = S.clotures[`${c.agence}_${p}`];
        const adj = S.ajust[`${c.id}_${p}`] || {};
        let montant = 0, src = "calcul";
        const cas = win.map((x) => caOf(S, c.id, x));
        const total = sum(cas);
        const { def } = typeAt(S, c, m);
        if (clo && clo.lignes && clo.lignes[c.id]) { montant = clo.lignes[c.id].K || 0; src = "clôture"; }
        else if (adj.K != null && adj.K !== "") { montant = Number(adj.K); src = "ajustement"; }
        else if (!def.sansPrimePerf && win.every((x) => !used.has(x)) && cas.every((v) => v != null)) montant = palier(total, B.primePerf.paliers);
        if (montant > 0) win.forEach((x) => used.add(x));
        res[c.id][p] = { fenetre: win, cas, total, montant, src, bloques: win.filter((x) => used.has(x) && montant === 0), eligible: !def.sansPrimePerf };
      }
    }
    return res;
  }

  function computePaie(S, agence, paie) {
    const perf = perfHistory(S, paie);
    const caAgenceQ = (ag, y, q) => {
      const bureau = Object.values(S.perimetres).find((p) => p.kind === "bureau" && p.agence === ag);
      const months = qMonths(y, q);
      if (bureau) { const vals = months.map((m) => perimMois(S, bureau, m).ca); return vals.some((v) => v == null) ? null : sum(vals); }
      return sum(Object.values(S.collabs).filter((c) => c.agence === ag).flatMap((c) => months.map((m) => caOf(S, c.id, m))));
    };
    const ctx = { perf, caAgenceQ };
    const clo = S.clotures[`${agence}_${paie}`];
    const collabs = Object.values(S.collabs)
      .filter((c) => c.agence === agence)
      .filter((c) => (clo ? clo.lignes && clo.lignes[c.id] : actifPaie(c, paie) && (!c.entree || c.entree.slice(0, 7) <= addM(paie, -1))))
      .sort((a, b) => a.nom.localeCompare(b.nom));
    const lignes = collabs.map((c) => {
      if (clo) {
        const l = clo.lignes[c.id];
        const items = { G: l.G || 0, H: l.H || 0, I: l.I || 0, K: l.K || 0, L: l.L || 0, M: l.M || 0, N: l.N || 0, O: l.O || 0, P: l.P || 0 };
        items.J = r2(items.G + items.H + items.I);
        const primes = r2(items.K + items.L + items.M + items.N + items.O + items.P);
        return { collab: c.id, nom: `${c.prenom} ${c.nom}`, poste: l.poste, type: l.type, ca: l.ca, mois: addM(paie, -1), paie, items, primes, total: r2(items.J + primes), cloture: true, expl: {}, alertes: [], forces: {}, note: l.note || "" };
      }
      return computeLigne(S, c, paie, ctx);
    });
    const tot = (k) => r2(sum(lignes.map((l) => (k === "total" ? l.total : k === "primes" ? l.primes : l.items[k]))));
    return { agence, paie, cloture: !!clo, clotureInfo: clo || null, lignes, totaux: Object.fromEntries(["G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "primes", "total"].map((k) => [k, tot(k)])) };
  }

  return { DEFAULT_BAREMES, tranches, varConsultant, varPerimetre, computePaie, perimMois, presentMois, posteAt, typeAt, addM, qOf, r2, perfHistory };
})();
if (typeof module !== "undefined") module.exports = Engine;
