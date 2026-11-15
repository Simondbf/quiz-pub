# Déploiement automatique depuis GitHub vers le VPS

Les changements sont testés dans GitHub Actions (sur une PR ou un push). **Seul un push sur `main` réussi est déployé**, si la variable de dépôt `DEPLOY_ENABLED` vaut `true`. La PR et les autres branches ne déploient jamais.

## Préparer le VPS une seule fois

1. Vérifier les ports **réels** avec `sudo ss -ltnp`, `docker ps`, les upstreams nginx ; voir `deploiement/PORTS_VPS.md`. **3014 est réservé à Comptes, 3015 au téléchargeur.** Ne pas activer si 3015 est occupé.
2. Vérifier le dépôt déjà cloné sous `/root/quiz-pub`, branche `main`, accessible à GitHub en lecture seule depuis le VPS (deploy key SSH de lecture). Les données `data/`, `cookies/` et secrets `.env` restent sur le VPS. Le script n'exécute jamais `git clean`, `docker compose down -v` ni une remise à zéro forcée du dépôt.
3. Après fusion de la PR et revue du script, installer le script dans un **chemin root immuable par l'utilisateur SSH** :
   ```bash
   sudo install -o root -g root -m 0755 /root/quiz-pub/deploiement/deploy-main.sh /usr/local/sbin/deploy-quiz-pub
   ```
   Réinstaller ce fichier manuellement si la logique du script change à l'avenir.
4. Créer un compte SSH technique sans accès aux autres applications, par exemple `deploybot` (ne pas utiliser root pour la connexion SSH). Ajouter **sa clé publique** dédiée dans `/home/deploybot/.ssh/authorized_keys` (permissions strictes : répertoire 0700, fichier 0600). Éviter de l'ajouter au groupe `docker`, qui équivaut largement à root.
5. Ajouter avec `sudo visudo -f /etc/sudoers.d/deploybot` :
   ```text
   deploybot ALL=(root) NOPASSWD: /usr/local/sbin/deploy-quiz-pub
   ```
   Ces scripts, détenus par root et acceptant uniquement un SHA Git complet, sont les seules commandes sudo accordées à ce compte. Revalider le fichier sudoers.

## Paramètres du dépôt GitHub

Dans **Settings → Secrets and variables → Actions**, renseigner les secrets :
- `VPS_HOST` : IP ou nom DNS du VPS ;
- `VPS_SSH_USER` : `deploybot` ;
- `VPS_SSH_PRIVATE_KEY` : clé privée SSH créée **pour cette connexion uniquement** (ne jamais la commiter) ;
- `VPS_SSH_KNOWN_HOSTS` : ligne du host key de ce VPS. Vérifier son empreinte via un canal SSH déjà fiable (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` sur le VPS). Ne pas accepter aveuglément le résultat de `ssh-keyscan`.

Dans **Variables**, ajouter `VPS_SSH_PORT` (optionnel, 22 par défaut) et, **uniquement après tests et installation du script**, `DEPLOY_ENABLED=true`.

Montage Vidéo n'est pas inclus : ce déploiement concerne seulement Quiz Pub et le téléchargeur YouTube.

## Fonctionnement

À chaque push `main` : tests → SSH avec validation stricte de la clé du VPS → `sudo -n /usr/local/sbin/deploy-quiz-pub <sha>` → `git fetch` → `git merge --ff-only` → `docker compose config` → `docker compose up -d --build --wait` → tests HTTP locaux. Une nouvelle config nginx n'est appliquée que si les fichiers nginx du dépôt ont changé. Le registre est copié dans `/etc/vps/ports.md`.

Le script prend un verrou (pas de concurrence), refuse un dépôt avec des changements suivis locaux et ignore les vieux commits remplacés par un push plus récent. Il ne redémarre que les conteneurs de ce projet. **Le premier déploiement et le passage 3014 → 3015 doivent être supervisés** : confirmer d'abord l'état Nginx et les ports en production.

En cas d'échec, lire les logs GitHub Actions puis `docker compose ps`, `docker compose logs --tail=100`, `sudo nginx -t` et `bash deploiement/diagnostic.sh` sur le VPS. Le script ne supprime aucune donnée et n'effectue pas de rollback automatique. Ne pas publier les secrets ni les journaux contenant des données privées.

Le bouton `workflow_dispatch` sur la branche **main** permet également de lancer un déploiement manuel **après les tests**, mais uniquement lorsque `DEPLOY_ENABLED=true` et les secrets SSH sont configurés. Tout push ultérieur sur `main` déploie automatiquement dans les mêmes conditions.
