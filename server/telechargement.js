// YT téléchargeur : une adresse YouTube (ou d'un autre site reconnu par
// yt-dlp), analysée d'abord (titre, définitions disponibles, liste de
// vidéos), puis une vidéo MP4 ou une musique MP3/M4A à enregistrer, entière
// ou en extrait.
// Même moteur que le quiz (youtube.js) ; une vidéo téléchargée ici peut être
// envoyée au quiz d'un clic.
//
// Chaque téléchargement a son dossier : <DATA_DIR>/<id>/meta.json + le fichier.
// Les fichiers sont effacés après CONSERVATION_JOURS jours (7 par défaut).
import express from 'express';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as taches from './taches.js';
import { executer, FFPROBE } from './outils.js';
import { installerSecurite, installerConnexion } from './connexion.js';
import { telecharger, verifierAdresse, versionYtdlp, mettreAJour, majAuDemarrage, cookiesPresents, analyserAdresse, RESOLUTIONS, AUDIOS } from './youtube.js';

const ICI = path.dirname(fileURLToPath(import.meta.url));

const nouvelId = () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(randomBytes(8), (b) => alphabet[b % 36]).join('');
};
const idValide = (id) => typeof id === 'string' && /^[a-z0-9]{8}$/.test(id);

const minutes = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
// « Vidéo 1080p », « Musique MP3 320 kbit/s », avec l'extrait s'il y en a un.
export const libelleFormat = (m) => {
  const base = m.mode === 'musique'
    ? `Musique ${AUDIOS[m.audio] || AUDIOS['mp3-320']}`
    : `Vidéo ${m.qualite === 'max' ? 'meilleure qualité' : m.qualite ? `${m.qualite === 2160 ? '4K ' : ''}${m.qualite}p` : 'MP4'}`;
  const e = m.extrait;
  return e ? `${base}, extrait ${minutes(e.debut ?? 0)} à ${e.fin !== null && e.fin !== undefined ? minutes(e.fin) : 'la fin'}` : base;
};

// Options envoyées par la page, vérifiées.
export const lireOptions = (b = {}) => {
  const mode = b.mode === 'musique' ? 'musique' : 'video';
  const q = b.qualite === 'max' ? 'max' : Number(b.qualite);
  const qualite = mode === 'video' ? (q === 'max' || RESOLUTIONS.includes(q) ? q : 1080) : null;
  const audio = mode === 'musique' ? (Object.hasOwn(AUDIOS, b.audio) ? b.audio : 'mp3-320') : null;
  const borne = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const debut = borne(b.debut), fin = borne(b.fin);
  if ((debut !== null && !(debut >= 0)) || (fin !== null && !(fin > 0)) || (debut !== null && fin !== null && fin <= debut)) {
    return { erreur: 'Extrait invalide : la fin doit venir après le début.' };
  }
  const extrait = debut !== null || fin !== null ? { debut: debut ?? 0, fin } : null;
  return { mode, qualite, audio, extrait };
};

