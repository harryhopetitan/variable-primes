#!/usr/bin/env python3
"""Change le mot de passe d'accès SANS export en clair des données.

  pip install cryptography
  python3 outils/changer-mot-de-passe.py

1. vérifie le mot de passe actuel contre js/config.js ;
2. écrit l'empreinte du nouveau mot de passe dans js/config.js ;
3. rechiffre js/donnees.js avec le nouveau mot de passe (déchiffrement en mémoire uniquement) ;
4. régénère le fichier unique dist/variables-primes-harry-hope.html.

Non interactif (tests, CI) : variables d'environnement HH_MDP_ACTUEL et HH_MDP_NOUVEAU."""
import base64, getpass, hashlib, hmac, json, os, pathlib, re, secrets, subprocess, sys

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
    sys.exit("Module manquant : lancez d'abord  pip install cryptography")

root = pathlib.Path(__file__).resolve().parent.parent
cfg_path, data_path = root / "js/config.js", root / "js/donnees.js"
cfg = cfg_path.read_text(encoding="utf-8")
champ = lambda k: re.search(k + r'\s*:\s*"?([0-9a-f]+)"?', cfg).group(1)
sel, empreinte, iters = champ("sel"), champ("empreinte"), int(champ("iterations"))
pbkdf2 = lambda mdp, s: hashlib.pbkdf2_hmac("sha256", mdp.encode(), s, iters, 32)

actuel = os.environ.get("HH_MDP_ACTUEL") or getpass.getpass("Mot de passe actuel : ")
if not hmac.compare_digest(pbkdf2(actuel, bytes.fromhex(sel)).hex(), empreinte):
    sys.exit("Mot de passe actuel incorrect : rien n'a été modifié.")

nouveau = os.environ.get("HH_MDP_NOUVEAU")
if not nouveau:
    nouveau = getpass.getpass("Nouveau mot de passe (16 caractères minimum, une phrase de passe est idéale) : ")
    if getpass.getpass("Confirmation : ") != nouveau:
        sys.exit("Les deux saisies ne correspondent pas : rien n'a été modifié.")
if len(nouveau) < 16:
    sys.exit("Trop court : choisissez au moins 16 caractères (ex. quatre mots séparés par des tirets).")
if nouveau == actuel or nouveau.lower() == "harryhope-2026":
    sys.exit("Choisissez un mot de passe différent de l'actuel et du mot de passe provisoire.")

# Rechiffrement des données (avant toute écriture, pour ne rien laisser à moitié fait)
nouveau_js = None
if data_path.exists():
    seed = json.loads(re.search(r"window\.HH_DONNEES\s*=\s*(\{.*\})\s*;", data_path.read_text(encoding="utf-8"), re.S).group(1))
    cle = hashlib.pbkdf2_hmac("sha256", actuel.encode(), bytes.fromhex(seed["sel"]), seed["iterations"], 32)
    clair = AESGCM(cle).decrypt(bytes.fromhex(seed["iv"]), base64.b64decode(seed["contenu"]), None)
    s2, iv2 = secrets.token_bytes(16), secrets.token_bytes(12)
    chiffre = AESGCM(pbkdf2(nouveau, s2)).encrypt(iv2, clair, None)
    # même identifiant : les navigateurs déjà initialisés gardent leurs saisies
    seed2 = {"id": seed["id"], "sel": s2.hex(), "iv": iv2.hex(), "iterations": iters, "contenu": base64.b64encode(chiffre).decode()}
    nouveau_js = ("/* Données initiales chiffrées (générées par outils/assembler.py) : déchiffrées par js/gate.js avec le mot de passe. */\n"
                  f"window.HH_DONNEES = {json.dumps(seed2)};\n")

sel2 = secrets.token_bytes(16)
cfg = re.sub(r'(sel\s*:\s*")[0-9a-f]+(")', lambda m: m.group(1) + sel2.hex() + m.group(2), cfg, count=1)
cfg = re.sub(r'(empreinte\s*:\s*")[0-9a-f]+(")', lambda m: m.group(1) + pbkdf2(nouveau, sel2).hex() + m.group(2), cfg, count=1)
cfg_path.write_text(cfg, encoding="utf-8")
if nouveau_js:
    data_path.write_text(nouveau_js, encoding="utf-8")
print("js/config.js mis à jour" + (" ; js/donnees.js rechiffré" if nouveau_js else ""))
subprocess.run([sys.executable, str(root / "outils/assembler.py")], check=True)
print("Terminé. Les sessions ouvertes devront saisir le nouveau mot de passe.")
