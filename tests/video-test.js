// Fabrique une petite compilation de pubs dont on connaît tout : débuts,
// révélations, fins, un filigrane permanent en haut à droite.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executer, FFMPEG } from '../server/outils.js';
import { POLICE } from '../server/rendu.js';

const W = 640, H = 360, FPS = 25;
const SOURCES = {
  testsrc2: `testsrc2=size=${W}x${H}:rate=${FPS}`,
  mandel: `mandelbrot=size=${W}x${H}:rate=${FPS}`,
  life: `life=size=320x180:rate=${FPS}:mold=10:ratio=0.2,scale=${W}:${H}:flags=neighbor`,
  cell: `cellauto=size=320x180:rate=${FPS}:rule=110,scale=${W}:${H}:flags=neighbor`,
};
const PUBS = [
  { plans: [['testsrc2', 5], ['pack', 4, 'MARQUE A']], apres: 'noir' },
  { plans: [['mandel', 6], ['life', 4], ['pack', 3, 'MARQUE B']], apres: 'silence' },
  { plans: [['cell', 5], ['pack', 3, 'MARQUE C']], apres: null },
];

const lancer = async (args) => {
  const r = await executer(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.code !== 0) throw new Error(r.erreurs);
};

export const fabriquerVideo = async (dossier) => {
  await mkdir(path.join(dossier, 'plans'), { recursive: true });
  const fichiers = [];
  let t = 0, freq = 300;
  const plan = async (nom, genre, duree, marque, silenceFin = 0) => {
    const sortie = path.join(dossier, 'plans', `${nom}.mkv`);
    const video = genre === 'pack'
      ? `color=c=0x1f3b73:size=${W}x${H}:rate=${FPS},drawtext=fontfile=${POLICE}:text='${marque}':fontsize=54:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`
      : genre === 'noir' ? `color=c=black:size=${W}x${H}:rate=${FPS}` : SOURCES[genre];
    freq += 41;
    const son = genre === 'noir' ? 'anullsrc=r=44100:cl=stereo' : `sine=frequency=${freq}:sample_rate=44100,volume=0.25,aformat=channel_layouts=stereo`;
    const filtreSon = silenceFin ? `afade=t=out:st=${duree - silenceFin - 0.01}:d=0.01` : 'anull';
    await lancer(['-f', 'lavfi', '-i', video, '-f', 'lavfi', '-i', son, '-t', String(duree), '-vf', 'format=yuv420p', '-af', filtreSon,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-c:a', 'pcm_s16le', sortie]);
    fichiers.push(sortie);
    t += duree;
  };
  await plan('intro', 'noir', 1);
  const verite = [];
  for (const [i, pub] of PUBS.entries()) {
    const debut = t;
    let revelation = 0;
    for (const [j, [genre, duree, marque]] of pub.plans.entries()) {
      const dernier = j === pub.plans.length - 1;
      if (genre === 'pack') revelation = t;
      await plan(`p${i}-${j}`, genre, duree, marque, dernier && pub.apres === 'silence' ? 0.5 : 0);
    }
    verite.push({ debut, revelation, fin: t, marque: pub.plans.at(-1)[2] });
    if (pub.apres === 'noir') await plan(`noir${i}`, 'noir', 0.6);
  }
  const liste = path.join(dossier, 'plans', 'liste.txt');
  await writeFile(liste, fichiers.map((f) => `file '${f}'`).join('\n'));
  const brut = path.join(dossier, 'brut.mkv');
  await lancer(['-f', 'concat', '-safe', '0', '-i', liste, '-c', 'copy', brut]);
  const sortie = path.join(dossier, 'compil.mp4');
  await lancer(['-i', brut, '-vf', `drawtext=fontfile=${POLICE}:text='TELE PUB 98':fontsize=22:fontcolor=yellow:x=w-tw-16:y=14`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', sortie]);
  return { chemin: sortie, duree: t, pubs: verite, largeur: W, hauteur: H, fps: FPS };
};

// Une image de la vidéo en niveaux de gris (ou en couleurs), à un instant donné.
export const imageA = async (chemin, t, { couleur = false } = {}) => {
  const r = await new Promise((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', chemin, '-frames:v', '1',
        '-f', 'rawvideo', '-pix_fmt', couleur ? 'rgb24' : 'gray', '-']);
      const morceaux = [];
      p.stdout.on('data', (d) => morceaux.push(d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(morceaux)) : reject(new Error(`ffmpeg ${code}`))));
    });
  });
  return new Uint8Array(r);
};
