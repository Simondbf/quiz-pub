#!/usr/bin/env bash
# Installation idempotente d'un minuteur systemd sur le VPS existant.
# Ne touche ni aux données, ni aux secrets, ni aux conteneurs tiers.
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Lancer avec sudo." >&2
  exit 1
fi

cd /root/quiz-pub
if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Le VPS doit être sur main avant l'installation." >&2
  exit 1
fi
for cmd in git python3 systemctl docker flock curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Commande manquante : $cmd" >&2
    exit 1
  fi
done
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Changements suivis présents sur le VPS : vérifier avant installation." >&2
  exit 1
fi

install -o root -g root -m 0755 deploiement/deploy-main.sh /usr/local/sbin/deploy-quiz-pub
install -o root -g root -m 0755 deploiement/check-updates.sh /usr/local/sbin/check-quiz-pub-updates

cat > /etc/systemd/system/quiz-pub-auto-update.service <<'EOF'
[Unit]
Description=Quiz Pub + telechargeur : mise a jour GitHub si CI reussie
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
User=root
WorkingDirectory=/root/quiz-pub
ExecStart=/usr/local/sbin/check-quiz-pub-updates
TimeoutStartSec=600
EOF

cat > /etc/systemd/system/quiz-pub-auto-update.timer <<'EOF'
[Unit]
Description=Verifier les mises a jour de Quiz Pub toutes les 3 minutes

[Timer]
OnBootSec=3min
OnUnitInactiveSec=3min
AccuracySec=30s
Unit=quiz-pub-auto-update.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now quiz-pub-auto-update.timer

echo "Timer systemd activé."
systemctl list-timers --all quiz-pub-auto-update.timer --no-pager
echo "Première vérification : systemctl start quiz-pub-auto-update.service"
