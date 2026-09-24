// Tests de bout en bout avec ffmpeg (et yt-dlp s'il est installé) :
// une vraie petite compilation est fabriquée, analysée, montée en quiz.
// Lancement : npm test (ffmpeg doit être disponible).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const racine = await mkdtemp(path.join(tmpdir(), 'quizpub-'));
// Réglages lus au chargement des modules : à poser avant de les importer.
process.env.DATA_DIR = path.join(racine, 'data');
process.env.MOT_DE_PASSE = 'mot-de-passe-de-test';
process.env.QP_TEST_FICHIERS = '1';

const { executer, FFMPEG, FFPROBE, YTDLP } = await import('../server/outils.js');
const { fabriquerVideo, imageA } = await import('./video-test.js');
const { analyser } = await import('../server/analyse.js');
const { commandeNettoyee, commandeQuiz, grilleChoix } = await import('../server/rendu.js');
const { creerApp } = await import('../server/index.js');

const ffmpegPresent = await executer(FFMPEG, ['-version']).then((r) => r.code === 0).catch(() => false);
const ytdlpPresent = await executer(YTDLP, ['--version']).then((r) => r.code === 0).catch(() => false);
const sauter = ffmpegPresent ? false : 'ffmpeg absent';

let vt;
let analyse;
before(async () => {
  if (!ffmpegPresent) return;
  vt = await fabriquerVideo(path.join(racine, 'video'));
  analyse = await analyser(vt.chemin);
});
after(() => rm(racine, { recursive: true, force: true }));

const duree = async (fichier) => Number((await executer(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fichier])).sortie.trim());
const unImage = 1 / 25 + 0.002;

// Énergie des contours dans un rectangle d'une image grise.
const contours = (img, W, x0, y0, x1, y1) => {
  let s = 0;
  for (let y = y0; y < y1; y++) for (let x = x0 + 1; x < x1; x++) s += Math.abs(img[y * W + x] - img[y * W + x - 1]);
  return s;
};
const ecartMoyen = (a, b, W, x0, y0, x1, y1) => {
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += Math.abs(a[y * W + x] - b[y * W + x]); n++; }
  return s / n;
};
const moyenne = (img) => img.reduce((a, b) => a + b, 0) / img.length;

test('analyse : chaque pub, sa révélation et sa fin, à une image près', { skip: sauter }, () => {
  assert.equal(analyse.pubs.length, vt.pubs.length);
  analyse.pubs.forEach((p, i) => {
    const v = vt.pubs[i];
    assert.ok(Math.abs(p.debut - v.debut) <= unImage, `début pub ${i + 1} : ${p.debut} au lieu de ${v.debut}`);
    assert.ok(Math.abs(p.revelation - v.revelation) <= unImage, `révélation pub ${i + 1} : ${p.revelation} au lieu de ${v.revelation}`);
    assert.ok(Math.abs(p.fin - v.fin) <= unImage, `fin pub ${i + 1} : ${p.fin} au lieu de ${v.fin}`);
    assert.equal(p.source, 'coupe');
  });
});

test('analyse : le filigrane est trouvé, la marque n\'est jamais cachée', { skip: sauter }, () => {
  const filigrane = analyse.masques.filter((m) => m.portee === 'tout' && m.x > 0.6 && m.y < 0.1 && m.x + m.w > 0.95);
  assert.equal(filigrane.length, 1, JSON.stringify(analyse.masques));
  // Le nom de la marque est au centre de l'image pendant la révélation.
  const centre = { x: 0.3, y: 0.4, w: 0.4, h: 0.2 };
  for (const m of analyse.masques) {
    const touche = m.x < centre.x + centre.w && m.x + m.w > centre.x && m.y < centre.y + centre.h && m.y + m.h > centre.y;
    assert.ok(!touche || m.portee === 'avant', `masque sur la marque : ${JSON.stringify(m)}`);
  }
});

test('rendu « nettoyée » : filigrane flouté, reste de l\'image intact', { skip: sauter }, async () => {
  const sortie = path.join(racine, 'nettoyee.mp4');
  const meta = analyse.meta;
  const cmd = commandeNettoyee({ source: vt.chemin, sortie, meta, pubs: analyse.pubs, masques: analyse.masques });
  const r = await executer(FFMPEG, cmd.args);
  assert.equal(r.code, 0, r.erreurs);
  assert.ok(Math.abs((await duree(sortie)) - (await duree(vt.chemin))) < 0.1);
  const W = vt.largeur;
  const avant = await imageA(vt.chemin, 3.02), apres = await imageA(sortie, 3.02);
  const zone = [460, 4, 630, 40];
  assert.ok(contours(apres, W, ...zone) < 0.35 * contours(avant, W, ...zone), 'le filigrane doit être flou');
  assert.ok(ecartMoyen(avant, apres, W, 40, 120, 600, 280) < 6, 'le centre de l\'image ne doit pas changer');
});

