#!/bin/sh
# Единая точка входа для Railway: поднимает сайт (server/server.js) и,
# если задан TELEGRAM_BOT_TOKEN, вторым процессом — Telegram-бота
# (server/bot.js). Так оба процесса живут в одном сервисе Railway и
# работают с одним и тем же файлом SQLite на одном и том же Volume —
# не нужно ничего "расшаривать" между сервисами.

set -e

node server/server.js &
SERVER_PID=$!

BOT_PID=""
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  # Небольшая пауза, чтобы сайт первым успел создать/открыть таблицы в
  # SQLite при холодном старте — избегаем гонки "database is locked".
  sleep 3
  echo "TELEGRAM_BOT_TOKEN задан — запускаю бота..."
  node server/bot.js &
  BOT_PID=$!
else
  echo "TELEGRAM_BOT_TOKEN не задан — бот не запускается (запустится сайт без привязки Telegram)."
fi

term_handler() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$BOT_PID" ] && kill "$BOT_PID" 2>/dev/null || true
}
trap term_handler TERM INT

# Если упадёт сайт — контейнер должен перезапуститься, поэтому ждём именно его.
wait "$SERVER_PID"
