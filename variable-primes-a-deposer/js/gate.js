/* Accès protégé par mot de passe (sécurisation TEMPORAIRE).
 *
 * Tant que le mot de passe n'est pas saisi, l'application et la couche de données ne sont
 * pas chargées : rien ne s'affiche et aucune donnée n'est lue.
 * Le mot de passe n'est jamais stocké en clair : seule son empreinte PBKDF2-SHA256
 * (sel + 210 000 itérations) figure dans js/config.js.
 *
 * LIMITE : c'est un contrôle côté navigateur. Il dissuade l'accès, mais le code source
 * de la page reste téléchargeable. Pour une vraie protection, voir README.md
 * (protection par le serveur, puis authentification du backend).
 */
(() => {
  "use strict";
  const cfg = (window.HH_CONFIG && window.HH_CONFIG.acces) || null;
  const SCRIPTS = ["js/platform/platform.js", "js/platform/browser-downloads.js", "js/platform/local-db.js", "js/platform/local-user.js", "js/engine.js", "js/app.js"];
  const KEY = "hh-acces";

  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
  async function empreinte(motDePasse, sel, iterations) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(motDePasse), "PBKDF2", false, ["deriveBits"]);
    return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(sel), iterations }, key, 256));
  }
  const egal = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

  const unb64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  async function dechiffrer(seed, motDePasse) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(motDePasse), "PBKDF2", false, ["deriveKey"]);
    const cle = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: unhex(seed.sel), iterations: seed.iterations }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const clair = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(seed.iv) }, cle, unb64(seed.contenu));
    return JSON.parse(new TextDecoder().decode(clair));
  }

  function sessionValide() {
    try {
      const s = JSON.parse(sessionStorage.getItem(KEY) || "null");
      return !!s && s.empreinte === cfg.empreinte && Date.now() < s.expire;
    } catch (e) { return false; }
  }
  function ouvrirSession() {
    const h = Number(cfg.dureeSessionHeures) || 12;
    try { sessionStorage.setItem(KEY, JSON.stringify({ empreinte: cfg.empreinte, expire: Date.now() + h * 3600e3 })); } catch (e) {}
  }
  window.HHGate = { deconnecter() { try { sessionStorage.removeItem(KEY); } catch (e) {} location.reload(); } };

  function chargerApplication() {
    document.body.classList.remove("locked");
    const g = document.getElementById("gate"); if (g) g.remove();
    const lo = document.getElementById("logout"); if (lo) { lo.hidden = !cfg; lo.onclick = () => window.HHGate.deconnecter(); }
    // Version « fichier unique » : les scripts sont embarqués dans la page, inactifs jusqu'ici.
    const inline = [...document.querySelectorAll('script[type="text/hh-differe"]')];
    if (inline.length) {
      for (const t of inline) { const s = document.createElement("script"); s.textContent = t.textContent; document.body.appendChild(s); }
      return;
    }
    SCRIPTS.reduce((p, src) => p.then(() => new Promise((ok, ko) => {
      const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => ko(new Error(src)); document.body.appendChild(s);
    })), Promise.resolve()).catch((e) => console.error("Chargement impossible :", e));
  }

  // Pas de mot de passe configuré : accès direct.
  if (!cfg || !cfg.empreinte) { chargerApplication(); return; }
  // Données initiales chiffrées (js/donnees.js) : déchiffrées avec le mot de passe.
  const seed = window.HH_DONNEES || null; // défini par js/donnees.js s'il existe
  const seedApplique = () => { try { return !seed || localStorage.getItem("hh-donnees-appliquees") === seed.id; } catch (e) { return false; } };
  // Garde-fou : le mot de passe provisoire n'est jamais accepté sur un site publié (hors poste local).
  const PROVISOIRE = "6dfa10ebbe9c44aa3a5344475e2b1f3f7db0a9f437be26c6bc8316cad935cc8c";
  const local = location.protocol === "file:" || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (cfg.empreinte === PROVISOIRE && !local) {
    document.getElementById("gate-form").innerHTML = `<div class="eyebrow">Publication bloquée</div><h2>Mot de passe provisoire</h2>
      <p class="gate-sub">Ce site est publié avec le mot de passe provisoire. Changez-le avec <code>outils/changer-mot-de-passe.py</code>, puis republiez.</p>`;
    return;
  }
  if (sessionValide() && seedApplique()) { chargerApplication(); return; }

  const form = document.getElementById("gate-form");
  const input = document.getElementById("gate-pw");
  const msg = document.getElementById("gate-msg");
  const btn = form.querySelector("button[type=submit]");
  const voir = document.getElementById("gate-show");
  let echecs = 0;

  if (!window.crypto || !crypto.subtle) {
    msg.textContent = "Ce site doit être ouvert en HTTPS pour vérifier le mot de passe.";
    input.disabled = btn.disabled = true;
    return;
  }
  voir.onclick = () => { const t = input.type === "password"; input.type = t ? "text" : "password"; voir.setAttribute("aria-pressed", String(t)); voir.textContent = t ? "Masquer" : "Afficher"; input.focus(); };
  input.focus();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!input.value) { msg.textContent = "Saisissez le mot de passe."; return; }
    btn.disabled = true; input.disabled = true; msg.textContent = ""; btn.textContent = "Vérification…";
    let ok = false;
    try { ok = egal(await empreinte(input.value, cfg.sel, cfg.iterations || 210000), cfg.empreinte); } catch (err) { console.error(err); }
    if (ok && seed) {
      try { window.HH_SEED = { id: seed.id, data: await dechiffrer(seed, input.value) }; }
      catch (err) { console.error(err); msg.textContent = "Les données intégrées n'ont pas pu être déchiffrées avec ce mot de passe."; btn.disabled = input.disabled = false; btn.textContent = "Accéder à l'outil"; return; }
    }
    if (ok) { ouvrirSession(); chargerApplication(); return; }
    echecs++;
    const attente = echecs >= 3 ? Math.min(30, 2 ** (echecs - 2)) : 0; // freine les essais répétés
    msg.textContent = attente ? `Mot de passe incorrect. Nouvel essai possible dans ${attente} s.` : "Mot de passe incorrect.";
    form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake");
    setTimeout(() => { btn.disabled = false; input.disabled = false; btn.textContent = "Accéder à l'outil"; input.select(); input.focus(); }, attente * 1000);
  });
})();
