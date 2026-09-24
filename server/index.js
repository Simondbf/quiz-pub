// Quiz Pub : télécharger une compilation de pubs, repérer les révélations,
// cacher les textes gênants et monter un quiz.
import express from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rm, readdir, rename, stat, copyFile, access } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as stock from './stockage.js';
import * as taches from './taches.js';
import { analyser, sonder, nouvelId } from './analyse.js';
import { commandeNettoyee, commandeQuiz, marqueursSource, marqueursQuiz, edlPour } from './rendu.js';
import { cadence, cadenceProche, tcVersFrames, ascii } from './temps.js';
import { executer, FFMPEG, YTDLP, derniereLigne } from './outils.js';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const TAILLE_MAX = Number(process.env.TAILLE_MAX_GO || 4) * 1024 ** 3;
const COOKIES = process.env.YTDLP_COOKIES || '';
const TEST_FICHIERS = process.env.QP_TEST_FICHIERS === '1';

/* ------------------------------ Connexion ------------------------------ */

const lireSecret = async () => {
  if (process.env.SECRET_SESSION) return process.env.SECRET_SESSION;
  const fichier = path.join(stock.DATA_DIR, '.secret');
  try { return (await readFile(fichier, 'utf8')).trim(); } catch { /* premier démarrage */ }
  const s = randomBytes(32).toString('hex');
  await mkdir(stock.DATA_DIR, { recursive: true });
  await writeFile(fichier, s, { mode: 0o600 });
  return s;
};

const empreinte = (v) => createHash('sha256').update(String(v)).digest();
const egal = (a, b) => timingSafeEqual(empreinte(a), empreinte(b));

