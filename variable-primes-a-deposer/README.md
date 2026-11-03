# Variables & Primes – Harry Hope (version hébergeable)

Version autonome de l'outil publié sur claude.ai. Les services propres à Claude
(`claude.use("db" | "user" | "downloads")`) sont remplacés par une **couche d'adaptation**
(`Platform.use(...)`) : l'application et le moteur de calcul sont inchangés.

## Structure

```
index.html                    page (structure HTML + chargement des scripts)
css/styles.css                charte et mise en page
js/config.js                  choix du backend et mot de passe d’accès
js/donnees.js                 données initiales chiffrées
js/gate.js                    écran de mot de passe
js/engine.js                  moteur de calcul des variables et primes (fonctions pures)
js/app.js                     interface (onglets, saisies, imports, clôtures, journal)
js/platform/platform.js       registre des services : Platform.use(nom), Platform.register(...)
js/platform/local-db.js       base de données locale (IndexedDB), API style Firestore
js/platform/local-user.js     identité locale (à remplacer par l'authentification réelle)
js/platform/browser-downloads.js  export de fichiers par le navigateur
```

## Lancer

Site statique, sans compilation : déposez le dossier sur n'importe quel hébergeur
(serveur web, intranet, Netlify, OVH…) ou testez en local :

```
python3 -m http.server 8000    # puis http://localhost:8000
```

## Publier sur GitHub Pages

> **Étape 1 obligatoire, AVANT tout envoi sur GitHub** : changer le mot de passe provisoire.
> Git conserve l'historique : un fichier envoyé une fois reste récupérable.
> (Garde-fou : publié avec le mot de passe provisoire, le site refuse de s'ouvrir.)

1. **Changer le mot de passe** (sur votre ordinateur, dans le dossier du projet) :
   ```
   pip install cryptography
   python3 outils/changer-mot-de-passe.py
   ```
   Choisissez une phrase de passe d'au moins 16 caractères (ex. quatre mots séparés par des
   tirets). Le script met à jour `js/config.js`, rechiffre `js/donnees.js` et régénère `dist/`.
   Vérifiez en local : `python3 -m http.server 8000`, puis http://localhost:8000.
2. **Créer le dépôt** sur github.com (*New repository*). Dépôt privé si votre offre GitHub le
   permet pour Pages (Pro, Team, Enterprise) ; sinon public — les données restent chiffrées.
3. **Envoyer les fichiers** : le *contenu* de ce dossier, `index.html` à la racine (fichiers cachés
   `.gitignore` et `.nojekyll` compris). Au choix :
   - site web : *Add file → Upload files*, glisser-déposer le contenu du dossier ;
   - GitHub Desktop : *Add local repository*, puis *Publish repository* ;
   - ligne de commande :
     ```
     git init && git add . && git commit -m "Variables & Primes – première version"
     git branch -M main
     git remote add origin https://github.com/<compte>/<depot>.git
     git push -u origin main
     ```
4. **Activer Pages** : *Settings → Pages → Build and deployment → Deploy from a branch*,
   branche `main`, dossier `/ (root)`, *Save*. Le site est en ligne après une à deux minutes à
   `https://<compte>.github.io/<depot>/` (HTTPS automatique).
5. **Communiquer le mot de passe** aux utilisateurs par un autre canal que le lien.

À chaque mise à jour : modifier les fichiers, relancer `python3 outils/assembler.py` si vous
utilisez le fichier unique, puis envoyer (commit + push) — Pages se met à jour tout seul.

Ne jamais déposer dans le dépôt un export de données en clair (`.gitignore` bloque les noms
courants : `export*.json`, `Sauvegarde*.json`, fichiers Excel et CSV).

## Version « fichier unique »

`dist/variables-primes-harry-hope.html` contient tout le projet, données comprises, dans un seul fichier
(pratique pour tester ou déposer rapidement). Après toute modification des sources,
la régénérer avec `python3 outils/assembler.py`.

## Données initiales (js/donnees.js)

Le projet contient les données de l'outil claude.ai au 3 novembre 2026 (barèmes, 15 cabinets,
160 collaborateurs, 24 bureaux et pôles), **chiffrées avec le mot de passe d'accès**
(AES-256-GCM) dans `js/donnees.js` : illisibles dans les fichiers, déchiffrées dans le navigateur
après connexion, puis copiées une seule fois dans la base locale de ce navigateur. Les
modifications faites ensuite sont conservées.

