// Tests du site de téléchargement, avec le vrai yt-dlp sur des fichiers
// locaux (adresses file://, permises seulement en test).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const racine = await mkdtemp(path.join(tmpdir(), 'telechargement-'));
process.env.QP_TEST_FICHIERS = '1';
process.env.DATA_DIR = path.join(racine, 'quiz');

const { executer, YTDLP, FFPROBE } = await import('../server/outils.js');
const { fabriquerVideo } = await import('./video-test.js');
const telechargement = await import('../server/telechargement.js');
const quizPub = await import('../server/index.js');
const taches = await import('../server/taches.js');

const ytdlpPresent = await executer(YTDLP, ['--version']).then((r) => r.code === 0).catch(() => false);
const sauter = ytdlpPresent ? false : 'yt-dlp absent';

let video, quiz, site;
const demarrer = async (app) => {
  const serveur = app.listen(0, '127.0.0.1');
  await new Promise((r) => serveur.once('listening', r));
  return { serveur, base: `http://127.0.0.1:${serveur.address().port}` };
};
const avecMotDePasse = async (mdp, f) => {
  const avant = process.env.MOT_DE_PASSE;
  process.env.MOT_DE_PASSE = mdp;
  try { return await f(); } finally { process.env.MOT_DE_PASSE = avant; }
};

before(async () => {
  if (!ytdlpPresent) return;
  video = await fabriquerVideo(path.join(racine, 'source'));
  // Le quiz a un mot de passe, le site de téléchargement non.
  quiz = await demarrer(await avecMotDePasse('mot-de-passe-du-quiz', () => quizPub.creerApp()));
  site = await demarrer(await avecMotDePasse('', () => telechargement.creerApp({
    dossier: path.join(racine, 'telechargements'),
    quiz: { url: quiz.base, motDePasse: 'mot-de-passe-du-quiz' },
  })));
});
after(() => { quiz?.serveur.close(); site?.serveur.close(); });