test('rendu « quiz » : durées, image figée, silence, révélation et réponse', { skip: sauter }, async () => {
  const sortie = path.join(racine, 'quiz.mp4');
  const pubs = structuredClone(analyse.pubs);
  pubs[0].reponse = 'Côte d\'Or : 100% « chocolat »';
  // Pub 2 : trois propositions, dont une trop longue pour sa case.
  pubs[1].reponse = 'Lu';
  pubs[1].propositions = ['Milka', 'Les chaussettes de mon grand-père en laine', ''];
  const cmd = await commandeQuiz({
    source: vt.chemin, sortie, dossierTextes: path.join(racine, 'textes'), meta: analyse.meta, pubs, masques: analyse.masques,
    options: { question: 'Pub {n} : quelle marque ?', dureeQuestion: 2, reponse: true },
  });
  const r = await executer(FFMPEG, cmd.args);
  assert.equal(r.code, 0, r.erreurs);
  const attendu = vt.pubs.reduce((s, p) => s + (p.fin - p.debut) + 2, 0);
  assert.ok(Math.abs((await duree(sortie)) - attendu) < 0.12, `durée ${await duree(sortie)} au lieu de ${attendu}`);
  assert.ok(Math.abs(cmd.duree - attendu) < 0.05);
  const W = vt.largeur, H = vt.hauteur;
  const L1 = vt.pubs[0].revelation - vt.pubs[0].debut;
  // Pendant la question : image figée (le bas ne bouge pas) et assombrie.
  const q1 = await imageA(sortie, L1 + 0.4), q2 = await imageA(sortie, L1 + 1.5);
  assert.ok(ecartMoyen(q1, q2, W, 0, Math.round(H * 0.75), W, H) < 2, 'l\'image doit être figée pendant la question');
  const derniere = await imageA(vt.chemin, vt.pubs[0].revelation - 0.04);
  assert.ok(moyenne(q1) < 0.75 * moyenne(derniere), 'l\'image de la question doit être assombrie');
  // Le compte à rebours change : 2 puis 1.
  assert.ok(ecartMoyen(q1, q2, W, Math.round(W * 0.4), Math.round(H * 0.44), Math.round(W * 0.6), Math.round(H * 0.7)) > 3);
  // Silence pendant la question, son avant.
  const volume = async (debut, longueur) => {
    const v = await executer(FFMPEG, ['-hide_banner', '-nostats', '-ss', String(debut), '-t', String(longueur), '-i', sortie, '-af', 'volumedetect', '-f', 'null', '-']);
    return Number(v.erreurs.match(/max_volume:\s*(-?[\d.]+)/)[1]);
  };
  assert.ok((await volume(L1 + 0.2, 1.5)) < -60, 'la question doit être silencieuse');
  assert.ok((await volume(1, 2)) > -45, 'la pub doit avoir du son');
  // Après la question : le plan de la marque (fond bleu), et la réponse en bas.
  const rev = await imageA(sortie, L1 + 2 + 0.5, { couleur: true });
  const px = (x, y) => [...rev.slice((y * W + x) * 3, (y * W + x) * 3 + 3)];
  const [rr, gg, bb] = px(40, 150);
  assert.ok(Math.abs(rr - 31) < 25 && Math.abs(gg - 59) < 25 && Math.abs(bb - 115) < 25, `couleur ${[rr, gg, bb]}`);
  const bas = await imageA(sortie, L1 + 2 + 0.5);
  const revSource = await imageA(vt.chemin, vt.pubs[0].revelation + 0.5);
  assert.ok(ecartMoyen(bas, revSource, W, 100, Math.round(H * 0.8), W - 100, Math.round(H * 0.95)) > 15, 'la réponse doit s\'afficher');
  // Pub 2 : image figée avec les trois propositions, cases sombres bordées d'orange.
  const q = cmd.plan[1];
  assert.match(q.lettre, /^[ABC]$/);
  const fig = await imageA(sortie, q.question + 0.6, { couleur: true });
  const pxf = (x, y) => [...fig.slice((y * W + x) * 3, (y * W + x) * 3 + 3)];
  const cases = grilleChoix(W, H, 3);
  for (const c of cases) {
    const [r1, g1, b1] = pxf(c.x + c.w - 8, c.y + Math.round(c.h / 2));
    assert.ok(r1 < 60 && g1 < 70 && b1 < 95 && b1 >= r1, `intérieur de case ${[r1, g1, b1]}`);
    const [r2, g2, b2] = pxf(c.x + Math.round(c.w / 2), c.y);
    assert.ok(r2 > 170 && g2 > 110 && b2 < 110, `bord de case ${[r2, g2, b2]}`);
  }
  // Des lettres et des mots dans chaque case : des contours à gauche.
  const figGris = await imageA(sortie, q.question + 0.6);
  for (const c of cases) {
    let bords = 0;
    for (let y = c.y + 6; y < c.y + c.h - 6; y++) for (let x = c.x + 8; x < c.x + Math.round(c.w * 0.6); x++) {
      if (Math.abs(figGris[y * W + x] - figGris[y * W + x + 1]) > 60) bords++;
    }
    assert.ok(bords > 40, `texte absent de la case (${bords})`);
  }
  // À la révélation, la bonne réponse sur fond vert.
  const rev2 = await imageA(sortie, q.revelation + 0.5, { couleur: true });
  const yb = Math.round(H * 0.82) - Math.round(Math.round(H / 40) / 2);
  const [rv, gv, bv] = [...rev2.slice((yb * W + W / 2) * 3, (yb * W + W / 2) * 3 + 3)];
  assert.ok(gv > rv + 40 && gv > bv + 20, `bandeau vert attendu, ${[rv, gv, bv]}`);
  const tard = await imageA(sortie, L1 + 2 + 3.4);
  assert.ok(ecartMoyen(tard, await imageA(vt.chemin, vt.pubs[0].revelation + 3.4), W, 100, Math.round(H * 0.8), W - 100, Math.round(H * 0.95)) < 8, 'la réponse disparaît après 3 s');
});

