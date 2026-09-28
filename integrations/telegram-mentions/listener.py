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

from telethon import TelegramClient, events, utils

LOG = logging.getLogger("telegram-mentions")
USER_REF = re.compile(r"(?<![A-Za-z0-9_])@skoomaholic(?=$|[^A-Za-z0-9_])", re.IGNORECASE)
# A private contact allowlist does not classify every private message as work.
# Filter obvious nonwork locally, before text leaves the owner's machine.
WORK_TOPIC = re.compile(
    r"\\b(?:ott|epg|uefa|sport|live|email|outlook|design|deadline|banner|stream|"
    r"content|release|draft|meeting|report|broadcast|schedule|promo)\\b|"
    r"работ|коллег|задач|письм|почт|баннер|эфир|трансляц|турнир|футбол|"
    r"матч|контент|платформ|дизайн|макет|логотип|материал|встреч|совещан|"
    r"дедлайн|отч[её]т|таблиц|расписан|презентац|релиз|промокод|"
    r"согласован|правообладател|подписк|отдел|редакци|канал|выпуск",
    re.IGNORECASE,
)
CHAT_ID = re.compile(r"^-?[0-9]{1,20}$")


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
                reason = "unknown"
                if error.code == 403:
                    try:
                        code = json.loads(error.read(256).decode("utf-8")).get("error", "")
                        if code in ("private_chat_not_allowed", "chat_not_allowed"):
                            reason = code
                    except (ValueError, UnicodeError, AttributeError):
                        pass
                LOG.error("Ingest refused message (HTTP %s, reason=%s)", error.code, reason)
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
    if not event.is_private and getattr(chat, "username", None):
        return f"https://t.me/{chat.username}/{event.message.id}"
    chat_id = str(event.chat_id)
    if chat_id.startswith("-100") and chat_id[4:].isdigit():
        return f"https://t.me/c/{chat_id[4:]}/{event.message.id}"
    return ""


async def run(args):
    api_id, api_hash, session = config()
    os.umask(0o077)
    # A local ID-only file beside the existing session can override environment lists.
    # Keep it outside Git; Cloudflare still checks its own independent allowlists.
    list_path = Path(session).parent / "telegram-chat-allowlists.txt"
    values = {}
    if list_path.is_file():
        for line in list_path.read_text(encoding="utf-8-sig").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                if key.strip() in ("TG_MENTION_CHAT_IDS", "TG_MENTION_PRIVATE_CHAT_IDS"):
                    values[key.strip()] = value.strip()
    ids = {x.strip() for x in values.get("TG_MENTION_CHAT_IDS", os.environ.get("TG_MENTION_CHAT_IDS", "")).split(",") if x.strip()}
    private_ids = {x.strip() for x in values.get("TG_MENTION_PRIVATE_CHAT_IDS", os.environ.get("TG_MENTION_PRIVATE_CHAT_IDS", "")).split(",") if x.strip()}
    if not args.list_chats and not ids and not private_ids:
        raise SystemExit("Set TG_MENTION_CHAT_IDS and/or TG_MENTION_PRIVATE_CHAT_IDS")
    if "*" in private_ids or any(not x.isdigit() or int(x) < 1 for x in private_ids):
        raise SystemExit("TG_MENTION_PRIVATE_CHAT_IDS must contain only numeric Telegram User IDs")
    if not args.list_chats and "*" not in ids and any(not CHAT_ID.fullmatch(x) for x in ids):
        raise SystemExit("Invalid TG_MENTION_CHAT_IDS")
    client = TelegramClient(session, api_id, api_hash, auto_reconnect=True, connection_retries=None, retry_delay=5)
    async with client:
        owner = await client.get_me()
        if args.list_chats:
            async for dialog in client.iter_dialogs():
                kind = "private" if dialog.is_user else "group" if dialog.is_group else "channel"
                print(f"{utils.get_peer_id(dialog.entity)}\t{kind}\t{dialog.name}")
            return
        if not owner or not owner.id:
            raise SystemExit("Telegram account was not authorized")
        LOG.info("Watching authorized chat mentions and replies (no historic chat export)")
        sem = asyncio.Semaphore(6)

        @client.on(events.NewMessage(incoming=True))
        async def on_message(event):
            private = bool(event.is_private)
            if private:
                if str(event.chat_id) not in private_ids:
                    return
            elif "*" not in ids and str(event.chat_id) not in ids:
                return
            msg = event.message
            sender = await event.get_sender()
            if not sender or getattr(sender, "id", None) in (owner.id, 777000) or getattr(sender, "bot", False):
                return
            if private and (not getattr(sender, "id", None) or str(sender.id) != str(event.chat_id)):
                return
            text = str(msg.raw_text or "").strip()
            if not text:
                return  # No content to classify; do not download media.
            if private and os.environ.get("TG_ASSISTANT_SCOPE", "work") == "work":
                if not WORK_TOPIC.search(text):
                    return  # Never export ambiguous private chat content.
            direct = private or bool(USER_REF.search(text) or getattr(msg, "mentioned", False))
            signal = "private" if private else "mention"
            if not private and not direct and msg.reply_to_msg_id:
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
                "source_type": "private" if private else "group",
                "media_kind": "document" if msg.document else "photo" if msg.photo else "",
            }
            async with sem:
                await asyncio.to_thread(relay_post, payload)

        while True:
            try:
                await client.run_until_disconnected()
            except (OSError, asyncio.TimeoutError) as error:
                LOG.warning("Connection interrupted (%s); reconnecting", type(error).__name__)
            await asyncio.sleep(5)
            if not client.is_connected():
                await client.connect()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Listen for personal Telegram mentions")
    parser.add_argument("--list-chats", action="store_true", help="List chat IDs locally to configure work allowlist")
    arguments = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if hasattr(__import__("sys").stdout, "reconfigure"):
        __import__("sys").stdout.reconfigure(errors="replace")
    asyncio.run(run(arguments))