export const creerApp = async () => {
  // Sans mot de passe, le site est ouvert à quiconque connaît son adresse.
  const MOT_DE_PASSE = process.env.MOT_DE_PASSE || '';
  const OUVERT = MOT_DE_PASSE === '';
  if (!OUVERT && MOT_DE_PASSE.length < 8) throw new Error('MOT_DE_PASSE trop court (8 caractères au moins), ou laissé vide pour un site sans mot de passe : voir .env.exemple');
  // Changer le mot de passe déconnecte tout le monde : il entre dans la clé.
  const cle = createHmac('sha256', await lireSecret()).update(MOT_DE_PASSE).digest();
  const DUREE_SESSION = 30 * 24 * 3600 * 1000;
  const signer = (expire) => `${expire}.${createHmac('sha256', cle).update(String(expire)).digest('base64url')}`;
  const sessionValide = (jeton) => {
    const [expire, sig] = String(jeton || '').split('.');
    if (!expire || !sig || !(Number(expire) > Date.now())) return false;
    return egal(signer(expire), jeton);
  };
  const lireCookie = (req, nom) => {
    for (const morceau of String(req.headers.cookie || '').split(';')) {
      const [k, ...v] = morceau.trim().split('=');
      if (k === nom) return decodeURIComponent(v.join('='));
    }
    return '';
  };
  const essais = new Map();

  await mkdir(stock.VIDEOS, { recursive: true });
  // Ce qui était en cours au dernier arrêt ne reprendra pas tout seul.
  for (const meta of await stock.listerVideos()) {
    if (['telechargement', 'analyse', 'attente'].includes(meta.etat)) {
      await stock.majMeta(meta.id, { etat: 'erreur', message: 'Interrompu par un redémarrage du serveur.' });
    }
  }

  const app = express();
  app.disable('x-powered-by');
  // Derrière nginx sur la même machine : l'adresse du visiteur vient de lui.
  // nginx joint le conteneur par le réseau Docker (adresse privée) : on lui
  // fait confiance pour l'adresse réelle du visiteur (limite des essais).
  app.set('trust proxy', ['loopback', 'uniquelocal']);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    // Refuse les requêtes d'écriture venues d'un autre site.
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origine = req.headers.origin;
      if (origine) {
        let hote = '';
        try { hote = new URL(origine).host; } catch { /* origine illisible */ }
        if (hote !== req.headers.host) return res.status(403).json({ erreur: 'Origine refusée.' });
      }
    }
    next();
  });

  const json = express.json({ limit: '2mb' });

  app.post('/api/connexion', json, (req, res) => {
    if (OUVERT) return res.json({ connecte: true, motDePasse: false });
    const ip = req.ip || '?';
    const maintenant = Date.now();
    const e = (essais.get(ip) || []).filter((t) => maintenant - t < 10 * 60 * 1000);
    if (e.length >= 8) return res.status(429).json({ erreur: 'Trop d\'essais. Réessaie dans quelques minutes.' });
    if (!egal(req.body?.motDePasse ?? '', MOT_DE_PASSE)) {
      e.push(maintenant);
      essais.set(ip, e);
      return res.status(401).json({ erreur: 'Mot de passe incorrect.' });
    }
    essais.delete(ip);
    const securise = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `qp_session=${signer(maintenant + DUREE_SESSION)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DUREE_SESSION / 1000}${securise ? '; Secure' : ''}`);
    res.json({ connecte: true });
  });
  app.post('/api/deconnexion', (req, res) => {
    res.setHeader('Set-Cookie', 'qp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.json({ connecte: false });
  });
  app.get('/api/session', (req, res) => res.json({ connecte: OUVERT || sessionValide(lireCookie(req, 'qp_session')), motDePasse: !OUVERT }));

  const protege = (req, res, next) => (OUVERT || sessionValide(lireCookie(req, 'qp_session')) ? next() : res.status(401).json({ erreur: 'Connexion requise.' }));
  app.use('/api', protege);
  app.use('/media', protege);

  const avecId = (req, res, next) => (stock.idValide(req.params.id) ? next() : res.status(404).json({ erreur: 'Vidéo introuvable.' }));
  const enveloppe = (f) => (req, res, next) => Promise.resolve(f(req, res, next)).catch(next);

  /* ------------------------------ Tâches ------------------------------ */

  const lancerAnalyse = (id) => taches.ajouter({
    type: 'analyse', videoId: id, libelle: 'Analyse',
    travail: async ({ progres, signal }) => {
      const meta = await stock.majMeta(id, { etat: 'analyse', message: '' });
      const source = path.join(stock.dossier(id), meta.fichier);
      progres(0, 'Recherche des coupes, des noirs et des silences');
      const r = await analyser(source, (p) => progres(p, p < 0.7 ? 'Recherche des coupes, des noirs et des silences' : 'Recherche des textes incrustés'), signal);
      await stock.ecrireAnalyse(id, { releve: r.releve, date: Date.now() });
      const ancien = await stock.lireProjet(id);
      await stock.ecrireProjet(id, {
        pubs: r.pubs,
        // Les masques dessinés à la main survivent à une nouvelle analyse.
        masques: [...r.masques, ...(ancien?.masques || []).filter((m) => !m.auto && m.portee === 'tout')],
        reglages: ancien?.reglages || stock.REGLAGES_DEFAUT,
      });
      await stock.majMeta(id, { etat: 'prete', message: '', info: r.meta });
      return { pubs: r.pubs.length, masques: r.masques.length };
    },
    surEchec: (erreur) => stock.majMeta(id, { etat: 'erreur', message: erreur }),
  });

  const messageYtdlp = (texte) => {
    const lignes = String(texte).split(/\r?\n/).filter((l) => l.startsWith('ERROR'));
    const brut = (lignes.pop() || derniereLigne(texte)).replace(/^ERROR:\s*/, '');
    if (/confirm you.?re not a bot|Sign in to confirm/i.test(brut)) {
      return 'YouTube bloque ce serveur (« confirmez que vous n\'êtes pas un robot »). Ajoute un fichier cookies.txt (voir README), ou envoie la vidéo depuis ton ordinateur.';
    }
    if (/Video unavailable|Private video|This video is private/i.test(brut)) return 'Vidéo indisponible ou privée.';
    return `Téléchargement impossible : ${brut}`;
  };

  const FORMAT = 'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[ext=mp4][vcodec^=avc1][height<=1080]/bv*[height<=1080]+ba/b';

  const lancerTelechargement = (id, url) => taches.ajouter({
    type: 'telechargement', videoId: id, libelle: 'Téléchargement',
    travail: async ({ progres, signal }) => {
      await stock.majMeta(id, { etat: 'telechargement', message: '' });
      const rep = stock.dossier(id);
      let infos = null;
      let fichierNumero = 0;
      let dernier = 0;
      // yt-dlp réécrit le fichier de cookies à la fin : on lui en donne une
      // copie, l'original peut rester en lecture seule.
      let cookies = '';
      if (COOKIES && await access(COOKIES).then(() => true, () => false)) {
        cookies = path.join(rep, '.cookies.txt');
        await copyFile(COOKIES, cookies);
      }
      const args = [
        '--no-playlist', '--no-mtime', '--newline', '--no-colors',
        '--js-runtimes', 'node',
        '-f', FORMAT, '--merge-output-format', 'mp4',
        '-o', path.join(rep, 'source.%(ext)s'),
        '--print', 'after_move:%(.{id,title,duration,filepath})j',
        '--progress', '--progress-template', 'download:QPPROG %(progress._percent_str)s',
        ...(cookies ? ['--cookies', cookies] : []),
        ...(TEST_FICHIERS ? ['--enable-file-urls'] : []),
        '--', url,
      ];
      progres(0, 'Préparation du téléchargement');
      const { code, erreurs, sortie } = await executer(YTDLP, args, {
        signal,
        garder: 60000,
        surLigne: (l) => {
          const m = l.match(/QPPROG\s+([\d.]+)%/);
          if (m) {
            const p = Number(m[1]) / 100;
            if (p + 0.2 < dernier) fichierNumero++;
            dernier = p;
            progres(p, fichierNumero ? 'Téléchargement du son' : 'Téléchargement');
          } else if (l.trim().startsWith('{')) {
            try { infos = JSON.parse(l); } catch { /* ligne incomplète */ }
          } else if (/\[Merger\]|\[VideoConvertor\]|\[FixupM3u8\]/.test(l)) {
            progres(1, 'Assemblage de l\'image et du son');
          }
        },
      });
      if (cookies) await rm(cookies, { force: true });
      if (code !== 0) throw new Error(messageYtdlp(`${erreurs}\n${sortie}`));
      // Retrouve le fichier produit, même si la ligne d'information manque.
      const noms = (await readdir(rep)).filter((n) => n.startsWith('source.') && !n.endsWith('.part') && !n.endsWith('.ytdl'));
      const fichier = infos?.filepath && noms.includes(path.basename(infos.filepath)) ? path.basename(infos.filepath) : noms[0];
      if (!fichier) throw new Error('Le téléchargement n\'a produit aucun fichier.');
      const taille = (await stat(path.join(rep, fichier))).size;
      const titre = String(infos?.title || '').slice(0, 200);
      await stock.majMeta(id, { fichier, taille, ...(titre ? { titre } : {}), etat: 'attente' });
      lancerAnalyse(id);
      return { fichier };
    },
    surEchec: (erreur) => stock.majMeta(id, { etat: 'erreur', message: erreur }),
  });

  const horodatage = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

  const lancerExport = (id, type) => taches.ajouter({
    type: `export-${type}`, videoId: id, libelle: type === 'quiz' ? 'Montage du quiz' : 'Vidéo nettoyée',
    travail: async ({ progres, signal }) => {
      const meta = await stock.lireMeta(id);
      const projet = await stock.lireProjet(id);
      if (!meta?.info || !projet) throw new Error('Analyse la vidéo d\'abord.');
      const source = path.join(stock.dossier(id), meta.fichier);
      const repExports = stock.cheminExports(id);
      const nom = `${type === 'quiz' ? 'quiz' : 'nettoyee'}-${horodatage()}`;
      const temporaire = path.join(repExports, `.${nom}`);
      await mkdir(temporaire, { recursive: true });
      try {
        const sortieTmp = path.join(temporaire, 'rendu.mp4');
        const cmd = type === 'quiz'
          ? await commandeQuiz({ source, sortie: sortieTmp, dossierTextes: temporaire, meta: meta.info, pubs: projet.pubs, masques: projet.masques, options: projet.reglages })
          : commandeNettoyee({ source, sortie: sortieTmp, meta: meta.info, pubs: projet.pubs, masques: projet.masques });
        progres(0, 'Rendu en cours');
        const { code, erreurs } = await executer(FFMPEG, cmd.args, {
          signal,
          surLigne: (l) => {
            const m = l.match(/^out_time_(?:us|ms)=(\d+)/);
            if (m) progres(Math.min(0.99, Number(m[1]) / 1e6 / cmd.duree), 'Rendu en cours');
          },
        });
        if (code !== 0) throw new Error(`Le rendu a échoué : ${derniereLigne(erreurs)}`);
        await rename(sortieTmp, path.join(repExports, `${nom}.mp4`));
        if (type === 'quiz') {
          const edl = edlPour(marqueursQuiz(cmd.plan), meta.info, { titre: `${meta.titre || 'Quiz'} - quiz` });
          await writeFile(path.join(repExports, `${nom}.edl`), edl);
        }
        return { fichier: `${nom}.mp4`, duree: cmd.duree };
      } finally {
        await rm(temporaire, { recursive: true, force: true });
      }
    },
  });

  /* ------------------------------ Vidéos ------------------------------ */

  const resume = (meta) => ({
    id: meta.id, titre: meta.titre, origine: meta.origine, url: meta.url || null,
    creee: meta.creee, etat: meta.etat, message: meta.message || '',
    duree: meta.info?.duree ?? null, taille: meta.taille ?? null, fichierPresent: Boolean(meta.fichier && meta.taille),
    tache: taches.activePublique(meta.id),
  });

  app.get('/api/videos', enveloppe(async (req, res) => {
    res.json((await stock.listerVideos()).map(resume));
  }));

  app.post('/api/videos/youtube', json, enveloppe(async (req, res) => {
    const brut = String(req.body?.url || '').trim();
    let url;
    try { url = new URL(brut); } catch { return res.status(400).json({ erreur: 'Adresse invalide.' }); }
    const permis = ['http:', 'https:', ...(TEST_FICHIERS ? ['file:'] : [])];
    if (!permis.includes(url.protocol) || brut.length > 2000) return res.status(400).json({ erreur: 'Colle une adresse qui commence par https://' });
    const meta = await stock.creerVideo({ titre: brut, origine: 'lien', url: brut, etat: 'attente' });
    lancerTelechargement(meta.id, brut);
    res.status(201).json(resume(meta));
  }));

  app.put('/api/videos/televersement', enveloppe(async (req, res) => {
    const nomOriginal = String(req.query.nom || 'video.mp4').slice(0, 200);
    const ext = (path.extname(nomOriginal).slice(1) || 'mp4').toLowerCase();
    if (!stock.EXTENSIONS_VIDEO.includes(ext)) return res.status(400).json({ erreur: `Format non accepté (.${ext}).` });
    const annonce = Number(req.headers['content-length'] || 0);
    if (annonce > TAILLE_MAX) return res.status(413).json({ erreur: 'Fichier trop lourd.' });
    const meta = await stock.creerVideo({ titre: nomOriginal.replace(/\.[^.]+$/, ''), origine: 'fichier', etat: 'attente', fichier: `source.${ext}` });
    const cible = path.join(stock.dossier(meta.id), meta.fichier);
    let recu = 0;
    const compteur = new Transform({
      transform(morceau, _enc, suite) {
        recu += morceau.length;
        if (recu > TAILLE_MAX) return suite(new Error('Fichier trop lourd.'));
        suite(null, morceau);
      },
    });
    try {
      await pipeline(req, compteur, createWriteStream(cible));
    } catch (e) {
      await stock.supprimerVideo(meta.id);
      if (!res.headersSent) res.status(400).json({ erreur: e.message === 'Fichier trop lourd.' ? e.message : 'Envoi interrompu.' });
      return;
    }
    if (recu === 0) {
      await stock.supprimerVideo(meta.id);
      return res.status(400).json({ erreur: 'Fichier vide.' });
    }
    try {
      await sonder(cible);
    } catch (e) {
      await stock.supprimerVideo(meta.id);
      return res.status(400).json({ erreur: e.message });
    }
    const m = await stock.majMeta(meta.id, { taille: recu });
    lancerAnalyse(meta.id);
    res.status(201).json(resume(m));
  }));

  app.get('/api/videos/:id', avecId, enveloppe(async (req, res) => {
    const meta = await stock.lireMeta(req.params.id);
    if (!meta) return res.status(404).json({ erreur: 'Vidéo introuvable.' });
    const analyse = await stock.lireAnalyse(req.params.id);
    res.json({
      ...resume(meta),
      info: meta.info || null,
      projet: await stock.lireProjet(req.params.id),
      coupes: analyse?.releve?.coupes || [],
      exports: await stock.listerExports(req.params.id),
      taches: taches.lister(req.params.id).slice(0, 10),
      cadenceConseillee: meta.info ? cadenceProche(meta.info.fps).id : '25',
    });
  }));

  app.put('/api/videos/:id/projet', avecId, json, enveloppe(async (req, res) => {
    const meta = await stock.lireMeta(req.params.id);
    if (!meta?.info) return res.status(409).json({ erreur: 'La vidéo n\'est pas encore analysée.' });
    let projet;
    try { projet = stock.validerProjet(req.body, meta.info.duree); } catch (e) { return res.status(400).json({ erreur: e.message }); }
    await stock.ecrireProjet(req.params.id, projet);
    res.json(projet);
  }));

  app.patch('/api/videos/:id', avecId, json, enveloppe(async (req, res) => {
    const meta = await stock.lireMeta(req.params.id);
    if (!meta) return res.status(404).json({ erreur: 'Vidéo introuvable.' });
    const titre = String(req.body?.titre ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
    if (!titre) return res.status(400).json({ erreur: 'Titre vide.' });
    res.json(resume(await stock.majMeta(req.params.id, { titre })));
  }));

  app.post('/api/videos/:id/analyser', avecId, enveloppe(async (req, res) => {
    const meta = await stock.lireMeta(req.params.id);
    if (!meta?.fichier) return res.status(409).json({ erreur: 'Pas encore de fichier vidéo.' });
    if (taches.active(req.params.id)) return res.status(409).json({ erreur: 'Un travail est déjà en cours sur cette vidéo.' });
    await stock.majMeta(req.params.id, { etat: 'attente', message: '' });
    res.status(202).json(lancerAnalyse(req.params.id));
  }));

  app.post('/api/videos/:id/exports', avecId, json, enveloppe(async (req, res) => {
    const type = req.body?.type;
    if (!['quiz', 'nettoyee'].includes(type)) return res.status(400).json({ erreur: 'Type d\'export inconnu.' });
    const meta = await stock.lireMeta(req.params.id);
    if (!meta?.info) return res.status(409).json({ erreur: 'La vidéo n\'est pas encore analysée.' });
    res.status(202).json(lancerExport(req.params.id, type));
  }));

  app.delete('/api/videos/:id/exports/:fichier', avecId, enveloppe(async (req, res) => {
    if (!stock.nomExportValide(req.params.fichier)) return res.status(404).json({ erreur: 'Fichier introuvable.' });
    await rm(path.join(stock.cheminExports(req.params.id), req.params.fichier), { force: true });
    if (req.params.fichier.endsWith('.mp4')) await rm(path.join(stock.cheminExports(req.params.id), req.params.fichier.replace(/\.mp4$/, '.edl')), { force: true });
    res.status(204).end();
  }));

  app.delete('/api/videos/:id', avecId, enveloppe(async (req, res) => {
    taches.annulerPourVideo(req.params.id);
    // Laisse aux programmes lancés le temps de s'arrêter.
    await new Promise((r) => setTimeout(r, 300));
    await stock.supprimerVideo(req.params.id);
    res.status(204).end();
  }));

  const nomTelechargement = (meta, suffixe) => `${ascii(meta.titre || 'video').replace(/[^\w .()-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video'} - ${suffixe}`;

  app.get('/api/videos/:id/marqueurs.edl', avecId, enveloppe(async (req, res) => {
    const meta = await stock.lireMeta(req.params.id);
    const projet = await stock.lireProjet(req.params.id);
    if (!meta?.info || !projet) return res.status(409).json({ erreur: 'La vidéo n\'est pas encore analysée.' });
    const cad = cadence(String(req.query.cadence || '')) || cadenceProche(meta.info.fps);
    const position = String(req.query.position || '01:00:00:00');
    if (tcVersFrames(position, cad) === null) return res.status(400).json({ erreur: 'Position invalide pour cette cadence.' });
    const texte = edlPour(marqueursSource(projet.pubs), meta.info, { titre: meta.titre, cadenceId: cad.id, position });
    res.setHeader('Content-Type', 'text/plain; charset=us-ascii');
    res.setHeader('Content-Disposition', `attachment; filename="${nomTelechargement(meta, 'marqueurs')}.edl"`);
    res.send(texte);
  }));

  app.get('/api/taches', (req, res) => res.json(taches.lister(stock.idValide(req.query.video) ? req.query.video : undefined)));
  app.delete('/api/taches/:id', (req, res) => res.status(taches.annuler(req.params.id) ? 204 : 404).end());

  /* ------------------------------ Système ------------------------------ */

  const version = async (cmd, args) => {
    try {
      const { code, sortie } = await executer(cmd, args, {});
      return code === 0 ? sortie.trim().split('\n')[0].slice(0, 120) : null;
    } catch { return null; }
  };
  app.get('/api/systeme', enveloppe(async (req, res) => {
    const [ytdlp, ffmpeg] = await Promise.all([version(YTDLP, ['--version']), version(FFMPEG, ['-hide_banner', '-version'])]);
    const cookies = Boolean(COOKIES) && await access(COOKIES).then(() => true, () => false);
    res.json({ ytdlp, ffmpeg: ffmpeg ? ffmpeg.replace(/^ffmpeg version (\S+).*/, '$1') : null, cookies });
  }));
  app.post('/api/systeme/maj-ytdlp', (req, res) => {
    res.status(202).json(taches.ajouter({
      type: 'maj-ytdlp', videoId: null, libelle: 'Mise à jour de yt-dlp',
      travail: async ({ progres, signal }) => {
        progres(0.1, 'Mise à jour de yt-dlp');
        const { code, sortie, erreurs } = await executer(YTDLP, ['-U'], { signal });
        const texte = `${sortie}\n${erreurs}`;
        if (code !== 0) throw new Error(`Mise à jour impossible : ${derniereLigne(texte)}`);
        return { message: derniereLigne(texte) };
      },
    }));
  });

  /* ------------------------------ Fichiers ------------------------------ */

  app.get('/media/:id/source', avecId, enveloppe(async (req, res) => {
    const meta = await stock.lireMeta(req.params.id);
    if (!meta?.fichier) return res.status(404).end();
    res.sendFile(path.join(stock.dossier(req.params.id), meta.fichier), { headers: { 'Cache-Control': 'private, max-age=3600' } });
  }));
  app.get('/media/:id/exports/:fichier', avecId, enveloppe(async (req, res) => {
    if (!stock.nomExportValide(req.params.fichier)) return res.status(404).end();
    const meta = await stock.lireMeta(req.params.id);
    const suffixe = req.params.fichier.replace(/-\d{8}-\d{6}/, '');
    const options = req.query.voir === '1' ? {} : { headers: { 'Content-Disposition': `attachment; filename="${nomTelechargement(meta || {}, suffixe)}"` } };
    res.sendFile(path.join(stock.cheminExports(req.params.id), req.params.fichier), options);
  }));

  app.use(express.static(path.join(ICI, '..', 'public'), {
    setHeaders: (res, fichier) => { if (fichier.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
  }));

  app.use((err, req, res, _next) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ erreur: 'Erreur du serveur.' });
  });

  return app;
};

// Lancement direct (node server/index.js), pas lors des tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3012);
  const hote = process.env.HOTE || '0.0.0.0';
  creerApp()
    .then((app) => {
      app.listen(port, hote, () => console.log(`Quiz Pub écoute sur ${hote}:${port}${process.env.MOT_DE_PASSE ? '' : ' (sans mot de passe)'}`));
      // YouTube change souvent : yt-dlp se met à jour à chaque démarrage.
      if (process.env.MAJ_YTDLP === '1') {
        executer(YTDLP, ['-U'])
          .then(({ sortie, erreurs }) => console.log(`yt-dlp : ${derniereLigne(`${sortie}\n${erreurs}`)}`))
          .catch((e) => console.log(`yt-dlp : mise à jour impossible (${e.message})`));
      }
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}

export { nouvelId };
