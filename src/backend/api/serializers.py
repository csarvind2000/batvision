from rest_framework import serializers
from .models import Case, CaseInput, AnalysisJob

class CaseInputSerializer(serializers.ModelSerializer):
    class Meta:
        model = CaseInput
        fields = ["id", "channel", "filename", "file_path", "created_at"]

class CaseSerializer(serializers.ModelSerializer):
    inputs = CaseInputSerializer(many=True, read_only=True)

    class Meta:
        model = Case
        fields = [
            "id",
            "case_id",
            "patient_id",
            "patient_name",
            "status",
            "progress",
            "status_message",
            "created_at",
            "inputs",
        ]
