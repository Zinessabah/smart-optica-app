#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════════
#  Smart Optica — INSTALLEUR
#
#  Installe l'application complète sur une machine Debian/Ubuntu :
#    • backend FastAPI (uvicorn)          → port 8000
#    • front (build figé, ou dev --dev)   → port 5173
#    • interface admin (Vite)             → port 5174
#    • PostgreSQL (rôle + base dédiés)
#    • certificats mkcert (pour l'iPad)   • services systemd (démarrage auto)
#
#  Le script est IDEMPOTENT : on peut le relancer autant de fois que nécessaire.
#  Il ne réécrit JAMAIS un `backend/.env` existant (donc jamais vos secrets ni vos données).
#
#  Usage :  ./install.sh [options]        (./install.sh --help pour la liste complète)
# ══════════════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Valeurs par défaut (surchargées par les options) ──────────────────────────────
ROOT=""                       # racine de l'app (déduite du script, ou --dir)
GIT_URL="https://github.com/Zinessabah/smart-optica-app.git"
GIT_BRANCH="main"
DIR=""                        # destination du clone si l'app n'est pas déjà là
FRONT_MODE="build"            # build | dev   (--dev bascule les deux serveurs en dev)
DO_APT=1                      # --no-apt pour ne pas toucher aux paquets système
REFRESH_DEPS=0                # --refresh-deps pour forcer la réinstallation des dépendances
FORCE_PORTS=0                 # --force : libérer un port occupé par un process étranger
FRONT_PORT=5173
ADMIN_PORT=5174
API_PORT=8000
INSTANCE=""                   # --instance : suffixe d'isolation (2ᵉ installation sur la même machine)
DB_NAME_OPT=""                # --db-name
DB_USER_OPT=""                # --db-user
DB_URL_OPT=""                 # --db-url : base imposée (externe, SQLite…) → aucune création
DB_URL=""                     # URL réellement utilisée (construite ou fournie)
RESET_DB_PW=0                 # --reset-db-password (explicite : on ne réécrit pas un mot de passe inconnu)
ADMIN_EMAIL=""
ADMIN_PASSWORD=""
ADMIN_NAME="Administrateur"

# ── Couleurs (désactivées si la sortie n'est pas un terminal) ─────────────────────
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_HEAD=$'\033[36m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_HEAD=""; C_DIM=""; C_OFF=""
fi

step()  { printf '\n%s══ %s %s\n' "$C_HEAD" "$1" "$C_OFF"; }
ok()    { printf '  %s✓%s %s\n' "$C_OK" "$C_OFF" "$1"; }
info()  { printf '  %s·%s %s\n' "$C_DIM" "$C_OFF" "$1"; }
warn()  { printf '  %s!%s %s\n' "$C_WARN" "$C_OFF" "$1"; }
die()   { printf '\n  %s✗ %s%s\n\n' "$C_ERR" "$1" "$C_OFF" >&2; exit 1; }

trap 'die "Échec inattendu à la ligne $LINENO. Rien n'\''a été laissé à moitié installé : relancez le script (il est idempotent)."' ERR

usage() {
  cat <<'USAGE'
Smart Optica — installeur

Usage : ./install.sh [options]

Options :
  --dir PATH              Installer dans PATH (clone si l'app n'y est pas).
                          Défaut : le dossier du script s'il contient l'app.
  --git-url URL           Dépôt à cloner. Défaut : dépôt GitHub officiel.
  --branch NAME           Branche à cloner (défaut : main).
  --dev                   Front + admin en serveurs de DEV (HMR, rechargement à chaud)
                          au lieu du build figé. À réserver au développement.
  --no-apt                Ne pas installer de paquets système : vérifier et s'arrêter
                          en listant ce qui manque.
  --refresh-deps          Forcer la réinstallation des dépendances node et Python.
  --force                 Tuer les process étrangers qui occupent les ports cibles.
  --instance NAME         Suffixe d'isolation : services, journaux et base portent ce nom
                          (permet une 2ᵉ installation — recette, test — sans toucher à celle
                          qui tourne).
  --db-name NAME          Nom de la base (défaut : smartoptica, ou smartoptica_NAME).
  --db-user NAME          Utilisateur PostgreSQL (défaut : idem base).
  --db-url URL            Utiliser une base EXISTANTE et ne rien créer côté PostgreSQL.
                          Exemples :
                            --db-url postgresql://user:motdepasse@hote:5432/base
                            --db-url "sqlite:////chemin/absolu/smartoptica.db"   (sans serveur)
                          C'est aussi la façon d'installer sans droits sudo.
  --reset-db-password     Autoriser la RÉÉCRITURE du mot de passe d'un rôle PostgreSQL
                          existant. Sans cette option, un rôle dont le mot de passe n'est
                          pas connu (backend/.env absent) fait ÉCHOUER l'installation
                          plutôt que d'être modifié en silence.
  --front-port N          Port du front (défaut : 5173).
  --admin-port N          Port de l'interface admin (défaut : 5174).
  --api-port N            Port du backend (défaut : 8000).
  --admin-email EMAIL     Compte administrateur à créer (sinon demandé).
  --admin-password PASS   Mot de passe de ce compte (sinon demandé, jamais affiché).
  --admin-name NAME       Nom affiché de l'administrateur.
  -h, --help              Afficher cette aide.

Exemples :
  ./install.sh                                  # installation complète (build figé)
  ./install.sh --dev                            # développement (HMR)
  ./install.sh --dir ~/smart-optica --no-apt    # depuis un clone, sans toucher à apt

Après l'installation, ouvrir le CA mkcert (certs/rootCA.pem) sur l'iPad pour que
Safari accepte le certificat : Réglages → Général → VPN et gestion de l'appareil.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)             DIR="${2:?--dir attend un chemin}"; shift 2 ;;
    --git-url)         GIT_URL="${2:?}"; shift 2 ;;
    --branch)          GIT_BRANCH="${2:?}"; shift 2 ;;
    --dev)             FRONT_MODE="dev"; shift ;;
    --no-apt)          DO_APT=0; shift ;;
    --refresh-deps)    REFRESH_DEPS=1; shift ;;
    --force)           FORCE_PORTS=1; shift ;;
    --instance)        INSTANCE="${2:?--instance attend un nom}"; shift 2 ;;
    --db-name)         DB_NAME_OPT="${2:?}"; shift 2 ;;
    --db-user)         DB_USER_OPT="${2:?}"; shift 2 ;;
    --db-url)          DB_URL_OPT="${2:?}"; shift 2 ;;
    --reset-db-password) RESET_DB_PW=1; shift ;;
    --front-port)      FRONT_PORT="${2:?}"; shift 2 ;;
    --admin-port)      ADMIN_PORT="${2:?}"; shift 2 ;;
    --api-port)        API_PORT="${2:?}"; shift 2 ;;
    --admin-email)     ADMIN_EMAIL="${2:?}"; shift 2 ;;
    --admin-password)  ADMIN_PASSWORD="${2:?}"; shift 2 ;;
    --admin-name)      ADMIN_NAME="${2:?}"; shift 2 ;;
    -h|--help)         usage; exit 0 ;;
    *)                 die "Option inconnue : $1   (./install.sh --help)" ;;
  esac
