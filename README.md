# BATVision (BAT Review) — Docker Setup

BATVision is a web-based platform for **Brown Adipose Tissue (BAT)** segmentation review and volumetric analysis.  
This repository provides a **Docker-based** way to run the full stack locally (frontend + backend + workers + database/redis as applicable).

> If your repo names/services differ, update them in `docker-compose.yml` and the commands below.

---

## What runs in Docker

Typical services (may vary by your repo):

- **frontend**: React + Vite (BAT Review UI, Niivue viewer)
- **backend**: Django/DRF (auth, cases, bat-review API)
- **worker**: Celery/RQ (optional; background tasks)
- **redis**: broker/cache (optional)
- **db**: PostgreSQL (optional; if backend uses DB)
- **bat-ai**: segmentation inference container (optional; if you run model inference)

---

## Prerequisites

- Docker Desktop (Mac/Windows) or Docker Engine (Linux)
- Docker Compose v2 (`docker compose version`)
- (Optional) `git`
- (Optional) `make`

---

## Quick start (recommended)

### 1) Clone and go to project directory
```bash
git clone <YOUR_REPO_URL>
cd <YOUR_REPO_DIR>
```

### 2) Create environment file(s)

Create a `.env` at the repository root (or wherever your compose expects it):

```bash
cp .env.example .env  # if available
```

Minimum example:

```bash
# --- Backend ---
DJANGO_SECRET_KEY=change-me
DJANGO_DEBUG=1
DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1
DJANGO_CORS_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000

# --- DB (if using Postgres) ---
POSTGRES_DB=batvision
POSTGRES_USER=batvision
POSTGRES_PASSWORD=batvision
POSTGRES_HOST=db
POSTGRES_PORT=5432

# --- Auth / JWT (if using SimpleJWT) ---
JWT_ACCESS_LIFETIME_MIN=60
JWT_REFRESH_LIFETIME_DAYS=7

# --- Redis (if using Celery/RQ) ---
REDIS_URL=redis://redis:6379/0

# --- Frontend ---
VITE_API_BASE_URL=http://localhost:8000
```

> If you already store your OpenAI/API keys in `.env`, keep doing that—just ensure the backend container receives the variables it needs.

### 3) Build and start
```bash
docker compose up --build
```

Open:

- Frontend: `http://localhost:5173` (or `http://localhost:3000`)
- Backend: `http://localhost:8000`

---

## First-time backend setup

If your backend uses Django migrations + superuser:

```bash
docker compose exec backend python manage.py migrate
docker compose exec backend python manage.py createsuperuser
```

If you need to load seed data:

```bash
docker compose exec backend python manage.py loaddata <fixture>.json
```

---

## Common ports

| Service     | Port (host) | Notes |
|------------|-------------|------|
| frontend   | 5173 / 3000 | Vite/React dev server |
| backend    | 8000        | Django/DRF |
| postgres   | 5432        | If exposed |
| redis      | 6379        | If exposed |

---

## Typical Docker Compose commands

Start (foreground):
```bash
docker compose up
```

Start (background):
```bash
docker compose up -d
```

Stop:
```bash
docker compose down
```

Stop and remove volumes (⚠ deletes DB data):
```bash
docker compose down -v
```

Rebuild a single service:
```bash
docker compose build backend
docker compose up -d backend
```

View logs:
```bash
docker compose logs -f
docker compose logs -f backend
docker compose logs -f frontend
```

---

## Authentication (JWT) notes

If you use Django SimpleJWT:

- Login endpoint often looks like:
  - `POST /api/auth/login/` OR `POST /api/token/`
- Refresh:
  - `POST /api/auth/refresh/` OR `POST /api/token/refresh/`

If you see:
`{"detail":"Given token not valid for any token type","code":"token_not_valid","messages":[...,"Token is expired"]}`

Fix by:
1. Refresh token flow (recommended), or
2. Log in again (short-term), or
3. Increase access token lifetime in backend settings (dev only)

---

## BAT Review API (example)

Your route may differ, but a common pattern:

- **Case list**: `GET /api/cases/`
- **BAT review**: `GET /api/cases/<id>/bat-review/`
- Response includes base image + segmentation masks (often base64 or URLs)

If your frontend expects trailing slashes, keep them:
- ✅ `/api/cases/25/bat-review/`
- ❌ `/api/cases/25/bat-review` (may redirect and drop auth header)

---

## Niivue mask overlay troubleshooting (very common)

### Symptom
- Base MRI loads, but mask does not appear
- Or mask **replaces** base instead of overlay
- Or console shows `hasDrawn=false` / `nv.drawImg missing`

### Root causes
1. **Loading masks as volumes** instead of **drawing layer**
   - If you `loadVolumes([mask])`, Niivue may display the mask as a separate image, not an overlay.
2. Mask geometry mismatch (different dimensions / affine)
3. Mask is empty (all zeros) or compressed incorrectly
4. Niivue version mismatch and API differences

### Recommended approach (stable)
- Load base as volume(s) via `loadVolumes`
- Load mask via `loadDrawing(...)` and control opacity using `setDrawOpacity`

### Quick checks
- Confirm base + mask are same shape (X×Y×Z) in your pipeline
- Confirm mask contains non-zero labels
- Confirm your `base64NiftiToObjectUrl` uses correct MIME:
  - `application/gzip` for `.nii.gz`
  - `application/octet-stream` for `.nii`

---

## Data & volumes

If you mount local data into containers, add a compose volume mapping, e.g.:

```yaml
services:
  backend:
    volumes:
      - ./data:/app/data:ro
```

Or for outputs:

```yaml
services:
  backend:
    volumes:
      - ./outputs:/app/outputs
```

---

## Production build (optional)

If you have a production compose file (example `docker-compose.prod.yml`):

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

Typical production setup:
- frontend served by Nginx
- backend behind Gunicorn/Uvicorn
- environment variables set via `.env.prod`

---

## Health checks

Check containers:
```bash
docker compose ps
```

Enter a container:
```bash
docker compose exec backend bash
docker compose exec frontend sh
```

Backend status:
```bash
curl -I http://localhost:8000/
```

---

## Troubleshooting

### 1) Ports already in use
Stop conflicting processes, or change host ports in compose.

### 2) “CORS blocked”
- Ensure backend `CORS_ALLOWED_ORIGINS` includes the frontend origin.
- Ensure `VITE_API_BASE_URL` points to backend host.

### 3) White screen in frontend
- Open browser console and fix missing exports / runtime errors.
- Ensure you are not violating React Hooks rules (consistent hook order).

### 4) Containers exiting repeatedly
Check logs:
```bash
docker compose logs -f bat-ai
docker compose logs -f worker
```

Usually caused by:
- missing model weights
- missing environment variables
- missing GPU runtime (if configured)

---

## Repository structure (example)

```
.
├── backend/                 # Django / API
├── frontend/                # React + Vite
├── docker-compose.yml
├── .env
└── README.md
```

---

## License / Citation

Add your lab/company + citation details here.

---

## Contact

- Maintainer: Arvind CS
- Email: <add email>
# BATAPP
# batvision
# batvision
# batvision
