// Commandes ffmpeg des exports :
//   - « nettoyée » : la vidéo entière, textes gênants masqués ;
//   - « quiz » : chaque pub jusqu'à la révélation, image figée avec la
//     question, un compte à rebours et, s'il y en a, les propositions de
//     réponse ; puis la révélation.
// Les textes libres passent par des fichiers (textfile) : ni apostrophe ni
// deux-points ne peuvent casser la commande.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { cadenceProche, edlMarqueurs } from './temps.js';
import { choixPub } from '../public/choix.js';

export const POLICE = process.env.POLICE || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

const pair = (v) => Math.max(0, 2 * Math.floor(v / 2));
const n3 = (v) => (Math.round(v * 1000) / 1000).toString();

// Rectangle en pixels, coordonnées paires (exigées par le format yuv420p).
export const rectPixels = (m, largeur, hauteur) => {
  const x = Math.min(pair(m.x * largeur), pair(largeur - 2));
  const y = Math.min(pair(m.y * hauteur), pair(hauteur - 2));
  const w = Math.max(2, Math.min(pair(m.w * largeur), pair(largeur - x)));
  const h = Math.max(2, Math.min(pair(m.h * hauteur), pair(hauteur - y)));
  return { x, y, w, h };
};

// Périodes où un masque s'applique ; null = toute la vidéo ; [] = jamais.
export const plagesMasque = (m, pubs, fps) => {
  if (m.portee === 'tout') return null;
  const demi = 0.5 / fps;
  const ids = new Set(m.pubs || []);
  return pubs
    .filter((p) => ids.has(p.id))
    .map((p) => [p.debut, (m.portee === 'avant' ? p.revelation : p.fin) - demi])
    .filter(([a, b]) => b > a);
};

// Chaîne de filtres qui applique les masques à l'entrée [entree] et
// produit [sortie]. Renvoie la liste des filtres (à joindre par « ; »).
export const filtresMasques = (masques, pubs, meta, entree, sortie) => {
  const parties = [];
  let courant = entree;
  let k = 0;
  for (const m of masques) {
    const plages = plagesMasque(m, pubs, meta.fps);
    if (plages && !plages.length) continue;
    const { x, y, w, h } = rectPixels(m, meta.largeur, meta.hauteur);
    const actif = plages ? `:enable='${plages.map(([a, b]) => `between(t,${n3(a)},${n3(b)})`).join('+')}'` : '';
    const suivant = `m${k}`;
    if (m.style === 'noir') {
      parties.push(`[${courant}]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black:t=fill${actif}[${suivant}]`);
    } else {
      let effet;
      if (m.style === 'pixels') {
        const bloc = Math.max(6, Math.round(Math.min(w, h) / 4));
        effet = `scale=${Math.max(1, Math.ceil(w / bloc))}:${Math.max(1, Math.ceil(h / bloc))}:flags=area,scale=${w}:${h}:flags=neighbor`;
      } else {
        effet = `gblur=sigma=${Math.max(8, Math.round(Math.min(w, h) / 3))}:steps=2`;
      }
      parties.push(`[${courant}]split[${suivant}a][${suivant}b]`);
      parties.push(`[${suivant}b]crop=${w}:${h}:${x}:${y},${effet}[${suivant}c]`);
      parties.push(`[${suivant}a][${suivant}c]overlay=${x}:${y}${actif}[${suivant}]`);
    }
    courant = suivant;
    k++;
  }
  parties.push(`[${courant}]null[${sortie}]`);
  return parties;
};

const base = (meta) => `[0:v:0]fps=${meta.debitTexte || meta.fps},format=yuv420p,setsar=1[v0]`;

const encodage = (meta) => [
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
  ...(meta.audio ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : []),
  '-movflags', '+faststart',
];