done

for p in "$FRONT_PORT" "$ADMIN_PORT" "$API_PORT"; do
  [[ "$p" =~ ^[0-9]+$ ]] || die "Port invalide : « $p »"
done
[ "$FRONT_PORT" != "$ADMIN_PORT" ] || die "Les ports front et admin doivent être différents."
[ "$(id -u)" != "0" ] || die "Ne lancez PAS ce script en root : les services sont installés pour l'utilisateur courant (systemd --user). Relancez-le sans sudo."

# ── Isolation multi-instance : noms de services, journaux et base ─────────────────
if [ -n "$INSTANCE" ]; then
  [[ "$INSTANCE" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "Nom d'instance invalide (minuscules, chiffres, tirets) : « $INSTANCE »"
  SVC_PREFIX="smart-optica-$INSTANCE"
  DB_NAME="${DB_NAME_OPT:-smartoptica_$INSTANCE}"
  DB_USER="${DB_USER_OPT:-$DB_NAME}"
else
  SVC_PREFIX="smart-optica"
  DB_NAME="${DB_NAME_OPT:-smartoptica}"
  DB_USER="${DB_USER_OPT:-$DB_NAME}"
fi
LOG_PREFIX="$SVC_PREFIX"

# ENV_FILE (fichier de configuration du backend) est résolu dans source_phase, une fois la
# racine du projet connue. Une instance (--instance) a le SIEN : elle ne peut donc pas hériter
# par accident de la configuration — et donc de la base — de la production.


# ══════════════════════════════════════════════════════════════════════════════════
#  PHASE 1 — Préflight : OS, outils, droits
# ══════════════════════════════════════════════════════════════════════════════════
APT_PACKAGES=(postgresql postgresql-contrib mkcert python3-venv build-essential curl git openssl ca-certificates)

preflight() {
  step "1/11 · Vérification de la machine"

  [ -r /etc/os-release ] || die "Système non identifié (pas de /etc/os-release)."
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}${ID_LIKE:-}" in
    *debian*|*ubuntu*) ok "Système : ${PRETTY_NAME:-$ID}" ;;
    *) warn "Système non Debian/Ubuntu (${PRETTY_NAME:-$ID}) — apt et les noms de paquets peuvent différer." ;;
  esac

  command -v sudo >/dev/null || warn "sudo est absent : les étapes nécessitant les droits root échoueront."
  ok "Utilisateur : $(id -un) · dossier personnel : $HOME"

  # Node : ≥ 20 requis par Vite. On installe via apt si absent, puis on CONTRÔLE la version
  # (apt livre Node 18 sur Ubuntu 24.04, trop ancien → on explique au lieu d'installer un Node cassé).
  if command -v node >/dev/null; then
    local major; major="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
    if [ "$major" -ge 20 ]; then ok "Node $(node --version)"
    else warn "Node $(node --version) est trop ancien (≥ 20 requis). Installez-le :"
         warn "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
         if [ "$DO_APT" = "1" ]; then die "Node trop ancien : l'installation s'arrête ici pour ne pas casser votre environnement."; fi
    fi
  else
    warn "Node est absent."
  fi
}

# ══════════════════════════════════════════════════════════════════════════════════
#  PHASE 2 — Paquets système
# ══════════════════════════════════════════════════════════════════════════════════
apt_phase() {
  step "2/11 · Paquets système"

  local missing=()
  for pkg in "${APT_PACKAGES[@]}"; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  command -v node >/dev/null 2>&1 || missing+=(nodejs npm)

  if [ "${#missing[@]}" -eq 0 ]; then ok "Tous les paquets requis sont déjà installés"; return; fi

  info "Manquants : ${missing[*]}"
  if [ "$DO_APT" = "0" ]; then
    die "--no-apt : installez-les vous-même puis relancez :
       sudo apt-get update && sudo apt-get install -y ${missing[*]}"
  fi

  info "Installation via apt (peut prendre quelques minutes)…"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
  ok "Paquets installés : ${missing[*]}"
}

