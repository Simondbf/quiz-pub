// Tests des calculs, sans ffmpeg : npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framesVersTc, tcVersFrames, cadence, cadenceProche, edlMarqueurs, ascii } from '../server/temps.js';
import { lireJournal, decouper, revelation, fusionnerCoupes, coupesHisto, boitesFixes, recouvrement } from '../server/analyse.js';
import { rectPixels, plagesMasque, filtresMasques, pubsDuQuiz, texteQuestion, marqueursSource, marqueursQuiz, grilleChoix, ajusterTexte } from '../server/rendu.js';
import { choixPub } from '../public/choix.js';
import { validerProjet } from '../server/stockage.js';

test('timecodes : cadences entières et drop frame', () => {
  assert.equal(framesVersTc(0, cadence('25')), '00:00:00:00');
  assert.equal(framesVersTc(90250, cadence('25')), '01:00:10:00');
  assert.equal(framesVersTc(1799, cadence('29.97df')), '00:00:59;29');
  assert.equal(framesVersTc(1800, cadence('29.97df')), '00:01:00;02');
  assert.equal(framesVersTc(17982, cadence('29.97df')), '00:10:00;00');
  assert.equal(framesVersTc(3600, cadence('59.94df')), '00:01:00;04');
  assert.equal(framesVersTc(24, cadence('23.976')), '00:00:01:00');
  for (const id of ['23.976', '25', '29.97df', '59.94df', '60']) {
    for (const n of [0, 1, 1799, 1800, 17982, 107892, 215999, 1234567]) {
      assert.equal(tcVersFrames(framesVersTc(n, cadence(id)), cadence(id)), n, `${id} ${n}`);
    }
  }
});

test('timecodes : saisies refusées', () => {
  assert.equal(tcVersFrames('00:01:00;00', cadence('29.97df')), null);
  assert.equal(tcVersFrames('00:00:01:25', cadence('25')), null);
  assert.equal(tcVersFrames('abc', cadence('25')), null);
  assert.equal(tcVersFrames('10:12', cadence('25')), 262);
});

test('cadence de timeline la plus proche', () => {
  assert.equal(cadenceProche(25).id, '25');
  assert.equal(cadenceProche(29.97).id, '29.97');
  assert.equal(cadenceProche(23.98).id, '23.976');
  assert.equal(cadenceProche(59.94).id, '59.94');
});

test('EDL de marqueurs au format de Resolve', () => {
  const texte = edlMarqueurs(
    [{ t: 1, nom: 'Pub 1 (Côte d\'Or)', couleur: 'Blue' }, { t: 16, nom: 'Pub 1 - revelation', couleur: 'Red' }, { t: 16.001, nom: 'doublon', couleur: 'Red' }],
    { titre: 'Compilation été', cadenceId: '25', position: '01:00:00:00' },
  );
  const lignes = texte.split('\r\n');
  assert.equal(lignes[0], 'TITLE: Compilation ete');
  assert.equal(lignes[1], 'FCM: NON-DROP FRAME');
  assert.equal(lignes[3], '001  001      V     C        01:00:01:00 01:00:01:01 01:00:01:00 01:00:01:01  ');
  assert.equal(lignes[4], ' |C:ResolveColorBlue |M:Pub 1 (Cote d\'Or) |D:1');
  assert.equal(lignes[6].slice(0, 3), '002');
  assert.ok(!texte.includes('doublon'), 'deux marqueurs sur la même image : un seul gardé');
  assert.ok([...texte].every((c) => c.charCodeAt(0) < 128));
  assert.equal(ascii('a|b « c »'), 'a/b c');
});

test('lecture des journaux de ffmpeg', () => {
  const r = lireJournal([
    '[Parsed_showinfo_3 @ 0x55] n:   0 pts:  17500 pts_time:7       duration: 1',
    '[blackdetect @ 0x56] black_start:20 black_end:20.6 black_duration:0.6',
    '[silencedetect @ 0x57] silence_start: 19.98',
    '[silencedetect @ 0x57] silence_end: 20.62 | silence_duration: 0.64',
    '[Parsed_showinfo_3 @ 0x55] n:   1 pts:  3000 pts_time:1.2 duration: 1',
    '[silencedetect @ 0x57] silence_start: 97.5',
  ], 98);
  assert.deepEqual(r.coupes, [1.2, 7]);
  assert.deepEqual(r.noirs, [{ debut: 20, fin: 20.6 }]);
  assert.deepEqual(r.silences, [{ debut: 19.98, fin: 20.62 }, { debut: 97.5, fin: 98 }]);
});

