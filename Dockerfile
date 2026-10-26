# The portal runs beside the PBX rather than inside it: HylaFAX state stays in
# the fax container, and the portal only needs its CLIs, the shared MariaDB and
# an outbound HTTPS path to Authentik.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:22-bookworm-slim AS build
# playwright is a devDependency for scripts/signin-e2e.mjs. Its browsers are
# only needed on a machine that runs that test, not to compile this image.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
# hylafax-client provides faxstat/sendfax; ghostscript normalises uploads and
# poppler-utils (pdftotext) extracts the archive's text layer. The spool is
# mounted read-write so submitted documents are owned by the same uid HylaFAX
# runs as. Real OCR (ocrmypdf/tesseract) is opt-in via FAX_OCR_BIN.
# A build host whose clock trails the mirror's Release file needs
# --build-arg APT_CHECK_DATE=false; the default stays strict.
ARG APT_CHECK_DATE=true
RUN apt-get -o Acquire::Check-Date=${APT_CHECK_DATE} update \
 && apt-get -o Acquire::Check-Date=${APT_CHECK_DATE} install -y --no-install-recommends \
      hylafax-client ca-certificates ghostscript poppler-utils \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/fax-portal/quarantine \
 && chown -R node:node /var/lib/fax-portal
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# scripts/smoke-pipeline.mjs is a deployment check: it must be runnable in the
# image that was actually built, not only in a checkout.
COPY scripts ./scripts
COPY package.json ./
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