# ══════════════════════════════════════════════════════════════════════════════════
#  PHASE 3 — Code source
# ══════════════════════════════════════════════════════════════════════════════════
is_app_dir() { [ -f "$1/package.json" ] && [ -d "$1/src" ] && [ -d "$1/backend" ]; }

source_phase() {
  step "3/11 · Code de l'application"

  if is_app_dir "$SCRIPT_DIR"; then
    ROOT="$SCRIPT_DIR"
    ok "Application trouvée sur place : $ROOT"
  elif [ -n "$DIR" ] && is_app_dir "$DIR"; then
    ROOT="$(cd "$DIR" && pwd)"
    ok "Application trouvée : $ROOT"
  else
    local target="${DIR:-$HOME/smart-optica-app}"
    if is_app_dir "$target" && [ -d "$target/.git" ]; then
      ROOT="$(cd "$target" && pwd)"
      info "Dépôt existant — mise à jour depuis origin/$GIT_BRANCH…"
      git -C "$ROOT" fetch origin "$GIT_BRANCH" -q
      git -C "$ROOT" checkout -q "$GIT_BRANCH"
      git -C "$ROOT" merge --ff-only "origin/$GIT_BRANCH" -q || warn "Mise à jour impossible (dépôt modifié localement) — on continue avec l'état actuel."
    else
      command -v git >/dev/null || die "git est requis pour cloner l'application."
      info "Clone de $GIT_URL ($GIT_BRANCH) → $target…"
      mkdir -p "$(dirname "$target")"
      git clone -q --branch "$GIT_BRANCH" "$GIT_URL" "$target"
      ROOT="$(cd "$target" && pwd)"
    fi
    ok "Application : $ROOT"
  fi

  cd "$ROOT"
  [ -f package-lock.json ] || warn "package-lock.json absent : les versions JavaScript ne seront pas verrouillées."
  [ -f backend/requirements.txt ] || die "backend/requirements.txt absent : impossible de reconstruire l'environnement Python."
  ok "Dépôt git : $(git rev-parse --short HEAD 2>/dev/null || echo 'aucun')"

  # Configuration : fichier propre à l'instance, sinon celui de l'application
  ENV_FILE="$ROOT/backend/.env"
  if [ -n "$INSTANCE" ]; then
    ENV_FILE="$ROOT/backend/.env.$INSTANCE"
    info "Instance « $INSTANCE » → configuration dédiée : backend/.env.$INSTANCE"
  fi
}

# ══════════════════════════════════════════════════════════════════════════════════
#  PHASE 4 — Dépendances Node
# ══════════════════════════════════════════════════════════════════════════════════
node_phase() {
  step "4/11 · Dépendances JavaScript"
  cd "$ROOT"

  if [ "$REFRESH_DEPS" = "0" ] && [ -f node_modules/.package-lock.json ]; then
    ok "node_modules déjà installé (--refresh-deps pour forcer)"
  else
    if [ -f package-lock.json ]; then
      info "npm ci (installation reproductible)…"
      if ! npm ci --no-audit --no-fund; then
        warn "npm ci a échoué (package-lock.json désynchronisé de package.json) — repli sur npm install."
        warn "  Pour corriger durablement : npm install --package-lock-only"
        npm install --no-audit --no-fund
      fi
    else
      info "npm install…"
      npm install --no-audit --no-fund
    fi
    ok "Dépendances JavaScript installées"
  fi

  [ -x node_modules/.bin/vite ] || die "Vite est introuvable dans node_modules — installation JavaScript incomplète."
}

# ══════════════════════════════════════════════════════════════════════════════════
#  PHASE 5 — Dépendances Python (venv)
# ══════════════════════════════════════════════════════════════════════════════════
python_phase() {
  step "5/11 · Environnement Python (venv)"
  cd "$ROOT"

  [ -d backend/venv ] || { info "Création du venv…"; python3 -m venv backend/venv; }
  ok "venv : $ROOT/backend/venv ($(backend/venv/bin/python --version 2>&1))"

  local stamp="backend/venv/.so-requirements.sha"
  local want; want="$(sha256sum backend/requirements.txt | cut -d' ' -f1)"
  if [ "$REFRESH_DEPS" = "0" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
    ok "Dépendances Python à jour (empreinte ${want:0:12}…)"
  else
    info "Installation des dépendances Python (mediapipe, opencv… 2 à 4 minutes)…"
    backend/venv/bin/python -m pip install -q --upgrade pip
    backend/venv/bin/pip install -q -r backend/requirements.txt
    echo "$want" > "$stamp"
    ok "Dépendances Python installées"
  fi

  if ! backend/venv/bin/python -c "import fastapi, sqlalchemy, bcrypt, jose, cv2, mediapipe, dotenv, multipart" 2>/dev/null; then
    die "Des modules Python essentiels manquent après installation (fastapi, sqlalchemy, bcrypt, python-jose, cv2, mediapipe, dotenv, python-multipart)."
  fi
  ok "Modules essentiels importables"
}

# ══════════════════════════════════════════════════════════════════════════════════
#  PHASE 6 — PostgreSQL (rôle + base)
# ══════════════════════════════════════════════════════════════════════════════════
DB_PASS=""; DB_HOST="localhost"; DB_PORT="5432"   # DB_USER / DB_NAME : définis plus haut (instance)

psql_super() {   # lit le SQL sur STDIN, s'exécute en superutilisateur postgres
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- psql "$@"
  else sudo -u postgres psql "$@"; fi
}

# Extrait une clé d'un fichier .env sans jamais l'afficher
env_get() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | head -1 | sed 's/^"//; s/"$//' || true; }