- Régénérer (nouvelles données ou nouveau mot de passe) :
  `python3 outils/assembler.py --donnees export.json` (`pip install cryptography`) ; le format
  attendu est `{ "collection": { "id": { ...document } } }`. Un nouveau `js/donnees.js` réécrit,
  dans chaque navigateur, les documents qu'il contient.
- Démarrer sans données : supprimer `js/donnees.js`.

## Mot de passe d'accès (sécurisation temporaire)

À l'ouverture, un écran demande un mot de passe (`js/gate.js`). L'application et les données
ne sont chargées qu'après une saisie correcte. La session dure 12 h au plus et se ferme avec l'onglet ;
le bouton « Se déconnecter » du bandeau la ferme immédiatement.

- **Changer le mot de passe** : ouvrir `outils/mot-de-passe.html` sur le site, saisir le nouveau
  mot de passe et coller le bloc généré dans `js/config.js` (bloc `acces`). Le mot de passe n'est
  jamais stocké en clair, seulement son empreinte PBKDF2-SHA256 salée.
- **Désactiver** : supprimer le bloc `acces` de `js/config.js`.
- Le site doit être servi en **HTTPS** (ou `localhost`) pour que la vérification fonctionne.

**Limite** : ce contrôle se fait dans le navigateur. Il bloque l'accès à l'interface, mais les
fichiers du site restent téléchargeables par qui connaît l'adresse. Pour une protection réelle
dès la mise en ligne, ajouter aussi une protection côté serveur (mot de passe « Basic Auth »
de l'hébergeur, `.htaccess` sur Apache/OVH, protection par mot de passe Netlify/Vercel, ou
accès réservé au VPN de l'entreprise), puis l'authentification du backend.

## Mode « local » (actuel)

Les données sont enregistrées **dans le navigateur** de la personne (IndexedDB) :
utile pour tester et faire une démonstration, **pas pour un usage partagé**
(chaque poste a sa propre base). Les onglets d'un même navigateur restent synchronisés.

Sauvegarde / restauration depuis la console du navigateur :
`copy(JSON.stringify(HHLocalDB.exportJSON()))` et `await HHLocalDB.importJSON(objet)`.

## Contrat de l'adaptateur

Un nouveau backend (Supabase, Firebase, API maison…) = un fichier dans `js/platform/`
qui enregistre ces trois services, puis `backend: "<nom>"` dans `js/config.js`.

```js
Platform.register("monbackend", "db", async (config) => ({ doc, collection }));
Platform.register("monbackend", "user", async (config) => ({ id, profiles }));
// "downloads" est fourni pour tous les backends par browser-downloads.js
```

**db** — ce que l'application utilise :

| Appel | Comportement attendu |
|---|---|
| `db.collection(c).onSnapshot(next, err)` | `next({ docs: [{ id, data() }] })` au démarrage puis à chaque changement ; renvoie une fonction de désabonnement |
| `db.collection("journal").orderBy("at","desc").limit(500)` | requête triée et limitée, même `onSnapshot` |
| `db.collection(c).add(data)` | crée un document avec un identifiant généré |
| `db.doc("col/id").set(data)` | remplace le document entier |
| `db.doc("col/id").update(patch)` | **fusion récursive** des objets imbriqués (tableaux et `null` remplacent) ; rejette si le document n'existe pas |
| `db.doc("col/id").delete()` | supprime |

Erreurs : rejeter un objet `{ code, message }`. Codes interprétés par l'interface :
`invalid_argument` (droits insuffisants), `quota_exceeded` (stockage plein), tout autre code = erreur temporaire.

Collections utilisées : `settings, agences, collabs, ca, perimetres, mensuel, agenceMois,
objectifs, regs, ajust, clotures, promos, journal`.

**user** — `id()` → identifiant stable de la personne connectée ;
`profiles(ids)` → `{ [id]: { name } }` (pour afficher les noms dans le journal).

**downloads** — `save({ filename, data })` → `{ status: "saved" }`.

## Avant une mise en production

- Brancher un backend partagé avec authentification (SSO de l'entreprise) et droits par rôle / cabinet.
- Recalculer ou valider les montants côté serveur au moment de la clôture.
- Héberger les données en UE (RGPD : données salariales nominatives), sauvegardes régulières.
- Optionnel : embarquer SheetJS et les polices localement plutôt que via CDN.
