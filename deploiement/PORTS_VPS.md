# Registre des ports — VPS Hetzner

Document de référence versionné pour éviter les doubles attributions. Copie conseillée sur le VPS : `/etc/vps/ports.md`.

**Attention :** inventaire établi le 15 novembre 2026 d'après les dépôts GitHub, **pas depuis les processus du VPS**. Un port déclaré dans un dépôt n'est pas forcément actif ; un autre service peut écouter sur un port non répertorié ici. Vérifier avec `ss` et `docker ps` avant toute mise en production.

| Port hôte | Service | Domaine ou accès | Statut d'après le code |
|---|---|---|---|
| 80/tcp | nginx | HTTP / validation ACME | Commun, service hôte |
| 443/tcp | nginx | HTTPS | Commun, service hôte |
| 853/tcp | Protego / Technitium DNS-over-TLS | dns.soleiljaune.be | Déclaré, service éventuellement conservé |
| 3000/tcp | CinéPrivé | nginx local | Déclaré dans docker-compose.yml |
| 3001/tcp | Gringotts | nginx local | Déclaré ; suppression envisagée |
| 3010/tcp | Loup-Garou | lg.soleiljaune.be | Déclaré dans docker-compose.yml |
| 3012/tcp | Quiz Pub | quizpub.soleiljaune.be | Déclaré, à conserver |
| 3013/tcp | Montage Vidéo | montage.soleiljaune.be | Déclaré, à conserver |
| **3014/tcp** | **Comptes** | **comptes.soleiljaune.be** | **Réservé à Comptes : NE PAS réutiliser** |
| **3015/tcp** | **YT téléchargeur** | **telechargement.soleiljaune.be** | **Nouvelle attribution proposée : vérifier qu'elle est libre** |
| 5380/tcp | Console Technitium | 127.0.0.1 uniquement | Déclaré si Protego actif |
| 8090/tcp | PocketBase (Gringotts) | 127.0.0.1 uniquement | Déclaré si Gringotts actif |

Les ports hôtes des applications sont liés à `127.0.0.1` dans leurs configurations principales ; nginx reçoit les accès publics. Les ports **internes** aux réseaux Docker ne constituent pas une réservation supplémentaire sur l'hôte. Les fichiers historiques/bêta peuvent contenir d'autres affectations : ne pas les déployer sans vérification.

## Avant de déployer, déplacer ou réserver un port

Sur le **VPS** :

```bash
sudo ss -ltnp
docker ps --format 'table {{.Names}}\t{{.Ports}}'
sudo nginx -T 2>/dev/null | grep -n 'proxy_pass http://127.0.0.1:'
```

Comparer les ports réellement écoutés, les publications Docker et les `proxy_pass` nginx avec ce tableau. Mettre à jour **ensemble** le fichier Compose, la configuration nginx, les scripts de déploiement et ce registre. Un port non présent dans le tableau n'est pas automatiquement libre.

**Ordre de migration 3014 → 3015 :**
1. Vérifier sur le VPS que `127.0.0.1:3015` est disponible et qu'il n'est réservé à aucun autre projet.
2. Mettre à jour le dépôt Quiz Pub sur le VPS, puis lancer `docker compose config` et `docker compose up -d --build`.
3. Tester `curl -i http://127.0.0.1:3015/api/session` (un `200` est attendu pour cette route).
4. Réinstaller la configuration nginx du téléchargeur via `deploiement/nginx.sh`, contrôler `nginx -t`, puis tester `https://telechargement.soleiljaune.be`.
5. Vérifier que le téléchargeur n'utilise plus 3014 **avant** le déploiement de Comptes.
6. Copier le registre : `sudo install -Dm0644 deploiement/PORTS_VPS.md /etc/vps/ports.md`.

Pour toute nouvelle application, réserver le port ici **avant** de configurer Docker/nginx. Ne jamais enregistrer de secrets dans ce fichier.