# Contrôle réel : la base répond-elle vraiment ? (create_engine + select 1)
verify_db() {
  DATABASE_URL="$1" JWT_SECRET="verification" \
  "$ROOT/backend/venv/bin/python" -c '
import os
from sqlalchemy import create_engine, text
url = os.environ["DATABASE_URL"]
eng = create_engine(url, pool_pre_ping=True,
                    connect_args={"check_same_thread": False} if url.startswith("sqlite") else {})
with eng.connect() as c:
    c.execute(text("select 1"))
' || return 1
}

database_phase() {
  step "6/11 · Base de données"

  # ── Cas 1 : base fournie (externe, SQLite, gérée ailleurs) → aucune création
  if [ -n "$DB_URL_OPT" ]; then
    DB_URL="$DB_URL_OPT"
    case "$DB_URL" in
      sqlite*) info "Base SQLite — aucun serveur PostgreSQL nécessaire" ;;
      *)       info "Base fournie via --db-url" ;;
    esac
    verify_db "$DB_URL" || die "La base indiquée ne répond pas (--db-url)."
    ok "Base joignable"
    return
  fi

  # ── Cas 1bis : une base NON PostgreSQL est déjà configurée dans le .env de l'instance
  # (SQLite, base gérée…) → on la réutilise telle quelle. Sans ce cas, une RELANCE du script
  # retomberait sur le chemin PostgreSQL et tenterait de créer un rôle à partir d'une URL SQLite.
  local url_env; url_env="$(env_get "$ENV_FILE" DATABASE_URL)"
  if [ -z "$DB_URL_OPT" ] && [ -n "$url_env" ] && [[ "$url_env" != postgres* ]]; then
    DB_URL="$url_env"
    info "Base déjà configurée dans $(basename "$ENV_FILE") — réutilisée telle quelle"
    verify_db "$DB_URL" || die "La base configurée dans $(basename "$ENV_FILE") ne répond pas."
    ok "Base joignable"
    return
  fi

  # ── Cas 2 : PostgreSQL local — rôle et base créés si nécessaire
  command -v psql >/dev/null || die "psql est introuvable (installez postgresql-client)."
  if systemctl is-active --quiet postgresql; then
    ok "Service PostgreSQL déjà actif"
  else
    sudo systemctl enable --now postgresql >/dev/null 2>&1 || die "Impossible de démarrer PostgreSQL."
    ok "Service PostgreSQL démarré"
  fi

  # Créer un rôle/base exige les droits superutilisateur : on le vérifie MAINTENANT, pour
  # s'arrêter avec une explication utile plutôt qu'au milieu des commandes SQL.
  if ! printf 'SELECT 1' | psql_super -tA >/dev/null; then
    die "Accès superutilisateur PostgreSQL impossible (sudo -u postgres psql).
       Solutions, au choix :
         • relancer l'installeur depuis un terminal où vous pouvez saisir votre mot de passe sudo ;
         • créer vous-même le rôle et la base, puis déclarer DATABASE_URL dans $ENV_FILE ;
         • réutiliser une base existante : --db-url postgresql://utilisateur:motdepasse@hote:5432/base
         • ou installer sans PostgreSQL : --db-url \"sqlite:////chemin/absolu/smartoptica.db\""
  fi
  ok "Accès superutilisateur PostgreSQL vérifié"

  # Une base existante (donc un .env existant) fait foi : on RÉUTILISE ses identifiants.
  local url_existing="" pw_from_env=0
  url_existing="$(env_get "$ENV_FILE" DATABASE_URL)"
  if [ -n "$url_existing" ]; then
    read -r DB_USER DB_PASS DB_NAME DB_HOST DB_PORT < <(printf '%s' "$url_existing" | python3 -c '
import sys
from urllib.parse import urlsplit, unquote
u = urlsplit(sys.stdin.read().strip())
print(unquote(u.username or "smartoptica"), unquote(u.password or ""),
      (u.path or "/smartoptica").lstrip("/"), u.hostname or "localhost", u.port or 5432)')
    [ -n "$DB_PASS" ] && pw_from_env=1
    info "Identifiants repris du .env existant (base « $DB_NAME », utilisateur « $DB_USER »)"
  fi
  [ -n "$DB_PASS" ] || DB_PASS="$(openssl rand -hex 24)"   # aléatoire, hexa : aucun souci de quoting SQL

  # ── Rôle PostgreSQL ──
  # ⚠️ On ne réécrit JAMAIS en silence le mot de passe d'un rôle existant : s'il n'est pas
  #    connu (pas de backend/.env), on s'arrête avec la marche à suivre. Sinon une simple
  #    réinstallation couperait l'accès aux données existantes.
  if [ "$(printf "SELECT 1 FROM pg_roles WHERE rolname='%s'" "$DB_USER" | psql_super -tA 2>/dev/null)" = "1" ]; then
    if [ "$pw_from_env" = "1" ]; then
      printf "ALTER ROLE \"%s\" WITH LOGIN PASSWORD '%s'" "$DB_USER" "$DB_PASS" | psql_super -q >/dev/null
      ok "Rôle « $DB_USER » existant : mot de passe réaligné sur backend/.env"
    elif [ "$RESET_DB_PW" = "1" ]; then
      printf "ALTER ROLE \"%s\" WITH LOGIN PASSWORD '%s'" "$DB_USER" "$DB_PASS" | psql_super -q >/dev/null
      ok "Rôle « $DB_USER » existant : mot de passe RÉINITIALISÉ (--reset-db-password)"
    else
      die "Le rôle PostgreSQL « $DB_USER » existe déjà et son mot de passe est introuvable (pas de backend/.env).\n       Je ne le modifie pas : vos données sont intactes.\n         • Si vous connaissez ce mot de passe : créez backend/.env avec la bonne DATABASE_URL, puis relancez.\n         • Si vous l'avez perdu : relancez avec --reset-db-password (les données sont conservées)."
    fi
  else
    printf "CREATE ROLE \"%s\" WITH LOGIN PASSWORD '%s'" "$DB_USER" "$DB_PASS" | psql_super -q >/dev/null
    ok "Rôle « $DB_USER » créé"
  fi

  # Base + droits (PostgreSQL ≥ 15 n'accorde plus « public » par défaut)
  if [ "$(printf "SELECT 1 FROM pg_database WHERE datname='%s'" "$DB_NAME" | psql_super -tA 2>/dev/null)" = "1" ]; then
    ok "Base « $DB_NAME » déjà présente — vos données sont conservées"
  else
    printf 'CREATE DATABASE "%s" OWNER "%s"' "$DB_NAME" "$DB_USER" | psql_super -q >/dev/null
    ok "Base « $DB_NAME » créée"
  fi
  printf 'GRANT ALL ON SCHEMA public TO "%s"' "$DB_USER" | psql_super -q -d "$DB_NAME" >/dev/null 2>&1 || true

  DB_URL="postgresql://$DB_USER:$DB_PASS@$DB_HOST:$DB_PORT/$DB_NAME"
  verify_db "$DB_URL" || die "La base refuse la connexion avec ces identifiants (rôle/droits à vérifier)."
  ok "Connexion vérifiée avec les identifiants de l'application"
}

