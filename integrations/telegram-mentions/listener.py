"""Personal Telegram mention listener. Runs separately from Cloudflare Workers.

Uses the owner's MTProto session only to READ authorized chats; transmits matching
mentions/replies to the existing assistant's protected ingestion endpoint.
Never commit a .session file or print its contents.
"""
import argparse
import asyncio
import json
import logging
import os
import re
import urllib.error
import urllib.request
from datetime import timezone
from pathlib import Path

from telethon import TelegramClient, events

LOG = logging.getLogger("telegram-mentions")
USER_REF = re.compile(r"(?<![\\w])@skoomaholic\\b", re.IGNORECASE)
CHAT_ID = re.compile(r"^-?\\d{1,20}$")


def config():
    api_id = os.environ.get("TG_API_ID", "")
    api_hash = os.environ.get("TG_API_HASH", "")
    if not api_id.isdigit() or not api_hash:
        raise SystemExit("Set TG_API_ID and TG_API_HASH from my.telegram.org")
    session_path = Path(os.environ.get("TG_SESSION_PATH", ".secrets/telegram-mentions")).expanduser()
    session_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(session_path.parent, 0o700)
    return int(api_id), api_hash, str(session_path)


def relay_post(payload):
    url = os.environ.get("TG_MENTION_INGEST_URL", "")
    secret = os.environ.get("TG_MENTION_INGEST_SECRET", "")
    if not url.startswith("https://") or not url.endswith("/internal/telegram/mention") or not secret:
        raise SystemExit("Set TG_MENTION_INGEST_URL (HTTPS) and TG_MENTION_INGEST_SECRET")
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, data=encoded, method="POST",
                headers={"Content-Type": "application/json",
                         "X-Telegram-Mention-Secret": secret})
            with urllib.request.urlopen(request, timeout=15) as response:
                response.read()
            return
        except urllib.error.HTTPError as error:
            if error.code in (400, 401, 403, 413):
                LOG.error("Ingest refused message (HTTP %s); check configuration", error.code)
                return
            LOG.warning("Ingest HTTP %s", error.code)
        except (urllib.error.URLError, TimeoutError) as error:
            LOG.warning("Ingest connection failed (%s)", type(error).__name__)
        if attempt < 2:
            import time
            time.sleep(2 ** attempt)
    LOG.error("Mention not delivered to staging. Check connection and service logs.")


def source_link(event, chat):
    # t.me/c links work for signed-in group members, not as public URLs.
    if getattr(chat, "username", None):
        return f"https://t.me/{chat.username}/{event.message.id}"
    chat_id = str(event.chat_id)
    if chat_id.startswith("-100") and chat_id[4:].isdigit():
        return f"https://t.me/c/{chat_id[4:]}/{event.message.id}"
    return ""


async def run(args):
    api_id, api_hash, session = config()
    os.umask(0o077)
    ids = {x.strip() for x in os.environ.get("TG_MENTION_CHAT_IDS", "").split(",") if x.strip()}
    if not args.list_chats and not ids:
        raise SystemExit("Set TG_MENTION_CHAT_IDS to comma-separated work chat IDs, or * for all accessible chats")
    if not args.list_chats and "*" not in ids and any(not CHAT_ID.fullmatch(x) for x in ids):
        raise SystemExit("Invalid TG_MENTION_CHAT_IDS")
    client = TelegramClient(session, api_id, api_hash)
    async with client:
        owner = await client.get_me()
        if args.list_chats:
            async for dialog in client.iter_dialogs():
                print(f"{dialog.id}\t{dialog.name}")
            return
        if not owner or not owner.id:
            raise SystemExit("Telegram account was not authorized")
        LOG.info("Watching authorized chat mentions and replies (no historic chat export)")
        sem = asyncio.Semaphore(6)

        @client.on(events.NewMessage(incoming=True))
        async def on_message(event):
            if "*" not in ids and str(event.chat_id) not in ids:
                return
            msg = event.message
            sender = await event.get_sender()
            if getattr(sender, "id", None) == owner.id:
                return
            text = str(msg.raw_text or "").strip()
            if not text:
                return  # Do not download media or upload attachments.
            direct = bool(USER_REF.search(text) or getattr(msg, "mentioned", False))
            signal = "mention"
            if not direct and msg.reply_to_msg_id:
                # Check actual parent author; do not treat every threaded reply as ours.
                original = await msg.get_reply_message()
                direct = bool(original and original.sender_id == owner.id)
                signal = "reply"
            if not direct:
                return
            chat = await event.get_chat()
            date = msg.date.astimezone(timezone.utc).isoformat() if msg.date else ""
            sender_name = " ".join(x for x in (
                getattr(sender, "first_name", ""), getattr(sender, "last_name", "")
            ) if x) or getattr(sender, "title", "") or "Участник"
            payload = {
                "chat_id": str(event.chat_id), "message_id": msg.id,
                "sender_id": str(msg.sender_id or ""),
                "chat_title": getattr(chat, "title", "") or getattr(chat, "username", "") or "Личные сообщения",
                "sender_name": sender_name, "text": text[:5000], "signal": signal,
                "date": date, "link": source_link(event, chat),
            }
            async with sem:
                await asyncio.to_thread(relay_post, payload)

        await client.run_until_disconnected()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Listen for personal Telegram mentions")
    parser.add_argument("--list-chats", action="store_true", help="List chat IDs locally to configure work allowlist")
    arguments = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    asyncio.run(run(arguments))
