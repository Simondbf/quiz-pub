// Quiz Pub : télécharger une compilation de pubs, repérer les révélations,
// cacher les textes gênants et monter un quiz.
import express from 'express';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, rm, rename, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as stock from './stockage.js';
import * as taches from './taches.js';
import { analyser, sonder, nouvelId } from './analyse.js';
import { commandeNettoyee, commandeQuiz, marqueursSource, marqueursQuiz, edlPour } from './rendu.js';
import { cadence, cadenceProche, tcVersFrames, ascii } from './temps.js';
import { executer, FFMPEG, derniereLigne } from './outils.js';
import { installerSecurite, installerConnexion } from './connexion.js';
import { telecharger, verifierAdresse, versionYtdlp, mettreAJour, majAuDemarrage, cookiesPresents } from './youtube.js';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const TAILLE_MAX = Number(process.env.TAILLE_MAX_GO || 4) * 1024 ** 3;

export const creerApp = async () => {
  await mkdir(stock.VIDEOS, { recursive: true });
  // Ce qui était en cours au dernier arrêt ne reprendra pas tout seul.
  for (const meta of await stock.listerVideos()) {
    if (['telechargement', 'analyse', 'attente'].includes(meta.etat)) {
      await stock.majMeta(meta.id, { etat: 'erreur', message: 'Interrompu par un redémarrage du serveur.' });
    }
  }

  const app = express();
  installerSecurite(app);
  const json = express.json({ limit: '2mb' });

  await installerConnexion(app, { dossier: stock.DATA_DIR, cookie: 'qp_session', protegees: ['/api', '/media'] });

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

  const lancerTelechargement = (id, url) => taches.ajouter({
    type: 'telechargement', videoId: id, libelle: 'Téléchargement',
    travail: async ({ progres, signal }) => {
      await stock.majMeta(id, { etat: 'telechargement', message: '' });
      const r = await telecharger({ url, dossier: stock.dossier(id), nom: 'source', mode: 'video', progres, signal });
      const taille = (await stat(path.join(stock.dossier(id), r.fichier))).size;
      await stock.majMeta(id, { fichier: r.fichier, taille, ...(r.titre ? { titre: r.titre } : {}), etat: 'attente' });
      lancerAnalyse(id);
      return { fichier: r.fichier };
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
    const { url, erreur } = verifierAdresse(req.body?.url);
    if (erreur) return res.status(400).json({ erreur });
    const meta = await stock.creerVideo({ titre: url, origine: 'lien', url, etat: 'attente' });
    lancerTelechargement(meta.id, url);
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
    const [ytdlp, ffmpeg, cookies] = await Promise.all([versionYtdlp(), version(FFMPEG, ['-hide_banner', '-version']), cookiesPresents()]);
    res.json({ ytdlp, ffmpeg: ffmpeg ? ffmpeg.replace(/^ffmpeg version (\S+).*/, '$1') : null, cookies });
  }));
  app.post('/api/systeme/maj-ytdlp', (req, res) => {
    res.status(202).json(taches.ajouter({
      type: 'maj-ytdlp', videoId: null, libelle: 'Mise à jour de yt-dlp',
      travail: async ({ progres, signal }) => {
        progres(0.1, 'Mise à jour de yt-dlp');
        return { message: await mettreAJour(signal) };
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
      majAuDemarrage();
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}

export { nouvelId };
