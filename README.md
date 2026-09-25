# Quiz Pub

Un site pour préparer des quiz de pubs, protégé par un mot de passe si tu en choisis un :

1. **Récupérer la vidéo** : colle un lien YouTube (le serveur la télécharge avec yt-dlp), ou envoie une vidéo depuis ton ordinateur.
2. **Repérage automatique** : le site découpe la compilation en pubs (passages au noir, silences sur une coupe) et place dans chaque pub la **révélation**, le début du dernier plan, celui où la marque apparaît.
3. **Vérifier et corriger** : lecteur image par image, frise, raccourcis clavier. Chaque repère se règle au curseur ou à l'image près.
4. **Cacher les textes gênants** : les textes incrustés qui ne bougent pas (logo de chaîne, « Pub 3 »…) sont trouvés à l'analyse. Tu peux en dessiner d'autres. Chaque masque floute, pixellise ou noircit sa zone, sur toute la vidéo, pendant certaines pubs, ou seulement jusqu'à leur révélation.
5. **Exporter** :
   - **le quiz monté** : chaque pub jusqu'à sa révélation, image figée avec la question, un compte à rebours et, si tu en as écrit, les propositions de réponse ; puis la révélation et, si tu l'as notée, la réponse ;
   - **la vidéo nettoyée** : la vidéo entière, masques appliqués, pour monter toi-même ;
   - **les marqueurs pour DaVinci Resolve** : début, révélation et fin de chaque pub, en fichier `.edl`, pour la vidéo d'origine comme pour le quiz monté.

Les vidéos produites sont en MP4 (H.264 et AAC), lisibles partout et dans Resolve.

## Installation sur le VPS

Tout tourne dans Docker. Le site écoute sur `127.0.0.1:3012` ; nginx le publie.
Les commandes ci-dessous supposent le dossier `/root/quiz-pub` et le
sous-domaine `quizpub.soleiljaune.be` : remplace-le par celui que tu veux.
Ne touche pas au dossier `/root/compilationpub`, qui contient l'ancienne appli.

### 1. Les fichiers et le mot de passe

```bash
cd /root/quiz-pub
cp .env.exemple .env
nano .env                      # MOT_DE_PASSE : à choisir, ou vide pour un site ouvert
mkdir -p data cookies
chown 1000:1000 data           # le conteneur n'a pas les droits root
docker compose up -d --build
docker compose logs --tail 20  # doit afficher « Quiz Pub écoute sur 0.0.0.0:3012 »
```

### 2. Le nom de domaine (Infomaniak)

Dans la zone DNS de `soleiljaune.be`, ajoute un enregistrement **A**
`quizpub` vers `178.105.235.106`.

### 3. nginx et le certificat

nginx ne lit pas le dossier du dépôt : le fichier doit exister dans
`/etc/nginx/sites-available/` avant d'être activé, sinon `nginx -t` échoue.
Ouvre-le avec `nano /etc/nginx/sites-available/quizpub.soleiljaune.be`, colle
le contenu ci-dessous (le même que `etc/nginx/sites-available/quizpub.soleiljaune.be`
dans le dépôt), puis enregistre (Ctrl+O, Entrée, Ctrl+X) :

```nginx
server {
    listen 80;
    server_name quizpub.soleiljaune.be;

    # Vidéos envoyées depuis l'ordinateur : jusqu'à 4 Go.
    client_max_body_size 5G;

    location / {
        proxy_pass http://127.0.0.1:3012;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Envoi et lecture des vidéos sans tampon ni coupure.
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Puis :

```bash
ln -sf /etc/nginx/sites-available/quizpub.soleiljaune.be /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d quizpub.soleiljaune.be
```

### Mise à jour

`maj` dans le dossier (`git pull && docker compose up -d --build`).
yt-dlp se met à jour tout seul à chaque démarrage du conteneur ; le bouton
**Mettre à jour yt-dlp** de la page d'accueil le fait à la demande.

## Si YouTube refuse de télécharger

YouTube bloque parfois les serveurs de centres de données, dont Hetzner :
le site affiche alors « YouTube bloque ce serveur ». Deux solutions :

- **Envoyer la vidéo depuis ton ordinateur** (bouton « Envoyer une vidéo depuis cet appareil ») : tout le reste fonctionne pareil.
- **Donner des cookies YouTube au serveur** :
  1. dans une fenêtre de navigation privée, connecte-toi à YouTube, de préférence avec un compte Google secondaire ;
  2. exporte les cookies au format `cookies.txt` avec l'extension « Get cookies.txt LOCALLY » ;
  3. ferme la fenêtre privée sans te déconnecter ;
  4. dépose le fichier sous `/root/quiz-pub/cookies/cookies.txt`, puis `docker compose restart`.

  La page d'accueil indique « cookies YouTube fournis » quand le fichier est pris en compte. Les cookies finissent par expirer : refais l'export si le blocage revient.

## Utilisation

- **Raccourcis** (écran de montage) : Espace lecture et pause ; ← → une image ; Maj + ← → une seconde ; ↑ ↓ repère ou coupe précédente, suivante ; D, R, F placent le début, la révélation, la fin de la pub choisie au curseur ; C coupe la pub au curseur ; Suppr retire le masque choisi (onglet Masques).
- Les révélations **à vérifier** ont été estimées faute de coupe nette : regarde-les en priorité.
- **Propositions de réponse** : pour chaque pub, écris la bonne réponse et jusqu'à trois fausses, crédibles ou absurdes. Pendant l'image figée, elles s'affichent en cases A, B, C, D ; la page indique à quelle lettre tombe la bonne réponse, qui change de place d'une pub à l'autre. À la révélation, la bonne réponse s'affiche en vert avec sa lettre. Une proposition trop longue passe sur deux lignes. Sans fausse proposition, le quiz pose seulement la question.
- Une pub décochée « Dans le quiz » reste dans les marqueurs mais pas dans le quiz monté.
- Tout est enregistré automatiquement.
- **Marqueurs dans Resolve** : pose la vidéo au début de la timeline (01:00:00:00 par défaut), puis dans le Media Pool, clic droit sur la timeline › Timelines › Import › Timeline Markers from EDL.

## Données

Tout est dans `data/videos/<identifiant>/` : la vidéo d'origine, l'analyse,
le projet (pubs et masques) et les exports. Supprimer une vidéo depuis le
site efface son dossier.

## Développement

```bash
npm install
npm test        # tests du serveur (ffmpeg et yt-dlp doivent être installés)
MOT_DE_PASSE=motdepasse-local DATA_DIR=./data npm start
```
