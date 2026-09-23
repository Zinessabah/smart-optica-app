#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════════
#  Smart Optica — DÉSINSTALLEUR
#
#  Par défaut, il retire UNIQUEMENT les services (arrêt, désactivation, suppression des
#  unités systemd). Vos DONNÉES sont conservées : base PostgreSQL, photos importées,
#  certificats et secrets restent en place — l'installation peut être refaite à l'identique.
#
#  Pour tout effacer réellement (base + photos + secrets), il faut le demander
#  explicitement :  ./uninstall.sh --purge
#
#  Usage : ./uninstall.sh [--instance NAME] [--purge] [--yes] [--dir PATH]
# ══════════════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INSTANCE=""
PURGE=0
ASSUME_YES=0
DIR=""
FRONT_PORT=5173
ADMIN_PORT=5174
API_PORT=8000

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_HEAD=$'\033[36m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_HEAD=""; C_DIM=""; C_OFF=""
fi
step() { printf '\n%s══ %s %s\n' "$C_HEAD" "$1" "$C_OFF"; }
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_OFF" "$1"; }
info() { printf '  %s·%s %s\n' "$C_DIM" "$C_OFF" "$1"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_OFF" "$1"; }
die()  { printf '\n  %s✗ %s%s\n\n' "$C_ERR" "$1" "$C_OFF" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Smart Optica — désinstalleur

Usage : ./uninstall.sh [options]

Options :
  --instance NAME     Cibler l'instance NAME (services smart-optica-NAME-*).
  --dir PATH          Dossier de l'application (déduit du script par défaut).
  --purge             SUPPRIME AUSSI LES DONNÉES : base PostgreSQL, rôle, photos
                      importées, certificats, backend/.env (secrets), venv, node_modules
                      et builds. Sans cette option, rien de tout cela n'est touché.
  --yes               Ne pas demander de confirmation (pour un script automatisé).
  --front-port/--admin-port/--api-port N   Ports à libérer (défaut 5173/5174/8000).
  -h, --help          Afficher cette aide.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --instance)   INSTANCE="${2:?}"; shift 2 ;;
    --dir)        DIR="${2:?}"; shift 2 ;;
    --purge)      PURGE=1; shift ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    --front-port) FRONT_PORT="${2:?}"; shift 2 ;;
    --admin-port) ADMIN_PORT="${2:?}"; shift 2 ;;
    --api-port)   API_PORT="${2:?}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "Option inconnue : $1   (./uninstall.sh --help)" ;;
  esac
done