# ══════════════════════════════════════════════════════════════════════════════════
#  PHASE 7 — Fichier .env du backend
# ══════════════════════════════════════════════════════════════════════════════════
IP_LIST=()

detect_ips() {   # IPv4 des interfaces + IP Tailscale (accès iPad distant)
  { hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true
    if command -v tailscale >/dev/null 2>&1; then tailscale ip -4 2>/dev/null || true; fi
  } | grep -v '^127\.' | sort -u
}

env_phase() {
  step "7/11 · Configuration du backend (.env)"
  mapfile -t IP_LIST < <(detect_ips)
  [ "${#IP_LIST[@]}" -gt 0 ] && ok "Adresses détectées : ${IP_LIST[*]}" || warn "Aucune adresse réseau détectée : l'accès depuis un autre appareil sera limité à localhost."

  local env_file="$ENV_FILE"
  if [ -f "$env_file" ]; then
    ok "$(basename "$env_file") déjà présent — CONSERVÉ tel quel (aucun secret réécrit)"
    chmod 600 "$env_file"
    return
  fi
  [ -n "$DB_URL" ] || die "Aucune base de données configurée (ni création PostgreSQL, ni --db-url)."

  local cors="https://localhost:$FRONT_PORT,https://127.0.0.1:$FRONT_PORT"
  local ip
  for ip in "${IP_LIST[@]:-}"; do
    [ -n "$ip" ] && cors="$cors,https://$ip:$FRONT_PORT,https://$ip:$ADMIN_PORT"
  done

  umask 077
  cat > "$env_file" <<EOF
# Généré par install.sh — $(date -Iseconds)
# Ce fichier contient des secrets : il est en chmod 600 et ne doit JAMAIS être commité.
DATABASE_URL="$DB_URL"
JWT_SECRET=$(openssl rand -hex 32)
JWT_EXPIRE_HOURS=168
APP_ENV=production
CORS_ORIGINS=$cors
EOF
  chmod 600 "$env_file"
  ok "$(basename "$env_file") créé (JWT_SECRET aléatoire 256 bits, mot de passe base aléatoire, mode 600)"
}

# ══════════════════════════════════════════════════════════════════════════════════
#  PHASE 8 — Certificats mkcert (HTTPS pour l'iPad)
# ══════════════════════════════════════════════════════════════════════════════════
cert_phase() {
  step "8/11 · Certificats HTTPS (mkcert)"
  cd "$ROOT"
  mkdir -p certs

  # CA locale : créée si absente. `mkcert -install` peut échouer sans TTY (le CA est créé quand même).
  if [ ! -f "$HOME/.local/share/mkcert/rootCA.pem" ]; then
    info "Création de l'autorité locale (CA)…"
    mkcert -install 2>/dev/null || warn "mkcert -install n'a pas pu s'exécuter complètement (sans TTY c'est normal : la CA est créée)."
  fi
  local ca="$HOME/.local/share/mkcert/rootCA.pem"
  [ -f "$ca" ] || die "La CA mkcert est introuvable ($ca)."
  ok "Autorité locale : $ca"

  # Le certificat doit couvrir CHAQUE adresse utilisée par la tablette — sinon Safari refuse.
  local need_regen=1
  if [ -f certs/localhost.pem ]; then
    local san; san="$(openssl x509 -in certs/localhost.pem -noout -ext subjectAltName 2>/dev/null || true)"
    need_regen=0
    local ip
    for ip in "${IP_LIST[@]:-}"; do
      [ -n "$ip" ] && grep -q "IP Address:$ip" <<<"$san" || { need_regen=1; break; }
    done
    [ "$need_regen" = "0" ] && ok "Certificat existant déjà valable pour toutes les adresses (SAN inchangé)"
  fi

  if [ "$need_regen" = "1" ]; then
    local hosts=(localhost 127.0.0.1 ::1)
    local ip; for ip in "${IP_LIST[@]:-}"; do [ -n "$ip" ] && hosts+=("$ip"); done
    mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem "${hosts[@]}" >/dev/null
    ok "Certificat (re)généré pour : ${hosts[*]}"
  fi

  cp -f "$ca" certs/rootCA.pem
  ok "CA copiée dans certs/rootCA.pem (à approuver sur l'iPad)"

  openssl x509 -in certs/localhost.pem -noout -ext subjectAltName | tail -n +2 | sed 's/^ */    /'
}

