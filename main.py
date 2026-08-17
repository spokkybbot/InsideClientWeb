import asyncio
import re
import json
import os
import time
import html
import traceback
import aiohttp
from aiohttp import web
from telegram import (
    BotCommand, Update, ReplyKeyboardMarkup, KeyboardButton,
    InlineKeyboardMarkup, InlineKeyboardButton
)
from telegram.ext import (
    Application, CommandHandler, MessageHandler, CallbackQueryHandler,
    ConversationHandler, ContextTypes, filters, ApplicationHandlerStop, TypeHandler
)
from telethon import TelegramClient
from telethon.sessions import StringSession

# ==================== КОНФИГУРАЦИЯ ====================
API_ID = int(os.environ.get("API_ID", "0") or "0")
API_HASH = os.environ.get("API_HASH", "")
SESSION_STRING = os.environ.get("SESSION_STRING", "")
PHONE_NUMBER = os.environ.get("PHONE_NUMBER", "")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
PORT = int(os.environ.get("PORT", 8080))
SPOOKY_BOT = "@SpookyTimeBot"
REQUEST_DELAY = 3
UPDATE_INTERVAL = 6
# Офф-бот SPOOKY_BOT принимает команду не чаще раза в 5 сек (антиспам).
# Не отправляем /events чаще этого порога, иначе команды игнорируются/мьют.
ANTISPAM_MIN_INTERVAL = 6
EFFECTIVE_INTERVAL = max(UPDATE_INTERVAL, ANTISPAM_MIN_INTERVAL)
DATA_DIR = os.environ.get("DATA_DIR", ".")
os.makedirs(DATA_DIR, exist_ok=True)
USER_COMMANDS_FILE = os.path.join(DATA_DIR, "user_commands.json")
MAX_CUSTOM_COMMANDS = 5
SUPPORT_USERNAME = "Xikik0mori"

# ---- Доступ к боту продаётся на сайте InsideClient (см. INTEGRATION.md) ----
# Проверяем bot_access через внутренний HTTP-эндпоинт сайта, а не напрямую
# через SQLite: это два разных процесса/сервиса на Railway, и HTTP надёжнее
# общего файла БД (не спотыкается о конкурентную запись, не требует общего
# volume между сервисами).
INSIDE_CLIENT_API_URL = os.environ.get("INSIDE_CLIENT_API_URL", "").rstrip("/")
SPOOKY_INTERNAL_SECRET = os.environ.get("SPOOKY_INTERNAL_SECRET", "")
INSIDE_CLIENT_BOT_USERNAME = os.environ.get("INSIDE_CLIENT_BOT_USERNAME", "InsideClientBot")
ACCESS_CHECK_TIMEOUT = 5  # сек
ACCESS_CACHE_TTL = 60  # сек — не долбим сайт на каждое нажатие кнопки
ACCESS_CACHE_STALE_GRACE = 600  # сек — если сайт недоступен, донашиваем последний "да"
# ====================================================

CHOOSE_VERSION, CHOOSE_TYPE, CHOOSE_EVENTS, CHOOSE_RARITY, CHOOSE_NAME, CHOOSE_EMOJI, CHOOSE_COLOR = range(7)

ANARCHY_TYPES = {
    "Соло": 1, "Дуо": 2, "Трио": 3,
    "Квадро": 4, "Пента": 5, "Клан": 6,
}
ANARCHY_TYPE_LIST = list(ANARCHY_TYPES.keys())

# трёхзначные (1xx-6xx) -> 1.21
# четырёхзначные (1xxx-6xxx) -> 1.16.5
VERSION_3DIGIT = "1.21"
VERSION_4DIGIT = "1.16.5"

EVENT_TYPES = [
    "Метеоритный дождь", "Мистический сундук", "Адская резня",
    "Бикини боттом", "Горящий череп", "Маяк убийца",
    "Сундуки смерти", "Вулкан", "Гейзер",
]
NO_RARITY_EVENTS = {"Адская резня", "Бикини боттом", "Горящий череп"}

RARITIES = ["Легендарный", "Элитный", "Богатый", "Солидный", "Обычный"]
RARITY_ORDER = {name: i for i, name in enumerate(RARITIES)}

# Редкости авто-шахт (у SpookyTime — в женском роде: «шахта»), от лучшей к худшей
MINE_RARITIES = ["Мифическая", "Легендарная", "Элитная", "Богатая", "Солидная", "Обычная"]
MINE_RARITY_ORDER = {name: i for i, name in enumerate(MINE_RARITIES)}

LANGUAGES = ["RU", "EN", "KZ", "UA", "BY"]

events_data = {"1.16.5": [], "1.21": []}
mines_data = {"1.16.5": [], "1.21": []}

# ==================== ПЕРЕВОДЫ ====================

TR = {
    "RU": {
        "welcome": (
            "👻 *SpookyEvents Bot*\n\n"
            "Я отслеживаю ивенты на анархиях SpookyTime и показываю активные события в реальном времени.\n\n"
            "*Версии серверов:*\n"
            "• /events1 — ивенты на анархиях *1.16.5* (четырёхзначные номера: 1xxx–6xxx)\n"
            "• /events2 — ивенты на анархиях *1.21* (трёхзначные номера: 1xx–6xx)\n\n"
            "*Команды:*\n"
            "• /events1 — все ивенты 1.16.5\n"
            "• /events2 — все ивенты 1.21\n"
            "• /mines — авто-шахты на всех анархиях\n"
            "• /mines1 — авто-шахты 1.16.5\n"
            "• /mines2 — авто-шахты 1.21\n"
            "• /help — справка и поддержка\n"
            "• ➕ Добавить команду — создай быструю кнопку с нужными фильтрами\n"
            "• 🗑 Удалить команду — удали ненужную быструю команду\n"
            "• ⚙️ Настройки — сортировка и язык\n\n"
            "Используй кнопки ниже 👇"
        ),
        "no_events": "📭 Нет активных ивентов: {label}",
        "events_header": "🎯 Ивенты — {label}:\n\n",
        "btn_add": "➕ Добавить команду",
        "btn_del": "🗑 Удалить команду",
        "btn_settings": "⚙️ Настройки",
        "btn_cancel": "❌ Отмена",
        "btn_skip": "Пропустить",
        "btn_done": "✅ Готово",
        "choose_version": "➕ *Добавление быстрой команды* ({n}/{max})\n\nВыбери версию сервера:",
        "choose_anarchy_type": "✅ Версия: *{version}*\n\nВыбери типы анархий (можно несколько) или «Пропустить» — все типы:",
        "choose_events": "✅ Тип: *{type} {version}*\n\nВыбери ивенты (можно несколько) или «Пропустить» — все ивенты:",
        "choose_rarity": "Теперь выбери редкость ивентов или «Пропустить» — все редкости:",
        "cmd_added": "✅ Команда добавлена!\nТеперь кнопка появилась в меню.",
        "cmd_limit": "❌ Достигнут лимит команд ({max}).",
        "cmd_exists": "ℹ️ Такая команда уже есть у тебя.",
        "cancelled": "❌ Отменено.",
        "no_cmds_to_del": "У тебя пока нет быстрых команд для удаления.",
        "choose_del": "🗑 Выбери команду для удаления:",
        "cmd_deleted": "✅ Команда удалена.",
        "settings_title": "⚙️ *Настройки*",
        "settings_sort": "Сортировка: {val}",
        "settings_lang": "Язык: {val}",
        "settings_hidden": "Скрытые ивенты: {val}",
        "hidden_none": "нет",
        "hidden_applied": "✅ Скрытые ивенты обновлены.",
        "sort_anarchy": "По анархиям",
        "sort_rarity": "По редкостям",
        "no_cmd": "⚠️ Такой команды у тебя нет.",
        "help_text": (
            "👻 *SpookyEvents Bot* — справка\n\n"
            "*Основные команды:*\n"
            "• /start — информация о боте\n"
            "• /events1 — все ивенты 1.16.5\n"
            "• /events2 — все ивенты 1.21\n"
            "• /mines — авто-шахты на всех анархиях\n"
            "• /mines1 — авто-шахты 1.16.5\n"
            "• /mines2 — авто-шахты 1.21\n"
            "• /help — эта справка\n\n"
            "*Быстрые команды:*\n"
            "Создай свою кнопку через «➕ Добавить команду» — выбери версию, типы анархий, ивенты и редкость. Макс. 5 команд.\n\n"
            "*Настройки:*\n"
            "⚙️ Сортировка — по номеру анархии или по редкости\n"
            "⚙️ Язык — RU / EN / KZ / UA / BY\n"
            "⚙️ Скрытые ивенты — выбери типы ивентов, которые не нужно показывать\n\n"
            "По вопросам и проблемам — кнопка ниже 👇"
        ),
        "support_btn": "💬 Написать создателю",
        "support_msg": "👇 Нажми кнопку чтобы написать создателю бота:",
    },
    "EN": {
        "welcome": (
            "👻 *SpookyEvents Bot*\n\n"
            "I track events on SpookyTime anarchies and show active events in real time.\n\n"
            "*Server versions:*\n"
            "• /events1 — events on *1.16.5* anarchies (4-digit: 1xxx–6xxx)\n"
            "• /events2 — events on *1.21* anarchies (3-digit: 1xx–6xx)\n\n"
            "*Anarchy types:*\n"
            "• Solo (100x / 1000x) • Duo (200x / 2000x) • Trio (300x / 3000x)\n"
            "• Quad (400x / 4000x) • Penta (500x / 5000x) • Clan (600x / 6000x)\n\n"
            "*Commands:*\n"
            "• /events1 — all 1.16.5 events\n"
            "• /events2 — all 1.21 events\n"
            "• /mines — auto-mines on all anarchies\n"
            "• /mines1 — auto-mines 1.16.5\n"
            "• /mines2 — auto-mines 1.21\n"
            "• /help — help & support\n"
            "• ➕ Add command — create a quick button with filters\n"
            "• 🗑 Delete command — remove a quick command\n"
            "• ⚙️ Settings — sorting and language\n\n"
            "Use the buttons below 👇"
        ),
        "no_events": "📭 No active events: {label}",
        "events_header": "🎯 Events — {label}:\n\n",
        "btn_add": "➕ Add command",
        "btn_del": "🗑 Delete command",
        "btn_settings": "⚙️ Settings",
        "btn_cancel": "❌ Cancel",
        "btn_skip": "Skip",
        "btn_done": "✅ Done",
        "choose_version": "➕ *Add quick command* ({n}/{max})\n\nChoose server version:",
        "choose_anarchy_type": "✅ Version: *{version}*\n\nChoose anarchy types (multiple allowed) or «Skip» — all types:",
        "choose_events": "✅ Type: *{type} {version}*\n\nChoose events (multiple allowed) or «Skip» — all events:",
        "choose_rarity": "Now choose event rarity or «Skip» — all rarities:",
        "cmd_added": "✅ Command added!\nA new button appeared in the menu.",
        "cmd_limit": "❌ Command limit reached ({max}).",
        "cmd_exists": "ℹ️ You already have this command.",
        "cancelled": "❌ Cancelled.",
        "no_cmds_to_del": "You don't have any quick commands to delete yet.",
        "choose_del": "🗑 Choose a command to delete:",
        "cmd_deleted": "✅ Command deleted.",
        "settings_title": "⚙️ *Settings*",
        "settings_sort": "Sort: {val}",
        "settings_lang": "Language: {val}",
        "settings_hidden": "🙈 Hidden events: {val}",
        "hidden_none": "none",
        "hidden_applied": "✅ Hidden events updated.",
        "sort_anarchy": "By anarchy",
        "sort_rarity": "By rarity",
        "no_cmd": "⚠️ You don't have this command.",
        "help_text": (
            "👻 *SpookyEvents Bot* — help\n\n"
            "*Main commands:*\n"
            "• /start — bot info\n"
            "• /events1 — all 1.16.5 events\n"
            "• /events2 — all 1.21 events\n"
            "• /mines — auto-mines on all anarchies\n"
            "• /mines1 — auto-mines 1.16.5\n"
            "• /mines2 — auto-mines 1.21\n"
            "• /help — this help\n\n"
            "*Quick commands:*\n"
            "Create your button via «➕ Add command» — choose version, anarchy types, events and rarity. Max 5 commands.\n\n"
            "*Settings:*\n"
            "⚙️ Sort — by anarchy number or by rarity\n"
            "⚙️ Language — RU / EN / KZ / UA / BY\n"
            "⚙️ Hidden events — pick event types you don't want to see\n\n"
            "For questions and issues — button below 👇"
        ),
        "support_btn": "💬 Contact creator",
        "support_msg": "👇 Press the button to contact the bot creator:",
    },
    "KZ": {
        "welcome": (
            "👻 *SpookyEvents Bot*\n\n"
            "Мен SpookyTime анархияларындағы ивенттерді бақылаймын.\n\n"
            "*Сервер нұсқалары:*\n"
            "• /events1 — *1.16.5* анархиялары (4 таңбалы: 1xxx–6xxx)\n"
            "• /events2 — *1.21* анархиялары (3 таңбалы: 1xx–6xx)\n\n"
            "*Команды:*\n"
            "• /events1, /events2, /help\n"
            "• ➕ Команда қосу • 🗑 Команданы өшіру • ⚙️ Баптаулар\n\n"
            "Төмендегі батырмаларды пайдалан 👇"
        ),
        "no_events": "📭 Белсенді ивенттер жоқ: {label}",
        "events_header": "🎯 Ивенттер — {label}:\n\n",
        "btn_add": "➕ Команда қосу",
        "btn_del": "🗑 Команданы өшіру",
        "btn_settings": "⚙️ Баптаулар",
        "btn_cancel": "❌ Бас тарту",
        "btn_skip": "Өткізіп жіберу",
        "btn_done": "✅ Дайын",
        "choose_version": "➕ *Жылдам команда қосу* ({n}/{max})\n\nСервер нұсқасын таңда:",
        "choose_anarchy_type": "✅ Нұсқа: *{version}*\n\nАнархия түрлерін таңда (бірнешеу болуы мүмкін):",
        "choose_events": "✅ Түрі: *{type} {version}*\n\nИвенттерді таңда:",
        "choose_rarity": "Ивент сиректігін таңда:",
        "cmd_added": "✅ Команда қосылды!",
        "cmd_limit": "❌ Команда лимитіне жетті ({max}).",
        "cmd_exists": "ℹ️ Бұл команда сізде бар.",
        "cancelled": "❌ Бас тартылды.",
        "no_cmds_to_del": "Өшіруге командалар жоқ.",
        "choose_del": "🗑 Өшіру үшін команданы таңда:",
        "cmd_deleted": "✅ Команда өшірілді.",
        "settings_title": "⚙️ *Баптаулар*",
        "settings_sort": "Сұрыптау: {val}",
        "settings_lang": "Тіл: {val}",
        "settings_hidden": "🙈 Жасырын ивенттер: {val}",
        "hidden_none": "жоқ",
        "hidden_applied": "✅ Жасырын ивенттер жаңартылды.",
        "sort_anarchy": "Анархия бойынша",
        "sort_rarity": "Сирек бойынша",
        "no_cmd": "⚠️ Бұндай команда жоқ.",
        "help_text": "👻 *SpookyEvents Bot* — анықтама\n\nСұрақтар үшін төмендегі батырманы басыңыз 👇",
        "support_btn": "💬 Авторға жазу",
        "support_msg": "👇 Авторға жазу үшін батырманы басыңыз:",
    },
    "UA": {
        "welcome": (
            "👻 *SpookyEvents Bot*\n\n"
            "Я відстежую івенти на анархіях SpookyTime.\n\n"
            "*Версії серверів:*\n"
            "• /events1 — анархії *1.16.5* (чотиризначні: 1xxx–6xxx)\n"
            "• /events2 — анархії *1.21* (тризначні: 1xx–6xx)\n\n"
            "*Команди:*\n"
            "• /events1, /events2, /help\n"
            "• ➕ Додати команду • 🗑 Видалити команду • ⚙️ Налаштування\n\n"
            "Використовуй кнопки нижче 👇"
        ),
        "no_events": "📭 Немає активних івентів: {label}",
        "events_header": "🎯 Івенти — {label}:\n\n",
        "btn_add": "➕ Додати команду",
        "btn_del": "🗑 Видалити команду",
        "btn_settings": "⚙️ Налаштування",
        "btn_cancel": "❌ Скасувати",
        "btn_skip": "Пропустити",
        "btn_done": "✅ Готово",
        "choose_version": "➕ *Додавання швидкої команди* ({n}/{max})\n\nОбери версію сервера:",
        "choose_anarchy_type": "✅ Версія: *{version}*\n\nОбери типи анархій (можна декілька):",
        "choose_events": "✅ Тип: *{type} {version}*\n\nОбери івенти:",
        "choose_rarity": "Тепер обери рідкість:",
        "cmd_added": "✅ Команду додано!",
        "cmd_limit": "❌ Досягнуто ліміт команд ({max}).",
        "cmd_exists": "ℹ️ Така команда вже є.",
        "cancelled": "❌ Скасовано.",
        "no_cmds_to_del": "Немає команд для видалення.",
        "choose_del": "🗑 Обери команду для видалення:",
        "cmd_deleted": "✅ Команду видалено.",
        "settings_title": "⚙️ *Налаштування*",
        "settings_sort": "Сортування: {val}",
        "settings_lang": "Мова: {val}",
        "settings_hidden": "🙈 Приховані івенти: {val}",
        "hidden_none": "немає",
        "hidden_applied": "✅ Приховані івенти оновлено.",
        "sort_anarchy": "За анархіями",
        "sort_rarity": "За рідкістю",
        "no_cmd": "⚠️ Такої команди немає.",
        "help_text": "👻 *SpookyEvents Bot* — довідка\n\nЗ питань — кнопка нижче 👇",
        "support_btn": "💬 Написати творцю",
        "support_msg": "👇 Натисни кнопку щоб написати творцю бота:",
    },
    "BY": {
        "welcome": (
            "👻 *SpookyEvents Bot*\n\n"
            "Я адсочваю івэнты на анархіях SpookyTime.\n\n"
            "*Версіі сервераў:*\n"
            "• /events1 — анархіі *1.16.5* (чатырохзначныя: 1xxx–6xxx)\n"
            "• /events2 — анархіі *1.21* (трохзначныя: 1xx–6xx)\n\n"
            "*Каманды:*\n"
            "• /events1, /events2, /help\n"
            "• ➕ Дадаць каманду • 🗑 Выдаліць каманду • ⚙️ Налады\n\n"
            "Выкарыстоўвай кнопкі ніжэй 👇"
        ),
        "no_events": "📭 Няма актыўных івэнтаў: {label}",
        "events_header": "🎯 Івэнты — {label}:\n\n",
        "btn_add": "➕ Дадаць каманду",
        "btn_del": "🗑 Выдаліць каманду",
        "btn_settings": "⚙️ Налады",
        "btn_cancel": "❌ Адмена",
        "btn_skip": "Прапусціць",
        "btn_done": "✅ Гатова",
        "choose_version": "➕ *Дадаванне хуткай каманды* ({n}/{max})\n\nАбяры версію сервера:",
        "choose_anarchy_type": "✅ Версія: *{version}*\n\nАбяры тыпы анархій (можна некалькі):",
        "choose_events": "✅ Тып: *{type} {version}*\n\nАбяры івэнты:",
        "choose_rarity": "Цяпер абяры рэдкасць:",
        "cmd_added": "✅ Каманда дададзена!",
        "cmd_limit": "❌ Дасягнуты ліміт каманд ({max}).",
        "cmd_exists": "ℹ️ Такая каманда ўжо ёсць.",
        "cancelled": "❌ Адменена.",
        "no_cmds_to_del": "Няма каманд для выдалення.",
        "choose_del": "🗑 Абяры каманду для выдалення:",
        "cmd_deleted": "✅ Каманда выдалена.",
        "settings_title": "⚙️ *Налады*",
        "settings_sort": "Сартаванне: {val}",
        "settings_lang": "Мова: {val}",
        "settings_hidden": "🙈 Схаваныя івэнты: {val}",
        "hidden_none": "няма",
        "hidden_applied": "✅ Схаваныя івэнты абноўлены.",
        "sort_anarchy": "Па анархіях",
        "sort_rarity": "Па рэдкасці",
        "no_cmd": "⚠️ Такой каманды няма.",
        "help_text": "👻 *SpookyEvents Bot* — даведка\n\nПа пытаннях — кнопка ніжэй 👇",
        "support_btn": "💬 Напісаць стваральніку",
        "support_msg": "👇 Націсні кнопку каб напісаць стваральніку бота:",
    },
}