if [ -n "$INSTANCE" ]; then
  [[ "$INSTANCE" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "Nom d'instance invalide : « $INSTANCE »"
  SVC_PREFIX="smart-optica-$INSTANCE"
  DB_NAME_DEFAULT="smartoptica_$INSTANCE"
else
  SVC_PREFIX="smart-optica"
  DB_NAME_DEFAULT="smartoptica"
fi
UNIT_DIR="$HOME/.config/systemd/user"

# ── Racine de l'app : dossier du script s'il contient l'app, sinon --dir ──────────
ROOT=""
for cand in "$SCRIPT_DIR" "$DIR"; do
  if [ -n "$cand" ] && [ -f "$cand/package.json" ] && [ -d "$cand/backend" ]; then ROOT="$cand"; break; fi
done

port_owner() { ss -tlnpH "sport = :$1" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1; }
unit_port() { [ -f "$1" ] && sed -n 's/.*--port \([0-9]\+\).*/\1/p' "$1" | head -1 || true; }
env_get() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | head -1 | sed 's/^"//; s/"$//' || true; }

printf '\n%sSmart Optica — désinstalleur%s  ·  instance : %s\n' "$C_HEAD" "$C_OFF" "${INSTANCE:-principale}"

# ══════════════════════════════════════════════════════════════════════════════════
step "1/3 · Arrêt et suppression des services"
UNIT_FRONT="$UNIT_DIR/$SVC_PREFIX-front.service"
UNIT_ADMIN="$UNIT_DIR/$SVC_PREFIX-admin.service"
UNIT_BACK="$UNIT_DIR/$SVC_PREFIX-backend.service"

# Les ports réellement utilisés sont relus dans les unités (plus fiable que les défauts)
[ -n "$(unit_port "$UNIT_FRONT")" ] && FRONT_PORT="$(unit_port "$UNIT_FRONT")"
[ -n "$(unit_port "$UNIT_ADMIN")" ] && ADMIN_PORT="$(unit_port "$UNIT_ADMIN")"
[ -n "$(unit_port "$UNIT_BACK")" ]  && API_PORT="$(unit_port "$UNIT_BACK")"

found=0
for u in "$UNIT_FRONT" "$UNIT_ADMIN" "$UNIT_BACK"; do
  name="$(basename "$u")"
  if [ -f "$u" ]; then
    systemctl --user disable --now "$name" >/dev/null 2>&1 || true
    rm -f "$u"
    ok "Service retiré : $name"
    found=$((found + 1))
  else
    info "Absent : $name"
  fi
done
systemctl --user daemon-reload
systemctl --user reset-failed >/dev/null 2>&1 || true
[ "$found" -gt 0 ] && ok "$found service(s) retiré(s)" || info "Aucun service de cette instance n'était installé"

# Processus orphelins qui garderaient un port (relance impossible sinon)
for p in "$API_PORT" "$FRONT_PORT" "$ADMIN_PORT"; do
  pid="$(port_owner "$p")"
  if [ -n "$pid" ]; then
    warn "Le port $p est encore occupé (PID $pid) — arrêt forcé (service déjà retiré)"
    kill "$pid" 2>/dev/null || true
    sleep 1
    [ -n "$(port_owner "$p")" ] && { kill -9 "$pid" 2>/dev/null || true; sleep 1; }
  fi
done
ok "Ports $API_PORT / $FRONT_PORT / $ADMIN_PORT libres"

# ══════════════════════════════════════════════════════════════════════════════════
step "2/3 · Données"
if [ "$PURGE" = "0" ]; then
  ok "CONSERVÉES (base, photos, certificats, secrets) — relancez ./install.sh pour repartir"
  printf '\n  Pour tout effacer réellement : %s./uninstall.sh%s %s--purge%s\n\n' \
    "$C_HEAD" "$C_OFF" "$C_WARN" "$C_OFF"
  exit 0
fi

DB_NAME="$DB_NAME_DEFAULT"
DB_USER="$DB_NAME"
if [ -n "$ROOT" ]; then
  url="$(env_get "$ROOT/backend/.env" DATABASE_URL)"
  if [ -n "$url" ]; then
    read -r DB_USER DB_NAME < <(printf '%s' "$url" | python3 -c '
import sys
from urllib.parse import urlsplit, unquote
u = urlsplit(sys.stdin.read().strip())
print(unquote(u.username or ""), (u.path or "").lstrip("/"))')
  fi
fi

if [ "$ASSUME_YES" = "0" ]; then
  [ -t 0 ] || die "--purge en mode non interactif exige --yes."
  warn "Suppression DÉFINITIVE de la base « $DB_NAME » et des données locales."
  read -rp "  Taper SUPPRIMER pour confirmer : " answer
  [ "$answer" = "SUPPRIMER" ] || die "Annulé — rien n'a été supprimé."
fi

psql_super() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- psql "$@"
  else sudo -u postgres psql "$@"; fi
}

if [ "$(printf "SELECT 1 FROM pg_database WHERE datname='%s'" "$DB_NAME" | psql_super -tA 2>/dev/null || true)" = "1" ]; then
  printf 'DROP DATABASE IF EXISTS "%s" WITH (FORCE)' "$DB_NAME" | psql_super -q >/dev/null
  ok "Base « $DB_NAME » supprimée"
else
  info "Base « $DB_NAME » absente"
fi
if [ "$DB_USER" != "postgres" ] && [ "$(printf "SELECT 1 FROM pg_roles WHERE rolname='%s'" "$DB_USER" | psql_super -tA 2>/dev/null || true)" = "1" ]; then
  printf 'DROP ROLE IF EXISTS "%s"' "$DB_USER" | psql_super -q >/dev/null
  ok "Rôle « $DB_USER » supprimé"
fi

# ══════════════════════════════════════════════════════════════════════════════════
step "3/3 · Fichiers locaux"
if [ -z "$ROOT" ]; then
  warn "Dossier de l'application introuvable : les fichiers locaux sont laissés en place."
else
  ENV_PURGE="backend/.env"
  [ -n "$INSTANCE" ] && ENV_PURGE="backend/.env.$INSTANCE"
  for item in "backend/uploads" "certs" "$ENV_PURGE" "backend/venv" "backend/smartoptica.db" \
              "backend/smartoptica.db.bak-*" "node_modules" "dist" "admin/dist" "backend/venv/.so-requirements.sha"; do
    # shellcheck disable=SC2086
    for path in $ROOT/$item; do
      if [ -e "$path" ]; then rm -rf "$path"; ok "Supprimé : ${path#"$ROOT"/}"; fi
    done
  done
  info "Le code source, dist-admin/ et les journaux ~/$SVC_PREFIX-*.log sont conservés."
fi

printf '\n%s✓ Désinstallation terminée (%s)%s\n\n' "$C_OK" "${INSTANCE:-instance principale}" "$C_OFF"
