from celery import shared_task
import time

@shared_task
def ping():
    return {"ok": True, "msg": "pong"}

@shared_task
def long_task(seconds: int = 10):
    for i in range(seconds):
        time.sleep(1)
    return {"ok": True, "slept": seconds}
