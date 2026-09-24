# Image de Quiz Pub : Node 22, ffmpeg, et yt-dlp dans sa version officielle.
FROM node:22-bookworm-slim

# ffmpeg : analyse et rendu. python3 : exigé par yt-dlp. Polices DejaVu :
# textes du quiz (question, compte à rebours, réponse).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp officiel : il contient déjà ce qu'il faut pour YouTube (yt-dlp-ejs)
# et se sert de Node, présent dans l'image, pour les défis JavaScript.
# Placé dans un dossier qui appartient à l'utilisateur node pour pouvoir se
# mettre à jour tout seul (au démarrage, et par le bouton du site).
RUN mkdir -p /opt/yt-dlp \
 && curl -fsSL -o /opt/yt-dlp/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod 755 /opt/yt-dlp/yt-dlp \
 && chown -R node:node /opt/yt-dlp

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3012 \
    HOTE=0.0.0.0 \
    YTDLP=/opt/yt-dlp/yt-dlp \
    MAJ_YTDLP=1

RUN mkdir -p /data && chown node:node /data
# Pas de droits root dans le conteneur : le dossier data monté doit
# appartenir à l'utilisateur 1000 (voir README).
USER node
EXPOSE 3012
CMD ["node", "server/index.js"]