export const commandeNettoyee = ({ source, sortie, meta, pubs, masques }) => {
  const graphe = [base(meta), ...filtresMasques(masques, pubs, meta, 'v0', 'vout')];
  return {
    args: [
      '-hide_banner', '-nostats', '-y', '-i', source,
      '-filter_complex', graphe.join(';'),
      '-map', '[vout]', ...(meta.audio ? ['-map', '0:a:0'] : []),
      ...encodage(meta), '-progress', 'pipe:1', sortie,
    ],
    duree: meta.duree,
  };
};

// Les instants de coupe tombent sur des images entières : ainsi l'image et
// le son de chaque morceau ont exactement la même durée.
const caler = (t, fps) => Math.round(t * fps) / fps;

export const pubsDuQuiz = (pubs, fps) => pubs
  .filter((p) => p.inclure !== false)
  .map((p) => ({ ...p, D: caler(p.debut, fps), R: caler(p.revelation, fps), F: caler(p.fin, fps) }))
  .filter((p) => p.R - p.D >= 1 / fps && p.F - p.R >= 1 / fps);

// Grille des propositions : deux colonnes, la dernière case centrée si le
// nombre est impair. Coordonnées paires pour des bords nets en yuv420p.
export const grilleChoix = (W, H, n) => {
  const w = pair(W * 0.43), h = pair(H * 0.14), ecartX = pair(W * 0.03), ecartY = pair(H * 0.04);
  const x0 = pair((W - 2 * w - ecartX) / 2), y0 = pair(H * 0.44);
  return Array.from({ length: n }, (_, i) => {
    const ligne = Math.floor(i / 2), seule = i === n - 1 && n % 2 === 1;
    return { x: seule ? pair((W - w) / 2) : x0 + (i % 2) * (w + ecartX), y: y0 + ligne * (h + ecartY), w, h };
  });
};

// Fait tenir un texte dans une case : taille normale si possible, sinon
// sur deux lignes, sinon plus petit, et coupé en dernier recours.
// 0,64 : largeur moyenne d'un caractère de DejaVu Sans Bold, en tailles de police.
const K = 0.64;
export const ajusterTexte = (texte, largeur, taille, minimum, hauteur = 0) => {
  if (texte.length * K * taille <= largeur) return { texte, taille, lignes: 1 };
  let t1 = Math.max(minimum, Math.floor(largeur / (texte.length * K)));
  // Deux lignes, coupées à l'espace le plus proche du milieu.
  const espaces = [...texte.matchAll(/ /g)].map((m) => m.index);
  if (hauteur && espaces.length) {
    const coupe = espaces.reduce((a, b) => (Math.abs(b - texte.length / 2) < Math.abs(a - texte.length / 2) ? b : a));
    const l1 = texte.slice(0, coupe).trimEnd(), l2 = texte.slice(coupe + 1).trimStart();
    const t2 = Math.min(taille, Math.floor(largeur / (Math.max(l1.length, l2.length) * K)), Math.floor(hauteur / 2.3));
    if (t2 >= minimum && t2 > t1) return { texte: `${l1}\n${l2}`, taille: t2, lignes: 2 };
  }
  let s = texte;
  if (s.length * K * t1 > largeur) {
    while (s.length > 1 && (s.length + 1) * K * t1 > largeur) s = s.slice(0, -1);
    s = `${s.trimEnd()}…`;
  }
  return { texte: s, taille: t1, lignes: 1 };
};

export const texteQuestion = (modele, n) => String(modele || 'Pub {n} : quelle est la marque ?').replace(/\{n\}/g, String(n));

