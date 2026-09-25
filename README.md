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

## Le YT téléchargeur

Le même dépôt fait tourner un second site, **YT téléchargeur**
(`telechargement.soleiljaune.be`), pour qui veut seulement récupérer une vidéo
ou une musique, sans publicité ni pistage :

- on colle un lien (YouTube, ou l'un du millier d'autres sites que connaît yt-dlp : TikTok, Instagram, Vimeo, SoundCloud…) ; le site le lit tout seul et montre le titre, la chaîne, la durée et l'image ;
- **Vidéo** : toutes les définitions proposées par la vidéo, de 360p à 4K (et 8K), avec leur poids approximatif. Jusqu'en 1080p, en H.264 lisible partout ; au-delà, en VP9 ;
- **Musique** : MP3 320, 192 ou 128 kbit/s, ou M4A dans la qualité d'origine, avec titre et pochette ;
- **Extrait** : ne garder qu'un morceau (début et fin en minutes et secondes) ;
- **Playlists** : toutes les vidéos à cocher, téléchargées l'une après l'autre ;
- **Le pont vers le quiz** : une vidéo téléchargée part dans la bibliothèque du quiz d'un clic (« Envoyer au quiz »). Le quiz garde aussi son propre champ « lien YouTube ».
- Les fichiers restent 7 jours sur le serveur, puis sont effacés (réglable avec `CONSERVATION_JOURS`).
- Mot de passe facultatif, distinct de celui du quiz : `TELECHARGEMENT_MOT_DE_PASSE`.

**yt-dlp**, le programme qui récupère les vidéos, est commun aux deux sites
(une seule copie, dans `data/.yt-dlp/`). YouTube change souvent sa façon de
livrer les vidéos : yt-dlp se met à jour à chaque démarrage des conteneurs, et
le lien « Mettre à jour yt-dlp » (sur l'un ou l'autre site) le fait à la
demande, par exemple quand un téléchargement échoue d'un coup.

Code : `server/telechargement.js`, `server/youtube.js` et `public-telechargement/`.

## Installation sur le VPS

Tout tourne dans Docker, deux conteneurs pour une même image : le quiz sur
`127.0.0.1:3012`, le téléchargement sur `127.0.0.1:3014` ; nginx les publie.
Les commandes supposent le dossier `/root/quiz-pub` et les sous-domaines
`quizpub.soleiljaune.be` et `telechargement.soleiljaune.be`.
Ne touche pas au dossier `/root/compilationpub`, qui contient l'ancienne appli.

### 1. Les conteneurs

```bash
cd /root/quiz-pub
mkdir -p data cookies
chown 1000:1000 data           # les conteneurs n'ont pas les droits root
docker compose up -d --build
docker compose logs --tail 20  # « Quiz Pub écoute sur 0.0.0.0:3012 » et « YT téléchargeur écoute sur 0.0.0.0:3014 »
```

Sans rien d'autre, les deux sites sont sans mot de passe. Les réglages
facultatifs (mots de passe, durée de conservation) se mettent dans un fichier
`.env` à côté de `docker-compose.yml` : voir `.env.exemple` pour la liste.
Après un changement : `docker compose up -d`.

### 2. Les noms de domaine (Infomaniak)

Dans la zone DNS de `soleiljaune.be`, ajoute deux enregistrements **A** vers
`178.105.235.106` : `quizpub` et `telechargement`.

### 3. nginx et le certificat

Une fois l'enregistrement DNS en place, dans le dossier du site :

```bash
bash deploiement/nginx.sh
```

Pour chacun des deux sites, le script installe la configuration nginx du dépôt
(`deploiement/nginx.conf` et `deploiement/nginx-telechargement.conf`), obtient
le certificat HTTPS au premier lancement, puis recharge nginx. Rien à
créer à la main dans `/etc/nginx`. Si nginx refuse la configuration, l'ancienne
est remise en place. Avant de demander le certificat, le script vérifie
lui-même que le domaine arrive bien sur ce site ; sinon il dit ce qui cloche
(fichier nginx en double, enregistrement DNS qui pointe ailleurs) et ne demande
rien, pour ne pas épuiser les essais autorisés par Let's Encrypt.
Pour changer la configuration nginx : modifier `deploiement/nginx.conf` dans le
dépôt, puis `maj` et relancer le script.

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
