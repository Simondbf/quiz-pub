// Analyse d'une compilation de pubs.
//
// Une seule lecture de la vidéo par ffmpeg relève trois choses : les coupes
// franches (changement de plan), les passages au noir et les silences.
// On en déduit où commence et finit chaque pub, et où se trouve la
// révélation : le dernier plan, celui du logo ou du produit.
// Une seconde lecture, en petites images grises, repère les textes incrustés
// qui ne bougent pas (logo de chaîne, « Pub 3 »...) pour proposer de les cacher.
import { randomBytes } from 'node:crypto';
import { executer, imagesBrutes, FFPROBE, derniereLigne } from './outils.js';

export const nouvelId = () => randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8).toLowerCase();

/* ------------------------------ Sonde ------------------------------ */

const fraction = (texte) => {
  const [a, b] = String(texte || '').split('/').map(Number);
  return b ? a / b : Number(a) || 0;
};

export const sonder = async (chemin) => {
  const { code, sortie, erreurs } = await executer(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', chemin]);
  if (code !== 0) throw new Error(`Fichier vidéo illisible : ${derniereLigne(erreurs)}`);
  const info = JSON.parse(sortie);
  const video = (info.streams || []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error('Ce fichier ne contient pas de vidéo.');
  const audio = (info.streams || []).some((s) => s.codec_type === 'audio');
  // Cadence exacte sous forme de fraction (30000/1001), pour ffmpeg.
  const texteValide = (t) => /^\d{1,6}\/\d{1,6}$/.test(t || '') && fraction(t) > 1 && fraction(t) <= 240;
  const debitTexte = texteValide(video.avg_frame_rate) ? video.avg_frame_rate : texteValide(video.r_frame_rate) ? video.r_frame_rate : '25/1';
  const fps = fraction(debitTexte);
  const duree = Number(info.format?.duration) || Number(video.duration) || 0;
  if (!(duree > 0)) throw new Error('Durée de la vidéo inconnue.');
  return {
    duree,
    fps: Math.round(fps * 1000) / 1000,
    debitTexte,
    largeur: video.width,
    hauteur: video.height,
    audio,
    codec: video.codec_name,
  };
};

/* --------------------- Lecture des journaux ffmpeg --------------------- */

// Transforme les lignes de ffmpeg en coupes, noirs et silences.
export const lireJournal = (lignes, duree) => {
  const coupes = [];
  const noirs = [];
  const silences = [];
  let silenceOuvert = null;
  for (const l of lignes) {
    let m;
    if (l.includes('Parsed_showinfo') && (m = l.match(/pts_time:\s*(-?[\d.]+)/))) {
      coupes.push(Number(m[1]));
    } else if ((m = l.match(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/))) {
      noirs.push({ debut: Number(m[1]), fin: Number(m[2]) });
    } else if ((m = l.match(/silence_start:\s*(-?[\d.]+)/))) {
      silenceOuvert = Math.max(0, Number(m[1]));
    } else if ((m = l.match(/silence_end:\s*([\d.]+)/))) {
      silences.push({ debut: silenceOuvert ?? 0, fin: Number(m[1]) });
      silenceOuvert = null;
    }
  }
  if (silenceOuvert !== null) silences.push({ debut: silenceOuvert, fin: duree });
  coupes.sort((a, b) => a - b);
  return { coupes, noirs, silences };
};

// Distance entre les histogrammes de luminosité de deux images (0 à 2).
export const distanceHisto = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d;
};

// Coupes vues par l'histogramme : un saut net par rapport aux images
// précédentes. Complète le détecteur de ffmpeg, qui rate les coupes entre
// deux plans très animés (le mouvement masque le changement de plan).
export const coupesHisto = (distances, fps) => {
  const coupes = [];
  for (let i = 1; i < distances.length; i++) {
    const d = distances[i];
    if (d < 0.5) continue;
    let moyenne = 0, n = 0;
    for (let j = Math.max(1, i - 6); j < i; j++) { moyenne += distances[j]; n++; }
    moyenne = n ? moyenne / n : 0;
    if (d >= 3 * moyenne + 0.15) coupes.push(Math.round((i / fps) * 1000) / 1000);
  }
  return coupes;
};

// Une coupe signalée sur deux images de suite n'en est qu'une : on garde la première.
export const fusionnerCoupes = (liste, ecart = 0.1) => {
  const sortie = [];
  for (const c of [...liste].sort((a, b) => a - b)) {
    if (!sortie.length || c - sortie[sortie.length - 1] > ecart) sortie.push(c);
  }
  return sortie;
};

export const detecter = async (chemin, meta, surProgres = () => {}, signal) => {
  const lignes = [];
  const graphe = [
    '[0:v:0]scale=160:-2,blackdetect=d=0.08:pix_th=0.12:pic_th=0.97,split=2[s][h]',
    "[s]select='gt(scene,0.28)',showinfo,nullsink",
    `[h]fps=${meta.debitTexte || meta.fps},scale=64:36,format=gray[g]`,
  ];
  if (meta.audio) graphe.push('[0:a:0]silencedetect=noise=-45dB:d=0.25,anullsink');
  const taille = 64 * 36;
  const distances = [];
  let precedent = null;
  let n = 0;
  await imagesBrutes(
    ['-hide_banner', '-nostats', '-i', chemin, '-filter_complex', graphe.join(';'), '-map', '[g]', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    taille,
    (img) => {
      const h = new Float32Array(32);
      for (let i = 0; i < taille; i++) h[img[i] >> 3] += 1 / taille;
      distances.push(precedent ? distanceHisto(h, precedent) : 0);
      precedent = h;
      n++;
      if (n % 50 === 0) surProgres(Math.min(1, n / meta.fps / meta.duree));
    },
    { signal, surLigne: (l) => { if (/showinfo|black_start|silence_/.test(l)) lignes.push(l); } },
  );
  const releve = lireJournal(lignes, meta.duree);
  releve.coupes = fusionnerCoupes([...releve.coupes, ...coupesHisto(distances, meta.fps)]);
  return releve;
};

/* ------------------------- Découpage en pubs ------------------------- */

// Où se trouve la révélation : au début du dernier plan de la pub, s'il
// est dans la seconde moitié et dure au moins une seconde. Sinon, estimée
// aux 4 dernières secondes (un quart de la pub au plus).
export const revelation = (pub, coupes) => {
  const longueur = pub.fin - pub.debut;
  const dedans = coupes.filter((c) => c > pub.debut + 0.5 && c < pub.fin - 1.0 && c >= pub.debut + longueur * 0.4);
  if (dedans.length) return { t: dedans[dedans.length - 1], source: 'coupe' };
  return { t: pub.fin - Math.min(4, longueur * 0.25), source: 'estimee' };
};

export const decouper = ({ duree, coupes, noirs, silences }, options = {}) => {
  const minPub = options.minPub ?? 5;
  // Séparations entre deux pubs : un passage au noir, ou un silence qui
  // tombe sur une coupe franche.
  const seps = [];
  for (const n of noirs) seps.push({ fin: n.debut, debut: n.fin, force: 3 });
  for (const s of silences) {
    const c = coupes.filter((x) => x >= s.debut - 0.35 && x <= s.fin + 0.35);
    if (c.length) {
      const coupe = c.reduce((a, b) => (Math.abs(b - s.fin) < Math.abs(a - s.fin) ? b : a));
      seps.push({ fin: coupe, debut: coupe, force: 2 });
    }
  }
  seps.sort((a, b) => a.fin - b.fin);
  // Deux séparations à moins d'une seconde n'en font qu'une.
  const fusion = [];
  for (const s of seps) {
    const d = fusion[fusion.length - 1];
    if (d && s.fin - d.debut < 1.0) {
      d.fin = Math.min(d.fin, s.fin);
      d.debut = Math.max(d.debut, s.debut);
      d.force = Math.max(d.force, s.force);
    } else fusion.push({ ...s });
  }
  let pubs = [];
  let courant = 0;
  for (const s of fusion) {
    if (s.fin > courant + 0.8) pubs.push({ debut: courant, fin: s.fin });
    courant = Math.max(courant, s.debut);
  }
  if (duree - courant > 0.8) pubs.push({ debut: courant, fin: duree });
  // Les morceaux trop courts rejoignent leur voisin le plus court.
  let change = true;
  while (change && pubs.length > 1) {
    change = false;
    for (let i = 0; i < pubs.length; i++) {
      if (pubs[i].fin - pubs[i].debut >= minPub) continue;
      const g = pubs[i - 1], d = pubs[i + 1];
      const avecGauche = g && (!d || g.fin - g.debut <= d.fin - d.debut);
      if (avecGauche) { g.fin = pubs[i].fin; pubs.splice(i, 1); } else { d.debut = pubs[i].debut; pubs.splice(i, 1); }
      change = true;
      break;
    }
  }
  pubs = pubs.map((p) => {
    const r = revelation(p, coupes);
    return { id: nouvelId(), debut: arrondi(p.debut), revelation: arrondi(r.t), fin: arrondi(p.fin), source: r.source, reponse: '', propositions: [], inclure: true };
  });
  return pubs;
};

const arrondi = (t) => Math.round(t * 1000) / 1000;

/* ---------------------- Textes incrustés fixes ---------------------- */

// Pixels qui portent un contour net dans au moins 80 % des images : le
// contour d'un texte ou d'un logo incrusté. Un décor filmé bouge, change de
// plan ou disparaît ; un texte incrusté reste au même endroit.
// moyenne : l'image moyenne de la période. Un texte incrusté y reste net ;
// une texture qui bouge (eau, feuillage, grain) s'y fond en gris uniforme.
export const boitesFixes = (compte, total, W, H, { part = 0.8, rayon = 2, moyenne = null } = {}) => {
  if (total < 6) return [];
  const seuil = Math.ceil(total * part);
  const masque = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) masque[i] = compte[i] >= seuil ? 1 : 0;
  // Dilatation : réunit les lettres d'un même mot.
  const dilate = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!masque[y * W + x]) continue;
      for (let dy = -rayon; dy <= rayon; dy++) {
        for (let dx = -rayon; dx <= rayon; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < H && xx >= 0 && xx < W) dilate[yy * W + xx] = 1;
        }
      }
    }
  }
  const vu = new Uint8Array(W * H);
  let boites = [];
  const pile = [];
  for (let i = 0; i < W * H; i++) {
    if (!dilate[i] || vu[i]) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0;
    pile.push(i); vu[i] = 1;
    while (pile.length) {
      const j = pile.pop();
      const x = j % W, y = (j / W) | 0;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const k of [j - 1, j + 1, j - W, j + W]) {
        if (k < 0 || k >= W * H || vu[k] || !dilate[k]) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === W - 1)) continue;
        vu[k] = 1; pile.push(k);
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    // Écarte les traits fins (bord de bandes noires) et les zones énormes.
    if (w < 2 * rayon + 4 || h < 2 * rayon + 4 || w * h > 0.25 * W * H || w / h > 30 || h / w > 30) continue;
    if (moyenne && netteteMoyenne(moyenne, masque, W, H, x0, y0, x1, y1) < 0.3) continue;
    boites.push({ x0, y0, x1, y1 });
  }
  // Réunit les boîtes qui se touchent presque (mots d'une même ligne).
  let fusionne = true;
  while (fusionne) {
    fusionne = false;
    outer: for (let a = 0; a < boites.length; a++) {
      for (let b = a + 1; b < boites.length; b++) {
        const A = boites[a], B = boites[b];
        const ecartX = Math.max(0, Math.max(A.x0, B.x0) - Math.min(A.x1, B.x1));
        const ecartY = Math.max(0, Math.max(A.y0, B.y0) - Math.min(A.y1, B.y1));
        if (ecartX <= 6 && ecartY <= 2) {
          boites[a] = { x0: Math.min(A.x0, B.x0), y0: Math.min(A.y0, B.y0), x1: Math.max(A.x1, B.x1), y1: Math.max(A.y1, B.y1) };
          boites.splice(b, 1);
          fusionne = true;
          break outer;
        }
      }
    }
  }
  // Après regroupement, une zone plus grande qu'un cinquième de l'image
  // n'est pas un texte incrusté mais un décor immobile.
  boites = boites.filter((b) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) <= 0.2 * W * H);
  const marge = 2;
  return boites.map((b) => {
    const x0 = Math.max(0, b.x0 - marge), y0 = Math.max(0, b.y0 - marge);
    const x1 = Math.min(W - 1, b.x1 + marge), y1 = Math.min(H - 1, b.y1 + marge);
    return { x: x0 / W, y: y0 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H };
  });
};

