import json
import os
import time
import urllib.parse
import urllib.request

TOKEN = os.environ.get("TELEGRAM_TOKEN", "").strip()
if not TOKEN:
    raise SystemExit("Set TELEGRAM_TOKEN in the app Environment Variables")

API = f"https://api.telegram.org/bot{TOKEN}/"
offset = 0
print("Telegram test bot started", flush=True)

def call(method, payload=None):
    data = urllib.parse.urlencode(payload or {}).encode()
    with urllib.request.urlopen(API + method, data=data, timeout=40) as response:
        return json.loads(response.read().decode())

while True:
    try:
        result = call("getUpdates", {"timeout": 30, "offset": offset})
        for update in result.get("result", []):
            offset = update["update_id"] + 1
            message = update.get("message", {})
            chat = message.get("chat", {})
            text = message.get("text", "")
            if chat.get("id") and text:
                reply = "سلام! بات Railway فعاله ✅" if text == "/start" else f"دریافت شد: {text}"
                call("sendMessage", {"chat_id": chat["id"], "text": reply})
    except Exception as exc:
        print(f"polling error: {exc}", flush=True)
        time.sleep(5)
