"""
Django settings for bfitserver project.
"""

from pathlib import Path
import os
import dj_database_url
from corsheaders.defaults import default_headers

# ------------------------------------------------------------------
# BASE DIRECTORY
# ------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent.parent

# ------------------------------------------------------------------
# SECURITY
# ------------------------------------------------------------------
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "change_me_to_a_long_random_string")
DEBUG = os.environ.get("DJANGO_DEBUG", "1") == "1"

ALLOWED_HOSTS = os.environ.get(
    "DJANGO_ALLOWED_HOSTS",
    "localhost,127.0.0.1,backend,0.0.0.0,*",
).split(",")

# ------------------------------------------------------------------
# APPLICATIONS
# ------------------------------------------------------------------
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",

    # Third-party
    "corsheaders",
    "rest_framework",
    "rest_framework_simplejwt",

    # Local apps
    "auth_api",
    "api",
]

# ------------------------------------------------------------------
# MIDDLEWARE
# ------------------------------------------------------------------
MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",  # must be first
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

# ------------------------------------------------------------------
# URLS / WSGI
# ------------------------------------------------------------------
ROOT_URLCONF = "bfitserver.urls"
WSGI_APPLICATION = "bfitserver.wsgi.application"

# ------------------------------------------------------------------
# CORS (Frontend on 5173)
# ------------------------------------------------------------------
CORS_ALLOW_ALL_ORIGINS = False
CORS_ALLOWED_ORIGINS = [
    "http://localhost:5173",
]
CORS_ALLOW_CREDENTIALS = True
CORS_ALLOW_HEADERS = list(default_headers) + [
    "authorization",
    "content-type",
]

# ------------------------------------------------------------------
# REST FRAMEWORK (JWT)
# ------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ),
}

# ------------------------------------------------------------------
# TEMPLATES
# ------------------------------------------------------------------
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    }
]

# ------------------------------------------------------------------
# DATABASE
# ------------------------------------------------------------------
DATABASE_URL = os.getenv("DATABASE_URL")
if DATABASE_URL:
    DATABASES = {
        "default": dj_database_url.config(default=DATABASE_URL, conn_max_age=600)
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }

# ------------------------------------------------------------------
# PASSWORD VALIDATION
# ------------------------------------------------------------------
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# ------------------------------------------------------------------
# INTERNATIONALIZATION
# ------------------------------------------------------------------
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

# ------------------------------------------------------------------
# STATIC
# ------------------------------------------------------------------
STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ------------------------------------------------------------------
# MEDIA / OUTPUT (mounted from host via docker-compose)
# ------------------------------------------------------------------
MEDIA_ROOT = Path(os.getenv("MEDIA_ROOT", "/BAT_DataFolder/media")).resolve()
OUTPUT_ROOT = Path(os.getenv("OUTPUT_ROOT", "/BAT_DataFolder/output")).resolve()

MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

UPLOAD_NIFTI_DIR = MEDIA_ROOT / "nifti"
UPLOAD_DICOM_DIR = MEDIA_ROOT / "dicom"
UPLOAD_NIFTI_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DICOM_DIR.mkdir(parents=True, exist_ok=True)

# ✅ FIX: define BAT_OUTPUT_DIR (what your views.py expects)
# Default: /BAT_DataFolder/output/bat_outputs
BAT_OUTPUT_DIR = Path(os.getenv("BAT_OUTPUT_DIR", str(OUTPUT_ROOT))).resolve()
BAT_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ------------------------------------------------------------------
# AI
# ------------------------------------------------------------------
AI_BASE_URL = os.getenv("AI_BASE_URL", "http://ai:9000")

# ------------------------------------------------------------------
# CELERY (Redis)
# ------------------------------------------------------------------
CELERY_BROKER_URL = os.environ.get("CELERY_BROKER_URL", "redis://redis:6379/0")
CELERY_RESULT_BACKEND = os.environ.get("CELERY_RESULT_BACKEND", "redis://redis:6379/0")
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
CELERY_TIMEZONE = "UTC"


from datetime import timedelta

SIMPLE_JWT = {
  "ACCESS_TOKEN_LIFETIME": timedelta(hours=8),
  "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
  "ROTATE_REFRESH_TOKENS": True,
  "BLACKLIST_AFTER_ROTATION": True,
}