#!/usr/bin/env bash
# Diagnostic EN LECTURE SEULE des sites du VPS : Quiz Pub, YT téléchargeur et Montage.
# Exécuter sur le VPS : bash deploiement/diagnostic.sh
# Aucune modification, redémarrage, mise à jour ou lecture des fichiers .env.
set -u

titre() { printf '\n===== %s =====\n' "$1"; }
disponible() { command -v "$1" >/dev/null 2>&1; }

titre "Date et services"
date -Is
if disponible systemctl; then
  for service in nginx docker; do
    printf '%s : ' "$service"
    systemctl is-active "$service" 2>&1 || true
  done
fi

titre "Etat de nginx"
if disponible nginx; then nginx -t 2>&1 || true; else echo "nginx introuvable"; fi

titre "Conteneurs Docker"
if disponible docker; then
  docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>&1 || true
else
  echo "Docker introuvable"
fi

titre "Espace disque et mémoire"
df -h / 2>&1 || true
df -i / 2>&1 || true
if disponible free; then free -h 2>&1 || true; fi

titre "Ports à l'écoute"
if disponible ss; then
  ss -ltn 2>&1 | grep -E '(^State|:80[[:space:]]|:443[[:space:]]|:3012[[:space:]]|:3013[[:space:]]|:3014[[:space:]])' || true
fi

titre "Tests HTTP locaux et publics"
if ! disponible curl; then
  echo "curl introuvable : tests HTTP ignorés"
  exit 0
fi
for entree in "quizpub.soleiljaune.be:3012" "telechargement.soleiljaune.be:3014" "montage.soleiljaune.be:3013"; do
  domaine="${entree%:*}"
  port="${entree##*:}"
  echo "--- $domaine (port $port)"
  printf 'Application locale : '
  curl --silent --show-error --max-time 6 -o /dev/null -w 'HTTP %{http_code}\n' "http://127.0.0.1:$port/api/session" || true
  printf 'Nginx local (DNS contourné) : '
  curl --silent --show-error --insecure --max-time 6 --resolve "$domaine:443:127.0.0.1" -o /dev/null -w 'HTTP %{http_code}\n' "https://$domaine/" || true
  printf 'Site public : '
  curl --silent --show-error --max-time 8 -o /dev/null -w 'HTTP %{http_code} - IP %{remote_ip}\n' "https://$domaine/" || true
done

titre "Interprétation"
echo "Local OK / nginx 502 : vérifier les upstreams et les erreurs nginx."
echo "Local 000 : conteneur arrêté, application non démarrée ou port absent."
echo "Local OK / public 000 : vérifier DNS, pare-feu, certificat et accès réseau."
echo "Si nginx est en erreur, consulter journalctl -u nginx ; si un conteneur est arrêté, docker logs NOM."
echo "ATTENTION : relire les logs avant de les partager, ils peuvent contenir des URL ou des données privées."
