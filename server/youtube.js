// Téléchargement de vidéos et de musiques avec yt-dlp, partagé par le quiz
// (server/index.js) et le site de téléchargement (server/telechargement.js).
import { copyFile, access, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { executer, YTDLP, derniereLigne } from './outils.js';

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

// Télécharge une adresse dans un dossier.
//   mode : 'video' (MP4) ou 'musique' (MP3, avec titre et image intégrés)
//   nom : nom du fichier produit, sans extension
// Renvoie { fichier, titre, duree }.
export const telecharger = async ({ url, dossier, nom, mode = 'video', progres = () => {}, signal }) => {
  // yt-dlp réécrit le fichier de cookies à la fin : on lui en donne une
  // copie, l'original peut rester en lecture seule.
  let cookies = '';
  if (await cookiesPresents()) {
    cookies = path.join(dossier, '.cookies.txt');
    await copyFile(COOKIES, cookies);
  }
  const format = mode === 'musique'
    ? ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg']
    : ['-f', FORMAT_VIDEO, '--merge-output-format', 'mp4'];
  const args = [
    '--no-playlist', '--no-mtime', '--newline', '--no-colors',
    '--js-runtimes', 'node',
    ...format,
    '-o', path.join(dossier, `${nom}.%(ext)s`),
    '--print', 'after_move:%(.{id,title,duration,filepath})j',
    '--progress', '--progress-template', 'download:QPPROG %(progress._percent_str)s',
    ...(cookies ? ['--cookies', cookies] : []),
    ...(TEST_FICHIERS ? ['--enable-file-urls'] : []),
    '--', url,
  ];
  let infos = null;
  let fichierNumero = 0;
  let dernier = 0;
  progres(0, 'Préparation du téléchargement');
  let resultat;
  try {
    resultat = await executer(YTDLP, args, {
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
          progres(1, 'Conversion en MP3');
        }
      },
    });
  } finally {
    if (cookies) await rm(cookies, { force: true });
  }
  if (resultat.code !== 0) throw new Error(messageYtdlp(`${resultat.erreurs}\n${resultat.sortie}`));
  // Retrouve le fichier produit, même si la ligne d'information manque.
  const noms = (await readdir(dossier)).filter((n) => n.startsWith(`${nom}.`) && !/\.(part|ytdl|jpg|webp|png)$/.test(n));
  const fichier = infos?.filepath && noms.includes(path.basename(infos.filepath)) ? path.basename(infos.filepath) : noms[0];
  if (!fichier) throw new Error('Le téléchargement n\'a produit aucun fichier.');
  return {
    fichier,
    titre: String(infos?.title || '').slice(0, 200),
    duree: Number.isFinite(Number(infos?.duration)) ? Number(infos.duration) : null,
  };
};

export const versionYtdlp = async () => {
  try {
    const { code, sortie } = await executer(YTDLP, ['--version']);
    return code === 0 ? sortie.trim().split('\n')[0].slice(0, 40) : null;
  } catch { return null; }
};

export const mettreAJour = async (signal) => {
  const { code, sortie, erreurs } = await executer(YTDLP, ['-U'], { signal });
  const texte = `${sortie}\n${erreurs}`;
  if (code !== 0) throw new Error(`Mise à jour impossible : ${derniereLigne(texte)}`);
  return derniereLigne(texte);
};

// YouTube change souvent : yt-dlp se met à jour à chaque démarrage (MAJ_YTDLP=1).
export const majAuDemarrage = () => {
  if (process.env.MAJ_YTDLP !== '1') return;
  mettreAJour()
    .then((m) => console.log(`yt-dlp : ${m}`))
    .catch((e) => console.log(`yt-dlp : ${e.message}`));
};
