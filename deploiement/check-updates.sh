#!/usr/bin/env bash
# Vérifie la dernière version main et ne déploie que si les tests CI du commit sont verts.
# Appelé toutes les 3 minutes par systemd, sans secrets GitHub ni accès SSH entrant.
set -Eeuo pipefail

cd /root/quiz-pub
LOCAL="$(git rev-parse HEAD)"
DISTANT="$(git ls-remote --exit-code origin refs/heads/main | awk '{print $1}')"

if [[ ! "$DISTANT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "SHA main GitHub invalide ; aucun déploiement." >&2
  exit 1
fi
if [[ "$LOCAL" == "$DISTANT" ]]; then
  echo "Quiz Pub déjà à jour : $LOCAL"
  exit 0
fi

echo "Nouveau commit $DISTANT détecté. Vérification du succès de la CI GitHub..."
if python3 - "$DISTANT" <<'PY'
import json
import sys
import urllib.error
import urllib.request

sha = sys.argv[1]
url = (
    "https://api.github.com/repos/Simondbf/quiz-pub/actions/runs?branch=main&per_page=30"
)
req = urllib.request.Request(
    url,
    headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "quiz-pub-vps-autoupdate",
    },
)
try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.load(resp)
except (OSError, ValueError) as err:
    print(f"Impossible de consulter GitHub Actions : {err}", file=sys.stderr)
    sys.exit(3)

runs = [
    r for r in data.get("workflow_runs", [])
    if r.get("head_sha") == sha and r.get("event") == "push"
    and r.get("path") == ".github/workflows/tests-deploy.yml"
]
if not runs:
    print("Tests GitHub absents ou en attente, déploiement différé.")
    sys.exit(3)
latest = max(runs, key=lambda r: (r.get("run_attempt", 0), r.get("id", 0)))
status = latest.get("status", "?")
conclusion = latest.get("conclusion", "?")
if status == "completed" and conclusion == "success":
    print(f"Tests GitHub réussis pour {sha}.")
    sys.exit(0)
print(f"Tests GitHub non réussis (état={status}, résultat={conclusion}), pas de déploiement.")
sys.exit(3)
PY
then
  # Script existant : refuse les fichiers suivis modifiés, contrôle le SHA,
  # prend un verrou, préserve les volumes et vérifie les endpoints locaux.
  exec /usr/local/sbin/deploy-quiz-pub "$DISTANT"
else
  echo "Mise à jour différée : la version installée reste inchangée."
  exit 0
fi
