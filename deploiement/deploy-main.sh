#!/usr/bin/env bash
# Déploiement du commit main validé par GitHub Actions.
# À installer une fois comme /usr/local/sbin/deploy-quiz-pub (root:root, 0755).
# N'exécuter que via un utilisateur SSH dédié autorisé par sudoers.
set -Eeuo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage : deploy-quiz-pub <SHA Git complet>" >&2
  exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then echo "Exécution root requise." >&2; exit 1; fi
CIBLE_SHA="$1"
RACINE="/root/quiz-pub"
exec 9>/run/lock/deploy-quiz-pub.lock
flock -w 60 9 || { echo "Un déploiement est déjà en cours." >&2; exit 1; }
cd "$RACINE"

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Le checkout VPS doit être sur main ; aucun changement effectué." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Fichiers suivis modifiés sur le VPS ; déploiement refusé pour ne rien écraser." >&2
  exit 1
fi

git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
DISTANT="$(git rev-parse refs/remotes/origin/main)"
if [[ "$DISTANT" != "$CIBLE_SHA" ]]; then
  echo "Commit demandé non actuel ($CIBLE_SHA) : un nouveau push le remplace, aucun déploiement."
  exit 0
fi

AVANT="$(git rev-parse HEAD)"
git merge --ff-only "$CIBLE_SHA"
docker compose config --quiet
# Les volumes ./data et ./cookies et les secrets .env ne sont pas effacés.
docker compose up -d --build --wait --wait-timeout 240
curl --fail --silent --show-error --max-time 10 -o /dev/null http://127.0.0.1:3012/api/session
curl --fail --silent --show-error --max-time 10 -o /dev/null http://127.0.0.1:3015/api/session

# Ne changer la config nginx que si le dépôt l'a réellement modifiée.
if git diff --name-only "$AVANT" "$CIBLE_SHA" -- deploiement/nginx.conf deploiement/nginx-telechargement.conf deploiement/nginx.sh \
  | grep -q .; then
  bash deploiement/nginx.sh
fi

# Registre central : copie sur le VPS à chaque déploiement.
install -D -o root -g root -m 0644 deploiement/PORTS_VPS.md /etc/vps/ports.md
echo "Quiz Pub et YT téléchargeur déployés : $CIBLE_SHA"
