from django.urls import path
from . import views

urlpatterns = [
    path("ping/", views.start_ping),
    path("long-task/", views.start_long_task),
]
