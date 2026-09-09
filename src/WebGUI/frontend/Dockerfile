# syntax=docker/dockerfile:1.7
###############################################################################
# batvision-frontend — React + Vite BAT review UI (Niivue viewer)
#
#   target `dev`  Vite dev server with HMR   (docker-compose.override.yml)
#   target `prod` static bundle behind nginx (default)
###############################################################################
ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:1.27-alpine

# --------------------------------------------------------------------------- #
#  deps — install once, reused by both dev and the production build
# --------------------------------------------------------------------------- #
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --------------------------------------------------------------------------- #
#  dev — hot reloading; the source tree is bind-mounted over /app
# --------------------------------------------------------------------------- #
FROM ${NODE_IMAGE} AS dev

LABEL org.opencontainers.image.title="batvision-frontend (dev)"

ENV NODE_ENV=development \
    CHOKIDAR_USEPOLLING=true

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

# --------------------------------------------------------------------------- #
#  build — type-check and emit the static bundle
# --------------------------------------------------------------------------- #
FROM ${NODE_IMAGE} AS build

# Vite inlines VITE_* at build time, so the API base URL is a build argument,
# not a runtime environment variable. Empty means "same origin", which is what
# the nginx /api proxy below serves.
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --------------------------------------------------------------------------- #
#  prod — nginx serving the bundle, proxying /api to the backend
# --------------------------------------------------------------------------- #
FROM ${NGINX_IMAGE} AS prod

LABEL org.opencontainers.image.title="batvision-frontend"
LABEL org.opencontainers.image.description="BATVision React UI served by nginx"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:5173/healthz >/dev/null || exit 1
