#!/usr/bin/env python3
"""Assemble le projet en un seul fichier HTML autonome.

  python3 outils/assembler.py
      -> dist/variables-primes-harry-hope.html (reprend js/donnees.js s'il existe)

  python3 outils/assembler.py --donnees export.json
      -> (ré)écrit js/donnees.js : données initiales CHIFFRÉES avec le mot de passe d'accès
         (AES-256-GCM, clé dérivée par PBKDF2-SHA256), puis produit le fichier unique.
         Le mot de passe est demandé (ou lu dans la variable d'environnement HH_MDP)
         et vérifié contre js/config.js.
         export.json : { "collection": { "id": { ...document } } }
         Après un changement de mot de passe, relancer cette commande.

Les scripts de l'application sont embarqués inactifs (type="text/hh-differe") et ne
s'exécutent qu'après la saisie du mot de passe (js/gate.js)."""
import argparse, base64, getpass, hashlib, hmac, json, os, pathlib, re, secrets

root = pathlib.Path(__file__).resolve().parent.parent
read = lambda p: (root / p).read_text(encoding="utf-8")
APP = ["js/platform/platform.js", "js/platform/browser-downloads.js", "js/platform/local-db.js",
       "js/platform/local-user.js", "js/engine.js", "js/app.js"]

ap = argparse.ArgumentParser()
ap.add_argument("--donnees", help="export JSON des données à intégrer (chiffrées)")
ap.add_argument("--sortie", help="fichier HTML à produire")
args = ap.parse_args()

if args.donnees:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # pip install cryptography
    cfg = read("js/config.js")
    get = lambda k: re.search(k + r'\s*:\s*"?([0-9a-f]+)"?', cfg).group(1)
    sel_acces, empreinte, iters = get("sel"), get("empreinte"), int(get("iterations"))
    mdp = os.environ.get("HH_MDP") or getpass.getpass("Mot de passe d'accès : ")
    calc = hashlib.pbkdf2_hmac("sha256", mdp.encode(), bytes.fromhex(sel_acces), iters, 32).hex()
    if not hmac.compare_digest(calc, empreinte):
        raise SystemExit("Mot de passe différent de celui de js/config.js : rien n'a été produit.")
    donnees = json.loads(pathlib.Path(args.donnees).read_text(encoding="utf-8"))
    sel, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    cle = hashlib.pbkdf2_hmac("sha256", mdp.encode(), sel, iters, 32)
    chiffre = AESGCM(cle).encrypt(iv, json.dumps(donnees, ensure_ascii=False).encode(), None)
    seed = {"id": secrets.token_hex(8), "sel": sel.hex(), "iv": iv.hex(), "iterations": iters,
            "contenu": base64.b64encode(chiffre).decode()}
    (root / "js/donnees.js").write_text(
        "/* Données initiales chiffrées (générées par outils/assembler.py) : déchiffrées par js/gate.js avec le mot de passe. */\n"
        f"window.HH_DONNEES = {json.dumps(seed)};\n", encoding="utf-8")
    print("js/donnees.js écrit")
    print("Données :", {k: len(v) for k, v in donnees.items()})

html = read("index.html")
html = html.replace('<link rel="stylesheet" href="css/styles.css">', "<style>\n" + read("css/styles.css") + "\n</style>")
deferred = "".join(f'<script type="text/hh-differe" data-source="{p}">\n{read(p)}\n</script>\n' for p in APP)
html = html.replace('<script src="js/config.js"></script>', "<script>\n" + read("js/config.js") + "\n</script>")
donnees = (root / "js/donnees.js")
html = html.replace('<script src="js/donnees.js"></script>', "<script>\n" + donnees.read_text(encoding="utf-8") + "\n</script>" if donnees.exists() else "")
html = html.replace('<script src="js/gate.js"></script>', deferred + "<script>\n" + read("js/gate.js") + "\n</script>")
assert not re.search(r'(src|href)="(js|css)/', html), "ressource locale non embarquée"

out = pathlib.Path(args.sortie) if args.sortie else root / "dist" / "variables-primes-harry-hope.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html, encoding="utf-8")
print(f"{out} ({out.stat().st_size // 1024} Ko)")
