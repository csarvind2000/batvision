from django.urls import path
from . import views
from .views import cases_delete

urlpatterns = [
    path("cases/", views.cases_list, name="cases_list"),
    path("cases/upload/", views.cases_upload, name="cases_upload"),
    path("cases/process/", views.cases_process, name="cases_process"),
    path("cases/<int:case_id>/status/", views.cases_status, name="cases_status"),
    path("cases/delete/", cases_delete, name="cases_delete"),
    path("cases/<int:case_id>/bat-review/", views.cases_bat_review, name="cases_bat_review"),
]
