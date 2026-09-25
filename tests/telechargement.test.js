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

// Réponse de « yt-dlp -J » telle que YouTube la donne (abrégée).
const reponseYoutube = {
  id: 'abc', title: 'Concert au parc', channel: 'Chaîne Test', duration: 200, webpage_url: 'https://www.youtube.com/watch?v=abc',
  thumbnail: 'https://i.ytimg.com/vi/abc/maxresdefault.jpg', extractor_key: 'Youtube',
  formats: [
    { format_id: '140', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129, filesize: 3_200_000 },
    { format_id: '251', vcodec: 'none', acodec: 'opus', abr: 135, filesize: 3_400_000 },
    { format_id: '137', vcodec: 'avc1.640028', acodec: 'none', width: 1920, height: 1080, filesize: 60_000_000 },
    { format_id: '248', vcodec: 'vp9', acodec: 'none', width: 1920, height: 1080, filesize: 40_000_000 },
    { format_id: '313', vcodec: 'vp9', acodec: 'none', width: 3840, height: 2160, filesize_approx: 300_000_000 },
    { format_id: '271', vcodec: 'vp9', acodec: 'none', width: 2560, height: 1440, tbr: 9000 },
    { format_id: '136', vcodec: 'avc1.4d401f', acodec: 'none', width: 1280, height: 720, filesize: 20_000_000 },
    { format_id: '18', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', width: 640, height: 360, filesize: 9_000_000 },
    { format_id: 'sb0', vcodec: 'none', acodec: 'none', width: 160, height: 90 },
  ],
};

test('analyse d\'un lien : définitions, poids, son, listes', async () => {
  const { lireInfos } = await import('../server/youtube.js');
  const v = lireInfos(reponseYoutube);
  assert.equal(v.type, 'video');
  assert.equal(v.titre, 'Concert au parc');
  assert.equal(v.chaine, 'Chaîne Test');
  assert.deepEqual(v.qualites.map((q) => q.res), [2160, 1440, 1080, 720, 360]);
  assert.equal(v.qualites.find((q) => q.res === 1080).taille, 60_000_000 + 3_400_000, 'le plus lourd des 1080p, plus le meilleur son');
  assert.equal(v.qualites.find((q) => q.res === 1080).h264, true);
  assert.equal(v.qualites.find((q) => q.res === 2160).h264, false);
  assert.equal(v.qualites.find((q) => q.res === 1440).taille, Math.round((9000 * 1000 / 8) * 200) + 3_400_000, 'poids estimé par le débit');
  assert.equal(v.qualites.find((q) => q.res === 360).taille, 9_000_000, 'format déjà avec son : pas de son ajouté');
  assert.deepEqual(v.son, { taille: 3_400_000 });
  // Vidéo verticale : on parle du petit côté, comme yt-dlp.
  const verticale = lireInfos({ title: 'Short', duration: 30, formats: [{ vcodec: 'avc1', acodec: 'none', width: 1080, height: 1920 }, { vcodec: 'none', acodec: 'opus', abr: 120 }] });
  assert.deepEqual(verticale.qualites.map((q) => q.res), [1080]);
  // Son seul (SoundCloud…) : pas de vidéo proposée.
  const son = lireInfos({ title: 'Morceau', duration: 180, formats: [{ vcodec: 'none', acodec: 'mp3', abr: 128 }] });
  assert.deepEqual([son.qualites, Boolean(son.son)], [[], true]);
  // Playlist (réponse « à plat »).
  const liste = lireInfos({ _type: 'playlist', title: 'Mes clips', uploader: 'Moi', entries: [
    { ie_key: 'Youtube', id: 'x1', url: 'x1', title: 'Clip 1', duration: 180, thumbnails: [{ url: 'https://i.ytimg.com/vi/x1/hq.jpg' }] },
    { ie_key: 'Youtube', id: 'x2', url: 'https://www.youtube.com/watch?v=x2', title: 'Clip 2' },
    null,
    { title: 'Sans adresse' },
  ] });
  assert.equal(liste.type, 'liste');
  assert.equal(liste.nombre, 2);
  assert.deepEqual(liste.entrees.map((e) => e.url), ['https://www.youtube.com/watch?v=x1', 'https://www.youtube.com/watch?v=x2']);
  assert.equal(liste.entrees[0].miniature, 'https://i.ytimg.com/vi/x1/hq.jpg');
});

test('options de téléchargement : format yt-dlp, vérification, libellé', async () => {
  const { argumentsFormat, FORMAT_VIDEO } = await import('../server/youtube.js');
  assert.deepEqual(argumentsFormat({ mode: 'video' }), ['-f', FORMAT_VIDEO, '--merge-output-format', 'mp4'], 'le quiz garde son format');
  assert.deepEqual(argumentsFormat({ mode: 'video', qualite: 1080 }).slice(0, 4), ['-f', 'bv*+ba/b', '-S', 'res:1080,vcodec:h264,acodec:aac']);
  assert.equal(argumentsFormat({ mode: 'video', qualite: 2160 })[3], 'res:2160,vcodec:vp9,acodec:aac');
  assert.equal(argumentsFormat({ mode: 'video', qualite: 'max' })[3], 'vcodec:vp9,acodec:aac');
  assert.ok(argumentsFormat({ mode: 'musique', audio: 'mp3-192' }).join(' ').includes('--audio-format mp3 --audio-quality 192K'));
  assert.ok(argumentsFormat({ mode: 'musique' }).join(' ').includes('--audio-quality 320K'));
  assert.ok(argumentsFormat({ mode: 'musique', audio: 'm4a' }).join(' ').includes('--audio-format m4a'));
  const { lireOptions, libelleFormat } = telechargement;
  assert.deepEqual(lireOptions({ mode: 'video', qualite: '2160' }), { mode: 'video', qualite: 2160, audio: null, extrait: null });
  assert.deepEqual(lireOptions({ mode: 'video', qualite: 999 }).qualite, 1080, 'définition inconnue : 1080p');
  assert.deepEqual(lireOptions({ mode: 'musique', audio: 'flac' }).audio, 'mp3-320');
  assert.deepEqual(lireOptions({ mode: 'musique', debut: 30, fin: 75 }).extrait, { debut: 30, fin: 75 });
  assert.deepEqual(lireOptions({ fin: 20 }).extrait, { debut: 0, fin: 20 });
  assert.ok(lireOptions({ debut: 50, fin: 40 }).erreur);
  assert.ok(lireOptions({ debut: -3 }).erreur);
  assert.equal(libelleFormat({ mode: 'video', qualite: 2160 }), 'Vidéo 4K 2160p');
  assert.equal(libelleFormat({ mode: 'video', qualite: 'max' }), 'Vidéo meilleure qualité');
  assert.equal(libelleFormat({ mode: 'musique', audio: 'm4a', extrait: { debut: 90, fin: null } }), 'Musique M4A, qualité d\'origine, extrait 1:30 à la fin');
  assert.equal(libelleFormat({ mode: 'musique' }), 'Musique MP3 320 kbit/s');
});

test('un seul yt-dlp pour les deux sites : copié si plus récent, jamais remplacé par plus ancien', async () => {
  const { mkdir: mk, writeFile: ecrire, chmod, readFile } = await import('node:fs/promises');
  const dossierFaux = path.join(racine, 'faux-ytdlp');
  await mk(dossierFaux, { recursive: true });
  const faux = async (nom, version) => {
    const chemin = path.join(dossierFaux, nom);
    await ecrire(chemin, `#!/bin/sh\necho ${version}\n`);
    await chmod(chemin, 0o755);
    return chemin;
  };
  const image = await faux('image', '2026.08.19');
  const partage = path.join(dossierFaux, 'partage', 'yt-dlp');
  const lancerNode = (code) => executer(process.execPath, ['--input-type=module', '-e', code], {});
  const essai = `process.env.YTDLP = ${JSON.stringify(image)}; process.env.YTDLP_PARTAGE = ${JSON.stringify(partage)};
    const y = await import(${JSON.stringify(new URL('../server/youtube.js', import.meta.url).href)});
    await y.preparerYtdlp(); console.log(y.cheminYtdlp(), await y.versionYtdlp());`;
  let r = await lancerNode(essai);
  assert.equal(r.sortie.trim(), `${partage} 2026.08.19`, r.erreurs);
  // Le partagé est plus récent (mis à jour depuis l'autre site) : on le garde.
  await ecrire(partage, '#!/bin/sh\necho 2026.09.30\n');
  r = await lancerNode(essai);
  assert.equal(r.sortie.trim(), `${partage} 2026.09.30`);
  assert.match(await readFile(partage, 'utf8'), /2026\.09\.30/);
});

test('extrait et formats de musique, avec le vrai yt-dlp', { skip: sauter }, async () => {
  const b = site.base;
  const a = await appel(b, '/api/analyse', { methode: 'POST', corps: { url: `file://${video.chemin}` } });
  assert.equal(a.statut, 200, JSON.stringify(a.json));
  assert.equal(a.json.type, 'video');
  assert.ok(a.json.videoInconnue && a.json.son, 'lien direct : meilleure qualité, avec le son');
  assert.equal((await appel(b, '/api/analyse', { methode: 'POST', corps: { url: 'file:///introuvable.mp4' } })).statut, 422);
  assert.equal((await appel(b, '/api/telechargements', { methode: 'POST', corps: { url: `file://${video.chemin}`, debut: 8, fin: 4 } })).statut, 400);
  const extrait = await appel(b, '/api/telechargements', { methode: 'POST', corps: { url: `file://${video.chemin}`, mode: 'video', qualite: 1080, debut: 2, fin: 7, titre: 'Mon extrait' } });
  const meilleure = await appel(b, '/api/telechargements', { methode: 'POST', corps: { url: `file://${video.chemin}`, mode: 'video', qualite: 'max' } });
  const m4a = await appel(b, '/api/telechargements', { methode: 'POST', corps: { url: `file://${video.chemin}`, mode: 'musique', audio: 'm4a' } });
  const mp3 = await appel(b, '/api/telechargements', { methode: 'POST', corps: { url: `file://${video.chemin}`, mode: 'musique', audio: 'mp3-128', debut: 1, fin: 4 } });
  await taches.attendreTout();
  const liste = (await appel(b, '/api/telechargements')).json;
  const le = liste.find((x) => x.id === extrait.json.id), lm = liste.find((x) => x.id === m4a.json.id), l3 = liste.find((x) => x.id === mp3.json.id);
  const lx = liste.find((x) => x.id === meilleure.json.id);
  for (const x of [le, lm, l3, lx]) assert.equal(x.etat, 'pret', x.message);
  assert.ok(lx.nom.endsWith('.mp4') && Math.abs(lx.duree - video.duree) < 1);
  assert.equal(le.titre, 'Mon extrait', 'le titre vu à l\'analyse est gardé');
  assert.equal(le.format, 'Vidéo 1080p, extrait 0:02 à 0:07');
  assert.ok(Math.abs(le.duree - 5) < 0.5, `extrait de 5 s : ${le.duree}`);
  assert.ok(lm.nom.endsWith('.m4a') && l3.nom.endsWith('.mp3'));
  assert.ok(Math.abs(l3.duree - 3) < 0.5, `extrait de musique de 3 s : ${l3.duree}`);
  const chemin = path.join(racine, 'essai-128.mp3');
  await writeFile(chemin, Buffer.from(await (await fetch(`${b}/fichiers/${l3.id}`)).arrayBuffer()));
  const sonde = JSON.parse((await executer(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', chemin])).sortie);
  const son = sonde.streams.find((x) => x.codec_type === 'audio');
  assert.equal(son.codec_name, 'mp3');
  assert.ok(Math.abs(Number(son.bit_rate) - 128000) < 5000, `débit ${son.bit_rate}`);
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