# ══════════════════════════════════════════════════════════════════════════════════
#  PHASE 9 — Build du front et de l'admin
# ══════════════════════════════════════════════════════════════════════════════════
build_phase() {
  step "9/11 · Build des interfaces"
  cd "$ROOT"

  if [ "$FRONT_MODE" = "dev" ]; then
    info "Mode développement (--dev) : pas de build, les serveurs serviront les sources."
    ok "Build ignoré"
    return
  fi

  info "Build du front (vite build)…"
  npm run build
  [ -f dist/index.html ] || die "Le build du front n'a pas produit dist/index.html."
  ok "Front construit : dist/"

  info "Build de l'administration…"
  npx vite build --config admin/vite.config.js
  [ -f admin/dist/index.html ] || die "Le build de l'admin n'a pas produit admin/dist/index.html."
  ok "Admin construit : admin/dist/"
}

# ══════════════════════════════════════════════════════════════════════════════════
#  PHASE 10 — Services systemd (utilisateur)
# ══════════════════════════════════════════════════════════════════════════════════
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FRONT="$SVC_PREFIX-front.service"
UNIT_ADMIN="$SVC_PREFIX-admin.service"
UNIT_BACK="$SVC_PREFIX-backend.service"

port_owner_pid() { ss -tlnpH "sport = :$1" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1; }

free_port() {   # $1 = port, $2 = nom de l'unité qui a le droit de l'occuper
  local port="$1" unit="$2" pid
  pid="$(port_owner_pid "$port")"
  [ -z "$pid" ] && return 0
  if [ "$(systemctl --user show -p MainPID --value "$unit" 2>/dev/null || true)" = "$pid" ]; then
    return 0   # c'est déjà notre service : systemd va le relancer proprement
  fi
  if [ "$FORCE_PORTS" = "1" ]; then
    warn "Port $port occupé par le PID $pid — libéré (--force)"
    kill "$pid" 2>/dev/null || true
    sleep 1
    return 0
  fi
  die "Le port $port est occupé par un autre programme (PID $pid).
       Arrêtez-le puis relancez, ou utilisez --force :
         kill $pid"
}

write_unit() {   # $1 = nom du fichier, reste = contenu
  local name="$1"; shift
  printf '%s\n' "$@" > "$UNIT_DIR/$name"
  chmod 644 "$UNIT_DIR/$name"
}

