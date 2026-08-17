import os
import re
import json
import time

import discord
from discord import app_commands

# ==================== КОНФИГ ====================
DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN", "")
DEV_GUILD_ID = os.environ.get("DISCORD_GUILD_ID", "").strip()
DATA_DIR = os.environ.get("DATA_DIR", ".")
EVENTS_CACHE_FILE = os.path.join(DATA_DIR, "events_cache.json")
DC_SETTINGS_FILE = os.path.join(DATA_DIR, "discord_settings.json")
DC_COMMANDS_FILE = os.path.join(DATA_DIR, "discord_commands.json")

# трёхзначные анархии (1xx-6xx) -> 1.21 ; четырёхзначные (1xxx-6xxx) -> 1.16.5
VERSION_3DIGIT = "1.21"
VERSION_4DIGIT = "1.16.5"

ANARCHY_TYPES = {"Соло": 1, "Дуо": 2, "Трио": 3, "Квадро": 4, "Пента": 5, "Клан": 6}
RARITIES = ["Легендарный", "Элитный", "Богатый", "Солидный", "Обычный"]
RARITY_ORDER = {name: i for i, name in enumerate(RARITIES)}
MAX_CUSTOM_COMMANDS = 10

DEFAULT_SETTINGS = {"sort": "anarchy", "status_filter": "both", "compact": False, "allowed_roles": []}

# ==================== ХРАНИЛИЩЕ ====================
def _scope_id(interaction: discord.Interaction) -> str:
    if interaction.guild_id:
        return f"g{interaction.guild_id}"
    return f"u{interaction.user.id}"


def _load(path):
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def _save(path, data):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:
        pass


def get_settings(interaction) -> dict:
    data = _load(DC_SETTINGS_FILE)
    s = dict(DEFAULT_SETTINGS)
    s.update(data.get(_scope_id(interaction), {}))
    return s


def set_settings(interaction, **kwargs):
    data = _load(DC_SETTINGS_FILE)
    key = _scope_id(interaction)
    cur = dict(DEFAULT_SETTINGS)
    cur.update(data.get(key, {}))
    cur.update(kwargs)
    data[key] = cur
    _save(DC_SETTINGS_FILE, data)
    return cur


def _cmd_scope(interaction) -> str:
    # быстрые команды всегда персональные (по пользователю), и в ЛС, и на сервере
    return f"u{interaction.user.id}"


def get_commands(interaction) -> list:
    data = _load(DC_COMMANDS_FILE)
    return data.get(_cmd_scope(interaction), [])


def save_commands(interaction, cmds):
    data = _load(DC_COMMANDS_FILE)
    data[_cmd_scope(interaction)] = cmds
    _save(DC_COMMANDS_FILE, data)


# ==================== ДОСТУП ПО РОЛЯМ ====================
def is_admin(interaction: discord.Interaction) -> bool:
    if not interaction.guild_id:
        return True
    perms = getattr(interaction.user, "guild_permissions", None)
    return bool(perms and (perms.administrator or perms.manage_guild))


def has_access(interaction: discord.Interaction) -> bool:
    # в ЛС — всегда; на сервере — админ всегда, иначе нужна разрешённая роль
    if not interaction.guild_id:
        return True
    if is_admin(interaction):
        return True
    allowed = set(get_settings(interaction).get("allowed_roles", []))
    if not allowed:
        return True  # роли не настроены -> доступ всем
    user_roles = {str(r.id) for r in getattr(interaction.user, "roles", [])}
    return bool(user_roles & allowed)


async def deny(interaction: discord.Interaction):
    await interaction.response.send_message(
        "🚫 У вас нет доступа к этому боту на сервере. Обратитесь к администратору.",
        ephemeral=True)


# ==================== ЧТЕНИЕ КЭША ====================
def read_events():
    data = _load(EVENTS_CACHE_FILE)
    return data.get("events", {VERSION_3DIGIT: [], VERSION_4DIGIT: []}), data.get("updated", 0)


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


def _live_timer(e):
    base = e.get("timer_sec")
    if base is not None and e.get("fetched_at"):
        rem = base - (time.time() - e["fetched_at"])
        label = e.get("timer_label") or ""
        return (label + " " if label else "") + _format_duration(rem)
    return e.get("time_str") or ""