const appel = async (base, chemin, { methode = 'GET', corps, cookie } = {}) => {
  const r = await fetch(base + chemin, {
    method: methode,
    headers: { ...(corps !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  const texte = r.status === 204 ? '' : await r.text();
  let json = null;
  try { json = JSON.parse(texte); } catch { /* pas du JSON */ }
  return { statut: r.status, json, r };
};

test('noms de fichier lisibles partout', () => {
  assert.equal(telechargement.nomDeFichier('AC/DC : « Thunderstruck » | Live?', 'mp3'), 'AC DC « Thunderstruck » Live.mp3');
  assert.equal(telechargement.nomDeFichier('  ...  ', 'mp4'), 'telechargement.mp4');
  assert.equal(telechargement.nomDeFichier('x'.repeat(300), 'mp4').length, 154);
});

test('vidéo, musique, enregistrement, envoi au quiz, suppression', { skip: sauter }, async () => {
  const b = site.base;
  assert.deepEqual((await appel(b, '/api/session')).json, { connecte: true, motDePasse: false });
  assert.equal((await appel(b, '/api/telechargements', { methode: 'POST', corps: { url: 'pas une adresse' } })).statut, 400);
  assert.equal((await appel(b, '/api/telechargements', { methode: 'POST', corps: { url: '--exec=touch /tmp/pirate' } })).statut, 400);
  const v = await appel(b, '/api/telechargements', { methode: 'POST', corps: { url: `file://${video.chemin}`, mode: 'video' } });
  const m = await appel(b, '/api/telechargements', { methode: 'POST', corps: { url: `file://${video.chemin}`, mode: 'musique' } });
  assert.equal(v.statut, 201);
  assert.equal(m.statut, 201);
  await taches.attendreTout();
  const liste = (await appel(b, '/api/telechargements')).json;
  const lv = liste.find((x) => x.id === v.json.id);
  const lm = liste.find((x) => x.id === m.json.id);
  assert.equal(lv.etat, 'pret', lv.message);
  assert.equal(lm.etat, 'pret', lm.message);
  assert.ok(lv.titre && lv.nom.endsWith('.mp4') && lm.nom.endsWith('.mp3'), JSON.stringify([lv.nom, lm.nom]));
  assert.ok(Math.abs(lv.duree - video.duree) < 1);

  // Enregistrement : le fichier arrive avec son titre pour nom.
  const fv = await fetch(`${b}/fichiers/${lv.id}`);
  assert.equal(fv.status, 200);
  assert.equal(decodeURIComponent(fv.headers.get('content-disposition')), `attachment; filename*=UTF-8''${lv.nom}`);
  const octets = Buffer.from(await fv.arrayBuffer());
  assert.equal(octets.length, lv.taille);
  const fm = await fetch(`${b}/fichiers/${lm.id}`);
  const cheminMp3 = path.join(racine, 'essai.mp3');
  await writeFile(cheminMp3, Buffer.from(await fm.arrayBuffer()));
  const sonde = JSON.parse((await executer(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', cheminMp3])).sortie);
  assert.equal(sonde.streams.find((s) => s.codec_type === 'audio').codec_name, 'mp3');
  assert.ok(Math.abs(Number(sonde.format.duration) - video.duree) < 1);
  assert.ok(sonde.format.tags?.title, 'le titre est écrit dans le MP3');

  // Le pont : la vidéo part au quiz, qui l'analyse.
  const envoi = await appel(b, `/api/telechargements/${lv.id}/quiz`, { methode: 'POST' });
  assert.equal(envoi.statut, 200, JSON.stringify(envoi.json));
  assert.equal((await appel(b, `/api/telechargements/${lm.id}/quiz`, { methode: 'POST' })).statut, 400, 'une musique ne part pas au quiz');
  const connexion = await fetch(`${quiz.base}/api/connexion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ motDePasse: 'mot-de-passe-du-quiz' }) });
  const cookie = connexion.headers.get('set-cookie').split(';')[0];
  await taches.attendreTout();
  const videosQuiz = (await appel(quiz.base, '/api/videos', { cookie })).json;
  const recue = videosQuiz.find((x) => x.id === envoi.json.quiz);
  assert.ok(recue, 'la vidéo est dans la bibliothèque du quiz');
  assert.equal(recue.etat, 'prete', recue.message);
  assert.equal(recue.titre, lv.titre);
  assert.ok((await appel(b, '/api/telechargements')).json.find((x) => x.id === lv.id).quiz, 'l\'envoi est retenu');

  // Mot de passe du quiz inconnu : message clair.
  const sansCle = await demarrer(await avecMotDePasse('', () => telechargement.creerApp({ dossier: path.join(racine, 'telechargements'), quiz: { url: quiz.base, motDePasse: 'faux' } })));
  const refus = await appel(sansCle.base, `/api/telechargements/${lv.id}/quiz`, { methode: 'POST' });
  sansCle.serveur.close();
  assert.equal(refus.statut, 502);
  assert.match(refus.json.erreur, /mot de passe/);

  // Suppression.
  assert.equal((await appel(b, `/api/telechargements/${lv.id}`, { methode: 'DELETE' })).statut, 204);
  assert.ok(!(await appel(b, '/api/telechargements')).json.some((x) => x.id === lv.id));
  assert.equal((await fetch(`${b}/fichiers/${lv.id}`)).status, 404);
  assert.equal((await fetch(`${b}/fichiers/..%2F..%2Fetc`)).status, 404);
  const systeme = (await appel(b, '/api/systeme')).json;
  assert.equal(systeme.quiz, true);
  assert.equal(systeme.conservationJours, 7);
  assert.match(systeme.ytdlp, /^\d{4}\.\d{2}\.\d{2}/);
});

test('les fichiers anciens sont effacés au démarrage', async () => {
  const dossier = path.join(racine, 'anciens');
  for (const [id, jours] of [['vieux001', 10], ['recent01', 1]]) {
    await mkdir(path.join(dossier, id), { recursive: true });
    await writeFile(path.join(dossier, id, 'meta.json'), JSON.stringify({ id, url: 'https://x', mode: 'video', etat: 'pret', creee: Date.now() - jours * 86400000 }));
  }
  await avecMotDePasse('', () => telechargement.creerApp({ dossier, quiz: { url: '' } }));
  assert.deepEqual((await readdir(dossier)).filter((n) => !n.startsWith('.')).sort(), ['recent01']);
});

test('avec mot de passe : tout est protégé', async () => {
  const app = await avecMotDePasse('mot-de-passe-du-site', () => telechargement.creerApp({ dossier: path.join(racine, 'protege'), quiz: { url: '' } }));
  const s = await demarrer(app);
  try {
    assert.equal((await fetch(`${s.base}/api/telechargements`)).status, 401);
    assert.equal((await fetch(`${s.base}/fichiers/abcdefgh`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/connexion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"motDePasse":"faux"}' })).status, 401);
    const ok = await fetch(`${s.base}/api/connexion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"motDePasse":"mot-de-passe-du-site"}' });
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^yt_session=/);
    assert.equal((await fetch(`${s.base}/api/telechargements`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${s.base}/api/systeme`, { headers: { cookie } }).then((r) => r.json())).quiz, false);
  } finally { s.serveur.close(); }
});