export const commandeQuiz = async ({ source, sortie, dossierTextes, meta, pubs, masques, options }) => {
  const Q = Math.min(30, Math.max(1, Number(options.dureeQuestion) || 5));
  const liste = pubsDuQuiz(pubs, meta.fps);
  if (!liste.length) throw new Error('Aucune pub à mettre dans le quiz.');
  await mkdir(dossierTextes, { recursive: true });
  const H = meta.hauteur;
  const taille = (div) => Math.max(12, Math.round(H / div));
  const graphe = [base(meta), ...filtresMasques(masques, pubs, meta, 'v0', 'vm')];
  const N = liste.length;
  graphe.push(`[vm]split=${2 * N}${liste.map((_, i) => `[s${2 * i}][s${2 * i + 1}]`).join('')}`);
  if (meta.audio) {
    graphe.push(`[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=${2 * N}${liste.map((_, i) => `[x${2 * i}][x${2 * i + 1}]`).join('')}`);
  }
  const concat = [];
  const plan = [];
  let t = 0;
  for (let i = 0; i < N; i++) {
    const p = liste[i];
    const L1 = p.R - p.D;
    const fQuestion = path.join(dossierTextes, `question-${i}.txt`);
    const fCompte = path.join(dossierTextes, `compte-${i}.txt`);
    await writeFile(fQuestion, texteQuestion(options.question, i + 1));
    // Le compte à rebours est calculé par ffmpeg à chaque image.
    await writeFile(fCompte, `%{eif:max(1,ceil(${n3(Q + L1)}-t)):d}`);
    const pendant = `enable='gte(t,${n3(L1)})'`;
    const choix = choixPub(p);
    let figee = `[s${2 * i}]trim=start=${n3(p.D)}:end=${n3(p.R)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${n3(Q)},` +
      `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.55:t=fill:${pendant},`;
    if (!choix) {
      figee += `drawtext=fontfile=${POLICE}:textfile=${fQuestion}:expansion=none:fontsize=${taille(13)}:fontcolor=white:x=(w-text_w)/2:y=h*0.30:${pendant},` +
        `drawtext=fontfile=${POLICE}:textfile=${fCompte}:expansion=normal:fontsize=${taille(4.5)}:fontcolor=white:x=(w-text_w)/2:y=h*0.44:${pendant}`;
    } else {
      // Question en haut, compte à rebours dessous, propositions en grille.
      figee += `drawtext=fontfile=${POLICE}:textfile=${fQuestion}:expansion=none:fontsize=${taille(15)}:fontcolor=white:x=(w-text_w)/2:y=h*0.08:${pendant},` +
        `drawtext=fontfile=${POLICE}:textfile=${fCompte}:expansion=normal:fontsize=${taille(7)}:fontcolor=white:x=(w-text_w)/2:y=h*0.19:${pendant}`;
      const cases = grilleChoix(meta.largeur, H, choix.choix.length);
      const trait = Math.max(2, pair(H / 120));
      for (const [k, c] of choix.choix.entries()) {
        const b = cases[k];
        const base = Math.round(b.h * 0.36);
        const marge = Math.round(b.h * 0.3);
        const place = b.w - 2 * marge - Math.round(base * 1.25);
        const aj = ajusterTexte(c.texte, place, base, Math.max(10, Math.round(base * 0.55)), b.h - 2 * trait - 4);
        const fChoix = path.join(dossierTextes, `choix-${i}-${k}.txt`);
        await writeFile(fChoix, aj.texte);
        const interligne = Math.round(aj.taille * 0.15);
        const yTexte = (t, lignes = 1) => b.y + Math.round((b.h - (lignes * t + (lignes - 1) * interligne)) / 2);
        figee += `,drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=0x101a2e@0.9:t=fill:${pendant}` +
          `,drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=0xF0A43A@0.95:t=${trait}:${pendant}` +
          `,drawtext=fontfile=${POLICE}:text=${c.lettre}:fontsize=${base}:fontcolor=0xF0A43A:x=${b.x + marge}:y=${yTexte(base)}:${pendant}` +
          `,drawtext=fontfile=${POLICE}:textfile=${fChoix}:expansion=none:fontsize=${aj.taille}:line_spacing=${interligne}:fontcolor=white:x=${b.x + marge + Math.round(base * 1.25)}:y=${yTexte(aj.taille, aj.lignes)}:${pendant}`;
      }
    }
    graphe.push(`${figee}[q${i}]`);
    let suite = `[s${2 * i + 1}]trim=start=${n3(p.R)}:end=${n3(p.F)},setpts=PTS-STARTPTS`;
    if (options.reponse && String(p.reponse || '').trim()) {
      const fReponse = path.join(dossierTextes, `reponse-${i}.txt`);
      await writeFile(fReponse, `Réponse${choix ? ` ${choix.lettre}` : ''} : ${String(p.reponse).trim()}`);
      // Avec des propositions, la bonne réponse s'affiche en vert.
      const fond = choix ? '0x1e7a45@0.9' : 'black@0.6';
      suite += `,drawtext=fontfile=${POLICE}:textfile=${fReponse}:expansion=none:fontsize=${taille(15)}:fontcolor=white:box=1:boxcolor=${fond}:boxborderw=${taille(40)}:x=(w-text_w)/2:y=h*0.82:enable='lt(t,3)'`;
    }
    graphe.push(`${suite}[r${i}]`);
    if (meta.audio) {
      graphe.push(`[x${2 * i}]atrim=start=${n3(p.D)}:end=${n3(p.R)},asetpts=PTS-STARTPTS,apad=whole_dur=${n3(L1 + Q)},atrim=end=${n3(L1 + Q)}[qa${i}]`);
      graphe.push(`[x${2 * i + 1}]atrim=start=${n3(p.R)}:end=${n3(p.F)},asetpts=PTS-STARTPTS[ra${i}]`);
      concat.push(`[q${i}][qa${i}][r${i}][ra${i}]`);
    } else {
      concat.push(`[q${i}][r${i}]`);
    }
    plan.push({ n: i + 1, id: p.id, debut: t, question: t + L1, revelation: t + L1 + Q, fin: t + L1 + Q + (p.F - p.R), reponse: p.reponse || '', lettre: choix?.lettre || '' });
    t += L1 + Q + (p.F - p.R);
  }
  graphe.push(`${concat.join('')}concat=n=${2 * N}:v=1:a=${meta.audio ? 1 : 0}[vout]${meta.audio ? '[aout]' : ''}`);
  return {
    args: [
      '-hide_banner', '-nostats', '-y', '-i', source,
      '-filter_complex', graphe.join(';'),
      '-map', '[vout]', ...(meta.audio ? ['-map', '[aout]'] : []),
      ...encodage(meta), '-progress', 'pipe:1', sortie,
    ],
    duree: t,
    plan,
  };
};