// Durée lue dans le fichier, quand le site d'origine ne l'a pas donnée.
const dureeFichier = async (chemin) => {
  try {
    const { code, sortie } = await executer(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', chemin]);
    const d = Number(sortie.trim());
    return code === 0 && Number.isFinite(d) ? Math.round(d * 10) / 10 : null;
  } catch { return null; }
};

// Nom de fichier lisible sous Windows comme sous Android.
export const nomDeFichier = (titre, ext) => {
  const propre = String(titre || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[. ]+$/, '').slice(0, 150);
  return `${propre || 'telechargement'}.${ext}`;
};

export const creerApp = async ({
  dossier = path.resolve(process.env.DATA_DIR || './data-telechargements'),
  quiz = { url: process.env.QUIZ_URL || '', motDePasse: process.env.QUIZ_MOT_DE_PASSE || '' },
  conservationJours = Number(process.env.CONSERVATION_JOURS || 7),
} = {}) => {
  await mkdir(dossier, { recursive: true });
  const rep = (id) => {
    if (!idValide(id)) throw new Error('identifiant invalide');
    return path.join(dossier, id);
  };
  const lireMeta = async (id) => {
    try { return JSON.parse(await readFile(path.join(rep(id), 'meta.json'), 'utf8')); } catch { return null; }
  };
  const ecrireMeta = async (meta) => {
    const fichier = path.join(rep(meta.id), 'meta.json');
    await writeFile(`${fichier}.tmp`, JSON.stringify(meta));
    await rename(`${fichier}.tmp`, fichier);
    return meta;
  };
  const majMeta = async (id, changements) => {
    const meta = await lireMeta(id);
    if (!meta) return null;
    return ecrireMeta({ ...meta, ...changements });
  };
  const lister = async () => {
    const ids = (await readdir(dossier).catch(() => [])).filter(idValide);
    const metas = (await Promise.all(ids.map(lireMeta))).filter(Boolean);
    return metas.sort((a, b) => b.creee - a.creee);
  };

  // Ce qui était en cours au dernier arrêt ne reprendra pas.
  for (const m of await lister()) {
    if (m.etat === 'attente' || m.etat === 'telechargement') await majMeta(m.id, { etat: 'erreur', message: 'Interrompu par un redémarrage du serveur.' });
  }
  // Les fichiers anciens partent tout seuls, pour ne pas remplir le disque.
  const nettoyer = async () => {
    const limite = Date.now() - conservationJours * 24 * 3600 * 1000;
    for (const m of await lister()) {
      if (m.creee < limite && m.etat !== 'attente' && m.etat !== 'telechargement') await rm(rep(m.id), { recursive: true, force: true });
    }
  };
  await nettoyer();
  const minuterie = setInterval(() => nettoyer().catch(() => {}), 6 * 3600 * 1000);
  minuterie.unref();

  const app = express();
  installerSecurite(app);
  await installerConnexion(app, { dossier, cookie: 'yt_session', protegees: ['/api', '/fichiers'] });
  const json = express.json({ limit: '20kb' });
  const enveloppe = (f) => (req, res, next) => Promise.resolve(f(req, res, next)).catch(next);
  const avecId = (req, res, next) => (idValide(req.params.id) ? next() : res.status(404).json({ erreur: 'Téléchargement introuvable.' }));

  const resume = (m) => ({
    id: m.id, url: m.url, mode: m.mode, titre: m.titre || '', etat: m.etat, message: m.message || '',
    format: libelleFormat(m), miniature: m.miniature || null, chaine: m.chaine || '',
    qualite: m.qualite ?? null, audio: m.audio ?? null, extrait: m.extrait ?? null,
    creee: m.creee, taille: m.taille ?? null, duree: m.duree ?? null,
    nom: m.fichier ? nomDeFichier(m.titre, path.extname(m.fichier).slice(1)) : null,
    quiz: m.quiz || null,
    tache: taches.activePublique(m.id),
  });

  app.get('/api/telechargements', enveloppe(async (req, res) => res.json((await lister()).map(resume))));

  // Analyse d'un lien avant de choisir : titre, chaîne, durée, définitions
  // disponibles (avec leur poids), ou liste des vidéos d'une playlist.
  let analysesEnCours = 0;
  app.post('/api/analyse', json, enveloppe(async (req, res) => {
    const { url, erreur } = verifierAdresse(req.body?.url);
    if (erreur) return res.status(400).json({ erreur });
    if (analysesEnCours >= 3) return res.status(429).json({ erreur: 'Déjà plusieurs liens en cours d\'analyse : réessaie dans un instant.' });
    analysesEnCours++;
    try {
      res.json(await analyserAdresse(url, { dossierTemporaire: path.join(dossier, '.analyse') }));
    } catch (e) {
      res.status(422).json({ erreur: e.message });
    } finally {
      analysesEnCours--;
    }
  }));

  app.post('/api/telechargements', json, enveloppe(async (req, res) => {
    const { url, erreur } = verifierAdresse(req.body?.url);
    if (erreur) return res.status(400).json({ erreur });
    const options = lireOptions(req.body);
    if (options.erreur) return res.status(400).json({ erreur: options.erreur });
    const { mode, qualite, audio, extrait } = options;
    const texte = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
    const miniature = /^https:\/\/[^\s"'<>]+$/.test(req.body?.miniature || '') ? String(req.body.miniature).slice(0, 500) : null;
    let id;
    do { id = nouvelId(); } while (await lireMeta(id));
    await mkdir(rep(id), { recursive: true });
    const meta = await ecrireMeta({
      id, url, mode, qualite, audio, extrait, miniature,
      titre: texte(req.body?.titre, 200), chaine: texte(req.body?.chaine, 120),
      etat: 'attente', message: '', creee: Date.now(),
    });
    taches.ajouter({
      type: 'telechargement', videoId: id, libelle: mode === 'musique' ? 'Téléchargement de la musique' : 'Téléchargement de la vidéo',
      travail: async ({ progres, signal }) => {
        await majMeta(id, { etat: 'telechargement' });
        const r = await telecharger({ url, dossier: rep(id), nom: 'fichier', mode, qualite, audio, debut: extrait?.debut, fin: extrait?.fin ?? undefined, progres, signal });
        const chemin = path.join(rep(id), r.fichier);
        const taille = (await stat(chemin)).size;
        const titre = (await lireMeta(id))?.titre || r.titre || url;
        await majMeta(id, { etat: 'pret', fichier: r.fichier, taille, titre, duree: extrait ? await dureeFichier(chemin) : (r.duree ?? await dureeFichier(chemin)) });
        return { fichier: r.fichier };
      },
      surEchec: (message) => majMeta(id, { etat: 'erreur', message }),
    });
    res.status(201).json(resume(meta));
  }));

  app.delete('/api/telechargements/:id', avecId, enveloppe(async (req, res) => {
    taches.annulerPourVideo(req.params.id);
    await rm(rep(req.params.id), { recursive: true, force: true });
    res.status(204).end();
  }));

  // Le pont vers le quiz : la vidéo part dans sa bibliothèque, comme si on
  // l'y avait envoyée depuis l'ordinateur.
  app.post('/api/telechargements/:id/quiz', avecId, enveloppe(async (req, res) => {
    if (!quiz.url) return res.status(404).json({ erreur: 'Aucun quiz relié à ce site.' });
    const meta = await lireMeta(req.params.id);
    if (!meta || meta.etat !== 'pret' || meta.mode !== 'video') return res.status(400).json({ erreur: 'Seule une vidéo téléchargée peut partir au quiz.' });
    const base = quiz.url.replace(/\/+$/, '');
    try {
      let cookie = '';
      const session = await (await fetch(`${base}/api/session`)).json();
      if (!session.connecte) {
        const r = await fetch(`${base}/api/connexion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ motDePasse: quiz.motDePasse }) });
        if (!r.ok) throw new Error('le quiz demande un mot de passe (QUIZ_MOT_DE_PASSE).');
        cookie = (r.headers.get('set-cookie') || '').split(';')[0];
      }
      const chemin = path.join(rep(meta.id), meta.fichier);
      const { size } = await stat(chemin);
      const r = await fetch(`${base}/api/videos/televersement?nom=${encodeURIComponent(nomDeFichier(meta.titre, 'mp4'))}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(size), ...(cookie ? { cookie } : {}) },
        body: Readable.toWeb(createReadStream(chemin)),
        duplex: 'half',
      });
      if (r.status !== 201) throw new Error((await r.json().catch(() => ({}))).erreur || `réponse ${r.status}`);
      const video = await r.json();
      await majMeta(meta.id, { quiz: { id: video.id, date: Date.now() } });
      res.json({ envoye: true, quiz: video.id });
    } catch (e) {
      res.status(502).json({ erreur: `Envoi au quiz impossible : ${e.cause?.code === 'ECONNREFUSED' ? 'le quiz ne répond pas.' : e.message}` });
    }
  }));

  app.get('/api/systeme', enveloppe(async (req, res) => {
    const [ytdlp, cookies] = await Promise.all([versionYtdlp(), cookiesPresents()]);
    res.json({ ytdlp, cookies, quiz: Boolean(quiz.url), conservationJours });
  }));
  app.post('/api/systeme/maj-ytdlp', (req, res) => {
    res.status(202).json(taches.ajouter({
      type: 'maj-ytdlp', videoId: null, libelle: 'Mise à jour de yt-dlp',
      travail: async ({ signal }) => ({ message: await mettreAJour(signal) }),
    }));
  });
  app.get('/api/taches/:tid', (req, res) => {
    const t = taches.trouver(req.params.tid);
    return t ? res.json(t) : res.status(404).json({ erreur: 'Tâche inconnue.' });
  });

  app.get('/fichiers/:id', avecId, enveloppe(async (req, res) => {
    const meta = await lireMeta(req.params.id);
    if (!meta?.fichier) return res.status(404).end();
    const nom = nomDeFichier(meta.titre, path.extname(meta.fichier).slice(1));
    res.sendFile(path.join(rep(meta.id), meta.fichier), {
      headers: { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(nom)}`, 'Cache-Control': 'private, no-store' },
    }, (e) => { if (e && !res.headersSent) res.status(404).end(); });
  }));

  app.use(express.static(path.join(ICI, '..', 'public-telechargement'), {
    setHeaders: (res, fichier) => { if (/\.(html|js|css)$/.test(fichier)) res.setHeader('Cache-Control', 'no-cache'); },
  }));
  app.use((err, req, res, _next) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ erreur: 'Erreur du serveur.' });
  });
  return app;
};

// Lancement direct (node server/telechargement.js), pas lors des tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3014);
  const hote = process.env.HOTE || '0.0.0.0';
  creerApp()
    .then((app) => {
      app.listen(port, hote, () => console.log(`YT téléchargeur écoute sur ${hote}:${port}${process.env.MOT_DE_PASSE ? '' : ' (sans mot de passe)'}`));
      majAuDemarrage();
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