test('coupes : doublons et histogramme', () => {
  assert.deepEqual(fusionnerCoupes([12.04, 12, 16, 16.08]), [12, 16]);
  const d = [0, 0.05, 0.04, 0.06, 0.05, 1.2, 0.05, 0.04];
  assert.deepEqual(coupesHisto(d, 25), [0.2]);
});

test('découpage : noirs, silence sur une coupe, intro et fin', () => {
  const pubs = decouper({
    duree: 60,
    coupes: [1, 7, 12, 16, 20.6, 28, 35, 41, 45.8, 50, 53],
    noirs: [{ debut: 0, fin: 1 }, { debut: 20, fin: 20.6 }],
    silences: [{ debut: 0, fin: 1 }, { debut: 45.3, fin: 45.8 }],
  });
  assert.equal(pubs.length, 3);
  assert.deepEqual(pubs.map((p) => [p.debut, p.revelation, p.fin]), [[1, 16, 20], [20.6, 41, 45.8], [45.8, 53, 60]]);
  assert.ok(pubs.every((p) => /^[a-z0-9]{8}$/.test(p.id) && p.inclure && p.reponse === ''));
});

test('découpage : un morceau trop court rejoint son voisin', () => {
  const pubs = decouper({ duree: 40, coupes: [], noirs: [{ debut: 18, fin: 18.5 }, { debut: 21, fin: 21.5 }], silences: [] });
  assert.equal(pubs.length, 2);
  assert.ok(pubs[0].fin - pubs[0].debut >= 5 && pubs[1].fin - pubs[1].debut >= 5);
});

test('révélation estimée quand le dernier plan manque', () => {
  const r = revelation({ debut: 10, fin: 30 }, [12]);
  assert.equal(r.source, 'estimee');
  assert.equal(r.t, 26);
  assert.equal(revelation({ debut: 10, fin: 30 }, [12, 22, 27]).t, 27);
  assert.equal(revelation({ debut: 10, fin: 30 }, [12, 22, 29.5]).t, 22, 'un dernier plan de moins d\'une seconde est ignoré');
});

test('textes fixes : un texte net est trouvé, une texture floue est écartée', () => {
  const W = 128, H = 72, total = 40;
  const compte = new Uint16Array(W * H);
  const moyenne = new Float32Array(W * H).fill(90);
  // « texte » : contours présents dans toutes les images, nets dans la moyenne
  for (let y = 8; y < 16; y++) for (let x = 90; x < 120; x++) if ((x + y) % 3 === 0) { compte[y * W + x] = total; moyenne[y * W + x] = 250; }
  // « texture » : contours fréquents, mais l'image moyenne est uniforme
  for (let y = 40; y < 60; y++) for (let x = 20; x < 60; x++) if ((x * 7 + y * 3) % 4 === 0) compte[y * W + x] = total;
  const boites = boitesFixes(compte, total, W, H, { moyenne });
  assert.equal(boites.length, 1);
  const b = boites[0];
  assert.ok(b.x < 90 / W && b.x + b.w > 119 / W && b.y < 8 / H && b.y + b.h > 15 / H);
  assert.ok(recouvrement(b, { x: 0.7, y: 0.11, w: 0.24, h: 0.11 }).iou > 0.4);
});

