# -*- coding: utf-8 -*-
"""
Одноразовый скрипт для получения SESSION_STRING (Telethon userbot-сессия).

ЗАЧЕМ: main.py логинится в Telegram как обычный юзер-аккаунт (не бот),
чтобы слать /events боту @SpookyTimeBot и читать его ответы. Для этого
нужна авторизованная сессия — её нельзя выпустить заранее без входа,
это НАДО сделать один раз вручную (ввести код из Telegram).

КАК ЗАПУСТИТЬ:
    pip install telethon
    python generate_session.py

Скрипт спросит номер телефона (тот, что зарегистрирован в Telegram),
потом код подтверждения (придёт в сам Telegram, в "Telegram" чат или
SMS), и если на аккаунте включена двухфакторка — облачный пароль.
В конце выведет длинную строку — это и есть SESSION_STRING.

ВАЖНО:
  - Используй ЛУЧШЕ отдельный Telegram-аккаунт, не основной личный —
    это будет автоматически слать сообщения боту раз в ~6 секунд,
    круглосуточно. Официальные боты иногда банят/лимитят аккаунты
    за подозрительно ровный паттерн запросов.
  - SESSION_STRING — это полноценный доступ к аккаунту (как будто ты
    вошёл с нового устройства). Никому не показывай, храни только в
    Railway → Variables (SESSION_STRING), не в коде и не в чате.
  - API_ID / API_HASH бери с https://my.telegram.org → API development
    tools (обычная бесплатная регистрация приложения).
"""

from telethon import TelegramClient
from telethon.sessions import StringSession

# Уже подставлены значения, которые ты присылал в чате. Если захочешь
# использовать другой аккаунт/приложение — просто поменяй тут.
API_ID = 21717369
API_HASH = "b5caf5666662d13269405c7189d44c60"


def main():
    api_id = API_ID or int(input("API_ID: ").strip())
    api_hash = API_HASH or input("API_HASH: ").strip()

    with TelegramClient(StringSession(), api_id, api_hash) as client:
        session_string = client.session.save()
        print("\n" + "=" * 60)
        print("Готово! Вот твой SESSION_STRING (одна строка целиком):\n")
        print(session_string)
        print("\n" + "=" * 60)
        print("Вставь его в Railway → сервис Spooky Bot → Variables → SESSION_STRING")


if __name__ == "__main__":
    main()
