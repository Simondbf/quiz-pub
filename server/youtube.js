// Téléchargement de vidéos et de musiques avec yt-dlp, partagé par le quiz
// (server/index.js) et le site de téléchargement (server/telechargement.js).
import { copyFile, access, rm, readdir, mkdir, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { executer, YTDLP, FFMPEG, derniereLigne } from './outils.js';

// Un seul yt-dlp pour les deux sites. Au démarrage, celui de l'image est
// recopié dans le dossier de données partagé (s'il y est plus récent) ; les
// deux sites se servent ensuite de cette copie. Une mise à jour faite depuis
// l'un sert donc aussi à l'autre.
const PARTAGE = process.env.YTDLP_PARTAGE || '';
let binaire = YTDLP;
export const cheminYtdlp = () => binaire;

const versionDe = async (chemin) => {
  try {
    const { code, sortie } = await executer(chemin, ['--version']);
    return code === 0 ? sortie.trim().split('\n')[0].slice(0, 40) : null;
  } catch { return null; }
};

export const preparerYtdlp = async () => {
  if (!PARTAGE) return binaire;
  try {
    await mkdir(path.dirname(PARTAGE), { recursive: true });
    const [image, partage] = await Promise.all([versionDe(YTDLP), versionDe(PARTAGE)]);
    if (image && (!partage || image > partage)) {
      const provisoire = `${PARTAGE}.${process.pid}.tmp`;
      await copyFile(YTDLP, provisoire);
      await chmod(provisoire, 0o755);
      await rename(provisoire, PARTAGE);
    }
    if (await versionDe(PARTAGE)) binaire = PARTAGE;
  } catch (e) {
    console.log(`yt-dlp partagé indisponible (${e.message}) : chaque site garde le sien.`);
  }
  return binaire;
};

export const COOKIES = process.env.YTDLP_COOKIES || '';
// Pour les tests seulement : autorise les adresses file:// (fichiers locaux).
export const TEST_FICHIERS = process.env.QP_TEST_FICHIERS === '1';

// Vidéo : H.264 et AAC dans un MP4, jusqu'à 1080p, lisible partout
// (téléphone, PC, DaVinci Resolve). YouTube ne propose pas de H.264 au-delà.
export const FORMAT_VIDEO = 'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[ext=mp4][vcodec^=avc1][height<=1080]/bv*[height<=1080]+ba/b';

export const cookiesPresents = async () => Boolean(COOKIES) && access(COOKIES).then(() => true, () => false);

// Vérifie l'adresse collée : { url } ou { erreur }.
export const verifierAdresse = (brut) => {
  const texte = String(brut || '').trim();
  let url;
  try { url = new URL(texte); } catch { return { erreur: 'Adresse invalide.' }; }
  const permis = ['http:', 'https:', ...(TEST_FICHIERS ? ['file:'] : [])];
  if (!permis.includes(url.protocol) || texte.length > 2000) return { erreur: 'Colle une adresse qui commence par https://' };
  return { url: texte };
};

// Message clair à partir de la sortie de yt-dlp.
export const messageYtdlp = (texte) => {
  const lignes = String(texte).split(/\r?\n/).filter((l) => l.startsWith('ERROR'));
  const brut = (lignes.pop() || derniereLigne(texte)).replace(/^ERROR:\s*/, '');
  if (/confirm you.?re not a bot|Sign in to confirm/i.test(brut)) {
    return 'YouTube bloque ce serveur (« confirmez que vous n\'êtes pas un robot »). Il faut lui donner des cookies YouTube (voir README).';
  }
  if (/Video unavailable|Private video|This video is private/i.test(brut)) return 'Vidéo indisponible ou privée.';
  if (/Unsupported URL/i.test(brut)) return 'Ce lien n\'est pas reconnu : colle l\'adresse d\'une vidéo.';
  return `Téléchargement impossible : ${brut}`;
};

/* ------------------------------ Analyse d'une adresse ------------------------------ */

// Définitions proposées, de la meilleure à la plus modeste (petit côté de
// l'image, comme yt-dlp : une vidéo verticale 1080 × 1920 est une « 1080p »).
export const RESOLUTIONS = [4320, 2160, 1440, 1080, 720, 480, 360];
export const AUDIOS = { 'mp3-320': 'MP3 320 kbit/s', 'mp3-192': 'MP3 192 kbit/s', 'mp3-128': 'MP3 128 kbit/s', m4a: 'M4A, qualité d\'origine' };

const nombre = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const miniatureDe = (j) => {
  if (typeof j.thumbnail === 'string') return j.thumbnail;
  const liste = Array.isArray(j.thumbnails) ? j.thumbnails.filter((t) => t?.url) : [];
  return liste.length ? liste[liste.length - 1].url : null;
};

// Lit la réponse de « yt-dlp -J » : une vidéo, avec les définitions
// disponibles et leur poids approximatif, ou une liste de vidéos.
export const lireInfos = (j) => {
  const titre = String(j.title || j.fulltitle || '').slice(0, 200);
  const chaine = String(j.channel || j.uploader || j.playlist_uploader || '').slice(0, 120);
  if (j._type === 'playlist' || Array.isArray(j.entries)) {
    const entrees = (j.entries || []).filter(Boolean).map((e) => ({
      url: String(e.webpage_url || (/^https?:\/\//.test(e.url || '') ? e.url : '') || (e.id && e.ie_key === 'Youtube' ? `https://www.youtube.com/watch?v=${e.id}` : '')),
      titre: String(e.title || '').slice(0, 200),
      duree: nombre(e.duration),
      miniature: miniatureDe(e),
    })).filter((e) => /^https?:\/\//.test(e.url)).slice(0, 300);
    return { type: 'liste', titre, chaine, nombre: entrees.length, entrees };
  }
  const duree = nombre(j.duration);
  const formats = Array.isArray(j.formats) && j.formats.length ? j.formats : [j];
  const poids = (f) => nombre(f.filesize) ?? nombre(f.filesize_approx) ?? (nombre(f.tbr) && duree ? Math.round((f.tbr * 1000 / 8) * duree) : null);
  const aDeLImage = (f) => f.vcodec !== 'none' && (nombre(f.height) || nombre(f.width));
  const aDuSon = (f) => f.acodec && f.acodec !== 'none';
  const sonSeul = formats.filter((f) => aDuSon(f) && f.vcodec === 'none');
  const meilleurSon = sonSeul.reduce((a, f) => ((nombre(f.abr) ?? nombre(f.tbr) ?? 0) > (nombre(a?.abr) ?? nombre(a?.tbr) ?? -1) ? f : a), null);
  const niveau = (f) => {
    const cote = Math.min(nombre(f.width) ?? Infinity, nombre(f.height) ?? Infinity);
    return RESOLUTIONS.find((r) => cote >= r * 0.95) ?? null;
  };
  const parNiveau = new Map();
  for (const f of formats.filter(aDeLImage)) {
    const r = niveau(f);
    if (!r) continue;
    const q = parNiveau.get(r) || { res: r, taille: null, h264: false };
    const total = (poids(f) ?? 0) + (aDuSon(f) ? 0 : (poids(meilleurSon || {}) ?? 0));
    if (total && (q.taille === null || total > q.taille)) q.taille = total;
    if (/^avc1|^h264/i.test(f.vcodec || '')) q.h264 = true;
    parNiveau.set(r, q);
  }
  const qualites = [...parNiveau.values()].sort((a, b) => b.res - a.res);
  // Lien direct vers un fichier (site inconnu) : ni codec ni taille connus.
  // On propose alors « la meilleure qualité », image et son compris.
  const inconnu = !qualites.length && formats.some((f) => f.vcodec == null && f.acodec == null);
  const avecSon = Boolean(meilleurSon) || formats.some(aDuSon) || inconnu;
  return {
    type: 'video', titre, chaine, duree,
    url: String(j.webpage_url || j.original_url || ''),
    miniature: miniatureDe(j),
    site: String(j.extractor_key || j.extractor || ''),
    qualites,
    videoInconnue: inconnu,
    son: avecSon ? { taille: poids(meilleurSon || {}) } : null,
  };
};

const copieCookies = async (dossier) => {
  if (!(await cookiesPresents())) return '';
  await mkdir(dossier, { recursive: true });
  const copie = path.join(dossier, '.cookies.txt');
  await copyFile(COOKIES, copie);
  return copie;
};

// Titre, chaîne, durée et définitions disponibles, sans rien télécharger.
export const analyserAdresse = async (url, { dossierTemporaire, delai = 90000 } = {}) => {
  const arret = new AbortController();
  const minuterie = setTimeout(() => arret.abort(), delai);
  let cookies = '';
  try {
    cookies = dossierTemporaire ? await copieCookies(dossierTemporaire) : '';
    const r = await executer(binaire, [
      '-J', '--no-playlist', '--flat-playlist', '--no-warnings', '--no-colors', '--js-runtimes', 'node',
      ...(cookies ? ['--cookies', cookies] : []),
      ...(TEST_FICHIERS ? ['--enable-file-urls'] : []),
      '--', url,
    ], { signal: arret.signal, garder: 60000 });
    if (r.code !== 0) throw new Error(messageYtdlp(`${r.erreurs}\n${r.sortie}`).replace(/^Téléchargement impossible/, 'Lien impossible à lire'));
    let json;
    try { json = JSON.parse(r.sortie); } catch { throw new Error('Réponse illisible de yt-dlp.'); }
    return lireInfos(json);
  } catch (e) {
    if (arret.signal.aborted) throw new Error('Le site met trop de temps à répondre. Réessaie.');
    throw e;
  } finally {
    clearTimeout(minuterie);
    if (cookies) await rm(cookies, { force: true });
  }
};

/* ------------------------------ Téléchargement ------------------------------ */

// Choix du format pour yt-dlp.
//   Vidéo : la meilleure définition jusqu'à celle demandée ; jusqu'en 1080p,
//   H.264 de préférence (lisible partout), au-delà VP9 (seul proposé en 4K).
//   Sans définition demandée (le quiz) : le format historique, H.264 1080p.
export const argumentsFormat = ({ mode = 'video', qualite, audio } = {}) => {
  if (mode === 'musique') {
    const incruster = ['--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg'];
    if (audio === 'm4a') return ['-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a', '--audio-quality', '0', ...incruster];
    const debit = { 'mp3-192': '192K', 'mp3-128': '128K' }[audio] || '320K';
    return ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', debit, ...incruster];
  }
  if (qualite === undefined || qualite === null) return ['-f', FORMAT_VIDEO, '--merge-output-format', 'mp4'];
  const tri = qualite === 'max' ? 'vcodec:vp9,acodec:aac' : `res:${qualite},vcodec:${qualite <= 1080 ? 'h264' : 'vp9'},acodec:aac`;
  return ['-f', 'bv*+ba/b', '-S', tri, '--merge-output-format', 'mp4'];
};

// Télécharge une adresse dans un dossier.
//   mode : 'video' (MP4) ou 'musique' (MP3 ou M4A, avec titre et image intégrés)
//   qualite : 360 à 4320, ou 'max' ; audio : clé de AUDIOS
//   debut, fin : secondes, pour ne garder qu'un extrait
//   nom : nom du fichier produit, sans extension
// Renvoie { fichier, titre, duree }.
export const telecharger = async ({ url, dossier, nom, mode = 'video', qualite, audio, debut, fin, progres = () => {}, signal }) => {
  // yt-dlp réécrit le fichier de cookies à la fin : on lui en donne une
  // copie, l'original peut rester en lecture seule.
  const cookies = await copieCookies(dossier);
  const format = argumentsFormat({ mode, qualite, audio });
  const avecExtrait = Number.isFinite(debut) || Number.isFinite(fin);
  const sections = ['--download-sections', `*${Number.isFinite(debut) ? debut : 0}-${Number.isFinite(fin) ? fin : 'inf'}`, '--force-keyframes-at-cuts'];
  let infos = null;
  const lancer = (extrait) => {
    let fichierNumero = 0;
    let dernier = 0;
    return executer(binaire, [
      '--no-playlist', '--no-mtime', '--newline', '--no-colors',
      '--js-runtimes', 'node',
      ...format,
      ...(extrait ? sections : []),
      '-o', path.join(dossier, `${nom}.%(ext)s`),
      '--print', 'after_move:%(.{id,title,duration,filepath})j',
      '--progress', '--progress-template', 'download:QPPROG %(progress._percent_str)s',
      ...(cookies ? ['--cookies', cookies] : []),
      ...(TEST_FICHIERS ? ['--enable-file-urls'] : []),
      '--', url,
    ], {
      signal,
      garder: 60000,
      surLigne: (l) => {
        const m = l.match(/QPPROG\s+([\d.]+)%/);
        if (m) {
          const p = Number(m[1]) / 100;
          // L'image puis le son : deux téléchargements à la suite.
          if (p + 0.2 < dernier) fichierNumero++;
          dernier = p;
          progres(p, fichierNumero ? 'Téléchargement du son' : 'Téléchargement');
        } else if (l.trim().startsWith('{')) {
          try { infos = JSON.parse(l); } catch { /* ligne incomplète */ }
        } else if (/\[Merger\]|\[VideoConvertor\]|\[FixupM3u8\]/.test(l)) {
          progres(1, 'Assemblage de l\'image et du son');
        } else if (/\[ExtractAudio\]/.test(l)) {
          progres(1, 'Conversion du son');
        }
      },
    });
  };
  progres(0, 'Préparation du téléchargement');
  let resultat;
  let couperNousMemes = false;
  try {
    resultat = await lancer(avecExtrait);
    // Certains sites ne permettent pas de ne télécharger qu'un morceau : on
    // prend alors tout, puis on découpe ici.
    if (avecExtrait && resultat.code !== 0 && /cannot be partially downloaded/i.test(`${resultat.erreurs}\n${resultat.sortie}`)) {
      couperNousMemes = true;
      resultat = await lancer(false);
    }
  } finally {
    if (cookies) await rm(cookies, { force: true });
  }
  if (resultat.code !== 0) throw new Error(messageYtdlp(`${resultat.erreurs}\n${resultat.sortie}`));
  // Retrouve le fichier produit, même si la ligne d'information manque.
  const noms = (await readdir(dossier)).filter((n) => n.startsWith(`${nom}.`) && !/\.(part|ytdl|jpg|webp|png)$/.test(n));
  const fichier = infos?.filepath && noms.includes(path.basename(infos.filepath)) ? path.basename(infos.filepath) : noms[0];
  if (!fichier) throw new Error('Le téléchargement n\'a produit aucun fichier.');
  if (couperNousMemes) {
    progres(1, 'Découpe de l\'extrait');
    await couper(path.join(dossier, fichier), { debut, fin, mode, audio, signal });
  }
  return {
    fichier,
    titre: String(infos?.title || '').slice(0, 200),
    duree: Number.isFinite(Number(infos?.duration)) ? Number(infos.duration) : null,
  };
};

// Garde seulement [debut, fin] d'un fichier, à l'image près (réencodage).
export const couper = async (chemin, { debut, fin, mode, audio, signal }) => {
  const ext = path.extname(chemin).slice(1);
  const provisoire = `${chemin}.coupe.${ext}`;
  const bornes = [...(Number.isFinite(debut) ? ['-ss', String(debut)] : []), ...(Number.isFinite(fin) ? ['-to', String(fin)] : [])];
  const encodage = mode === 'musique'
    ? (ext === 'mp3'
      ? ['-map', '0:a:0', '-map', '0:v?', '-c:v', 'copy', '-c:a', 'libmp3lame', '-b:a', { 'mp3-192': '192k', 'mp3-128': '128k' }[audio] || '320k', '-id3v2_version', '3', '-map_metadata', '0']
      : ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '256k', '-map_metadata', '0'])
    : ['-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
  const { code, erreurs } = await executer(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', chemin, ...bornes, ...encodage, provisoire], { signal });
  if (code !== 0) {
    await rm(provisoire, { force: true });
    throw new Error(`Découpe impossible : ${derniereLigne(erreurs)}`);
  }
  await rename(provisoire, chemin);
};

export const versionYtdlp = () => versionDe(binaire);

export const mettreAJour = async (signal) => {
  const { code, sortie, erreurs } = await executer(binaire, ['-U'], { signal });
  const texte = `${sortie}\n${erreurs}`;
  if (code !== 0) throw new Error(`Mise à jour impossible : ${derniereLigne(texte)}`);
  return derniereLigne(texte);
};

// YouTube change souvent : yt-dlp se met à jour à chaque démarrage (MAJ_YTDLP=1).
export const majAuDemarrage = async () => {
  await preparerYtdlp();
  if (process.env.MAJ_YTDLP !== '1') return;
  mettreAJour()
    .then((m) => console.log(`yt-dlp : ${m}`))
    .catch((e) => console.log(`yt-dlp : ${e.message}`));
};
