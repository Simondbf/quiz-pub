// Sécurité commune aux deux sites (quiz et téléchargement) : en-têtes,
// refus des requêtes venues d'un autre site, mot de passe facultatif.
import express from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const empreinte = (v) => createHash('sha256').update(String(v)).digest();
const egal = (a, b) => timingSafeEqual(empreinte(a), empreinte(b));

const lireSecret = async (dossier) => {
  if (process.env.SECRET_SESSION) return process.env.SECRET_SESSION;
  const fichier = path.join(dossier, '.secret');
  try { return (await readFile(fichier, 'utf8')).trim(); } catch { /* premier démarrage */ }
  const s = randomBytes(32).toString('hex');
  await mkdir(dossier, { recursive: true });
  await writeFile(fichier, s, { mode: 0o600 });
  return s;
};

export const installerSecurite = (app) => {
  app.disable('x-powered-by');
  // nginx joint le conteneur par le réseau Docker (adresse privée) : on lui
  // fait confiance pour l'adresse réelle du visiteur (limite des essais).
  app.set('trust proxy', ['loopback', 'uniquelocal']);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    // Refuse les requêtes d'écriture venues d'un autre site.
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
      let hote = '';
      try { hote = new URL(req.headers.origin).host; } catch { /* origine illisible */ }
      if (hote !== req.headers.host) return res.status(403).json({ erreur: 'Origine refusée.' });
    }
    next();
  });
};

// Routes /api/connexion, /api/deconnexion, /api/session, et protection des
// chemins donnés. Sans MOT_DE_PASSE, le site est ouvert à quiconque connaît
// son adresse.
export const installerConnexion = async (app, { dossier, cookie, protegees }) => {
  const MOT_DE_PASSE = process.env.MOT_DE_PASSE || '';
  const OUVERT = MOT_DE_PASSE === '';
  if (!OUVERT && MOT_DE_PASSE.length < 8) throw new Error('MOT_DE_PASSE trop court (8 caractères au moins), ou laissé vide pour un site sans mot de passe : voir le README');
  // Changer le mot de passe déconnecte tout le monde : il entre dans la clé.
  const cle = createHmac('sha256', await lireSecret(dossier)).update(MOT_DE_PASSE).digest();
  const DUREE = 30 * 24 * 3600 * 1000;
  const signer = (expire) => `${expire}.${createHmac('sha256', cle).update(String(expire)).digest('base64url')}`;
  const valide = (jeton) => {
    const [expire, sig] = String(jeton || '').split('.');
    if (!expire || !sig || !(Number(expire) > Date.now())) return false;
    return egal(signer(expire), jeton);
  };
  const lire = (req) => {
    for (const morceau of String(req.headers.cookie || '').split(';')) {
      const [k, ...v] = morceau.trim().split('=');
      if (k === cookie) return decodeURIComponent(v.join('='));
    }
    return '';
  };
  const essais = new Map();
  app.post('/api/connexion', express.json({ limit: '10kb' }), (req, res) => {
    if (OUVERT) return res.json({ connecte: true, motDePasse: false });
    const ip = req.ip || '?';
    const maintenant = Date.now();
    const e = (essais.get(ip) || []).filter((t) => maintenant - t < 10 * 60 * 1000);
    if (e.length >= 8) return res.status(429).json({ erreur: 'Trop d\'essais. Réessaie dans quelques minutes.' });
    if (!egal(req.body?.motDePasse ?? '', MOT_DE_PASSE)) {
      e.push(maintenant);
      essais.set(ip, e);
      return res.status(401).json({ erreur: 'Mot de passe incorrect.' });
    }
    essais.delete(ip);
    const securise = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${cookie}=${signer(maintenant + DUREE)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DUREE / 1000}${securise ? '; Secure' : ''}`);
    res.json({ connecte: true, motDePasse: true });
  });
  app.post('/api/deconnexion', (req, res) => {
    res.setHeader('Set-Cookie', `${cookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ connecte: false });
  });
  app.get('/api/session', (req, res) => res.json({ connecte: OUVERT || valide(lire(req)), motDePasse: !OUVERT }));
  const protege = (req, res, next) => (OUVERT || valide(lire(req)) ? next() : res.status(401).json({ erreur: 'Connexion requise.' }));
  for (const chemin of protegees) app.use(chemin, protege);
};
