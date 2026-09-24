// Tout est rangé sur disque, une vidéo par dossier :
//   videos/<id>/meta.json     titre, origine, état, caractéristiques
//   videos/<id>/source.<ext>  la vidéo d'origine
//   videos/<id>/analyse.json  coupes, noirs, silences relevés
//   videos/<id>/projet.json   découpage en pubs, masques, réglages du quiz
//   videos/<id>/exports/      vidéos et marqueurs produits
import { mkdir, readFile, writeFile, rename, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { nouvelId } from './analyse.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
// Le chemin des fichiers apparaît dans les commandes ffmpeg : on le veut simple.
if (!/^[\w/.-]+$/.test(DATA_DIR)) throw new Error(`DATA_DIR doit être un chemin simple (lettres, chiffres, / . - _) : ${DATA_DIR}`);
export const VIDEOS = path.join(DATA_DIR, 'videos');

export const idValide = (id) => typeof id === 'string' && /^[a-z0-9]{8}$/.test(id);
export const dossier = (id) => {
  if (!idValide(id)) throw new Error('identifiant invalide');
  return path.join(VIDEOS, id);
};
export const cheminExports = (id) => path.join(dossier(id), 'exports');

export const lireJson = async (fichier, defaut = null) => {
  try { return JSON.parse(await readFile(fichier, 'utf8')); } catch { return defaut; }
};
// Écriture en deux temps : jamais de fichier à moitié écrit après une coupure.
export const ecrireJson = async (fichier, donnees) => {
  const temporaire = `${fichier}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaire, JSON.stringify(donnees, null, 1));
  await rename(temporaire, fichier);
};

export const lireMeta = (id) => lireJson(path.join(dossier(id), 'meta.json'));
export const ecrireMeta = (id, meta) => ecrireJson(path.join(dossier(id), 'meta.json'), meta);
export const majMeta = async (id, changements) => {
  const meta = (await lireMeta(id)) || {};
  const nouveau = { ...meta, ...changements };
  await ecrireMeta(id, nouveau);
  return nouveau;
};
export const lireProjet = (id) => lireJson(path.join(dossier(id), 'projet.json'));
export const ecrireProjet = (id, projet) => ecrireJson(path.join(dossier(id), 'projet.json'), projet);
export const lireAnalyse = (id) => lireJson(path.join(dossier(id), 'analyse.json'));
export const ecrireAnalyse = (id, a) => ecrireJson(path.join(dossier(id), 'analyse.json'), a);

export const creerVideo = async (infos) => {
  let id;
  do { id = nouvelId(); } while (await lireMeta(id));
  await mkdir(path.join(dossier(id), 'exports'), { recursive: true });
  const meta = { id, creee: Date.now(), etat: 'nouvelle', message: '', ...infos };
  await ecrireMeta(id, meta);
  return meta;
};

export const listerVideos = async () => {
  await mkdir(VIDEOS, { recursive: true });
  const noms = await readdir(VIDEOS);
  const metas = await Promise.all(noms.filter(idValide).map((id) => lireMeta(id)));
  return metas.filter(Boolean).sort((a, b) => b.creee - a.creee);
};

export const supprimerVideo = (id) => rm(dossier(id), { recursive: true, force: true });

export const EXTENSIONS_VIDEO = ['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'ts', 'mpg', 'mpeg', 'flv', 'wmv', '3gp'];

export const listerExports = async (id) => {
  const rep = cheminExports(id);
  let noms = [];
  try { noms = await readdir(rep); } catch { return []; }
  const fichiers = [];
  for (const nom of noms) {
    if (!/^[\w.-]+\.(mp4|edl)$/.test(nom)) continue;
    const s = await stat(path.join(rep, nom)).catch(() => null);
    if (s?.isFile()) fichiers.push({ nom, taille: s.size, date: s.mtimeMs });
  }
  return fichiers.sort((a, b) => b.date - a.date);
};
export const nomExportValide = (nom) => typeof nom === 'string' && /^[\w.-]+\.(mp4|edl)$/.test(nom) && !nom.startsWith('.');

/* --------------------------- Validation --------------------------- */

const nombre = (v, min, max, defaut) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaut;
};
const texte = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
const r3 = (v) => Math.round(v * 1000) / 1000;

export const REGLAGES_DEFAUT = { question: 'Pub {n} : quelle est la marque ?', dureeQuestion: 5, reponse: true };

// Nettoie un projet envoyé par le navigateur : bornes, types, tailles.
export const validerProjet = (brut, duree) => {
  if (!brut || typeof brut !== 'object') throw new Error('projet invalide');
  const pubs = (Array.isArray(brut.pubs) ? brut.pubs : []).slice(0, 500).map((p) => {
    const debut = nombre(p?.debut, 0, duree, 0);
    const fin = nombre(p?.fin, 0, duree, duree);
    if (!(fin - debut >= 0.2)) return null;
    const revelation = nombre(p?.revelation, debut, fin, fin - Math.min(4, (fin - debut) / 4));
    return {
      id: idValide(p?.id) ? p.id : nouvelId(),
      debut: r3(debut), revelation: r3(revelation), fin: r3(fin),
      source: ['coupe', 'estimee', 'manuel'].includes(p?.source) ? p.source : 'manuel',
      reponse: texte(p?.reponse, 120).trim(),
      // Fausses propositions (trois au plus) : les cases vides sont gardées,
      // pour que chaque champ de la page retrouve sa place.
      propositions: (Array.isArray(p?.propositions) ? p.propositions : []).slice(0, 3).map((x) => texte(x, 60).trim()),
      inclure: p?.inclure !== false,
    };
  }).filter(Boolean).sort((a, b) => a.debut - b.debut);
  const masques = (Array.isArray(brut.masques) ? brut.masques : []).slice(0, 60).map((m) => {
    const x = nombre(m?.x, 0, 0.995, 0), y = nombre(m?.y, 0, 0.995, 0);
    const w = nombre(m?.w, 0.005, 1 - x, 0.1), h = nombre(m?.h, 0.005, 1 - y, 0.1);
    return {
      id: idValide(m?.id) ? m.id : nouvelId(),
      x: r4(x), y: r4(y), w: r4(w), h: r4(h),
      style: ['flou', 'pixels', 'noir'].includes(m?.style) ? m.style : 'flou',
      portee: ['tout', 'pubs', 'avant'].includes(m?.portee) ? m.portee : 'tout',
      pubs: (Array.isArray(m?.pubs) ? m.pubs : []).filter(idValide).slice(0, 500),
      auto: m?.auto === true,
    };
  });
  const r = brut.reglages || {};
  const reglages = {
    question: texte(r.question, 120).trim() || REGLAGES_DEFAUT.question,
    dureeQuestion: nombre(r.dureeQuestion, 1, 30, REGLAGES_DEFAUT.dureeQuestion),
    reponse: r.reponse !== false,
  };
  return { pubs, masques, reglages };
};
const r4 = (v) => Math.round(v * 10000) / 10000;
