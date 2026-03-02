import os
from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "bfitserver.settings")

app = Celery("bfitserver")

# Read CELERY_* settings from Django settings
app.config_from_object("django.conf:settings", namespace="CELERY")

# Auto-discover tasks.py in installed apps
app.autodiscover_tasks()