export const recouvrement = (a, b) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return { iou: inter / (a.w * a.h + b.w * b.h - inter), dansA: inter / (a.w * a.h), dansB: inter / (b.w * b.h) };
};

const bords = (img, W, H, sortie, seuil = 180) => {
  sortie.fill(0);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = img[i - W + 1] + 2 * img[i + 1] + img[i + W + 1] - img[i - W - 1] - 2 * img[i - 1] - img[i + W - 1];
      const gy = img[i + W - 1] + 2 * img[i + W] + img[i + W + 1] - img[i - W - 1] - 2 * img[i - W] - img[i - W + 1];
      if (Math.abs(gx) + Math.abs(gy) > seuil) sortie[i] = 1;
    }
  }
};

// Part des pixels de contour d'une zone qui restent nets dans l'image moyenne.
const netteteMoyenne = (moyenne, masque, W, H, x0, y0, x1, y1) => {
  let total = 0, nets = 0;
  for (let y = Math.max(1, y0); y <= Math.min(H - 2, y1); y++) {
    for (let x = Math.max(1, x0); x <= Math.min(W - 2, x1); x++) {
      const i = y * W + x;
      if (!masque[i]) continue;
      total++;
      const gx = moyenne[i - W + 1] + 2 * moyenne[i + 1] + moyenne[i + W + 1] - moyenne[i - W - 1] - 2 * moyenne[i - 1] - moyenne[i + W - 1];
      const gy = moyenne[i + W - 1] + 2 * moyenne[i + W] + moyenne[i + W + 1] - moyenne[i - W - 1] - 2 * moyenne[i - W] - moyenne[i - W + 1];
      if (Math.abs(gx) + Math.abs(gy) > 120) nets++;
    }
  }
  return total ? nets / total : 0;
};