def _live_next_in(e):
    base = e.get("next_in_sec")
    if base is not None and e.get("fetched_at"):
        return _format_duration(base - (time.time() - e["fetched_at"]))
    return str(e.get("next_in") or "?")


def _norm_name(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def get_version(num) -> str:
    return VERSION_4DIGIT if len(str(num)) == 4 else VERSION_3DIGIT


def filter_by_type(version, evs, type_nums):
    if not type_nums:
        return evs
    result = []
    for e in evs:
        num = e["anarchy_num"]
        prefix = num // 1000 if version == VERSION_4DIGIT else num // 100
        if prefix in type_nums:
            result.append(e)
    return result


def apply_status_filter(evs, mode):
    if mode == "active":
        return [e for e in evs if not e.get("upcoming")]
    if mode == "upcoming":
        return [e for e in evs if e.get("upcoming")]
    return evs


def sort_events(evs, sort_mode):
    if sort_mode == "rarity":
        return sorted(evs, key=lambda e: (1 if e.get("upcoming") else 0,
                                          RARITY_ORDER.get(e.get("rarity"), 9),
                                          e["anarchy_num"]))
    return sorted(evs, key=lambda e: (1 if e.get("upcoming") else 0, e["anarchy_num"]))


def format_one(e, compact=False, version_tag=None):
    head = f"[{version_tag}] " if version_tag else ""
    if e.get("upcoming"):
        return f"{head}**Анархия {e['anarchy_num']}:** ⏳ ивент через {_live_next_in(e)}\n"
    out = f"{head}**Анархия {e['anarchy_num']}:**\n{e.get('raw_first_line','')}\n"
    if not compact:
        if e.get("loot_level"):
            out += f"Уровень лута: {e['loot_level']}\n"
        if e.get("status"):
            out += f"Статус: {e['status']}"
            tm = _live_timer(e)
            if tm:
                out += f", {tm}"
            out += "\n"
    if e.get("location"):
        loc = re.sub(r"\s+", " ", str(e["location"])).strip()
        if ":" in loc:
            lab, val = loc.split(":", 1)
            out += f"{lab.strip()}: `{val.strip()}`\n"
        else:
            out += f"`{loc}`\n"
    return out + "\n"


def _trim(text):
    return text[:1990] + ("…" if len(text) > 1990 else "")


def build_events_text(version, interaction):
    settings = get_settings(interaction)
    events, _ = read_events()
    evs = list(events.get(version, []))
    evs = apply_status_filter(evs, settings["status_filter"])
    evs = sort_events(evs, settings["sort"])
    if not evs:
        return f"📭 Нет событий для {version}."
    body = "".join(format_one(e, settings.get("compact", False)) for e in evs)
    return _trim(f"🎯 **События {version}**\n\n" + body)


def search_text(query, interaction):
    settings = get_settings(interaction)
    events, _ = read_events()
    ql = _norm_name(query)
    if not ql:
        return "⚠️ Укажи название для поиска."
    lines = []
    for version in (VERSION_4DIGIT, VERSION_3DIGIT):
        for e in events.get(version, []):
            if ql in _norm_name(e.get("name")):
                lines.append(format_one(e, settings.get("compact", False), version))
    if not lines:
        return f"🔍 По запросу «{query}» ничего не найдено."
    return _trim(f"🔍 **Результаты по «{query}»**\n\n" + "".join(lines))


def run_custom_cmd(cmd, interaction):
    settings = get_settings(interaction)
    events, _ = read_events()
    version = cmd.get("version")
    evs = list(events.get(version, []))
    type_nums = None
    types = cmd.get("types") or ([cmd["type"]] if cmd.get("type") else None)
    if types:
        type_nums = [ANARCHY_TYPES[t] for t in types if t in ANARCHY_TYPES]
    evs = filter_by_type(version, evs, type_nums)
    events_names = cmd.get("events")
    if events_names:
        wanted = {_norm_name(n) for n in events_names}
        evs = [e for e in evs if _norm_name(e["name"]) in wanted]
    rarities = cmd.get("rarities") or ([cmd["rarity"]] if cmd.get("rarity") else None)
    if rarities:
        evs = [e for e in evs if e.get("rarity") in rarities]
    evs = apply_status_filter(evs, settings["status_filter"])
    evs = sort_events(evs, settings["sort"])
    label = cmd_label(cmd)
    if not evs:
        return f"📭 {label}: нет подходящих событий."
    body = "".join(format_one(e, settings.get("compact", False)) for e in evs)
    return _trim(f"**{label}**\n\n" + body)


def cmd_label(cmd):
    if cmd.get("name"):
        emoji = cmd.get("emoji")
        return f"{emoji} {cmd['name']}" if emoji else cmd["name"]
    version = cmd.get("version", "")
    types = cmd.get("types") or cmd.get("type")
    if isinstance(types, list):
        type_str = "+".join(types) if types else "Все"
    else:
        type_str = types or "Все"
    rar = cmd.get("rarities")
    rar_str = ("+".join(rar) if rar else "") or (cmd.get("rarity") or "")
    parts = [version, type_str]
    if rar_str:
        parts.append(rar_str)
    return " · ".join(p for p in parts if p)


# ==================== CHANGELOG ====================
def load_changelog():
    """Читает общий CHANGELOG.txt (тот же, что у Telegram-бота)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "CHANGELOG.txt")
    entries = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except Exception:
        return entries
    cur = None
    for line in raw.splitlines():
        if line.startswith("## "):
            if cur:
                cur["body"] = cur["body"].strip("\n")
                entries.append(cur)
            header = line[3:].strip()
            date, title = (header.split("|", 1) + [""])[:2] if "|" in header else (header, "")
            cur = {"date": date.strip(), "title": title.strip(), "body": ""}
        elif cur is not None:
            cur["body"] += line + "\n"
    if cur:
        cur["body"] = cur["body"].strip("\n")
        entries.append(cur)
    return entries


def changelog_page(entries, idx):
    idx = max(0, min(idx, len(entries) - 1))
    e = entries[idx]
    text = (f"📋 **Обновления** ({idx + 1}/{len(entries)})\n\n"
            f"**{e['date']} — {e['title']}**\n{e['body']}")
    return text, idx


class ChangelogView(discord.ui.View):
    def __init__(self, entries, idx=0):
        super().__init__(timeout=300)
        self.entries = entries
        self.idx = idx
        self._refresh()

    def _refresh(self):
        self.prev_btn.disabled = self.idx <= 0
        self.next_btn.disabled = self.idx >= len(self.entries) - 1

    @discord.ui.button(label="◀️ Новее", style=discord.ButtonStyle.secondary)
    async def prev_btn(self, interaction, button):
        self.idx = max(0, self.idx - 1)
        text, self.idx = changelog_page(self.entries, self.idx)
        self._refresh()
        await interaction.response.edit_message(content=text, view=self)

    @discord.ui.button(label="Старее ▶️", style=discord.ButtonStyle.secondary)
    async def next_btn(self, interaction, button):
        self.idx = min(len(self.entries) - 1, self.idx + 1)
        text, self.idx = changelog_page(self.entries, self.idx)
        self._refresh()
        await interaction.response.edit_message(content=text, view=self)


# ==================== UI: СОЗДАНИЕ КОМАНДЫ ====================
class NameModal(discord.ui.Modal, title="Название команды"):
    name = discord.ui.TextInput(label="Имя (необязательно)", required=False, max_length=40)

    def __init__(self, view):
        super().__init__()
        self.view_ref = view

    async def on_submit(self, interaction: discord.Interaction):
        self.view_ref.state["name"] = str(self.name.value).strip() or None
        await self.view_ref.finish(interaction)


class NewCommandView(discord.ui.View):
    def __init__(self, interaction):
        super().__init__(timeout=300)
        self.author_id = interaction.user.id
        self.state = {"version": None, "types": [], "rarities": [], "name": None}
        self.add_item(self.VersionSelect(self))

    async def interaction_check(self, interaction):
        return interaction.user.id == self.author_id

    class VersionSelect(discord.ui.Select):
        def __init__(self, view):
            self.view_ref = view
            super().__init__(placeholder="1) Версия", options=[
                discord.SelectOption(label="1.16.5", value=VERSION_4DIGIT),
                discord.SelectOption(label="1.21", value=VERSION_3DIGIT),
            ])

        async def callback(self, interaction):
            self.view_ref.state["version"] = self.values[0]
            self.disabled = True
            self.view_ref.add_item(self.view_ref.TypeSelect(self.view_ref))
            await interaction.response.edit_message(content="Выбери тип анархий (можно несколько, или пропусти):", view=self.view_ref)

    class TypeSelect(discord.ui.Select):
        def __init__(self, view):
            self.view_ref = view
            opts = [discord.SelectOption(label=k, value=k) for k in ANARCHY_TYPES]
            super().__init__(placeholder="2) Типы анархий (опц.)", min_values=0, max_values=len(opts), options=opts)

        async def callback(self, interaction):
            self.view_ref.state["types"] = list(self.values)
            self.disabled = True
            self.view_ref.add_item(self.view_ref.RaritySelect(self.view_ref))
            await interaction.response.edit_message(content="Выбери редкость (можно несколько, или пропусти):", view=self.view_ref)

    class RaritySelect(discord.ui.Select):
        def __init__(self, view):
            self.view_ref = view
            opts = [discord.SelectOption(label=r, value=r) for r in RARITIES]
            super().__init__(placeholder="3) Редкость (опц.)", min_values=0, max_values=len(opts), options=opts)

        async def callback(self, interaction):
            self.view_ref.state["rarities"] = list(self.values)
            self.disabled = True
            self.view_ref.add_item(self.view_ref.NameButton(self.view_ref))
            self.view_ref.add_item(self.view_ref.SkipButton(self.view_ref))
            await interaction.response.edit_message(content="Задать имя команде или сохранить без имени?", view=self.view_ref)

    class NameButton(discord.ui.Button):
        def __init__(self, view):
            self.view_ref = view
            super().__init__(label="✏️ Задать имя", style=discord.ButtonStyle.primary)

        async def callback(self, interaction):
            await interaction.response.send_modal(NameModal(self.view_ref))

    class SkipButton(discord.ui.Button):
        def __init__(self, view):
            self.view_ref = view
            super().__init__(label="💾 Сохранить", style=discord.ButtonStyle.success)

        async def callback(self, interaction):
            await self.view_ref.finish(interaction)

    async def finish(self, interaction):
        cmds = get_commands(interaction)
        if len(cmds) >= MAX_CUSTOM_COMMANDS:
            await interaction.response.edit_message(content=f"⚠️ Достигнут лимит команд ({MAX_CUSTOM_COMMANDS}).", view=None)
            return
        new = {
            "version": self.state["version"],
            "types": sorted(self.state["types"]) or None,
            "events": None,
            "rarities": sorted(self.state["rarities"]) or None,
            "name": self.state["name"],
        }
        # защита от дублей
        for c in cmds:
            if (c.get("version") == new["version"] and (c.get("types") or None) == new["types"]
                    and (c.get("rarities") or None) == new["rarities"] and c.get("name") == new["name"]):
                msg = "⚠️ Такая команда уже есть."
                if interaction.response.is_done():
                    await interaction.edit_original_response(content=msg, view=None)
                else:
                    await interaction.response.edit_message(content=msg, view=None)
                return
        cmds.append(new)
        save_commands(interaction, cmds)
        msg = f"✅ Команда создана: **{cmd_label(new)}**\nЗапуск: /commands"
        if interaction.response.is_done():
            await interaction.edit_original_response(content=msg, view=None)
        else:
            await interaction.response.edit_message(content=msg, view=None)


# ==================== UI: УДАЛЕНИЕ ====================
class DeleteView(discord.ui.View):
    def __init__(self, interaction):
        super().__init__(timeout=300)
        self.author_id = interaction.user.id
        cmds = get_commands(interaction)
        opts = [discord.SelectOption(label=cmd_label(c)[:100], value=str(i)) for i, c in enumerate(cmds)]
        self.select = discord.ui.Select(placeholder="Выбери команды для удаления", min_values=1, max_values=len(opts), options=opts)
        self.select.callback = self.on_select
        self.add_item(self.select)

    async def interaction_check(self, interaction):
        return interaction.user.id == self.author_id

    async def on_select(self, interaction):
        idxs = sorted((int(v) for v in self.select.values), reverse=True)
        cmds = get_commands(interaction)
        removed = 0
        for i in idxs:
            if 0 <= i < len(cmds):
                cmds.pop(i)
                removed += 1
        save_commands(interaction, cmds)
        await interaction.response.edit_message(content=f"🗑 Удалено команд: {removed}", view=None)


# ==================== UI: ЗАПУСК ====================
class RunView(discord.ui.View):
    def __init__(self, interaction):
        super().__init__(timeout=300)
        cmds = get_commands(interaction)
        opts = [discord.SelectOption(label=cmd_label(c)[:100], value=str(i)) for i, c in enumerate(cmds)]
        self.select = discord.ui.Select(placeholder="Выбери команду", options=opts)
        self.select.callback = self.on_select
        self.add_item(self.select)

    async def on_select(self, interaction):
        cmds = get_commands(interaction)
        i = int(self.select.values[0])
        if 0 <= i < len(cmds):
            await interaction.response.send_message(run_custom_cmd(cmds[i], interaction), ephemeral=True)
        else:
            await interaction.response.send_message("⚠️ Команда не найдена.", ephemeral=True)


# ==================== DISCORD CLIENT ====================
intents = discord.Intents.default()
client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)


@client.event
async def on_ready():
    print(f"✅ Discord-бот запущен как {client.user} (id={client.user.id})")
    # Глобальная синхронизация — нужна для ЛС (появляется в течение ~1 ч)
    try:
        g = await tree.sync()
        print(f"🌍 Глобально синхронизировано {len(g)} команд (для ЛС, ~1 ч на распространение)")
    except Exception as e:
        print(f"⚠️ Ошибка глобальной синхронизации: {e}")
    # Синхронизация на сервер — появляется мгновенно (только для этого сервера)
    if DEV_GUILD_ID and DEV_GUILD_ID.isdigit():
        try:
            guild = discord.Object(id=int(DEV_GUILD_ID))
            tree.copy_global_to(guild=guild)
            s = await tree.sync(guild=guild)
            print(f"⚡ На сервере {DEV_GUILD_ID} синхронизировано {len(s)} команд (мгновенно)")
        except Exception as e:
            print(f"⚠️ Ошибка серверной синхронизации: {e}")
    else:
        print("💡 Задай DISCORD_GUILD_ID, чтобы команды на сервере появились сразу (не ждать час).")


@tree.command(name="events1", description="События 1.16.5")
async def events1(interaction: discord.Interaction):
    if not has_access(interaction):
        return await deny(interaction)
    await interaction.response.send_message(build_events_text(VERSION_4DIGIT, interaction), ephemeral=True)


@tree.command(name="events2", description="События 1.21")
async def events2(interaction: discord.Interaction):
    if not has_access(interaction):
        return await deny(interaction)
    await interaction.response.send_message(build_events_text(VERSION_3DIGIT, interaction), ephemeral=True)


@tree.command(name="search", description="Поиск события по названию")
@app_commands.describe(query="Название события")
async def search(interaction: discord.Interaction, query: str):
    if not has_access(interaction):
        return await deny(interaction)
    await interaction.response.send_message(search_text(query, interaction), ephemeral=True)


@tree.command(name="newcommand", description="Создать быструю команду")
async def newcommand(interaction: discord.Interaction):
    if not has_access(interaction):
        return await deny(interaction)
    await interaction.response.send_message("Выбери версию:", view=NewCommandView(interaction), ephemeral=True)


@tree.command(name="delcommand", description="Удалить быстрые команды")
async def delcommand(interaction: discord.Interaction):
    if not has_access(interaction):
        return await deny(interaction)
    if not get_commands(interaction):
        return await interaction.response.send_message("📭 Нет сохранённых команд.", ephemeral=True)
    await interaction.response.send_message("Выбери команды для удаления:", view=DeleteView(interaction), ephemeral=True)


@tree.command(name="commands", description="Запустить быструю команду")
async def commands_cmd(interaction: discord.Interaction):
    if not has_access(interaction):
        return await deny(interaction)
    if not get_commands(interaction):
        return await interaction.response.send_message("📭 Нет сохранённых команд. Создай через /newcommand.", ephemeral=True)
    await interaction.response.send_message("Выбери команду:", view=RunView(interaction), ephemeral=True)


@tree.command(name="settings", description="Настройки отображения")
@app_commands.describe(sort="Сортировка", status="Фильтр статуса", compact="Компактный режим")
@app_commands.choices(
    sort=[app_commands.Choice(name="По анархии", value="anarchy"),
          app_commands.Choice(name="По редкости", value="rarity")],
    status=[app_commands.Choice(name="Активные", value="active"),
            app_commands.Choice(name="Скорые", value="upcoming"),
            app_commands.Choice(name="Все", value="both")],
)
async def settings_cmd(interaction: discord.Interaction,
                       sort: app_commands.Choice[str] = None,
                       status: app_commands.Choice[str] = None,
                       compact: bool = None):
    if not has_access(interaction):
        return await deny(interaction)
    changes = {}
    if sort is not None:
        changes["sort"] = sort.value
    if status is not None:
        changes["status_filter"] = status.value
    if compact is not None:
        changes["compact"] = compact
    cur = set_settings(interaction, **changes) if changes else get_settings(interaction)
    scope = "сервера" if interaction.guild_id else "ваши"
    head = f"✅ Настройки {scope} обновлены:" if changes else f"⚙️ Текущие настройки ({scope}):"
    await interaction.response.send_message(
        f"{head}\n• Сортировка: {cur['sort']}\n• Фильтр: {cur['status_filter']}\n• Компактно: {cur['compact']}",
        ephemeral=True)


@tree.command(name="setroles", description="[Админ] Роли с доступом к боту")
@app_commands.describe(role="Добавить/убрать роль из списка доступа (пусто — показать список)")
async def setroles(interaction: discord.Interaction, role: discord.Role = None):
    if not interaction.guild_id:
        return await interaction.response.send_message("Эта команда только для серверов.", ephemeral=True)
    if not is_admin(interaction):
        return await interaction.response.send_message("🚫 Только админ может настраивать доступ.", ephemeral=True)
    settings = get_settings(interaction)
    allowed = list(settings.get("allowed_roles", []))
    if role is None:
        if not allowed:
            txt = "Доступ открыт всем (роли не заданы). Укажи роль в /setroles, чтобы ограничить."
        else:
            names = []
            for rid in allowed:
                r = interaction.guild.get_role(int(rid))
                names.append(r.name if r else rid)
            txt = "Доступ разрешён ролям: " + ", ".join(names)
        return await interaction.response.send_message(txt, ephemeral=True)
    rid = str(role.id)
    if rid in allowed:
        allowed.remove(rid)
        action = f"❌ Роль **{role.name}** убрана из доступа."
    else:
        allowed.append(rid)
        action = f"✅ Роль **{role.name}** добавлена в доступ."
    set_settings(interaction, allowed_roles=allowed)
    note = "\n(Если список пуст — доступ снова открыт всем.)" if not allowed else ""
    await interaction.response.send_message(action + note, ephemeral=True)


@tree.command(name="help", description="Помощь по боту")
async def help_cmd(interaction: discord.Interaction):
    txt = (
        "🛡 **Spooky Events — Discord**\n\n"
        "**Команды:**\n"
        "• /events1 — события 1.16.5\n"
        "• /events2 — события 1.21\n"
        "• /search <название> — поиск события\n"
        "• /newcommand — создать быструю команду (версия/тип/редкость/имя)\n"
        "• /delcommand — удалить быстрые команды\n"
        "• /commands — запустить быструю команду\n"
        "• /settings — сортировка, фильтр статуса, компактный режим\n"
        "• /setroles — [админ] ограничить доступ ролями\n"
        "• /changelog — список обновлений\n"
        "• /help — эта справка\n\n"
        "Работает в личных сообщениях и на серверах.\n"
        "На сервере настройки и команды общие для всех участников.\n"
        "Доступ можно ограничить ролями через /setroles (по умолчанию открыт всем)."
    )
    await interaction.response.send_message(txt, ephemeral=True)


@tree.command(name="changelog", description="Список обновлений бота")
async def changelog_cmd(interaction: discord.Interaction):
    entries = load_changelog()
    if not entries:
        return await interaction.response.send_message("📭 Список обновлений пуст.", ephemeral=True)
    text, idx = changelog_page(entries, 0)
    view = ChangelogView(entries, idx) if len(entries) > 1 else None
    await interaction.response.send_message(text, view=view, ephemeral=True)


def main():
    if not DISCORD_TOKEN:
        print("❌ DISCORD_TOKEN не задан. Добавь его в Railway → Variables.")
        return
    client.run(DISCORD_TOKEN)


if __name__ == "__main__":
    main()