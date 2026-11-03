/* Configuration de déploiement.
 * backend : "local" = données stockées dans le navigateur (tests, démonstration).
 *           Un futur backend (ex. "supabase", "api") s'ajoute dans js/platform/
 *           et se sélectionne ici, sans toucher à l'application.
 * user.name : nom affiché dans le journal des modifications en mode local.
 * acces : mot de passe d'ouverture du site (sécurisation temporaire).
 *         Pour le changer : python3 outils/changer-mot-de-passe.py (rechiffre aussi js/donnees.js).
 *         Supprimez le bloc « acces » pour désactiver la protection.
 *         dureeSessionHeures : durée avant de redemander le mot de passe (fermer l'onglet le redemande aussi). */
window.HH_CONFIG = {
  backend: "local",
  user: { name: "Utilisateur local" },
  acces: {
    sel: "f997f065b3790ee10b6086c4585e02ba",
    iterations: 210000,
    empreinte: "6833f7871f91f92c56fb814e5f7d78534547d9a1453d1e365e5bc26f09769d20",
    dureeSessionHeures: 12,
  },
};