const nouveauCumul = (taille) => ({ compte: new Uint16Array(taille), somme: new Float32Array(taille), n: 0 });
const cumuler = (c, img, contour) => {
  for (let i = 0; i < img.length; i++) {
    if (contour[i]) c.compte[i]++;
    c.somme[i] += img[i];
  }
  c.n++;
};

export const zonesFixes = async (chemin, meta, pubs, surProgres = () => {}, signal) => {
  const W = 256;
  const H = Math.max(16, 2 * Math.round((W * meta.hauteur) / meta.largeur / 2));
  const cadence = Math.min(4, 1200 / meta.duree);
  const taille = W * H;
  const global = nouveauCumul(taille);
  const parPub = pubs.map(() => nouveauCumul(taille));
  const contour = new Uint8Array(taille);
  let n = 0;
  await imagesBrutes([
    '-hide_banner', '-nostats', '-i', chemin, '-map', '0:v:0',
    '-vf', `fps=${cadence.toFixed(4)},scale=${W}:${H},format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], taille, (img) => {
    const t = n / cadence;
    bords(img, W, H, contour);
    cumuler(global, img, contour);
    pubs.forEach((p, k) => {
      // Seulement avant la révélation : c'est là que le masque servira, et
      // le texte du plan final (la marque) n'a pas à être compté.
      if (t >= p.debut + 0.3 && t <= p.revelation - 0.1) cumuler(parPub[k], img, contour);
    });
    n++;
    if (n % 20 === 0) surProgres(Math.min(1, t / meta.duree));
  }, { signal });
  const boites = (c) => boitesFixes(c.compte, c.n, W, H, { moyenne: c.somme.map((v) => v / Math.max(1, c.n)) });
  // Allure d'un texte ou d'un logo incrusté : plutôt plat, pas trop grand,
  // et au bord de l'image. Ce qui est au centre d'une pub, c'est la pub
  // elle-même (souvent la marque) : on n'y touche pas.
  const ratio = meta.largeur / meta.hauteur;
  const ressembleTexte = (b, hauteurMax, aireMax) => {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const auCentre = cx > 0.3 && cx < 0.7 && cy > 0.3 && cy < 0.7;
    return b.h <= hauteurMax && b.w * b.h <= aireMax && (b.w / b.h) * ratio >= 0.8 && !auCentre;
  };
  const masques = boites(global).filter((b) => ressembleTexte(b, 0.25, 0.1)).map((b) => ({ ...b, portee: 'tout', pubs: [] }));
  // Textes fixes pendant une pub seulement (un logo de marque dans un coin,
  // une légende), regroupés s'ils reviennent au même endroit dans plusieurs
  // pubs. Ils ne sont cachés que jusqu'à la révélation.
  const groupes = [];
  pubs.forEach((p, k) => {
    if (parPub[k].n < 8) return;
    const trouvees = boites(parPub[k]);
    // Beaucoup de zones fixes : c'est un plan filmé sans bouger, pas du texte.
    if (trouvees.length > 5) return;
    for (const b of trouvees.filter((x) => ressembleTexte(x, 0.18, 0.08))) {
      if (masques.some((g) => { const r = recouvrement(g, b); return r.iou > 0.3 || r.dansB > 0.7; })) continue;
      const g = groupes.find((x) => recouvrement(x, b).iou > 0.35);
      if (g) {
        const x0 = Math.min(g.x, b.x), y0 = Math.min(g.y, b.y);
        g.w = Math.max(g.x + g.w, b.x + b.w) - x0; g.h = Math.max(g.y + g.h, b.y + b.h) - y0;
        g.x = x0; g.y = y0;
        g.pubs.push(p.id);
      } else groupes.push({ ...b, portee: 'avant', pubs: [p.id] });
    }
  });
  return [...masques, ...groupes].map((m) => ({
    id: nouvelId(), x: arr4(m.x), y: arr4(m.y), w: arr4(m.w), h: arr4(m.h),
    style: 'flou', portee: m.portee, pubs: m.pubs, auto: true,
  }));
};
const arr4 = (v) => Math.round(v * 10000) / 10000;

/* ------------------------------ Tout ------------------------------ */

export const analyser = async (chemin, surProgres = () => {}, signal) => {
  const meta = await sonder(chemin);
  const releve = await detecter(chemin, meta, (p) => surProgres(p * 0.7), signal);
  const pubs = decouper({ duree: meta.duree, ...releve });
  const masques = await zonesFixes(chemin, meta, pubs, (p) => surProgres(0.7 + p * 0.3), signal);
  surProgres(1);
  return { meta, releve, pubs, masques };
};
