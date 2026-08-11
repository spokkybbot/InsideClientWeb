# Inside Client — HWID Verify API

Документация по эндпоинту `/api/verify` для Minecraft Fabric клиента.

---

## Как это работает

```
Minecraft-клиент          ──POST /api/verify──►   Сервер (Node.js + SQLite)
  hwid = SHA256(CPU+MAC+…)                             │
  ip   = внешний IP                                    ▼
                                               Поиск HWID в users.hwid
                                                    │
                           ◄── { status: "access",  ├── найден, подписка активна
                                  uid, username }    │
                           ◄── { status: "reject",  └── не найден / истёк / бан
                                  message }
```

---

## API Reference

### POST /api/verify

**Запрос:**
```http
POST /api/verify
Content-Type: application/json

{
  "hwid": "a1b2c3...64символа",   // SHA-256 хеш аппаратного ID
  "ip":   "1.2.3.4"              // внешний IP (опционально, для логов)
}
```

**Ответ — доступ открыт (200):**
```json
{
  "status": "access",
  "uid": "42",
  "username": "Игрок"
}
```

**Ответ — отказ (200):**
```json
{
  "status": "reject",
  "message": "Лицензия не найдена или истекла"
}
```

**Ответ — rate limit (429):**
```json
{
  "status": "reject",
  "message": "Слишком много запросов. Подождите минуту."
}
```

---

## Логика проверки

1. Валидация формата HWID (SHA-256 = 64 hex-символа)
2. Rate limit: ≤10 запросов / мин с одного IP, ≤5 разных HWID с IP
3. Поиск `users WHERE hwid = ?`
4. Проверка `banned`
5. Проверка наличия активной подписки (`subscription_until`) ИЛИ покупки клиента (`purchases`)
6. Логирование в таблицу `verify_log`

---

## Привязка HWID к аккаунту

### Вариант 1 — через сайт (пользователь сам привязывает)

Клиент при первом запуске отправляет HWID на `/api/verify`.
Если HWID не найден — пользователь заходит на сайт и привязывает HWID вручную.

> Текущий сервер хранит HWID в поле `users.hwid`. Чтобы добавить
> эндпоинт для самостоятельной привязки, добавьте `POST /api/hwid/bind`
> аналогично `/api/hwid/reset` (только записывает, а не очищает).

### Вариант 2 — через админ-панель

Откройте `/adminpanel.html` → секция **«Управление HWID»**:
- Найдите пользователя (поиск по логину / UID)
- Нажмите ✏️ **Изменить** → введите SHA-256 HWID → **Сохранить**

---

## База данных

### Таблица `users` (нужные поля)
| Поле | Тип | Описание |
|---|---|---|
| `id` | INTEGER | UID пользователя |
| `login` | TEXT | никнейм |
| `hwid` | TEXT | SHA-256 хеш, nullable |
| `banned` | INTEGER | 0/1 |
| `subscription_until` | TEXT | ISO-дата окончания подписки |

### Таблица `verify_log` (новая)
| Поле | Тип | Описание |
|---|---|---|
| `hwid` | TEXT | HWID из запроса |
| `client_ip` | TEXT | IP из тела запроса |
| `server_ip` | TEXT | реальный IP запроса |
| `result` | TEXT | `access` / `reject` / `rate_limited` / … |
| `user_id` | INTEGER | ID пользователя если найден |
| `created_at` | TEXT | ISO timestamp |

---

## Безопасность

| Мера | Реализация |
|---|---|
| Rate limiting | In-memory: 10 req/min с IP, 5 HWID/min с IP |
| Валидация HWID | Regex `/^[0-9a-fA-F]{64}$/` |
| Логирование | Все попытки в `verify_log` |
| CORS | `Access-Control-Allow-Origin: *` на `/api/verify` |
| HWID хранится уже захешированным | SHA-256 на стороне клиента |

---

## Деплой на Railway

### Переменные окружения (Railway Variables)

| Переменная | Описание |
|---|---|
| `ADMIN_LOGINS` | Comma-separated логины с правами админа, напр. `owner,alice` |
| `PORT` | Проставляется Railway автоматически |
| `TELEGRAM_BOT_USERNAME` | username Telegram-бота (если используется) |
| `SPOOKY_INTERNAL_SECRET` | Секрет для Spooky Events интеграции |

### Шаги деплоя

1. Залейте проект в GitHub-репозиторий
2. В Railway: **New Project → Deploy from GitHub → выберите репо**
3. Railway автоматически найдёт `railway.json` и запустит `sh start.sh`
4. В Variables добавьте `ADMIN_LOGINS=ваш_логин`
5. Зайдите на сайт → зарегистрируйтесь с логином из `ADMIN_LOGINS` → вы получите права Админ

### Важно: SQLite и Railway Volumes

SQLite хранится в `./data/inside-client.sqlite`. На Railway **файловая система эфемерна** — при рестарте данные сотрутся.

**Решение:** подключите Railway Volume:
1. Railway → ваш сервис → **Volumes → Attach Volume**
2. Mount Path: `/app/data`
3. Перезапустите сервис

После этого `./data/` будет персистентным.

---

## Пример кода клиента (Java/Fabric)

```java
// Генерация HWID
String hwid = sha256(
    System.getProperty("user.name") +
    getNetworkMac() +
    getCpuSerial()
);

// Запрос к серверу
HttpClient client = HttpClient.newHttpClient();
String body = """
    {"hwid": "%s", "ip": ""}
""".formatted(hwid);

HttpRequest req = HttpRequest.newBuilder()
    .uri(URI.create("https://insideclientweb-production.up.railway.app/api/verify"))
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(body))
    .build();

HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
JsonObject json = JsonParser.parseString(resp.body()).getAsJsonObject();

if ("access".equals(json.get("status").getAsString())) {
    String uid      = json.get("uid").getAsString();
    String username = json.get("username").getAsString();
    // Клиент авторизован!
} else {
    String message = json.get("message").getAsString();
    // Показываем сообщение об ошибке
}
```

---

## Новые API-эндпоинты (только для администраторов)

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/api/admin/users` | Список всех пользователей |
| `POST` | `/api/admin/hwid/set` | Установить HWID пользователю |
| `DELETE` | `/api/admin/hwid/clear` | Сбросить HWID |
| `GET` | `/api/admin/verify-log` | Лог верификаций |

Все требуют сессионную куку администратора (`ic_sid`).
