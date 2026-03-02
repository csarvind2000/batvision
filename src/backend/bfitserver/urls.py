from django.contrib import admin
from django.urls import path, include
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

urlpatterns = [
    # -------------------------------
    # Admin
    # -------------------------------
    path("admin/", admin.site.urls),

    # -------------------------------
    # API (all app endpoints)
    # -------------------------------
    path("api/", include("api.urls")),   # <- ALL case endpoints live inside api app

    # Jobs (optional app)
    path("api/jobs/", include("jobs.urls")),

    # -------------------------------
    # AUTH (JWT)
    # -------------------------------
    path("api/auth/login/", TokenObtainPairView.as_view(), name="jwt_login"),
    path("api/auth/refresh/", TokenRefreshView.as_view(), name="jwt_refresh"),
    path("api/auth/", include("auth_api.urls")),
]