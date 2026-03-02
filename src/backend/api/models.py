import uuid
from django.db import models


class Case(models.Model):
    """
    One subject/case.
    case_id: use your subject id like '010-04002' (folder/prefix)
    """
    case_id = models.CharField(max_length=128, unique=True)  # subject id
    patient_id = models.CharField(max_length=128, null=True, blank=True)
    patient_name = models.CharField(max_length=256, null=True, blank=True)

    # UI status convenience (derived from latest job, but stored for fast listing)
    STATUS_PROCESSING = "PROCESSING"
    STATUS_FAILED = "FAILED"
    STATUS_READY = "READY"

    STATUS_CHOICES = [
        (STATUS_PROCESSING, "Processing"),
        (STATUS_FAILED, "Failed"),
        (STATUS_READY, "Ready"),
    ]

    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_PROCESSING)
    progress = models.IntegerField(default=0)
    status_message = models.TextField(blank=True, default="")

    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.case_id} ({self.status})"


class CaseInput(models.Model):
    """
    Stores input files for a case:
      channel = 'fat' or 'fat_fraction'
      filename = original filename
      file_path = where it is stored inside /storage
    """
    CHANNELS = [
        ("fat", "fat"),
        ("fat_fraction", "fat_fraction"),
    ]

    case = models.ForeignKey(Case, related_name="inputs", on_delete=models.CASCADE)
    channel = models.CharField(max_length=32, choices=CHANNELS)
    filename = models.CharField(max_length=512)
    file_path = models.CharField(max_length=1024)  # absolute path like /storage/bat_inputs/<case_id>/...
    created_at = models.DateTimeField(auto_now_add=True)


class AnalysisJob(models.Model):
    """
    One processing run (RQ job) for a case.
    """
    STATUS = [
        ("queued", "queued"),
        ("running", "running"),
        ("completed", "completed"),
        ("failed", "failed"),
    ]

    case = models.ForeignKey(Case, related_name="jobs", on_delete=models.CASCADE)
    status = models.CharField(max_length=16, choices=STATUS, default="queued")
    message = models.TextField(null=True, blank=True)
    progress = models.IntegerField(default=0)
    output_dir = models.CharField(max_length=512, null=True, blank=True)

    rq_job_id = models.CharField(max_length=128, null=True, blank=True)  # optional
    created_at = models.DateTimeField(auto_now_add=True)