# ==================== ГРУППОВОЙ ДОСТУП / ВРЕМЯ ОБНОВЛЕНИЯ ====================

LAST_UPDATE = {"ts": None}
ALLOW_FILE = os.path.join(DATA_DIR, "group_allow.json")
STATS_FILE = os.path.join(DATA_DIR, "stats.json")
EVENTS_CACHE_FILE = os.path.join(DATA_DIR, "events_cache.json")


def dump_events_cache():
    """Сохраняет текущие события в общий файл, чтобы Discord-бот читал те же данные."""
    try:
        with open(EVENTS_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump({"updated": time.time(), "events": events_data, "mines": mines_data}, f, ensure_ascii=False)
    except Exception as e:
        print(f"⚠️ dump_events_cache: {e}")


def _today():
    return time.strftime("%Y-%m-%d")


def load_stats() -> dict:
    if os.path.exists(STATS_FILE):
        try:
            with open(STATS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_stats(data: dict):
    try:
        with open(STATS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:
        pass


def track(user_id: int, kind: str):
    """kind: 'view' (выдан список ивентов) или 'search'."""
    data = load_stats()
    day = _today()
    d = data.setdefault(day, {"users": [], "views": 0, "searches": 0})
    if user_id not in d["users"]:
        d["users"].append(user_id)
    if kind == "view":
        d["views"] = d.get("views", 0) + 1
    elif kind == "search":
        d["searches"] = d.get("searches", 0) + 1
    # храним максимум 30 последних дней
    for old in sorted(data.keys())[:-30]:
        data.pop(old, None)
    save_stats(data)


def stats_summary() -> str:
    data = load_stats()
    today = data.get(_today(), {"users": [], "views": 0, "searches": 0})
    total_users = set()
    total_views = 0
    for d in data.values():
        total_users.update(d.get("users", []))
        total_views += d.get("views", 0)
    return (
        "\n\n📊 *Статистика:*\n"
        f"• Сегодня юзеров: {len(today.get('users', []))}\n"
        f"• Сегодня выдано списков: {today.get('views', 0)}\n"
        f"• Сегодня поисков: {today.get('searches', 0)}\n"
        f"• Всего уникальных юзеров: {len(total_users)}\n"
        f"• Всего выдано списков: {total_views}"
    )


def _load_allow():
    if os.path.exists(ALLOW_FILE):
        try:
            with open(ALLOW_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def _save_allow(data):
    with open(ALLOW_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_chat_allow(chat_id) -> list:
    return _load_allow().get(str(chat_id), [])


def add_chat_allow(chat_id, username: str) -> bool:
    data = _load_allow()
    lst = data.setdefault(str(chat_id), [])
    uname = username.lstrip("@").lower()
    if uname in lst:
        return False
    lst.append(uname)
    _save_allow(data)
    return True


def last_update_str() -> str:
    ts = LAST_UPDATE.get("ts")
    return time.strftime("%H:%M:%S", time.localtime(ts)) if ts else "\u2014"


# Доп. тексты (RU; для остальных языков сработает RU-fallback в t())
_EXTRA_TR_RU = {
    "footer_updated": "\n🕒 Обновлено: {ts}",
    "btn_refresh": "🔄 Обновить",
    "btn_share": "📤 Поделиться",
    "btn_search": "🔍 Поиск",
    "upcoming_line": "Анархия {num}: ⏳ ивент через {next_in}",
    "search_prompt": "🔍 Введи название ивента для поиска:",
    "search_empty": "📭 Ничего не найдено по запросу: {q}",
    "search_header": "🔍 Результаты «{q}»:\n\n",
    "ask_name": "✏️ Введи название для команды (или «-» для авто):",
    "ask_color": "🎨 Выбери цвет кнопки для этой команды:",
    "ask_emoji": "😀 Выбери эмодзи для кнопки команды:",
    "choose_del_multi": "🗑 Отметь команды для удаления и нажми «Удалить выбранные»:",
    "choose_rarities": "Выбери редкости (можно несколько):",
    "set_status": "📊 Статус: {val}",
    "status_both": "оба",
    "status_active": "активные",
    "status_upcoming": "скорые",
    "set_compact": "🗜 Компактный: {val}",
    "on": "вкл",
    "off": "выкл",
    "set_autoupdate": "🔄 Автообновление: {val}",
    "set_audelay": "⏱ Интервал автообновления: {val} сек",
    "audelay_prompt": "Введите интервал автообновления в секундах (минимум 6):",
    "audelay_bad": "⚠️ Нужно число не меньше 6. Откройте настройки и попробуйте снова.",
    "audelay_set": "✅ Интервал автообновления: {val} сек.",
    "btn_stop_autoupdate": "⏹ Остановить автообновление",
    "autoupdate_stopped": "Автообновление остановлено",
    "refreshed": "🔄 Обновлено!",
    "no_access": "🚫 Нет доступа. Попроси админа чата: /allow @username",
    "allow_ok": "✅ @{u} получил доступ в этом чате.",
    "allow_exists": "ℹ️ @{u} уже имеет доступ.",
    "allow_usage": "Использование: /allow @username (только в группах, для админов).",
    "allow_not_admin": "🚫 Только админ чата может выдавать доступ.",
    "fast_none": "❌ Быстрой команды №{n} нет.",
}
TR["RU"].update(_EXTRA_TR_RU)


def t(lang: str, key: str, **kwargs) -> str:
    lang = lang if lang in TR else "RU"
    text = TR[lang].get(key, TR["RU"].get(key, key))
    return text.format(**kwargs) if kwargs else text

# ==================== ХРАНИЛИЩЕ ====================

DEFAULT_SETTINGS = {"sort": "anarchy", "lang": "RU", "hidden_events": [], "status_filter": "both", "compact": False, "autoupdate": False, "autoupdate_delay": 6}


def load_all() -> dict:
    if os.path.exists(USER_COMMANDS_FILE):
        try:
            with open(USER_COMMANDS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_all(data: dict):
    with open(USER_COMMANDS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_user_entry(user_id: int) -> dict:
    data = load_all()
    key = str(user_id)
    entry = data.get(key)
    if entry is None:
        entry = {"commands": [], "settings": dict(DEFAULT_SETTINGS)}
        data[key] = entry
        save_all(data)
    elif isinstance(entry, list):
        entry = {"commands": entry, "settings": dict(DEFAULT_SETTINGS)}
        data[key] = entry
        save_all(data)
    else:
        entry.setdefault("commands", [])
        entry.setdefault("settings", dict(DEFAULT_SETTINGS))
        for k, v in DEFAULT_SETTINGS.items():
            entry["settings"].setdefault(k, v)
    return entry


def save_user_entry(user_id: int, entry: dict):
    data = load_all()
    data[str(user_id)] = entry
    save_all(data)


def get_user_cmds(user_id: int) -> list:
    return get_user_entry(user_id)["commands"]


def get_user_settings(user_id: int) -> dict:
    s = get_user_entry(user_id)["settings"]
    for _k, _v in DEFAULT_SETTINGS.items():
        if _k not in s:
            s[_k] = list(_v) if isinstance(_v, list) else _v
    return s


def set_user_setting(user_id: int, key: str, value):
    entry = get_user_entry(user_id)
    entry["settings"][key] = value
    save_user_entry(user_id, entry)


def add_user_cmd(user_id: int, version: str, anarchy_types: list, events: list, rarity=None, name: str = None, style: str = None, emoji: str = None) -> bool:
    entry = get_user_entry(user_id)
    cmds = entry["commands"]
    if len(cmds) >= MAX_CUSTOM_COMMANDS:
        return False
    if isinstance(rarity, (list, set, tuple)):
        rarities = sorted(rarity) or None
    elif rarity:
        rarities = [rarity]
    else:
        rarities = None
    new_entry = {
        "version": version,
        "types": sorted(anarchy_types) if anarchy_types else None,
        "events": sorted(events) if events else None,
        "rarity": None,
        "rarities": rarities,
        "name": name or None,
        "style": style or None,
        "emoji": emoji or None,
    }
    for c in cmds:
        c_rar = c.get("rarities") or ([c["rarity"]] if c.get("rarity") else None)
        if (c.get("version") == new_entry["version"] and c.get("types") == new_entry["types"]
                and c.get("events") == new_entry["events"] and c_rar == rarities):
            return False
    cmds.append(new_entry)
    entry["commands"] = cmds
    save_user_entry(user_id, entry)
    return True


def delete_user_cmd(user_id: int, idx: int) -> bool:
    entry = get_user_entry(user_id)
    cmds = entry["commands"]
    if 0 <= idx < len(cmds):
        cmds.pop(idx)
        entry["commands"] = cmds
        save_user_entry(user_id, entry)
        return True
    return False


def delete_user_cmds(user_id: int, indices) -> int:
    """Удаляет несколько команд по индексам. Возвращает число удалённых."""
    entry = get_user_entry(user_id)
    cmds = entry["commands"]
    removed = 0
    for idx in sorted(set(indices), reverse=True):
        if 0 <= idx < len(cmds):
            cmds.pop(idx)
            removed += 1
    entry["commands"] = cmds
    save_user_entry(user_id, entry)
    return removed

# ==================== КЛАВИАТУРА ====================

def cmd_label(cmd: dict) -> str:
    if cmd.get("name"):
        emoji = cmd.get("emoji")
        return f"{emoji} {cmd['name']}" if emoji else cmd["name"]
    version = cmd.get("version", "")
    types = cmd.get("types") or cmd.get("type")  # совместимость со старым форматом
    if isinstance(types, list):
        type_str = "+".join(types) if len(types) <= 3 else f"{len(types)} типов"
    else:
        type_str = types or "Все"
    label = f"🔍 {type_str} {version}"
    extras = []
    if cmd.get("events"):
        names = cmd["events"]
        extras.append(names[0] if len(names) == 1 else f"{len(names)} ив.")
    rar = cmd.get("rarities") or ([cmd["rarity"]] if cmd.get("rarity") else None)
    if rar:
        extras.append("+".join(rar) if len(rar) <= 2 else f"{len(rar)} ред.")
    if extras:
        label += " (" + ", ".join(extras) + ")"
    return label


def default_layout(cmds) -> list:
    """Стандартный порядок ключей кнопок reply-клавиатуры."""
    keys = ["events1", "events2", "search", "mines1", "mines2", "mines", "del", "add", "help", "settings", "changelog"]
    keys += [f"fast{i + 1}" for i in range(len(cmds))]
    return keys


def _btn_label(key: str, lang: str, cmds) -> str:
    """Ключ кнопки -> подпись. None, если ключ невалиден."""
    if key == "events1":
        return "🎯 /events1"
    if key == "events2":
        return "🚀 /events2"
    if key == "mines1":
        return "⛏ /mines1"
    if key == "mines2":
        return "⛏ /mines2"
    if key == "mines":
        return "⛏ /mines"
    if key == "help":
        return "🛡 /help"
    if key == "changelog":
        return "📋 /changelog"
    if key == "add":
        return t(lang, "btn_add")
    if key == "del":
        return t(lang, "btn_del")
    if key == "settings":
        return t(lang, "btn_settings")
    if key == "search":
        return t(lang, "btn_search")
    if key.startswith("fast"):
        try:
            idx = int(key[4:]) - 1
        except ValueError:
            return None
        if 0 <= idx < len(cmds):
            return cmd_label(cmds[idx])
    return None


def default_layout_rows(cmds) -> list:
    """Стандартная раскладка по рядам."""
    rows = [
        ["events1", "events2", "search"],
        ["mines1", "mines2", "mines"],
        ["del", "add"],
        ["help", "settings", "changelog"],
    ]
    rows += [[f"fast{i + 1}"] for i in range(len(cmds))]
    return rows


def get_user_layout(user_id: int) -> list:
    """Возвращает раскладку юзера как список рядов, отфильтрованную по валидным ключам.
    Поддерживает старый формат (плоский список) и новый (список рядов)."""
    settings = get_user_settings(user_id)
    cmds = get_user_cmds(user_id)
    layout = settings.get("layout")
    valid = set(default_layout(cmds))
    if not isinstance(layout, list) or not layout:
        return default_layout_rows(cmds)
    # старый формат: плоский список ключей -> по 2 в ряд
    if all(isinstance(x, str) for x in layout):
        flat = [k for k in layout if k in valid]
        rows = [flat[i:i + 2] for i in range(0, len(flat), 2)]
    else:
        # новый формат: список рядов
        rows = []
        for row in layout:
            if isinstance(row, list):
                clean = [k for k in row if k in valid]
                if clean:
                    rows.append(clean)
    # новые фаст-команды, которых ещё нет в раскладке, дописываем новым рядом
    present = {k for row in rows for k in row}
    extra = [k for k in default_layout(cmds) if k.startswith("fast") and k not in present]
    for i in range(0, len(extra), 2):
        rows.append(extra[i:i + 2])
    return rows


def layout_keys_flat(rows) -> list:
    return [k for row in rows for k in row]


# Цвета кнопок (Bot API 9.4+): success=зелёный, primary=синий, danger=красный
BTN_STYLES = {
    "events1": "success", "events2": "success", "search": "success",
    "mines1": "primary", "mines2": "primary", "mines": "primary",
    "settings": "primary", "help": "primary", "changelog": "primary",
    "add": "danger", "del": "danger",
}
COLOR_NAMES = {"success": "🟢 Зелёный", "primary": "🔵 Синий", "danger": "🔴 Красный"}


def _kbtn(text, style=None):
    """KeyboardButton с цветом, с откатом если версия библиотеки не поддерживает style."""
    if style:
        try:
            return KeyboardButton(text, style=style)
        except TypeError:
            pass
    return KeyboardButton(text)


def _btn_style(key, cmds):
    if key.startswith("fast"):
        try:
            idx = int(key[4:]) - 1
        except ValueError:
            return None
        if 0 <= idx < len(cmds):
            return cmds[idx].get("style")
        return None
    return BTN_STYLES.get(key)


def build_main_keyboard(user_id: int) -> ReplyKeyboardMarkup:
    settings = get_user_settings(user_id)
    lang = settings["lang"]
    cmds = get_user_cmds(user_id)
    layout = get_user_layout(user_id)
    rows = []
    for row in layout:
        btns = [_kbtn(_btn_label(k, lang, cmds), _btn_style(k, cmds))
                for k in row if _btn_label(k, lang, cmds)]
        if btns:
            rows.append(btns)
    if not rows:
        rows = [[KeyboardButton("/settings")]]
    return ReplyKeyboardMarkup(rows, resize_keyboard=True)

# ==================== ПАРСИНГ ИВЕНТОВ ====================

def get_version(num) -> str:
    return VERSION_4DIGIT if len(str(num)) == 4 else VERSION_3DIGIT


def filter_events(version: str, type_nums: list) -> list:
    evs = events_data.get(version, [])
    result = []
    for e in evs:
        num = e["anarchy_num"]
        if version == VERSION_4DIGIT:
            prefix = num // 1000
        else:
            prefix = num // 100
        if prefix in type_nums:
            result.append(e)
    return result


def _norm_name(s: str) -> str:
    return (s or "").strip().casefold()


def remove_hidden(evs: list, hidden: list) -> list:
    if not hidden:
        return evs
    hidden_set = {_norm_name(h) for h in hidden}
    return [e for e in evs if _norm_name(e["name"]) not in hidden_set]


def _parse_ru_duration(s):
    """'1 мин 9 сек' / '2 ч 3 мин' / '45 сек' -> всего секунд (int) или None."""
    if not s:
        return None
    total = 0
    found = False
    for val, unit in re.findall(r"(\d+)\s*(ч|час\w*|мин\w*|сек\w*|m|s|h)", s, re.IGNORECASE):
        n = int(val)
        u = unit.lower()
        if u.startswith("ч") or u == "h":
            total += n * 3600
        elif u.startswith("м") or u == "m":
            total += n * 60
        else:
            total += n
        found = True
    return total if found else None


def _format_duration(sec):
    sec = int(max(0, round(sec)))
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    parts = []
    if h:
        parts.append(f"{h} ч")
    if m:
        parts.append(f"{m} мин")
    parts.append(f"{s} сек")
    return " ".join(parts)


def _split_timer(time_str):
    """'до деактивации: 1 мин 9 сек' -> ('до деактивации:', 69)."""
    if not time_str:
        return "", None
    if ":" in time_str:
        label, dur = time_str.rsplit(":", 1)
        return label.strip() + ":", _parse_ru_duration(dur)
    return "", _parse_ru_duration(time_str)


def parse_events(text):
    now = time.time()
    events = []
    pattern = r'Анархия (\d+):\s*(.*?)(?=Анархия \d+:|$)'
    for num_str, content in re.findall(pattern, text, re.DOTALL):
        num = int(num_str)
        if "До следующего ивента:" in content:
            m_up = re.search(r"До следующего ивента:\s*(.+)", content)
            next_in = m_up.group(1).strip().split("\n")[0].strip() if m_up else "?"
            events.append({
                "anarchy_num": num,
                "name": "",
                "loot_level": None,
                "rarity": None,
                "status": None,
                "time_str": None,
                "location": None,
                "raw_first_line": "",
                "upcoming": True,
                "next_in": next_in,
                "next_in_sec": _parse_ru_duration(next_in),
                "fetched_at": now,
            })
            continue
        lines = content.strip().split("\n")
        if not lines:
            continue
        first = lines[0].strip()
        name_match = re.search(r"\]\s*(.+?)$", first)
        if not name_match:
            continue
        loot = status = time_str = location = None
        for line in lines[1:]:
            line = line.strip()
            if "Уровень лута:" in line:
                loot = line.split(":", 1)[1].strip()
            elif "Статус:" in line:
                parts = line.split(":", 1)[1].strip().split(",", 1)
                status = parts[0].strip()
                if len(parts) > 1:
                    time_str = parts[1].strip()
            elif "Координаты:" in line or "Локация:" in line:
                location = line
        rarity = None
        if loot:
            for r in RARITY_ORDER:
                if r in loot:
                    rarity = r
                    break
        events.append({
            "anarchy_num": num,
            "name": name_match.group(1).strip(),
            "rarity": rarity,
            "loot_level": loot,
            "status": status,
            "time_str": time_str,
            "timer_label": _split_timer(time_str)[0],
            "timer_sec": _split_timer(time_str)[1],
            "fetched_at": now,
            "location": location,
            "raw_first_line": first
        })
    return events


def _parse_clock(s):
    """'01:48' / '1:02:03' -> секунды (int), иначе fallback на слова ('1 мин 9 сек')."""
    if not s:
        return None
    s = s.strip()
    if ":" in s:
        digits = [p for p in s.split(":") if p.strip().isdigit()]
        if digits:
            total = 0
            for p in digits:
                total = total * 60 + int(p)
            return total
    return _parse_ru_duration(s)


def parse_mines(text):
    """Парсит ответ @SpookyTimeBot на /mines.

    Формат блока:
    [🩵] Анархия 401:
    Следующая: Легендарная
    Обновится через: 01:48
    """
    now = time.time()
    mines = []
    if not text:
        return mines
    blocks = re.findall(
        r"\[\s*([^\]]+?)\s*\]\s*Анархия\s*(\d+):\s*(.*?)(?=\[\s*[^\]]+?\]\s*Анархия\s*\d+\s*:|$)",
        text, re.DOTALL)
    for emoji, num_str, content in blocks:
        m_next = re.search(r"Следующая:\s*(.+)", content)
        if not m_next:
            continue
        m_refresh = re.search(r"Обновится через:\s*([^\n]+)", content)
        refresh_str = m_refresh.group(1).strip() if m_refresh else None
        mines.append({
            "anarchy_num": int(num_str),
            "emoji": emoji.strip(),
            "next_rarity": m_next.group(1).strip(),
            "refresh_str": refresh_str,
            "refresh_sec": _parse_clock(refresh_str),
            "fetched_at": now,
        })
    return mines


def sort_mines(mines: list, sort_mode: str) -> list:
    if sort_mode == "rarity":
        return sorted(mines, key=lambda m: (
            MINE_RARITY_ORDER.get(m.get("next_rarity"), len(MINE_RARITY_ORDER)),
            m["anarchy_num"]))
    return sorted(mines, key=lambda m: m["anarchy_num"])


def _format_clock(sec):
    sec = int(max(0, round(sec)))
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def format_mines(mines: list, version: str = None) -> str:
    if not mines:
        return "📭 Нет данных об авто-шахтах." + (f" ({version})" if version else "")
    if version:
        out = f"📅 Список авто-шахт на анархиях {version}:\n\n"
    else:
        out = "📅 Список авто-шахт на всех анархиях:\n\n"
    for m in mines:
        emoji = m.get("emoji") or "🪙"
        nxt = html.escape(m.get("next_rarity") or "?")
        base = m.get("refresh_sec")
        if base is not None and m.get("fetched_at"):
            t = html.escape(_format_clock(base - (time.time() - m["fetched_at"])))
        else:
            t = html.escape(m.get("refresh_str") or "?")
        out += f"[{emoji}] Анархия {m['anarchy_num']}:\n"
        out += f"Следующая: {nxt}\n"
        out += f"Обновится через: {t}\n\n"
    return out


def apply_status_filter(evs: list, mode: str) -> list:
    if mode == "active":
        return [e for e in evs if not e.get("upcoming")]
    if mode == "upcoming":
        return [e for e in evs if e.get("upcoming")]
    return evs


def sort_events(evs: list, sort_mode: str) -> list:
    # Скорые ивенты всегда идут ПОСЛЕ активных, независимо от сортировки
    if sort_mode == "rarity":
        return sorted(evs, key=lambda e: (1 if e.get("upcoming") else 0,
                                          RARITY_ORDER.get(e.get("rarity"), len(RARITY_ORDER)),
                                          e["anarchy_num"]))
    return sorted(evs, key=lambda e: (1 if e.get("upcoming") else 0, e["anarchy_num"]))


def _clean_location(loc: str) -> str:
    """Чистит координаты/варп от лишних пробелов и оборачивает значение в
    HTML <code> — в Telegram такой текст копируется одним тапом."""
    if not loc:
        return loc
    if ":" in loc:
        label, val = loc.split(":", 1)
        val = re.sub(r"\s+", " ", val).strip()
        if not val:
            return html.escape(loc)
        return f"{html.escape(label.strip())}: <code>{html.escape(val)}</code>"
    val = re.sub(r"\s+", " ", loc).strip()
    return f"<code>{html.escape(val)}</code>" if val else loc


def format_one_event(e: dict, compact: bool = False, version: str = None) -> str:
    head = f"[{version}] " if version else ""
    if e.get("upcoming"):
        base = e.get("next_in_sec")
        if base is not None and e.get("fetched_at"):
            nxt = _format_duration(base - (time.time() - e["fetched_at"]))
        else:
            nxt = str(e.get("next_in") or "?")
        return f"{head}Анархия {e['anarchy_num']}: ⏳ ивент через {html.escape(nxt)}\n\n"
    out = f"{head}Анархия {e['anarchy_num']}:\n{html.escape(e['raw_first_line'])}\n"
    if not compact:
        if e.get("loot_level"):
            out += f"Уровень лута: {html.escape(str(e['loot_level']))}\n"
        if e.get("status"):
            out += f"Статус: {html.escape(str(e['status']))}"
            base = e.get("timer_sec")
            if base is not None and e.get("fetched_at"):
                remaining = base - (time.time() - e["fetched_at"])
                label = e.get("timer_label") or ""
                ts = (label + " " if label else "") + _format_duration(remaining)
                out += f", {html.escape(ts)}"
            elif e.get("time_str"):
                out += f", {html.escape(str(e['time_str']))}"
            out += "\n"
    if e.get("location"):
        out += _clean_location(e["location"]) + "\n"
    out += "\n"
    return out


def format_events(evs: list, version: str, lang: str, type_name: str = None, compact: bool = False) -> str:
    label = f"{type_name} {version}" if type_name else version
    if not evs:
        return t(lang, "no_events", label=label)
    out = t(lang, "events_header", label=label)
    for e in evs:
        out += format_one_event(e, compact)
    return out


async def send_long(update: Update, text: str, keyboard=None):
    kwargs = {"reply_markup": keyboard} if keyboard else {}
    kwargs["parse_mode"] = "HTML"
    if len(text) > 4000:
        for i in range(0, len(text), 4000):
            await update.message.reply_text(text[i:i + 4000], **kwargs)
    else:
        await update.message.reply_text(text, **kwargs)

# ==================== ДОСТУП (проверка покупки на сайте InsideClient) ====================
# Кэш: chat_id -> (access: bool, checked_at: float). Живёт в памяти процесса —
# при рестарте бота просто перезапросится заново, ничего страшного.
_access_cache: dict[int, tuple[bool, float]] = {}
_http_session: "aiohttp.ClientSession | None" = None


def _get_http_session() -> aiohttp.ClientSession:
    global _http_session
    if _http_session is None or _http_session.closed:
        _http_session = aiohttp.ClientSession()
    return _http_session


async def check_spooky_access(chat_id: int) -> bool:
    """Спрашивает сайт InsideClient, куплен ли доступ для этого chat_id.

    При недоступности сайта — донашиваем последнее известное "да" ещё
    ACCESS_CACHE_STALE_GRACE секунд (чтобы платящие пользователи не
    получали отказ из-за короткого даунтайма сайта), но никогда не
    выдумываем "да" на пустом месте: если кэша нет вообще — отказываем.
    """
    if not INSIDE_CLIENT_API_URL or not SPOOKY_INTERNAL_SECRET:
        print("⚠️ INSIDE_CLIENT_API_URL/SPOOKY_INTERNAL_SECRET не заданы — доступ закрыт для всех.")
        return False

    now = time.time()
    cached = _access_cache.get(chat_id)
    if cached and (now - cached[1]) < ACCESS_CACHE_TTL:
        return cached[0]

    url = f"{INSIDE_CLIENT_API_URL}/api/internal/spooky-access"
    try:
        session = _get_http_session()
        async with session.get(
            url,
            params={"chat_id": chat_id},
            headers={"X-Internal-Secret": SPOOKY_INTERNAL_SECRET},
            timeout=aiohttp.ClientTimeout(total=ACCESS_CHECK_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}")
            data = await resp.json()
            access = bool(data.get("access"))
            _access_cache[chat_id] = (access, now)
            return access
    except Exception as e:
        print(f"⚠️ Не удалось проверить доступ для {chat_id}: {e}")
        if cached and (now - cached[1]) < ACCESS_CACHE_STALE_GRACE:
            return cached[0]
        return False


def _paywall_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("🛒 Купить доступ", url=f"https://t.me/{INSIDE_CLIENT_BOT_USERNAME}")
    ]])


async def access_gate(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Глобальный пре-хендлер (group=-1, регистрируется раньше всех
    остальных). Если доступа нет — отвечает и останавливает дальнейшую
    обработку апдейта через ApplicationHandlerStop, ни один из обычных
    хендлеров (start/events/настройки и т.д.) не выполнится."""
    chat = update.effective_chat
    if chat is None or chat.type != "private":
        # В группы бот не продаётся — гейтим только личку.
        return

    user = update.effective_user
    if user is None:
        return

    if await check_spooky_access(chat.id):
        return  # доступ есть — пропускаем апдейт дальше как обычно

    text = (
        "🔒 Доступ к SpookyEvents нужно купить на сайте InsideClient.\n\n"
        "1. Откройте @{bot} и привяжите Telegram (если ещё не привязан).\n"
        "2. Купите «Доступ к боту» и активируйте ключ.\n"
        "3. Возвращайтесь сюда и нажмите /start ещё раз."
    ).format(bot=INSIDE_CLIENT_BOT_USERNAME)

    try:
        if update.callback_query:
            await update.callback_query.answer("Нужен доступ — см. сообщение в чате", show_alert=True)
            await context.bot.send_message(chat.id, text, reply_markup=_paywall_keyboard())
        elif update.message:
            await update.message.reply_text(text, reply_markup=_paywall_keyboard())
        else:
            await context.bot.send_message(chat.id, text, reply_markup=_paywall_keyboard())
    except Exception as e:
        print(f"⚠️ Не удалось отправить paywall-сообщение {chat.id}: {e}")

    raise ApplicationHandlerStop

# ==================== КОМАНДЫ БОТА ====================

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    kb = build_main_keyboard(user_id)
    await update.message.reply_text(t(lang, "welcome"), parse_mode="Markdown", reply_markup=kb)


COMMANDS_HELP = (
    "\n\n*Команды:*\n"
    "• /events1 — ивенты 1.16.5\n"
    "• /events2 — ивенты 1.21\n"
    "• /mines — авто-шахты на всех анархиях\n"
    "• /mines1 — авто-шахты 1.16.5\n"
    "• /mines2 — авто-шахты 1.21\n"
    "• /search <текст> — поиск ивента\n"
    "• /newcommand — создать быструю команду\n"
    "• /delcommand — удалить быструю команду\n"
    "• /fastcommand1 … /fastcommand5 — запустить быструю команду №N\n"
    "• /keyboard — настроить раскладку клавиатуры\n"
    "• /changelog — список обновлений\n"
    "• /settings — настройки\n"
    "• /allow @username — выдать доступ в группе (для админов)\n"
    "• /help — справка"
)


async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    kb = build_main_keyboard(user_id)
    inline_kb = InlineKeyboardMarkup([[
        InlineKeyboardButton(t(lang, "support_btn"), url=f"https://t.me/{SUPPORT_USERNAME}")
    ]])
    await update.message.reply_text(
        t(lang, "help_text") + COMMANDS_HELP + stats_summary(), parse_mode="Markdown", reply_markup=kb
    )
    await update.message.reply_text(
        t(lang, "support_msg"), reply_markup=inline_kb
    )


# ==================== ПОИСК / ПОДЕЛИТЬСЯ / ОБНОВИТЬ / ДОСТУП ====================

def results_kb(token: str, lang: str, autoupdate: bool = False) -> InlineKeyboardMarkup:
    rows = [[InlineKeyboardButton(t(lang, "btn_refresh"), callback_data=f"refresh:{token}")]]
    if autoupdate:
        rows.append([InlineKeyboardButton(t(lang, "btn_stop_autoupdate"), callback_data=f"austop:{token}")])
    return InlineKeyboardMarkup(rows)


async def send_events_view(update, evs, version, settings, type_name, token, context=None):
    lang = settings["lang"]
    try:
        track(update.effective_user.id, "view")
    except Exception:
        pass
    text = format_events(evs, version, lang, type_name, settings.get("compact", False))
    user_id = update.effective_user.id
    au_on = (settings.get("autoupdate", False) and context is not None
             and getattr(context, "job_queue", None) is not None)
    kb = results_kb(token, lang, autoupdate=au_on)
    msg = update.effective_message
    sent = None
    if len(text) > 4000:
        chunks = [text[i:i + 4000] for i in range(0, len(text), 4000)]
        for c in chunks[:-1]:
            await msg.reply_text(c, parse_mode="HTML")
        sent = await msg.reply_text(chunks[-1], reply_markup=kb, parse_mode="HTML")
    else:
        sent = await msg.reply_text(text, reply_markup=kb, parse_mode="HTML")
    if au_on and sent is not None:
        last_search = context.user_data.get("last_search", "") if hasattr(context, "user_data") else ""
        _start_autoupdate(context, user_id, sent.chat_id, sent.message_id, token, last_search)


def _search_events(query: str, settings: dict):
    ql = (query or "").strip().lower()
    res = []
    if not ql:
        return res
    for version in (VERSION_4DIGIT, VERSION_3DIGIT):
        evs = apply_status_filter(events_data.get(version, []), settings.get("status_filter", "both"))
        evs = remove_hidden(evs, settings.get("hidden_events", []))
        for e in sort_events(evs, settings["sort"]):
            if ql in (e.get("name") or "").lower():
                res.append((version, e))
    return res


def _format_search(results, query, lang, compact):
    out = t(lang, "search_header", q=query)
    for version, e in results:
        out += format_one_event(e, compact, version)
    return out


async def do_search(update, context, query):
    user_id = update.effective_user.id
    settings = get_user_settings(user_id)
    lang = settings["lang"]
    try:
        track(user_id, "search")
    except Exception:
        pass
    context.user_data["last_search"] = query
    results = _search_events(query, settings)
    if not results:
        await update.message.reply_text(t(lang, "search_empty", q=query),
                                        reply_markup=build_main_keyboard(user_id))
        return
    text = _format_search(results, query, lang, settings.get("compact", False))
    kb = results_kb("s", lang)
    if len(text) > 4000:
        chunks = [text[i:i + 4000] for i in range(0, len(text), 4000)]
        for c in chunks[:-1]:
            await update.message.reply_text(c)
        await update.message.reply_text(chunks[-1], reply_markup=kb)
    else:
        await update.message.reply_text(text, reply_markup=kb)


def _events_for_cmd(user_id, cmd, settings):
    version = cmd.get("version")
    types = cmd.get("types") or ([cmd["type"]] if cmd.get("type") else None)
    type_nums = [ANARCHY_TYPES[x] for x in types if x in ANARCHY_TYPES] if types else list(ANARCHY_TYPES.values())
    evs = filter_events(version, type_nums)
    wanted = cmd.get("events")
    if wanted:
        evs = [e for e in evs if e.get("name") in wanted]
    rarities = cmd.get("rarities") or ([cmd["rarity"]] if cmd.get("rarity") else None)
    if rarities:
        evs = [e for e in evs if e.get("rarity") in rarities]
    evs = remove_hidden(evs, settings.get("hidden_events", []))
    evs = apply_status_filter(evs, settings.get("status_filter", "both"))
    evs = sort_events(evs, settings["sort"])
    type_label = "+".join(types) if types else ""
    return evs, version, type_label


def render_for_user(user_id, token, last_search=""):
    """Синхронный рендер (text, lang) по токену — для refresh и автообновления."""
    settings = get_user_settings(user_id)
    lang = settings["lang"]
    kind, _, rest = token.partition(":")
    if kind == "v":
        version = rest
        evs = filter_events(version, list(ANARCHY_TYPES.values()))
        evs = remove_hidden(evs, settings.get("hidden_events", []))
        evs = apply_status_filter(evs, settings.get("status_filter", "both"))
        evs = sort_events(evs, settings["sort"])
        return format_events(evs, version, lang, None, settings.get("compact", False)), lang
    if kind == "c":
        cmds = get_user_cmds(user_id)
        idx = int(rest) if rest.isdigit() else -1
        if 0 <= idx < len(cmds):
            evs, version, type_label = _events_for_cmd(user_id, cmds[idx], settings)
            return format_events(evs, version, lang, type_label, settings.get("compact", False)), lang
        return t(lang, "no_events", label=""), lang
    if kind == "s":
        q = last_search
        results = _search_events(q, settings)
        if not results:
            return t(lang, "search_empty", q=q), lang
        return _format_search(results, q, lang, settings.get("compact", False)), lang
    if kind == "m":
        if rest == "all":
            mines = sort_mines(mines_data[VERSION_4DIGIT] + mines_data[VERSION_3DIGIT], settings["sort"])
            return format_mines(mines), lang
        mines = sort_mines(mines_data.get(rest, []), settings["sort"])
        return format_mines(mines, rest), lang
    return t(lang, "no_events", label=""), lang


async def _render_token(update, context, token):
    """Возвращает (text, lang) для refresh/share."""
    user_id = update.effective_user.id
    last_search = context.user_data.get("last_search", "")
    return render_for_user(user_id, token, last_search)


# ==================== АВТООБНОВЛЕНИЕ ====================
def _stop_autoupdate(context, user_id):
    if getattr(context, "job_queue", None) is None:
        return
    for job in context.job_queue.get_jobs_by_name(f"au_{user_id}"):
        job.schedule_removal()


def _start_autoupdate(context, user_id, chat_id, message_id, token, last_search=""):
    if getattr(context, "job_queue", None) is None:
        return
    _stop_autoupdate(context, user_id)
    settings = get_user_settings(user_id)
    if not settings.get("autoupdate"):
        return
    delay = max(6, int(settings.get("autoupdate_delay", 6) or 6))
    context.job_queue.run_repeating(
        _autoupdate_job, interval=delay, first=delay, name=f"au_{user_id}",
        data={"user_id": user_id, "chat_id": chat_id, "message_id": message_id,
              "token": token, "last_search": last_search})


async def _autoupdate_job(context):
    data = context.job.data
    user_id = data["user_id"]
    settings = get_user_settings(user_id)
    if not settings.get("autoupdate"):
        context.job.schedule_removal()
        return
    try:
        text, lang = render_for_user(user_id, data["token"], data.get("last_search", ""))
        await context.bot.edit_message_text(
            text[:4000], chat_id=data["chat_id"], message_id=data["message_id"],
            reply_markup=results_kb(data["token"], lang, autoupdate=True), parse_mode="HTML")
    except Exception as e:
        msg = str(e).lower()
        if "not modified" in msg:
            return
        if "not found" in msg or "can't be edited" in msg or "message to edit" in msg:
            context.job.schedule_removal()


async def austop_cb(update, context):
    query = update.callback_query
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    set_user_setting(user_id, "autoupdate", False)
    _stop_autoupdate(context, user_id)
    token = query.data.split(":", 1)[1]
    try:
        text, lang = await _render_token(update, context, token)
        await query.edit_message_text(text[:4000], reply_markup=results_kb(token, lang),
                                      parse_mode="HTML")
    except Exception:
        pass
    try:
        await query.answer(t(lang, "autoupdate_stopped"))
    except Exception:
        pass


async def refresh_cb(update, context):
    query = update.callback_query
    lang = get_user_settings(update.effective_user.id)["lang"]
    token = query.data.split(":", 1)[1]
    text, lang = await _render_token(update, context, token)
    await query.answer(t(lang, "refreshed"))
    try:
        await query.edit_message_text(text[:4000], reply_markup=results_kb(token, lang))
    except Exception:
        pass


async def share_cb(update, context):
    query = update.callback_query
    await query.answer()
    token = query.data.split(":", 1)[1]
    text, lang = await _render_token(update, context, token)
    await query.message.reply_text(text[:4000])


async def _has_group_access(update, context) -> bool:
    chat = update.effective_chat
    user = update.effective_user
    try:
        member = await context.bot.get_chat_member(chat.id, user.id)
        if member.status in ("creator", "administrator"):
            return True
    except Exception:
        pass
    uname = (user.username or "").lower()
    return uname in get_chat_allow(chat.id)


async def allow_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    chat = update.effective_chat
    if chat.type not in ("group", "supergroup"):
        await update.message.reply_text(t(lang, "allow_usage"))
        return
    try:
        member = await context.bot.get_chat_member(chat.id, user_id)
        if member.status not in ("creator", "administrator"):
            await update.message.reply_text(t(lang, "allow_not_admin"))
            return
    except Exception:
        await update.message.reply_text(t(lang, "allow_not_admin"))
        return
    if not context.args:
        await update.message.reply_text(t(lang, "allow_usage"))
        return
    uname = context.args[0].lstrip("@")
    if add_chat_allow(chat.id, uname):
        await update.message.reply_text(t(lang, "allow_ok", u=uname.lower()))
    else:
        await update.message.reply_text(t(lang, "allow_exists", u=uname.lower()))


async def events1(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    settings = get_user_settings(user_id)
    kb = build_main_keyboard(user_id)
    all_type_nums = list(ANARCHY_TYPES.values())
    evs = filter_events(VERSION_4DIGIT, all_type_nums)
    evs = remove_hidden(evs, settings.get("hidden_events", []))
    evs = sort_events(evs, settings["sort"])
    evs = apply_status_filter(evs, settings.get("status_filter", "both"))
    await send_events_view(update, evs, VERSION_4DIGIT, settings, None, "v:" + VERSION_4DIGIT, context)


async def events2(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    settings = get_user_settings(user_id)
    kb = build_main_keyboard(user_id)
    all_type_nums = list(ANARCHY_TYPES.values())
    evs = filter_events(VERSION_3DIGIT, all_type_nums)
    evs = remove_hidden(evs, settings.get("hidden_events", []))
    evs = sort_events(evs, settings["sort"])
    evs = apply_status_filter(evs, settings.get("status_filter", "both"))
    await send_events_view(update, evs, VERSION_3DIGIT, settings, None, "v:" + VERSION_3DIGIT, context)

# ==================== АВТО-ШАХТЫ ====================

async def send_mines_view(update, mines, version, settings, context=None):
    """Отправляет список шахт с кнопкой «Обновить» (и автообновлением, если включено)."""
    lang = settings["lang"]
    try:
        track(update.effective_user.id, "view")
    except Exception:
        pass
    text = format_mines(mines, version)
    user_id = update.effective_user.id
    au_on = (settings.get("autoupdate", False) and context is not None
             and getattr(context, "job_queue", None) is not None)
    token = "m:all" if not version else "m:" + version
    kb = results_kb(token, lang, autoupdate=au_on)
    msg = update.effective_message
    sent = None
    if len(text) > 4000:
        chunks = [text[i:i + 4000] for i in range(0, len(text), 4000)]
        for c in chunks[:-1]:
            await msg.reply_text(c, parse_mode="HTML")
        sent = await msg.reply_text(chunks[-1], reply_markup=kb, parse_mode="HTML")
    else:
        sent = await msg.reply_text(text, reply_markup=kb, parse_mode="HTML")
    if au_on and sent is not None:
        _start_autoupdate(context, user_id, sent.chat_id, sent.message_id, token, "")


async def mines(update: Update, context: ContextTypes.DEFAULT_TYPE):
    settings = get_user_settings(update.effective_user.id)
    all_mines = sort_mines(mines_data[VERSION_4DIGIT] + mines_data[VERSION_3DIGIT], settings["sort"])
    await send_mines_view(update, all_mines, None, settings, context)


async def mines1(update: Update, context: ContextTypes.DEFAULT_TYPE):
    settings = get_user_settings(update.effective_user.id)
    m = sort_mines(mines_data[VERSION_4DIGIT], settings["sort"])
    await send_mines_view(update, m, VERSION_4DIGIT, settings, context)


async def mines2(update: Update, context: ContextTypes.DEFAULT_TYPE):
    settings = get_user_settings(update.effective_user.id)
    m = sort_mines(mines_data[VERSION_3DIGIT], settings["sort"])
    await send_mines_view(update, m, VERSION_3DIGIT, settings, context)

# ==================== ДОБАВЛЕНИЕ БЫСТРОЙ КОМАНДЫ ====================

def anarchy_types_inline_kb(selected: set, lang: str) -> InlineKeyboardMarkup:
    rows = []
    for name in ANARCHY_TYPE_LIST:
        mark = "✅ " if name in selected else ""
        rows.append([InlineKeyboardButton(f"{mark}{name}", callback_data=f"atype:{name}")])
    rows.append([InlineKeyboardButton(t(lang, "btn_skip"), callback_data="atype:skip")])
    if selected:
        rows.append([InlineKeyboardButton(t(lang, "btn_done"), callback_data="atype:done")])
    return InlineKeyboardMarkup(rows)


def events_inline_kb(selected: set, lang: str) -> InlineKeyboardMarkup:
    rows = []
    for i, name in enumerate(EVENT_TYPES):
        mark = "✅ " if name in selected else ""
        rows.append([InlineKeyboardButton(f"{mark}{name}", callback_data=f"ev:{i}")])
    rows.append([InlineKeyboardButton(t(lang, "btn_skip"), callback_data="ev:skip")])
    if selected:
        rows.append([InlineKeyboardButton(t(lang, "btn_done"), callback_data="ev:done")])
    return InlineKeyboardMarkup(rows)


def rarity_inline_kb(lang, selected=None) -> InlineKeyboardMarkup:
    sel = selected or set()
    rows = [[InlineKeyboardButton(("✅ " if r in sel else "") + r, callback_data=f"rar:{r}")] for r in RARITIES]
    rows.append([
        InlineKeyboardButton(t(lang, "btn_skip"), callback_data="rar:skip"),
        InlineKeyboardButton(t(lang, "btn_done"), callback_data="rar:done"),
    ])
    return InlineKeyboardMarkup(rows)


async def add_cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    cmds = get_user_cmds(user_id)
    if len(cmds) >= MAX_CUSTOM_COMMANDS:
        await update.message.reply_text(
            t(lang, "cmd_limit", max=MAX_CUSTOM_COMMANDS),
            reply_markup=build_main_keyboard(user_id)
        )
        return ConversationHandler.END
    version_kb = ReplyKeyboardMarkup(
        [[KeyboardButton("1.16.5"), KeyboardButton("1.21")], [KeyboardButton(t(lang, "btn_cancel"))]],
        resize_keyboard=True
    )
    await update.message.reply_text(
        t(lang, "choose_version", n=len(cmds), max=MAX_CUSTOM_COMMANDS),
        parse_mode="Markdown", reply_markup=version_kb
    )
    return CHOOSE_VERSION


async def add_cmd_version(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    text = update.message.text.strip()
    if text == t(lang, "btn_cancel"):
        return await cancel(update, context)
    if text == VERSION_4DIGIT:
        context.user_data["add_version"] = VERSION_4DIGIT
    elif text == VERSION_3DIGIT:
        context.user_data["add_version"] = VERSION_3DIGIT
    else:
        await update.message.reply_text("Пожалуйста, выбери версию кнопкой.")
        return CHOOSE_VERSION
    context.user_data["add_types"] = set()
    version = context.user_data["add_version"]
    await update.message.reply_text(
        t(lang, "choose_anarchy_type", version=version),
        parse_mode="Markdown",
        reply_markup=anarchy_types_inline_kb(set(), lang)
    )
    return CHOOSE_TYPE


async def choose_anarchy_type_cb(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    selected = context.user_data.setdefault("add_types", set())
    data = query.data.split(":", 1)[1]

    if data == "skip":
        context.user_data["add_types"] = set()
        return await proceed_to_events(update, context, query)
    if data == "done":
        return await proceed_to_events(update, context, query)

    if data in selected:
        selected.discard(data)
    else:
        selected.add(data)
    await query.edit_message_reply_markup(reply_markup=anarchy_types_inline_kb(selected, lang))
    return CHOOSE_TYPE


async def proceed_to_events(update, context, query):
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    context.user_data["add_events"] = set()
    types = context.user_data.get("add_types", set())
    version = context.user_data.get("add_version", "")
    type_str = "+".join(sorted(types)) if types else "Все"
    await query.edit_message_text(
        t(lang, "choose_events", type=type_str, version=version),
        parse_mode="Markdown",
        reply_markup=events_inline_kb(set(), lang)
    )
    return CHOOSE_EVENTS


async def choose_events_cb(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    selected = context.user_data.setdefault("add_events", set())
    data = query.data.split(":", 1)[1]

    if data == "skip":
        context.user_data["add_events"] = set()
        return await proceed_to_rarity(update, context, query)
    if data == "done":
        return await proceed_to_rarity(update, context, query)

    idx = int(data)
    name = EVENT_TYPES[idx]
    if name in selected:
        selected.discard(name)
    else:
        selected.add(name)
    await query.edit_message_reply_markup(reply_markup=events_inline_kb(selected, lang))
    return CHOOSE_EVENTS


async def proceed_to_rarity(update, context, query):
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    selected = context.user_data.get("add_events", set())
    if selected and selected.issubset(NO_RARITY_EVENTS):
        return await finalize_add_cmd(update, context, query, rarity=None)
    await query.edit_message_text(
        t(lang, "choose_rarities"),
        reply_markup=rarity_inline_kb(lang, set())
    )
    return CHOOSE_RARITY


async def choose_rarity_cb(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    lang = get_user_settings(update.effective_user.id)["lang"]
    data = query.data.split(":", 1)[1]
    sel = context.user_data.setdefault("add_rarities", set())
    if data == "skip":
        sel.clear()
        return await ask_cmd_name(update, context, query)
    if data == "done":
        return await ask_cmd_name(update, context, query)
    if data in sel:
        sel.discard(data)
    else:
        sel.add(data)
    await query.edit_message_reply_markup(reply_markup=rarity_inline_kb(lang, sel))
    return CHOOSE_RARITY


async def ask_cmd_name(update, context, query):
    lang = get_user_settings(update.effective_user.id)["lang"]
    await query.edit_message_text(t(lang, "ask_name"))
    return CHOOSE_NAME


async def receive_cmd_name(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    raw = (update.message.text or "").strip()
    name = None if raw in ("-", "") else raw[:40]
    context.user_data["add_name"] = name
    emojis = ["⭐", "🔥", "💎", "⚡", "🎯", "👑", "🌟", "💀", "🍀", "❤️"]
    rows = []
    for i in range(0, len(emojis), 5):
        rows.append([InlineKeyboardButton(em, callback_data=f"cmdemoji:{em}") for em in emojis[i:i + 5]])
    rows.append([InlineKeyboardButton("⚪ Без эмодзи", callback_data="cmdemoji:none")])
    await update.message.reply_text(t(lang, "ask_emoji"), reply_markup=InlineKeyboardMarkup(rows))
    return CHOOSE_EMOJI


async def receive_cmd_emoji(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    lang = get_user_settings(update.effective_user.id)["lang"]
    emoji = query.data.split(":", 1)[1]
    context.user_data["add_emoji"] = None if emoji == "none" else emoji
    color_kb = InlineKeyboardMarkup([
        [InlineKeyboardButton("🟢 Зелёный", callback_data="cmdcolor:success"),
         InlineKeyboardButton("🔵 Синий", callback_data="cmdcolor:primary")],
        [InlineKeyboardButton("🔴 Красный", callback_data="cmdcolor:danger"),
         InlineKeyboardButton("⚪ Без цвета", callback_data="cmdcolor:none")],
    ])
    await query.edit_message_text(t(lang, "ask_color"), reply_markup=color_kb)
    return CHOOSE_COLOR


async def receive_cmd_color(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    style = query.data.split(":", 1)[1]
    style = None if style == "none" else style
    version = context.user_data.get("add_version")
    types_sel = list(context.user_data.get("add_types", set())) or None
    events_sel = list(context.user_data.get("add_events", set())) or None
    rarities_sel = sorted(context.user_data.get("add_rarities", set())) or None
    name = context.user_data.get("add_name")
    emoji = context.user_data.get("add_emoji")
    ok = add_user_cmd(user_id, version, types_sel, events_sel, rarities_sel, name, style, emoji)
    if ok:
        msg = t(lang, "cmd_added")
    elif len(get_user_cmds(user_id)) >= MAX_CUSTOM_COMMANDS:
        msg = t(lang, "cmd_limit", max=MAX_CUSTOM_COMMANDS)
    else:
        msg = t(lang, "cmd_exists")
    await query.edit_message_text(msg)
    await query.message.reply_text("👇", reply_markup=build_main_keyboard(user_id))
    context.user_data.clear()
    return ConversationHandler.END


async def finalize_add_cmd(update, context, query, rarity=None):
    if rarity:
        context.user_data.setdefault("add_rarities", set()).add(rarity)
    return await ask_cmd_name(update, context, query)
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    version = context.user_data.get("add_version")
    types_sel = list(context.user_data.get("add_types", set())) or None
    events_sel = list(context.user_data.get("add_events", set())) or None

    success = add_user_cmd(user_id, version, types_sel, events_sel, rarity)
    kb = build_main_keyboard(user_id)
    if success:
        msg = t(lang, "cmd_added")
    else:
        cmds = get_user_cmds(user_id)
        msg = t(lang, "cmd_limit", max=MAX_CUSTOM_COMMANDS) if len(cmds) >= MAX_CUSTOM_COMMANDS else t(lang, "cmd_exists")
    await query.edit_message_text(msg)
    await context.bot.send_message(chat_id=update.effective_chat.id, text="👍", reply_markup=kb)
    context.user_data.clear()
    return ConversationHandler.END


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    context.user_data.clear()
    await update.message.reply_text(t(lang, "cancelled"), reply_markup=build_main_keyboard(user_id))
    return ConversationHandler.END

# ==================== УДАЛЕНИЕ БЫСТРОЙ КОМАНДЫ ====================

def _del_keyboard(user_id, selected):
    cmds = get_user_cmds(user_id)
    rows = []
    for i, c in enumerate(cmds):
        mark = "✅ " if i in selected else "⬜ "
        rows.append([InlineKeyboardButton(mark + cmd_label(c), callback_data=f"delcmd:toggle:{i}")])
    rows.append([InlineKeyboardButton("🗑 Удалить выбранные", callback_data="delcmd:ask"),
                 InlineKeyboardButton("❌ Отмена", callback_data="delcmd:cancel")])
    return InlineKeyboardMarkup(rows)


async def delete_cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    cmds = get_user_cmds(user_id)
    if not cmds:
        await update.message.reply_text(t(lang, "no_cmds_to_del"), reply_markup=build_main_keyboard(user_id))
        return
    context.user_data["del_selected"] = set()
    await update.message.reply_text(t(lang, "choose_del_multi"),
                                    reply_markup=_del_keyboard(user_id, set()))


async def delete_cmd_cb(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    parts = query.data.split(":")
    action = parts[1]
    selected = context.user_data.get("del_selected", set())

    if action == "toggle":
        idx = int(parts[2])
        if idx in selected:
            selected.discard(idx)
        else:
            selected.add(idx)
        context.user_data["del_selected"] = selected
        await query.edit_message_reply_markup(reply_markup=_del_keyboard(user_id, selected))
        return

    if action == "cancel":
        context.user_data.pop("del_selected", None)
        await query.edit_message_text("❌ Отменено.")
        await context.bot.send_message(chat_id=update.effective_chat.id, text="👍",
                                       reply_markup=build_main_keyboard(user_id))
        return

    if action == "ask":
        if not selected:
            await query.answer("Ничего не выбрано", show_alert=True)
            return
        confirm_kb = InlineKeyboardMarkup([[
            InlineKeyboardButton("✅ Да, удалить", callback_data="delcmd:do"),
            InlineKeyboardButton("🔙 Назад", callback_data="delcmd:back"),
        ]])
        await query.edit_message_text(f"⚠️ Точно удалить выбранные команды ({len(selected)} шт.)?",
                                      reply_markup=confirm_kb)
        return

    if action == "back":
        await query.edit_message_text(t(lang, "choose_del_multi"),
                                      reply_markup=_del_keyboard(user_id, selected))
        return

    if action == "do":
        n = delete_user_cmds(user_id, selected)
        context.user_data.pop("del_selected", None)
        await query.edit_message_text(f"🗑 Удалено команд: {n}")
        await context.bot.send_message(chat_id=update.effective_chat.id, text="👍",
                                       reply_markup=build_main_keyboard(user_id))
        return

# ==================== НАСТРОЙКИ ====================

def hidden_events_inline_kb(selected: set, lang: str) -> InlineKeyboardMarkup:
    rows = []
    for i, name in enumerate(EVENT_TYPES):
        mark = "✅ " if name in selected else ""
        rows.append([InlineKeyboardButton(f"{mark}{name}", callback_data=f"hideev:{i}")])
    rows.append([InlineKeyboardButton(t(lang, "btn_done"), callback_data="hideev:apply")])
    rows.append([InlineKeyboardButton("⬅️", callback_data="set:back")])
    return InlineKeyboardMarkup(rows)


def settings_kb(user_id: int) -> InlineKeyboardMarkup:
    settings = get_user_settings(user_id)
    lang = settings["lang"]
    sort_label = t(lang, "sort_anarchy") if settings["sort"] == "anarchy" else t(lang, "sort_rarity")
    hidden = settings.get("hidden_events", [])
    if not hidden:
        hidden_label = t(lang, "hidden_none")
    elif len(hidden) == 1:
        hidden_label = hidden[0]
    else:
        hidden_label = f"{len(hidden)}"
    rows = [
        [InlineKeyboardButton(t(lang, "settings_sort", val=sort_label), callback_data="set:sort")],
        [InlineKeyboardButton(t(lang, "settings_lang", val=settings["lang"]), callback_data="set:lang")],
        [InlineKeyboardButton(t(lang, "settings_hidden", val=hidden_label), callback_data="set:hidden")],
        [InlineKeyboardButton(t(lang, "set_status", val=t(lang, "status_" + settings.get("status_filter", "both"))), callback_data="set:status")],
        [InlineKeyboardButton(t(lang, "set_compact", val=t(lang, "on") if settings.get("compact") else t(lang, "off")), callback_data="set:compact")],
        [InlineKeyboardButton(t(lang, "set_autoupdate", val=t(lang, "on") if settings.get("autoupdate") else t(lang, "off")), callback_data="set:autoupdate")],
        [InlineKeyboardButton(t(lang, "set_audelay", val=max(6, int(settings.get("autoupdate_delay", 6) or 6))), callback_data="set:audelay")],
    ]
    return InlineKeyboardMarkup(rows)


async def settings_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    await update.message.reply_text(
        t(lang, "settings_title"), parse_mode="Markdown", reply_markup=settings_kb(user_id)
    )


async def settings_cb(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id
    data = query.data

    if data == "set:status":
        lang = get_user_settings(user_id)["lang"]
        rows = [
            [InlineKeyboardButton(t(lang, "status_both"), callback_data="setstatus:both")],
            [InlineKeyboardButton(t(lang, "status_active"), callback_data="setstatus:active")],
            [InlineKeyboardButton(t(lang, "status_upcoming"), callback_data="setstatus:upcoming")],
            [InlineKeyboardButton("⬅️", callback_data="set:back")],
        ]
        await query.edit_message_reply_markup(reply_markup=InlineKeyboardMarkup(rows))
        return
    if data.startswith("setstatus:"):
        set_user_setting(user_id, "status_filter", data.split(":", 1)[1])
        await query.edit_message_reply_markup(reply_markup=settings_kb(user_id))
        return
    if data == "set:compact":
        cur = get_user_settings(user_id).get("compact", False)
        set_user_setting(user_id, "compact", not cur)
        await query.edit_message_reply_markup(reply_markup=settings_kb(user_id))
        return

    if data == "set:autoupdate":
        cur = get_user_settings(user_id).get("autoupdate", False)
        set_user_setting(user_id, "autoupdate", not cur)
        if cur:
            _stop_autoupdate(context, user_id)
        await query.edit_message_reply_markup(reply_markup=settings_kb(user_id))
        return

    if data == "set:audelay":
        lang = get_user_settings(user_id)["lang"]
        context.user_data["awaiting_audelay"] = True
        await query.message.reply_text(t(lang, "audelay_prompt"))
        return

    if data == "set:sort":
        lang = get_user_settings(user_id)["lang"]
        rows = [
            [InlineKeyboardButton(t(lang, "sort_anarchy"), callback_data="setsort:anarchy")],
            [InlineKeyboardButton(t(lang, "sort_rarity"), callback_data="setsort:rarity")],
            [InlineKeyboardButton("⬅️", callback_data="set:back")],
        ]
        await query.edit_message_reply_markup(reply_markup=InlineKeyboardMarkup(rows))
        return
    if data.startswith("setsort:"):
        set_user_setting(user_id, "sort", data.split(":", 1)[1])
        await query.edit_message_reply_markup(reply_markup=settings_kb(user_id))
        return
    if data == "set:lang":
        rows = [[InlineKeyboardButton(l, callback_data=f"setlang:{l}")] for l in LANGUAGES]
        rows.append([InlineKeyboardButton("⬅️", callback_data="set:back")])
        await query.edit_message_reply_markup(reply_markup=InlineKeyboardMarkup(rows))
        return
    if data.startswith("setlang:"):
        set_user_setting(user_id, "lang", data.split(":", 1)[1])
        await query.edit_message_reply_markup(reply_markup=settings_kb(user_id))
        await context.bot.send_message(chat_id=update.effective_chat.id, text="👍", reply_markup=build_main_keyboard(user_id))
        return
    if data == "set:hidden":
        lang = get_user_settings(user_id)["lang"]
        hidden = set(get_user_settings(user_id).get("hidden_events", []))
        context.user_data["hidden_temp"] = hidden
        await query.edit_message_reply_markup(reply_markup=hidden_events_inline_kb(hidden, lang))
        return
    if data.startswith("hideev:"):
        lang = get_user_settings(user_id)["lang"]
        val = data.split(":", 1)[1]
        temp = context.user_data.setdefault(
            "hidden_temp", set(get_user_settings(user_id).get("hidden_events", []))
        )
        if val == "apply":
            set_user_setting(user_id, "hidden_events", sorted(temp))
            context.user_data.pop("hidden_temp", None)
            await query.edit_message_reply_markup(reply_markup=settings_kb(user_id))
            await context.bot.send_message(
                chat_id=update.effective_chat.id,
                text=t(lang, "hidden_applied"),
                reply_markup=build_main_keyboard(user_id)
            )
            return
        idx = int(val)
        name = EVENT_TYPES[idx]
        if name in temp:
            temp.discard(name)
        else:
            temp.add(name)
        await query.edit_message_reply_markup(reply_markup=hidden_events_inline_kb(temp, lang))
        return
    if data == "set:back":
        context.user_data.pop("hidden_temp", None)
        await query.edit_message_reply_markup(reply_markup=settings_kb(user_id))
        return

# ==================== ОБРАБОТКА КАСТОМНЫХ КОМАНД ====================

async def handle_custom_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()
    user_id = update.effective_user.id
    settings = get_user_settings(user_id)
    lang = settings["lang"]

    if update.effective_chat.type in ("group", "supergroup"):
        if not await _has_group_access(update, context):
            await update.message.reply_text(t(lang, "no_access"))
            return

    if text == t(lang, "btn_search"):
        context.user_data["awaiting_search"] = True
        await update.message.reply_text(t(lang, "search_prompt"))
        return
    if context.user_data.get("awaiting_layout"):
        context.user_data["awaiting_layout"] = False
        user_id = update.effective_user.id
        settings = get_user_settings(user_id)
        lang = settings["lang"]
        cmds = get_user_cmds(user_id)
        raw = text.strip().lower()
        if raw == "reset":
            data = load_all()
            entry = data.setdefault(str(user_id), {"commands": [], "settings": dict(DEFAULT_SETTINGS)})
            entry["settings"].pop("layout", None)
            save_all(data)
            await update.message.reply_text("✅ Клавиатура сброшена к стандарту.",
                                            reply_markup=build_main_keyboard(user_id))
            return
        valid = set(default_layout(cmds))
        new_layout = []
        seen = set()
        for row_str in raw.split(";"):
            row = []
            for part in re.split(r"[\s,]+", row_str):
                part = part.strip()
                if part and part in valid and part not in seen:
                    row.append(part)
                    seen.add(part)
            if row:
                new_layout.append(row)
        if not new_layout:
            await update.message.reply_text("⚠️ Не распознал ни одного ключа. Попробуй ещё раз через /keyboard.")
            return
        data = load_all()
        entry = data.setdefault(str(user_id), {"commands": [], "settings": dict(DEFAULT_SETTINGS)})
        entry["settings"]["layout"] = new_layout
        save_all(data)
        await update.message.reply_text("✅ Клавиатура обновлена!",
                                        reply_markup=build_main_keyboard(user_id))
        return

    if context.user_data.get("awaiting_audelay"):
        context.user_data["awaiting_audelay"] = False
        lang = get_user_settings(update.effective_user.id)["lang"]
        digits = re.sub(r"[^0-9]", "", text)
        if not digits or int(digits) < 6:
            await update.message.reply_text(t(lang, "audelay_bad"))
            return
        val = min(3600, int(digits))
        set_user_setting(update.effective_user.id, "autoupdate_delay", val)
        await update.message.reply_text(t(lang, "audelay_set", val=val))
        return

    if context.user_data.get("awaiting_search"):
        context.user_data["awaiting_search"] = False
        return await do_search(update, context, text)

    if text == t(lang, "btn_add"):
        return await add_cmd_start(update, context)
    if text == t(lang, "btn_del"):
        return await delete_cmd_start(update, context)
    if text == t(lang, "btn_settings"):
        return await settings_start(update, context)
    if text == "🎯 /events1":
        return await events1(update, context)
    if text == "🚀 /events2":
        return await events2(update, context)
    if text == "⛏ /mines1":
        return await mines1(update, context)
    if text == "⛏ /mines2":
        return await mines2(update, context)
    if text == "⛏ /mines":
        return await mines(update, context)
    if text == "🛡 /help":
        return await help_cmd(update, context)
    if text == "📋 /changelog":
        return await changelog_cmd(update, context)

    cmds = get_user_cmds(user_id)
    matched = next((c for c in cmds if cmd_label(c) == text), None)
    if matched is None:
        return

    version = matched["version"]
    # поддержка старого формата (type) и нового (types)
    if matched.get("types"):
        type_nums = [ANARCHY_TYPES[tp] for tp in matched["types"] if tp in ANARCHY_TYPES]
    elif matched.get("type"):
        type_nums = [ANARCHY_TYPES[matched["type"]]] if matched["type"] in ANARCHY_TYPES else list(ANARCHY_TYPES.values())
    else:
        type_nums = list(ANARCHY_TYPES.values())

    evs = filter_events(version, type_nums)
    if matched.get("events"):
        wanted = {_norm_name(n) for n in matched["events"]}
        evs = [e for e in evs if _norm_name(e["name"]) in wanted]
    rarities = matched.get("rarities")
    if rarities:
        evs = [e for e in evs if e.get("rarity") in rarities]
    elif matched.get("rarity"):
        evs = [e for e in evs if e.get("rarity") == matched["rarity"]]
    evs = remove_hidden(evs, settings.get("hidden_events", []))
    evs = apply_status_filter(evs, settings.get("status_filter", "both"))
    evs = sort_events(evs, settings["sort"])

    types_label = "+".join(matched["types"]) if matched.get("types") else matched.get("type", "")
    idx = cmds.index(matched)
    await send_events_view(update, evs, version, settings, types_label, f"c:{idx}", context)

async def _run_cmd_index(update, context, idx):
    user_id = update.effective_user.id
    settings = get_user_settings(user_id)
    lang = settings["lang"]
    cmds = get_user_cmds(user_id)
    if idx < 0 or idx >= len(cmds):
        await update.message.reply_text(t(lang, "fast_none", n=idx + 1))
        return
    matched = cmds[idx]
    evs, version, types_label = _events_for_cmd(user_id, matched, settings)
    await send_events_view(update, evs, version, settings, types_label, f"c:{idx}", context)


async def keyboard_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    settings = get_user_settings(user_id)
    lang = settings["lang"]
    cmds = get_user_cmds(user_id)
    layout = get_user_layout(user_id)
    present = set(layout_keys_flat(layout))
    # текущая раскладка (по рядам)
    cur_lines = []
    for row in layout:
        labels = [_btn_label(k, lang, cmds) for k in row if _btn_label(k, lang, cmds)]
        cur_lines.append("  " + ", ".join(f"{k}" for k in row) + "   →  [" + " | ".join(labels) + "]")
    # все доступные ключи (включая скрытые)
    all_lines = []
    for key in default_layout(cmds):
        label = _btn_label(key, lang, cmds)
        if label:
            mark = "" if key in present else " (скрыто)"
            all_lines.append(f"  `{key}` — {label}{mark}")
    msg = (
        "*⌨️ Настройка клавиатуры*\n\n"
        "*Сейчас:*\n" + ("\n".join(cur_lines) or "  (пусто)") + "\n\n"
        "*Все доступные кнопки:*\n" + "\n".join(all_lines) + "\n\n"
        "Пришли ключи кнопок: *запятая* — кнопки в одном ряду, *точка с запятой* — новый ряд.\n"
        "Что не укажешь — будет *скрыто*.\n\n"
        "Пример (каждый ключ можно скопировать тапом сверху):\n"
        "`events1`, `events2` \\; `fast1`, `fast2`, `fast3` \\; `search`, `settings`\n"
        "Это даст: ряд1 = events1, events2; ряд2 = fast1, fast2, fast3; ряд3 = search, settings.\n\n"
        "Сброс к стандарту: напиши `reset`."
    )
    context.user_data["awaiting_layout"] = True
    await update.message.reply_text(msg, parse_mode="Markdown")


def _load_changelog():
    """Читает CHANGELOG.txt из репо. Формат блоков:
    ## YYYY-MM-DD | Заголовок
    • строка
    • строка
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "CHANGELOG.txt")
    entries = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
    except Exception:
        return entries
    cur = None
    for line in raw.splitlines():
        if line.startswith("## "):
            if cur:
                cur["body"] = cur["body"].strip("\n")
                entries.append(cur)
            header = line[3:].strip()
            if "|" in header:
                date, title = header.split("|", 1)
            else:
                date, title = header, ""
            cur = {"date": date.strip(), "title": title.strip(), "body": ""}
        elif cur is not None:
            cur["body"] += line + "\n"
    if cur:
        cur["body"] = cur["body"].strip("\n")
        entries.append(cur)
    return entries


CHANGELOG = _load_changelog()


def _changelog_page(idx: int):
    idx = max(0, min(idx, len(CHANGELOG) - 1))
    e = CHANGELOG[idx]
    text = f"📋 *Обновление от {e['date']}*\n*{e['title']}*\n\n{e['body']}\n\n_Страница {idx + 1}/{len(CHANGELOG)}_"
    btns = []
    if idx < len(CHANGELOG) - 1:
        btns.append(InlineKeyboardButton("⬅️ Старее", callback_data=f"chlog:{idx + 1}"))
    if idx > 0:
        btns.append(InlineKeyboardButton("Новее ➡️", callback_data=f"chlog:{idx - 1}"))
    kb = InlineKeyboardMarkup([btns]) if btns else None
    return text, kb


async def changelog_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text, kb = _changelog_page(0)
    await update.message.reply_text(text, parse_mode="Markdown", reply_markup=kb)


async def changelog_cb(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    idx = int(query.data.split(":", 1)[1])
    text, kb = _changelog_page(idx)
    await query.edit_message_text(text, parse_mode="Markdown", reply_markup=kb)


async def search_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    lang = get_user_settings(user_id)["lang"]
    query = " ".join(context.args).strip() if context.args else ""
    if not query:
        context.user_data["awaiting_search"] = True
        await update.message.reply_text(t(lang, "search_prompt"))
        return
    await do_search(update, context, query)


async def settings_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    return await settings_start(update, context)


async def newcommand_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    return await add_cmd_start(update, context)


async def delcommand_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    return await delete_cmd_start(update, context)


def _make_fast_cmd(n):
    async def _h(update: Update, context: ContextTypes.DEFAULT_TYPE):
        await _run_cmd_index(update, context, n - 1)
    return _h


# ==================== ВЕБ-АВТОРИЗАЦИЯ ====================

code_future = None
phone_code_hash = None


async def web_index(request):
    return web.Response(content_type="text/html", text="""
<html><head><meta charset="utf-8">
<style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e}
h2{color:#e0e0e0}input{font-size:24px;padding:12px;width:220px;border-radius:8px;border:none;margin-right:8px}
button{font-size:24px;padding:12px 24px;border-radius:8px;border:none;background:#7289da;color:white;cursor:pointer}</style>
</head><body>
<h2>👻 SpookyEvents — Введи код из Telegram</h2>
<form method="POST" action="/code">
    <input name="code" placeholder="12345" autofocus/>
    <button type="submit">Войти</button>
</form>
</body></html>
""")


async def web_submit_code(request):
    global code_future
    data = await request.post()
    code = data.get("code", "").strip()
    if code_future and not code_future.done():
        code_future.set_result(code)
        return web.Response(content_type="text/html", text="""
<html><head><meta charset="utf-8">
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e}
h2{color:#43b581}</style></head><body>
<h2>✅ Код принят! Бот запускается...</h2>
</body></html>
""")
    return web.Response(text="Ошибка: код уже был введён.")


async def run_web_server():
    app = web.Application()
    app.router.add_get("/", web_index)
    app.router.add_post("/code", web_submit_code)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()
    print(f"🌐 Веб-сервер запущен на порту {PORT} — открой домен Railway и введи код")

# ==================== ГЛАВНАЯ ФУНКЦИЯ ====================

async def main():
    missing = [n for n, v in [("BOT_TOKEN", BOT_TOKEN), ("API_ID", API_ID), ("API_HASH", API_HASH)] if not v]
    if missing:
        print(f"❌ Не заданы переменные окружения: {', '.join(missing)}. Добавь их в Railway → Variables.")
        return
    session_str = (SESSION_STRING or "").strip().strip('"').strip("'")
    if not session_str:
        print("❌ SESSION_STRING пуст. Добавь строку сессии в Railway → Variables.")
        return
    print(f"🔑 Длина SESSION_STRING: {len(session_str)} символов")
    try:
        user_client = TelegramClient(StringSession(session_str), API_ID, API_HASH)
    except Exception as e:
        print(f"❌ SESSION_STRING повреждён/обрезан ({e}). Сгенерируй строку заново и вставь ЦЕЛИКОМ одной строкой.")
        return

    await user_client.connect()
    if not await user_client.is_user_authorized():
        print("❌ Сессия не авторизована. Сгенерируй новую строку и обнови SESSION_STRING.")
        return
    _me = await user_client.get_me()
    print(f"✅ Userbot (Telethon) авторизован через SESSION_STRING как {_me.first_name}")

    async def fetch_last_response(markers: tuple, retries: int = 4, delay: float = 1.5):
        """Читает последнее сообщение от SPOOKY_BOT, пока в нём не появится нужный маркер."""
        for _ in range(retries):
            messages = await user_client.get_messages(SPOOKY_BOT, limit=1)
            if messages:
                msg = messages[0]
                if msg.text and any(m in msg.text for m in markers):
                    return msg.text
            await asyncio.sleep(delay)
        return None

    async def update_loop():
        while True:
            cycle_start = time.time()
            try:
                await user_client.send_message(SPOOKY_BOT, "/events")
                await asyncio.sleep(REQUEST_DELAY)
                text = await fetch_last_response(("Уровень лута", "До следующего"))
                if text:
                    parsed = parse_events(text)
                    events_data[VERSION_4DIGIT].clear()
                    events_data[VERSION_3DIGIT].clear()
                    for event in parsed:
                        v = get_version(event["anarchy_num"])
                        events_data[v].append(event)
                    events_data[VERSION_4DIGIT].sort(key=lambda x: x["anarchy_num"])
                    events_data[VERSION_3DIGIT].sort(key=lambda x: x["anarchy_num"])
                    LAST_UPDATE["ts"] = time.time()
                    print(f"🔄 Ивенты: {VERSION_4DIGIT} — {len(events_data[VERSION_4DIGIT])}, {VERSION_3DIGIT} — {len(events_data[VERSION_3DIGIT])}")

                # /mines — держим паузу не меньше ANTISPAM_MIN_INTERVAL с начала цикла,
                # чтобы не упереться в антиспам офф-бота (команда не чаще раза в 5 сек)
                gap = ANTISPAM_MIN_INTERVAL - (time.time() - cycle_start)
                if gap > 0:
                    await asyncio.sleep(gap)
                await user_client.send_message(SPOOKY_BOT, "/mines")
                await asyncio.sleep(REQUEST_DELAY)
                text = await fetch_last_response(("Обновится через", "авто-шахт"))
                if text:
                    parsed = parse_mines(text)
                    mines_data[VERSION_4DIGIT].clear()
                    mines_data[VERSION_3DIGIT].clear()
                    for mine in parsed:
                        v = get_version(mine["anarchy_num"])
                        mines_data[v].append(mine)
                    mines_data[VERSION_4DIGIT].sort(key=lambda x: x["anarchy_num"])
                    mines_data[VERSION_3DIGIT].sort(key=lambda x: x["anarchy_num"])
                    print(f"🔄 Шахты: {VERSION_4DIGIT} — {len(mines_data[VERSION_4DIGIT])}, {VERSION_3DIGIT} — {len(mines_data[VERSION_3DIGIT])}")
                dump_events_cache()
            except Exception as e:
                print(f"❌ Ошибка опроса: {e}")
                traceback.print_exc()
            elapsed = time.time() - cycle_start
            await asyncio.sleep(max(0.5, EFFECTIVE_INTERVAL - elapsed))

    asyncio.create_task(update_loop())

    bot_app = Application.builder().token(BOT_TOKEN).build()

    # group=-1 — выполняется раньше всех остальных хендлеров (они в group=0).
    # Если доступа нет, access_gate сам ответит пользователю и остановит
    # обработку апдейта (ApplicationHandlerStop) — ни start, ни events,
    # ни любой другой хендлер ниже не вызовется.
    bot_app.add_handler(TypeHandler(Update, access_gate), group=-1)

    bot_app.add_handler(CommandHandler("start", start))
    bot_app.add_handler(CommandHandler("help", help_cmd))
    bot_app.add_handler(CommandHandler("search", search_cmd))
    bot_app.add_handler(CommandHandler("keyboard", keyboard_cmd))
    bot_app.add_handler(CommandHandler("changelog", changelog_cmd))
    bot_app.add_handler(CallbackQueryHandler(changelog_cb, pattern=r"^chlog:"))
    bot_app.add_handler(CommandHandler("settings", settings_cmd))
    bot_app.add_handler(CommandHandler("newcommand", newcommand_cmd))
    bot_app.add_handler(CommandHandler("delcommand", delcommand_cmd))
    for _i in range(1, 6):
        bot_app.add_handler(CommandHandler(f"fastcommand{_i}", _make_fast_cmd(_i)))
    bot_app.add_handler(CommandHandler("events1", events1))
    bot_app.add_handler(CommandHandler("events2", events2))
    bot_app.add_handler(CommandHandler("mines", mines))
    bot_app.add_handler(CommandHandler("mines1", mines1))
    bot_app.add_handler(CommandHandler("mines2", mines2))

    # Все локализованные варианты кнопок "Добавить команду"
    add_btn_pattern = "^(" + "|".join(re.escape(TR[l]["btn_add"]) for l in LANGUAGES) + ")$"
    conv_handler = ConversationHandler(
        entry_points=[MessageHandler(filters.Regex(add_btn_pattern), add_cmd_start)],
        states={
            CHOOSE_VERSION: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_cmd_version)],
            CHOOSE_TYPE: [CallbackQueryHandler(choose_anarchy_type_cb, pattern=r"^atype:")],
            CHOOSE_EVENTS: [CallbackQueryHandler(choose_events_cb, pattern=r"^ev:")],
            CHOOSE_RARITY: [CallbackQueryHandler(choose_rarity_cb, pattern=r"^rar:")],
            CHOOSE_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, receive_cmd_name)],
            CHOOSE_EMOJI: [CallbackQueryHandler(receive_cmd_emoji, pattern=r"^cmdemoji:")],
            CHOOSE_COLOR: [CallbackQueryHandler(receive_cmd_color, pattern=r"^cmdcolor:")],
        },
        fallbacks=[
            MessageHandler(filters.TEXT & ~filters.COMMAND, cancel),
            CommandHandler("start", start),
        ],
    )
    bot_app.add_handler(conv_handler)

    bot_app.add_handler(CallbackQueryHandler(delete_cmd_cb, pattern=r"^delcmd:"))
    bot_app.add_handler(CallbackQueryHandler(settings_cb, pattern=r"^set"))
    bot_app.add_handler(CallbackQueryHandler(settings_cb, pattern=r"^hideev:"))
    bot_app.add_handler(CommandHandler("allow", allow_cmd))
    bot_app.add_handler(CallbackQueryHandler(refresh_cb, pattern=r"^refresh:"))
    bot_app.add_handler(CallbackQueryHandler(austop_cb, pattern=r"^austop:"))

    bot_app.add_handler(MessageHandler(
        filters.TEXT & ~filters.COMMAND,
        handle_custom_cmd
    ))

    print("🤖 Telegram-бот запущен")
    await bot_app.initialize()
    await bot_app.start()
    try:
        await bot_app.bot.set_my_commands([
            BotCommand("events1", "Ивенты 1.16.5"),
            BotCommand("events2", "Ивенты 1.21"),
            BotCommand("mines", "Авто-шахты (все анархии)"),
            BotCommand("mines1", "Авто-шахты 1.16.5"),
            BotCommand("mines2", "Авто-шахты 1.21"),
            BotCommand("search", "Поиск ивента"),
            BotCommand("newcommand", "Создать быструю команду"),
            BotCommand("delcommand", "Удалить быструю команду"),
            BotCommand("fastcommand1", "Быстрая команда №1"),
            BotCommand("fastcommand2", "Быстрая команда №2"),
            BotCommand("fastcommand3", "Быстрая команда №3"),
            BotCommand("fastcommand4", "Быстрая команда №4"),
            BotCommand("fastcommand5", "Быстрая команда №5"),
            BotCommand("keyboard", "Настроить клавиатуру"),
            BotCommand("changelog", "Список обновлений"),
            BotCommand("settings", "Настройки"),
            BotCommand("help", "Справка"),
        ])
    except Exception as _e:
        print(f"⚠️ set_my_commands: {_e}")
    await bot_app.updater.start_polling()
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
