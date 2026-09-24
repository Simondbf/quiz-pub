// Timecodes et fichier de marqueurs pour DaVinci Resolve.
// Mêmes règles que Resolve : drop frame à 29,97 et 59,94, EDL en ASCII.

export const CADENCES = [
  { id: '23.976', num: 24000, den: 1001, nominal: 24, df: false },
  { id: '24', num: 24, den: 1, nominal: 24, df: false },
  { id: '25', num: 25, den: 1, nominal: 25, df: false },
  { id: '29.97', num: 30000, den: 1001, nominal: 30, df: false },
  { id: '29.97df', num: 30000, den: 1001, nominal: 30, df: true },
  { id: '30', num: 30, den: 1, nominal: 30, df: false },
  { id: '50', num: 50, den: 1, nominal: 50, df: false },
  { id: '59.94', num: 60000, den: 1001, nominal: 60, df: false },
  { id: '59.94df', num: 60000, den: 1001, nominal: 60, df: true },
  { id: '60', num: 60, den: 1, nominal: 60, df: false },
];

export const cadence = (id) => CADENCES.find((c) => c.id === id) ?? null;
export const debit = (cad) => cad.num / cad.den;

// La cadence de timeline la plus proche des images par seconde d'une vidéo.
export const cadenceProche = (fps) => {
  let meilleure = CADENCES[2];
  for (const c of CADENCES) {
    if (c.df) continue;
    if (Math.abs(debit(c) - fps) < Math.abs(debit(meilleure) - fps)) meilleure = c;
  }
  return meilleure;
};

const deux = (n) => String(n).padStart(2, '0');

export const framesVersTc = (images, cad) => {
  const n = cad.nominal;
  let x = Math.max(0, Math.round(images));
  if (cad.df) {
    const D = n === 30 ? 2 : 4;
    const par10 = n * 600 - D * 9;
    const parMinute = n * 60 - D;
    const d = Math.floor(x / par10);
    const m = x % par10;
    x += D * 9 * d + (m > D ? D * Math.floor((m - D) / parMinute) : 0);
  }
  const ff = x % n;
  const ss = Math.floor(x / n) % 60;
  const mm = Math.floor(x / (n * 60)) % 60;
  const hh = Math.floor(x / (n * 3600)) % 24;
  return `${deux(hh)}:${deux(mm)}:${deux(ss)}${cad.df ? ';' : ':'}${deux(ff)}`;
};

export const tcVersFrames = (texte, cad) => {
  const g = String(texte ?? '').trim().split(/[:;.]/);
  if (!g.length || g.length > 4 || g.some((x) => !/^\d{1,3}$/.test(x))) return null;
  const v = g.map(Number);
  while (v.length < 4) v.unshift(0);
  const [h, m, s, f] = v;
  const n = cad.nominal;
  if (h > 23 || m > 59 || s > 59 || f >= n) return null;
  if (cad.df) {
    const D = n === 30 ? 2 : 4;
    if (s === 0 && m % 10 !== 0 && f < D) return null;
    const minutes = h * 60 + m;
    return (minutes * 60 + s) * n + f - D * (minutes - Math.floor(minutes / 10));
  }
  return ((h * 60 + m) * 60 + s) * n + f;
};

// Resolve ignore les caractères hors ASCII dans les noms de marqueurs.
export const ascii = (texte) => String(texte ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/œ/g, 'oe').replace(/Œ/g, 'OE').replace(/æ/g, 'ae').replace(/Æ/g, 'AE')
  .replace(/\|/g, '/').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();

// marqueurs : [{ t (secondes de la vidéo), nom, couleur }]
export const edlMarqueurs = (marqueurs, { titre, cadenceId, position }) => {
  const cad = cadence(cadenceId);
  if (!cad) throw new Error('cadence inconnue');
  const depart = tcVersFrames(position, cad);
  if (depart === null) throw new Error('position invalide');
  const lignes = [`TITLE: ${ascii(titre).slice(0, 70) || 'Quiz pub'}`, `FCM: ${cad.df ? 'DROP FRAME' : 'NON-DROP FRAME'}`, ''];
  const vus = new Set();
  let numero = 0;
  for (const m of [...marqueurs].sort((a, b) => a.t - b.t)) {
    const image = depart + Math.round(m.t * debit(cad));
    if (vus.has(image)) continue;
    vus.add(image);
    numero += 1;
    const a = framesVersTc(image, cad);
    const b = framesVersTc(image + 1, cad);
    lignes.push(`${String(numero).padStart(3, '0')}  001      V     C        ${a} ${b} ${a} ${b}  `);
    lignes.push(` |C:ResolveColor${m.couleur} |M:${ascii(m.nom)} |D:1`);
    lignes.push('');
  }
  return lignes.join('\r\n');
};