const nomPub = (p, n) => `Pub ${n}${String(p.reponse || '').trim() ? ` (${String(p.reponse).trim()})` : ''}`;

// Marqueurs de la vidéo d'origine : début (bleu), révélation (rouge), fin (jaune).
// Quand une pub commence là où finit la précédente, seul le début est marqué.
export const marqueursSource = (pubs) => {
  const m = [];
  pubs.forEach((p, i) => {
    m.push({ t: p.debut, nom: nomPub(p, i + 1), couleur: 'Blue' });
    m.push({ t: p.revelation, nom: `Pub ${i + 1} - revelation`, couleur: 'Red' });
    const suivante = pubs[i + 1];
    if (!suivante || suivante.debut - p.fin > 0.02) m.push({ t: p.fin, nom: `Pub ${i + 1} - fin`, couleur: 'Yellow' });
  });
  return m;
};

// Marqueurs du quiz monté : début de pub, question, révélation.
export const marqueursQuiz = (plan) => plan.flatMap((p) => [
  { t: p.debut, nom: nomPub(p, p.n), couleur: 'Blue' },
  { t: p.question, nom: `Pub ${p.n} - question`, couleur: 'Yellow' },
  { t: p.revelation, nom: `Pub ${p.n} - revelation${p.lettre ? ` (${p.lettre})` : ''}`, couleur: 'Red' },
]);

export const edlPour = (marqueurs, meta, { titre, cadenceId, position = '01:00:00:00' } = {}) =>
  edlMarqueurs(marqueurs, { titre, cadenceId: cadenceId || cadenceProche(meta.fps).id, position });
