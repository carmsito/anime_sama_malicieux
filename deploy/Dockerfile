# syntax=docker/dockerfile:1
# Multi-stage : build du front (node) puis runtime Python + chromium + xvfb + imagemagick.
# Compatible amd64 ET arm64 (Oracle Cloud Always Free = ARM Ampere) grâce à `chromium`
# (google-chrome-stable est amd64-only, on ne l'utilise donc pas).

# ── Stage 1 : build du frontend ───────────────────────────────────────────────
FROM node:20-slim AS front
WORKDIR /front
COPY app/front/package*.json ./
RUN npm ci
COPY app/front/ ./
RUN npm run build   # produit /front/dist

# ── Stage 2 : runtime ─────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

# Sushiscan passe par FlareSolverr (conteneur séparé) + curl_cffi → PAS de navigateur
# dans cette image. On garde imagemagick (make_epub/split_manga) + tini.
RUN apt-get update && apt-get install -y --no-install-recommends \
      imagemagick fonts-liberation ca-certificates tini openssh-client \
 && rm -rf /var/lib/apt/lists/*

# Autorise webp/coalesce dans ImageMagick (certaines policies bloquent par défaut)
RUN if [ -f /etc/ImageMagick-6/policy.xml ]; then \
      sed -i 's/rights="none" pattern="WEBP"/rights="read|write" pattern="WEBP"/' /etc/ImageMagick-6/policy.xml || true; \
    fi

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Code
COPY app ./app
COPY scripts ./scripts
COPY docs ./docs
# Front buildé depuis le stage 1
COPY --from=front /front/dist ./app/front/dist

# Données persistantes (DB, covers, sessions, extraction)
VOLUME ["/srv/app/api/data", "/srv/extraction"]

EXPOSE 8000

# tini = reap des process chrome/xvfb zombies
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "app.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
