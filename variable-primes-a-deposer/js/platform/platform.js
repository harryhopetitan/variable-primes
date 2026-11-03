/* Couche d'adaptation « plateforme » — Harry Hope Variables & Primes.
 *
 * Remplace les services fournis par claude.ai (claude.use("db" | "user" | "downloads")).
 * L'application n'appelle que Platform.use(nom) et reçoit un objet au même contrat
 * (voir README.md, section « Contrat de l'adaptateur »), ou null si le service est
 * indisponible. Chaque backend enregistre ses pilotes avec Platform.register().
 *
 * Choix du backend : window.HH_CONFIG.backend (js/config.js).
 */
window.Platform = (() => {
  "use strict";
  const drivers = {};      // drivers[backend][service] = async (config) => namespace
  const instances = {};    // promesses mémorisées : un seul objet par service

  const config = () => window.HH_CONFIG || {};
  const backend = () => config().backend || "local";

  /** Enregistre un pilote. backend "*" = valable pour tous les backends (ex. téléchargements navigateur). */
  function register(backendName, service, factory) {
    (drivers[backendName] ||= {})[service] = factory;
  }

  /** Équivalent de claude.use(nom) : résout l'objet du service, ou null. Ne rejette jamais. */
  function use(service) {
    if (!instances[service]) {
      const b = backend();
      const factory = (drivers[b] && drivers[b][service]) || (drivers["*"] && drivers["*"][service]);
      instances[service] = !factory
        ? Promise.resolve(null)
        : Promise.resolve()
            .then(() => factory(config()))
            .catch((e) => { console.error(`[Platform] service « ${service} » indisponible (${b})`, e); return null; });
    }
    return instances[service];
  }

  const LABELS = { local: "stockage local du navigateur" };
  const backendName = () => LABELS[backend()] || backend();

  /** Erreur au format attendu par l'application : { code, message }. */
  function error(code, message) { const e = new Error(message); e.code = code; return e; }

  return { register, use, backend, backendName, error };
})();
