# Mises à jour automatiques sur le VPS : Quiz Pub et téléchargeur

**Mode retenu : pull depuis le VPS, sans secret GitHub et sans SSH depuis GitHub Actions.**

Le VPS interroge GitHub environ toutes les **3 minutes** grâce à un timer `systemd`. En présence d'un nouveau commit sur `main`, il consulte le résultat du workflow GitHub Actions `.github/workflows/tests-deploy.yml`. **Il ne déploie que si les tests associés à ce SHA ont réussi.** Si les tests sont en cours, échouent ou si GitHub est indisponible, les sites restent sur leur version actuelle. Le workflow GitHub ne contient plus de job qui se connecte au VPS.

## Installation (une seule fois)

Dans la session VPS actuelle, sans ouvrir de nouvelle connexion :

```bash
cd /root/quiz-pub
git pull --ff-only
sudo bash deploiement/install-auto-updates.sh
sudo systemctl start quiz-pub-auto-update.service
sudo systemctl status quiz-pub-auto-update.timer --no-pager
sudo journalctl -u quiz-pub-auto-update.service -n 30 --no-pager
```

La deuxième commande installe une copie root-owned des scripts `deploiement/check-updates.sh` et `deploiement/deploy-main.sh` sous `/usr/local/sbin/`, crée les unités `quiz-pub-auto-update.service` et `quiz-pub-auto-update.timer`, puis active le timer. La troisième force une vérification immédiate.

**Conditions :** dépôt cloné sous `/root/quiz-pub`, branche `main`, pas de modifications Git suivies sur le VPS, `python3`, `git`, `docker compose` et systemd installés. Le dépôt public GitHub et l'API Actions doivent être accessibles depuis le VPS en HTTPS. Aucune clé GitHub n'est nécessaire pour ce dépôt public.

## Mécanisme et limites

1. `git ls-remote` récupère le SHA courant de `origin/main` sans modifier les fichiers.
2. Si ce SHA est différent du checkout local, le script interroge `https://api.github.com/repos/Simondbf/quiz-pub/actions/workflows/tests-deploy.yml/runs?branch=main&per_page=30` et cherche une exécution **push** sur le SHA précis, `completed/success`.
3. Après confirmation, `/usr/local/sbin/deploy-quiz-pub SHA` vérifie encore le SHA, prend un verrou, refuse les modifications locales suivies, effectue `git merge --ff-only`, reconstruit uniquement les services du dépôt, attend leur santé HTTP et synchronise `/etc/vps/ports.md`.
4. Les dossiers `data/`, `cookies/` et le fichier `.env` ne sont pas supprimés. Aucun conteneur étranger au projet n'est arrêté.
5. Le script met à jour nginx **uniquement** si les configurations nginx ou leur installateur ont changé. Une erreur de déploiement ne provoque pas de restauration automatique : consulter les journaux.
6. Si plusieurs pushes ont lieu pendant 3 minutes, le VPS vérifie le **dernier SHA** et attend son résultat de tests. Cela évite les déploiements intermédiaires.

**La vérification se fait à intervalle régulier (environ trois minutes), pas au moment exact du push.** Les tests CI doivent d'abord finir. L'API publique GitHub est interrogée sans jeton, avec limite d'appels ; une éventuelle limitation diffère simplement le déploiement. Si le dépôt devient privé, ce mécanisme devra être adapté.

## Suivi

```bash
systemctl list-timers --all quiz-pub-auto-update.timer
sudo journalctl -u quiz-pub-auto-update.service -n 70 --no-pager
docker compose ps
```

Pour forcer une vérification : `sudo systemctl start quiz-pub-auto-update.service`.

Pour désactiver proprement l'automatisation : `sudo systemctl disable --now quiz-pub-auto-update.timer`.

Si un futur commit modifie les scripts installés sous `/usr/local/sbin/`, réexécuter l'installateur **après** cette mise à jour : leurs copies sont volontairement détenues par root et ne sont pas remplacées automatiquement.

## Configuration SSH GitHub Actions précédente (devenue inutile)

Une préparation antérieure a éventuellement créé le compte `quizdeploy`, un fichier sudoers et une paire de clés sous `/root/.ssh/quizpub-github-actions*`. Le timer **n'en utilise aucun**. Ne pas supprimer immédiatement un compte ou une clé sans vérifier qu'il ne sert pas ailleurs. On pourra retirer cette configuration obsolète après validation des mises à jour périodiques.

Il ne faut **pas** définir `DEPLOY_ENABLED` ni ajouter les secrets `VPS_HOST`, `VPS_SSH_USER`, `VPS_SSH_PRIVATE_KEY` ou `VPS_SSH_KNOWN_HOSTS` : le job GitHub→SSH a été retiré du workflow.

Montage Vidéo et Comptes ne sont pas inclus dans cette automatisation.
