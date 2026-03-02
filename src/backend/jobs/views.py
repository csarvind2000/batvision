from rest_framework.decorators import api_view
from rest_framework.response import Response
from .tasks import ping, long_task

@api_view(["POST"])
def start_ping(request):
    task = ping.delay()
    return Response({"task_id": task.id})

@api_view(["POST"])
def start_long_task(request):
    seconds = int(request.data.get("seconds", 5))
    task = long_task.delay(seconds)
    return Response({"task_id": task.id})