test('masques : pixels pairs et périodes', () => {
  assert.deepEqual(rectPixels({ x: 0.7148, y: 0, w: 0.2734, h: 0.1181 }, 640, 360), { x: 456, y: 0, w: 174, h: 42 });
  const pubs = [{ id: 'aaaaaaaa', debut: 1, revelation: 16, fin: 20 }, { id: 'bbbbbbbb', debut: 20.6, revelation: 41.6, fin: 45.2 }];
  assert.equal(plagesMasque({ portee: 'tout' }, pubs, 25), null);
  assert.deepEqual(plagesMasque({ portee: 'avant', pubs: ['bbbbbbbb'] }, pubs, 25), [[20.6, 41.58]]);
  assert.deepEqual(plagesMasque({ portee: 'pubs', pubs: ['inconnue'] }, pubs, 25), []);
  const f = filtresMasques([
    { x: 0.7, y: 0, w: 0.3, h: 0.12, style: 'flou', portee: 'tout', pubs: [] },
    { x: 0, y: 0.85, w: 0.2, h: 0.12, style: 'noir', portee: 'avant', pubs: ['aaaaaaaa'] },
    { x: 0.1, y: 0.1, w: 0.2, h: 0.2, style: 'pixels', portee: 'pubs', pubs: [] },
  ], pubs, { largeur: 640, hauteur: 360, fps: 25 }, 'v0', 'vm');
  const g = f.join(';');
  assert.match(g, /crop=192:42:448:0,gblur/);
  assert.match(g, /drawbox=x=0:y=306:w=128:h=42:color=black:t=fill:enable='between\(t,1,15\.98\)'/);
  assert.ok(!g.includes('scale='), 'un masque sans pub concernée est ignoré');
  assert.ok(g.endsWith('[m1]null[vm]'));
});

test('quiz : instants calés sur les images, texte de la question', () => {
  const liste = pubsDuQuiz([
    { id: 'a', debut: 1.013, revelation: 16.021, fin: 20.007, inclure: true },
    { id: 'b', debut: 21, revelation: 30, fin: 34, inclure: false },
  ], 25);
  assert.equal(liste.length, 1);
  assert.deepEqual([liste[0].D, liste[0].R, liste[0].F], [1, 16.04, 20]);
  assert.equal(texteQuestion('Pub {n} : quelle marque ?', 3), 'Pub 3 : quelle marque ?');
  assert.equal(marqueursSource([{ debut: 1, revelation: 16, fin: 20, reponse: 'Lu' }]).map((x) => x.nom).join('|'), 'Pub 1 (Lu)|Pub 1 - revelation|Pub 1 - fin');
});

test('projet envoyé par le navigateur : nettoyé et borné', () => {
  const p = validerProjet({
    pubs: [
      { id: 'zzzzzzzz', debut: 30, revelation: 50, fin: 40, reponse: 'Lu\u0007', propositions: [' Milka ', '', 'x'.repeat(80), 'Galler', 'en trop'], inclure: true },
      { id: '../../etc', debut: -5, revelation: 3, fin: 8 },
      { debut: 9, fin: 9.1 },
    ],
    masques: [{ id: 'masque01', x: 2, y: -1, w: 5, h: 0.1, style: 'lasers', portee: 'avant', pubs: ['zzzzzzzz', 'mauvais!'] }],
    reglages: { question: '', dureeQuestion: 400, reponse: false },
  }, 60);
  assert.equal(p.pubs.length, 2);
  assert.deepEqual(p.pubs.map((x) => [x.debut, x.revelation, x.fin]), [[0, 3, 8], [30, 40, 40]]);
  assert.ok(/^[a-z0-9]{8}$/.test(p.pubs[0].id) && p.pubs[0].id !== '../../etc');
  assert.equal(p.pubs[1].reponse, 'Lu');
  assert.deepEqual(p.pubs[1].propositions, ['Milka', '', 'x'.repeat(60)]);
  assert.deepEqual(p.pubs[0].propositions, []);
  const mq = p.masques[0];
  assert.ok(mq.x <= 0.995 && mq.y === 0 && mq.x + mq.w <= 1.0001);
  assert.equal(mq.style, 'flou');
  assert.deepEqual(mq.pubs, ['zzzzzzzz']);
  assert.equal(p.reglages.dureeQuestion, 30);
  assert.equal(p.reglages.reponse, false);
  assert.ok(p.reglages.question.includes('{n}'));
  assert.throws(() => validerProjet(null, 10));
});