units_phase() {
  step "10/11 · Services systemd (démarrage automatique)"
  cd "$ROOT"
  mkdir -p "$UNIT_DIR"

  local node_dir; node_dir="$(dirname "$(command -v node)")"
  local bin_path="$ROOT/node_modules/.bin:$node_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

  # ── Ports libres ? (on ne tue rien sans --force)
  free_port "$API_PORT" "$UNIT_BACK"
  free_port "$FRONT_PORT" "$UNIT_FRONT"
  free_port "$ADMIN_PORT" "$UNIT_ADMIN"

  # ── Backend (uvicorn)
  write_unit "$UNIT_BACK" \
    "[Unit]" \
    "Description=Smart Optica — backend FastAPI (port $API_PORT)" \
    "After=network-online.target" \
    "Wants=network-online.target" \
    "StartLimitIntervalSec=0" \
    "" \
    "[Service]" \
    "Type=simple" \
    "WorkingDirectory=$ROOT/backend" \
    "ExecStart=$ROOT/backend/venv/bin/uvicorn main:app --host 0.0.0.0 --port $API_PORT" \
    "EnvironmentFile=-$ENV_FILE" \
    "Environment=\"PATH=$ROOT/backend/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"" \
    "Environment=\"VIRTUAL_ENV=$ROOT/backend/venv\"" \
    "Restart=always" \
    "RestartSec=5" \
    "KillMode=mixed" \
    "TimeoutStopSec=60" \
    "StandardOutput=append:$HOME/$LOG_PREFIX-backend.log" \
    "StandardError=append:$HOME/$LOG_PREFIX-backend.log" \
    "" \
    "[Install]" \
    "WantedBy=default.target"

  # ── Front : build figé (preview) ou dev (HMR)
  local front_cmd front_desc
  if [ "$FRONT_MODE" = "dev" ]; then
    front_cmd="$ROOT/node_modules/.bin/vite --host 0.0.0.0 --port $FRONT_PORT"
    front_desc="serveur de développement (HMR)"
  else
    front_cmd="$ROOT/node_modules/.bin/vite preview --host 0.0.0.0 --port $FRONT_PORT"
    front_desc="build figé (dist/)"
  fi
  write_unit "$UNIT_FRONT" \
    "[Unit]" \
    "Description=Smart Optica — front $front_desc (port $FRONT_PORT)" \
    "After=network-online.target" \
    "Wants=network-online.target" \
    "StartLimitIntervalSec=0" \
    "" \
    "[Service]" \
    "Type=simple" \
    "WorkingDirectory=$ROOT" \
    "ExecStart=$front_cmd" \
    "Environment=\"PATH=$bin_path\"" \
    "Restart=always" \
    "RestartSec=5" \
    "KillMode=mixed" \
    "TimeoutStopSec=30" \
    "StandardOutput=append:$HOME/$LOG_PREFIX-front.log" \
    "StandardError=append:$HOME/$LOG_PREFIX-front.log" \
    "" \
    "[Install]" \
    "WantedBy=default.target"

  # ── Admin
  local admin_cmd
  if [ "$FRONT_MODE" = "dev" ]; then
    admin_cmd="$ROOT/node_modules/.bin/vite --config admin/vite.config.js --host 0.0.0.0 --port $ADMIN_PORT"
  else
    admin_cmd="$ROOT/node_modules/.bin/vite preview --config admin/vite.config.js --host 0.0.0.0 --port $ADMIN_PORT"
  fi
  write_unit "$UNIT_ADMIN" \
    "[Unit]" \
    "Description=Smart Optica — interface admin (port $ADMIN_PORT)" \
    "After=network-online.target" \
    "Wants=network-online.target" \
    "StartLimitIntervalSec=0" \
    "" \
    "[Service]" \
    "Type=simple" \
    "WorkingDirectory=$ROOT" \
    "ExecStart=$admin_cmd" \
    "Environment=\"PATH=$bin_path\"" \
    "Restart=always" \
    "RestartSec=5" \
    "KillMode=mixed" \
    "TimeoutStopSec=30" \
    "StandardOutput=append:$HOME/$LOG_PREFIX-admin.log" \
    "StandardError=append:$HOME/$LOG_PREFIX-admin.log" \
    "" \
    "[Install]" \
    "WantedBy=default.target"

  systemctl --user daemon-reload
  ok "Unités écrites dans $UNIT_DIR"

  # ── Démarrage sans session ouverte (sinon rien ne tourne au reboot)
  if loginctl enable-linger "$(id -un)" 2>/dev/null; then ok "Démarrage sans session activé (linger)"
  else warn "« loginctl enable-linger » a échoué : les services ne démarreront pas au reboot sans session ouverte."; fi

  local u
  for u in "$UNIT_BACK" "$UNIT_FRONT" "$UNIT_ADMIN"; do
    systemctl --user enable "$u" >/dev/null 2>&1
    systemctl --user restart "$u"
    ok "Service $u activé et (re)démarré"
  done
}