/* ------------------------------ API ------------------------------ */

test('API : connexion, envoi, analyse, projet, quiz, marqueurs, suppression', { skip: sauter }, async () => {
  const app = await creerApp();
  const serveur = app.listen(0, '127.0.0.1');
  await new Promise((r) => serveur.once('listening', r));
  const base = `http://127.0.0.1:${serveur.address().port}`;
  let cookie = '';
  const appel = async (chemin, { methode = 'GET', corps, brut, entetes = {} } = {}) => {
    const r = await fetch(base + chemin, {
      method: methode,
      headers: { ...(cookie ? { cookie } : {}), ...(corps !== undefined ? { 'content-type': 'application/json' } : {}), ...entetes },
      body: brut ?? (corps !== undefined ? JSON.stringify(corps) : undefined),
      duplex: brut ? 'half' : undefined,
    });
    return r;
  };
  const attendre = async (id, etat, limite = 120000) => {
    const debut = Date.now();
    for (;;) {
      const v = await (await appel(`/api/videos/${id}`)).json();
      if (v.etat === etat && !v.tache) return v;
      if (v.etat === 'erreur') throw new Error(v.message);
      if (Date.now() - debut > limite) throw new Error(`délai dépassé (${v.etat})`);
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  try {
    assert.equal((await appel('/api/videos')).status, 401, 'sans connexion : refusé');
    assert.equal((await appel('/media/aaaaaaaa/source')).status, 401);
    assert.equal((await appel('/api/connexion', { methode: 'POST', corps: { motDePasse: 'faux' } })).status, 401);
    assert.equal((await appel('/api/connexion', { methode: 'POST', corps: { motDePasse: 'mot-de-passe-de-test' }, entetes: { origin: 'https://ailleurs.example' } })).status, 403, 'autre site : refusé');
    const ok = await appel('/api/connexion', { methode: 'POST', corps: { motDePasse: 'mot-de-passe-de-test' } });
    assert.equal(ok.status, 200);
    cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.match(ok.headers.get('set-cookie'), /HttpOnly/);

    // Envoi d'un fichier
    const envoi = await appel(`/api/videos/televersement?nom=${encodeURIComponent('Pubs 1998.mp4')}`, { methode: 'PUT', brut: await readFile(vt.chemin) });
    assert.equal(envoi.status, 201);
    const { id } = await envoi.json();
    assert.match(id, /^[a-z0-9]{8}$/);
    const v = await attendre(id, 'prete');
    assert.equal(v.titre, 'Pubs 1998');
    assert.equal(v.projet.pubs.length, 3);
    assert.equal(v.cadenceConseillee, '25');
    assert.ok(v.coupes.length >= 6);

    // Un fichier qui n'est pas une vidéo est refusé et ne laisse rien.
    const mauvais = await appel('/api/videos/televersement?nom=texte.mp4', { methode: 'PUT', brut: Buffer.from('pas une vidéo') });
    assert.equal(mauvais.status, 400);
    assert.equal((await (await appel('/api/videos')).json()).length, 1);

    // Lecture de la source avec plage d'octets (nécessaire au lecteur vidéo).
    const plage = await appel(`/media/${id}/source`, { entetes: { range: 'bytes=0-99' } });
    assert.equal(plage.status, 206);
    assert.equal((await plage.arrayBuffer()).byteLength, 100);

    // Modification du projet : réponse, pub exclue, masque dessiné.
    const projet = v.projet;
    projet.pubs[0].reponse = 'Lu';
    projet.pubs[2].inclure = false;
    projet.masques.push({ id: 'dessine1', x: 0.02, y: 0.85, w: 0.2, h: 0.1, style: 'noir', portee: 'pubs', pubs: [projet.pubs[1].id] });
    projet.reglages.dureeQuestion = 3;
    const enr = await appel(`/api/videos/${id}/projet`, { methode: 'PUT', corps: projet });
    assert.equal(enr.status, 200);
    const relu = await (await appel(`/api/videos/${id}`)).json();
    assert.equal(relu.projet.pubs[0].reponse, 'Lu');
    assert.equal(relu.projet.masques.at(-1).style, 'noir');

    // Marqueurs pour Resolve
    const edl = await appel(`/api/videos/${id}/marqueurs.edl?cadence=25&position=01:00:00:00`);
    assert.equal(edl.status, 200);
    assert.match(edl.headers.get('content-disposition'), /Pubs 1998 - marqueurs\.edl/);
    const texte = await edl.text();
    // 3 pubs × 3 repères, moins la fin de la pub 2 qui est aussi le début de la 3.
    assert.equal(texte.split('\r\n').filter((l) => l.includes('|C:ResolveColor')).length, 8);
    assert.match(texte, /\|M:Pub 1 \(Lu\) \|D:1/);
    assert.match(texte, /\|C:ResolveColorBlue \|M:Pub 3 \|D:1/);
    assert.equal((await appel(`/api/videos/${id}/marqueurs.edl?cadence=25&position=99:99`)).status, 400);

    // Montage du quiz
    const exp = await appel(`/api/videos/${id}/exports`, { methode: 'POST', corps: { type: 'quiz' } });
    assert.equal(exp.status, 202);
    const fini = await attendre(id, 'prete');
    const quiz = fini.exports.find((f) => f.nom.startsWith('quiz-') && f.nom.endsWith('.mp4'));
    assert.ok(quiz, JSON.stringify(fini.exports));
    assert.ok(fini.exports.some((f) => f.nom === quiz.nom.replace('.mp4', '.edl')));
    const telecharge = await appel(`/media/${id}/exports/${quiz.nom}`);
    assert.equal(telecharge.status, 200);
    assert.match(telecharge.headers.get('content-disposition'), /Pubs 1998 - quiz\.mp4/);
    const fichierQuiz = path.join(racine, 'quiz-api.mp4');
    await (await import('node:fs/promises')).writeFile(fichierQuiz, Buffer.from(await telecharge.arrayBuffer()));
    const attendu = vt.pubs.slice(0, 2).reduce((s, p) => s + (p.fin - p.debut) + 3, 0);
    assert.ok(Math.abs((await duree(fichierQuiz)) - attendu) < 0.12, 'deux pubs seulement, 3 s de question');
    assert.equal((await readdir(path.join(process.env.DATA_DIR, 'videos', id, 'exports'))).filter((n) => n.startsWith('.')).length, 0, 'aucun fichier temporaire oublié');

    // Chemins piégés
    assert.equal((await appel('/api/videos/..%2F..%2Fetc')).status, 404);
    assert.equal((await appel(`/media/${id}/exports/..%2Fmeta.json`)).status, 404);
    assert.equal((await appel(`/media/${id}/exports/meta.json`)).status, 404);

    // Téléchargement par lien (yt-dlp réel, sur un fichier local)
    if (ytdlpPresent) {
      const lien = await appel('/api/videos/youtube', { methode: 'POST', corps: { url: `file://${vt.chemin}` } });
      assert.equal(lien.status, 201);
      const { id: id2 } = await lien.json();
      const v2 = await attendre(id2, 'prete');
      assert.equal(v2.titre, 'compil');
      assert.equal(v2.projet.pubs.length, 3);
      await appel(`/api/videos/${id2}`, { methode: 'DELETE' });
    }
    assert.equal((await appel('/api/videos/youtube', { methode: 'POST', corps: { url: 'javascript:alert(1)' } })).status, 400);
    assert.equal((await appel('/api/videos/youtube', { methode: 'POST', corps: { url: '--exec=touch /tmp/pirate' } })).status, 400);

    const sys = await (await appel('/api/systeme')).json();
    assert.ok(sys.ffmpeg);

    assert.equal((await appel(`/api/videos/${id}`, { methode: 'DELETE' })).status, 204);
    assert.equal((await (await appel('/api/videos')).json()).length, 0);
  } finally {
    serveur.close();
  }
});