test('propositions : bonne réponse placée selon la pub, sans doublon', () => {
  assert.equal(choixPub({ id: 'aaaaaaaa', reponse: '', propositions: ['Milka'] }), null, 'sans bonne réponse');
  assert.equal(choixPub({ id: 'aaaaaaaa', reponse: 'Lu', propositions: ['', '  '] }), null, 'sans fausse proposition');
  const c = choixPub({ id: 'aaaaaaaa', reponse: 'Côte d\'Or', propositions: ['Milka', 'côte d\'or', 'MILKA', 'Chaussettes Dupont'] });
  assert.equal(c.choix.length, 3, 'la réponse répétée et le doublon sont écartés');
  assert.deepEqual(c.choix.map((x) => x.lettre), ['A', 'B', 'C']);
  assert.equal(c.choix.filter((x) => x.bonne).length, 1);
  assert.equal(c.choix.find((x) => x.bonne).texte, 'Côte d\'Or');
  assert.equal(c.choix.find((x) => x.bonne).lettre, c.lettre);
  assert.deepEqual(choixPub({ id: 'aaaaaaaa', reponse: 'Côte d\'Or', propositions: ['Milka', 'Chaussettes Dupont'] }), c, 'même pub, même ordre');
  // D'une pub à l'autre, la bonne réponse change de place.
  const places = new Set();
  for (let i = 0; i < 40; i++) places.add(choixPub({ id: `pub${String(i).padStart(5, '0')}`, reponse: 'Lu', propositions: ['A1', 'B2', 'C3'] }).lettre);
  assert.deepEqual([...places].sort(), ['A', 'B', 'C', 'D']);
  assert.equal(choixPub({ id: 'x', reponse: 'Lu', propositions: ['1', '2', '3', '4', '5'] }).choix.length, 4, 'quatre cases au plus');
});

test('propositions : grille et textes trop longs', () => {
  const g = grilleChoix(1920, 1080, 4);
  assert.equal(g.length, 4);
  assert.ok(g.every((c) => c.x % 2 === 0 && c.y % 2 === 0 && c.w % 2 === 0 && c.x + c.w <= 1920 && c.y + c.h <= 1080));
  assert.ok(g[0].y === g[1].y && g[2].y > g[0].y + g[0].h, 'deux lignes de deux');
  const trois = grilleChoix(640, 360, 3);
  assert.ok(Math.abs(trois[2].x - (640 - trois[2].w) / 2) <= 1, 'la case seule est centrée');
  assert.deepEqual(ajusterTexte('Lu', 200, 18, 10, 44), { texte: 'Lu', taille: 18, lignes: 1 });
  // Trop long pour une ligne : deux lignes coupées au milieu, police plus grande qu'en une ligne.
  const deuxLignes = ajusterTexte('Les chaussettes de mon grand-père', 200, 18, 10, 44);
  assert.equal(deuxLignes.lignes, 2);
  assert.deepEqual(deuxLignes.texte.split('\n'), ['Les chaussettes', 'de mon grand-père']);
  assert.ok(deuxLignes.taille > 10 && deuxLignes.taille * 2.3 <= 44);
  assert.ok(deuxLignes.texte.split('\n').every((l) => l.length * 0.64 * deuxLignes.taille <= 200));
  // Beaucoup trop long, même sur deux lignes : une ligne, petite, coupée.
  const long = ajusterTexte('Anticonstitutionnellement-extraordinairement-long', 200, 18, 10, 44);
  assert.equal(long.lignes, 1);
  assert.ok(long.texte.endsWith('…') && long.taille === 10 && long.texte.length * 0.64 * 10 <= 200 + 0.64 * 10);
  // Sans hauteur donnée : jamais deux lignes.
  const moyen = ajusterTexte('Chaussettes Dupont', 200, 18, 10);
  assert.ok(moyen.lignes === 1 && moyen.taille < 18 && moyen.taille >= 10 && !moyen.texte.endsWith('…'));
  assert.equal(marqueursQuiz([{ n: 2, debut: 0, question: 5, revelation: 10, reponse: 'Lu', lettre: 'C' }])[2].nom, 'Pub 2 - revelation (C)');
});