# ══════════════════════════════════════════════════════════════════════════════════
#  PHASE 11 — Compte administrateur + auto-contrôle
# ══════════════════════════════════════════════════════════════════════════════════
admin_user_phase() {
  step "11/11 · Compte administrateur"

  # Le backend charge `backend/.env` sans écraser l'environnement du process : en exportant
  # DATABASE_URL ici, on garantit que le compte est créé dans LA BASE DE CETTE INSTALLATION
  # (et jamais dans celle de la production quand on installe une instance de test).
  export DATABASE_URL="$DB_URL"

  local existing=""
  existing="$(cd "$ROOT/backend" && venv/bin/python -c '
from dotenv import load_dotenv
load_dotenv()
try:
    from auth import SessionLocal, User
    from sqlalchemy import select
    with SessionLocal() as db:
        print(sum(1 for u in db.scalars(select(User)) if u.role == "admin"))
except Exception:
    print("erreur")
' 2>/dev/null)" || true
  if [ "$existing" != "0" ] && [ -n "$existing" ] && [ "$existing" != "erreur" ]; then
    ok "$existing compte(s) administrateur déjà présent(s) — aucun compte créé"
    return
  fi
  if [ "$existing" = "erreur" ] || [ -z "$existing" ]; then
    warn "Lecture des comptes impossible — création manuelle ignorée (l'app reste utilisable)."
    return
  fi

  if [ -z "$ADMIN_EMAIL" ]; then
    if [ -t 0 ]; then
      read -rp "  E-mail de l'administrateur : " ADMIN_EMAIL
    else
      die "Tout est installé SAUF le compte administrateur : en mode non interactif il faut
       fournir l'e-mail et le mot de passe. Les services tournent déjà, il suffit de relancer :
         ./install.sh${INSTANCE:+ --instance $INSTANCE} --admin-email vous@exemple.fr --admin-password 'votre-mot-de-passe'"
    fi
  fi
  if [ -z "$ADMIN_PASSWORD" ]; then
    if [ -t 0 ]; then
      local p1 p2
      read -rsp "  Mot de passe (8 caractères minimum, non affiché) : " p1; echo
      read -rsp "  Confirmation : " p2; echo
      [ "$p1" = "$p2" ] || die "Les mots de passe ne correspondent pas."
      ADMIN_PASSWORD="$p1"
    else
      ADMIN_PASSWORD="$(openssl rand -base64 12)"
      GENERATED_PASSWORD="$ADMIN_PASSWORD"
    fi
  fi
  [ "${#ADMIN_PASSWORD}" -ge 8 ] || die "Mot de passe trop court (8 caractères minimum)."

  export ADMIN_EMAIL ADMIN_PASSWORD ADMIN_NAME
  if (cd "$ROOT/backend" && venv/bin/python -c '
import os
from dotenv import load_dotenv
load_dotenv()
from auth import SessionLocal, User, hash_password
from sqlalchemy import select
with SessionLocal() as db:
    email = os.environ["ADMIN_EMAIL"].strip().lower()
    u = db.scalar(select(User).where(User.email == email))
    if u:
        u.role = "admin"
        u.password_hash = hash_password(os.environ["ADMIN_PASSWORD"])
        u.name = os.environ["ADMIN_NAME"]
        db.commit()
        print("  · compte existant promu administrateur et mot de passe réinitialisé")
    else:
        db.add(User(email=email, name=os.environ["ADMIN_NAME"],
                    password_hash=hash_password(os.environ["ADMIN_PASSWORD"]),
                    role="admin", is_active=True))
        db.commit()
        print("  · compte administrateur créé")
'); then ok "Compte administrateur : $ADMIN_EMAIL"
  else die "Création du compte administrateur impossible."; fi
}

selfcheck_phase() {
  step "Contrôle final"
  local fail=0

  wait_http() {   # $1 = url, $2 = libellé, $3 = options curl (facultatif)
    local i code
    for i in $(seq 1 20); do
      # shellcheck disable=SC2086
      code="$(curl -s -k -m 4 -o /dev/null -w '%{http_code}' ${3:-} "$1" 2>/dev/null || true)"
      [ "$code" = "200" ] && { ok "$2 → HTTP 200"; return 0; }
      sleep 1.5
    done
    warn "$2 → pas de réponse 200 (dernier code : ${code:-aucun})"; fail=1; return 1
  }

  wait_http "http://127.0.0.1:$API_PORT/health" "Backend  ($API_PORT)"
  wait_http "https://127.0.0.1:$FRONT_PORT/"     "Front    ($FRONT_PORT)"
  wait_http "https://127.0.0.1:$ADMIN_PORT/"     "Admin    ($ADMIN_PORT)"

  local ip
  for ip in "${IP_LIST[@]:-}"; do
    [ -z "$ip" ] && continue
    if curl -s -k -m 4 -o /dev/null "https://$ip:$FRONT_PORT/"; then ok "Joignable depuis le réseau : https://$ip:$FRONT_PORT/"
    else warn "Non joignable sur https://$ip:$FRONT_PORT/ (pare-feu ?)"; fi
  done

  [ -f "$ENV_FILE" ] && [ "$(stat -c '%a' "$ENV_FILE")" = "600" ] \
    && ok "$(basename "$ENV_FILE") en mode 600 (lisible par le seul propriétaire)" \
    || warn "$(basename "$ENV_FILE") n'est pas en mode 600 — corrigez : chmod 600 $ENV_FILE"

  return $fail
}

summary() {
  local ip="${IP_LIST[0]:-127.0.0.1}"
  printf '\n%s╔════════════════════════════════════════════════════════════════════╗%s\n' "$C_OK" "$C_OFF"
  printf   '%s║              SMART OPTICA — INSTALLATION TERMINÉE                  ║%s\n' "$C_OK" "$C_OFF"
  printf   '%s╚════════════════════════════════════════════════════════════════════╝%s\n\n' "$C_OK" "$C_OFF"
  printf '  Application (iPads/tablettes)  %shttps://%s:%s/%s\n' "$C_HEAD" "$ip" "$FRONT_PORT" "$C_OFF"
  printf '  Interface d’administration     %shttps://%s:%s/%s\n' "$C_HEAD" "$ip" "$ADMIN_PORT" "$C_OFF"
  printf '  API (santé)                    %shttp://localhost:%s/health%s\n\n' "$C_HEAD" "$API_PORT" "$C_OFF"
  printf '  Mode front : %s\n' "$FRONT_MODE"
  printf '  Dossier    : %s\n' "$ROOT"
  printf '  Journaux   : ~/%s-{front,admin,backend}.log\n\n' "$LOG_PREFIX"
  printf '  %s⚠ SUR CHAQUE iPAD, une seule fois :%s ouvrez %scerts/rootCA.pem%s (AirDrop ou\n' "$C_WARN" "$C_OFF" "$C_HEAD" "$C_OFF"
  printf '    navigateur) puis Réglages → Général → VPN et gestion de l’appareil → approuver.\n'
  printf '    Sans cette étape, Safari refusera le certificat et la caméra restera bloquée.\n\n'
  if [ -n "${GENERATED_PASSWORD:-}" ]; then
    printf '  %sMot de passe administrateur généré (notez-le, il ne sera plus affiché) :%s\n' "$C_WARN" "$C_OFF"
    printf '    %s\n\n' "$GENERATED_PASSWORD"
  fi
  printf '  Commandes utiles :\n'
  printf '    systemctl --user status  %s-{front,admin,backend}\n' "$SVC_PREFIX"
  printf '    systemctl --user restart %s-front\n' "$SVC_PREFIX"
  printf '    ./uninstall.sh%s                                     # désinstallation\n\n' \
    "$([ -n "$INSTANCE" ] && printf ' --instance %s' "$INSTANCE")"
}

# ══════════════════════════════════════════════════════════════════════════════════
main() {
  printf '\n%sSmart Optica — installeur%s  ·  mode front : %s\n' "$C_HEAD" "$C_OFF" "$FRONT_MODE"
  preflight
  apt_phase
  source_phase
  node_phase
  python_phase
  database_phase
  env_phase
  cert_phase
  build_phase
  units_phase
  admin_user_phase
  if selfcheck_phase; then :; else warn "Un ou plusieurs contrôles ont échoué — voir les journaux : journalctl --user -u $SVC_PREFIX-front -n 50"; fi
  summary
}

main
