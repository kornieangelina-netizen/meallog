# MealLog

Личный дневник питания, где интерфейсом служит Claude. Фото тарелки или этикетки в чат Claude,
он считает КБЖУ и через MCP-коннектор записывает в твою базу. На телефоне PWA с журналом,
планом на день, холодильником, аналитикой и целями.

## Устройство

```
Claude (iPhone / web) ──MCP──▶ /mcp/<секрет> ─┐
PWA на телефоне       ──REST─▶ /api/*        ─┤ server.py (FastMCP/MCPServer + Starlette) ─▶ data/meals.db
                      ──GET──▶ /             ─┘
Caddy: HTTPS и домен, reverse proxy на 127.0.0.1:8010
systemd-таймеры: 03:00 бэкап · 04:00 DuckDNS · 07:00 план на день
```

Файлы:

| Файл | Что |
|---|---|
| `server.py` | MCP-инструменты для Claude, REST для PWA, вход по паролю, статика |
| `db.py` | SQLite: `meals`, `products` (справочник + холодильник), `recommendations`, `goals`, `weight_log` |
| `rules.md` | твои личные правила для Claude, попадают в инструкцию коннектора |
| `scripts/daily_plan.py` | план на день через Claude API с проверкой лимитов |
| `scripts/backup.py` | консистентный бэкап SQLite |
| `webapp/` | PWA: `index.html`, `app.js`, `styles.css`, `service-worker.js` |
| `deploy/` | Caddyfile, systemd service и timers, `install.sh` |

## Установка на VPS (Ubuntu 24.04)

Самый простой путь, без SSH: при создании сервера в Hetzner Cloud вставить в поле «Cloud config»
вывод `python3 scripts/make_cloud_init.py`. Сервер сам ставит всё при первой загрузке и открывает
приложение по адресу `https://<ip-через-дефисы>.sslip.io` (домен регистрировать не нужно).

Вручную:

```bash
git clone https://github.com/kornieangelina-netizen/meallog /opt/meallog
DOMAIN=yourname.duckdns.org bash /opt/meallog/deploy/install.sh   # DOMAIN необязателен
```

Скрипт ставит Python и Caddy, создаёт `.env` с секретами, пишет Caddyfile и включает сервисы.
В конце печатает адрес приложения и URL коннектора. Дальше:

1. Если нужен план на день, в `/opt/meallog/.env` задать `ANTHROPIC_API_KEY`, затем
   `systemctl restart meallog`. Пароль входа в PWA тоже лежит в `.env` (`APP_PASSWORD`).
2. Если используете DuckDNS, создать `/opt/meallog/duckdns.token` (chmod 600) со строками
   `DOMAIN=имя` и `TOKEN=токен`, затем `systemctl enable --now meallog-duckdns.timer`.
3. Коннектор: Claude → Settings → Connectors → Add custom connector → URL из вывода скрипта. Без OAuth.
4. PWA: открыть адрес приложения в Safari, ввести пароль, «Поделиться → На экран „Домой“».

## Локальный запуск

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env   # поправить значения
set -a; source .env; set +a
.venv/bin/python server.py
.venv/bin/python -m unittest discover tests
```

## Инструменты коннектора

`find_products` · `log_product` · `log_meal` · `save_product` · `list_fridge` · `day_summary` ·
`list_meals` · `delete_meal` · `add_recommendation` · `clear_recommendations` · `list_recommendations` ·
`set_product_flags` · `set_fridge` · `get_goals` · `set_goals` · `log_weight`

Правила поведения живут в докстрингах инструментов и в `INSTRUCTIONS` в `server.py` плюс `rules.md`.

## Безопасность

MCP-эндпоинт без авторизации, защита только неугадываемым путём. Для личного дневника на одного
человека это приемлемо. PWA и REST за паролем и cookie на год. Секреты только в `.env` (права 600).

## Обновление

Сервер сам проверяет GitHub каждые 10 минут (`meallog-update.timer` → `deploy/update.sh`): если в `main`
появились новые коммиты, он делает `git reset --hard origin/main`, ставит зависимости и перезапускает
сервис. База `data/meals.db`, `.env` и бэкапы вне git и не трогаются. Так что обновление = merge в `main`.

Если сервер ставился до появления таймера, один раз вручную:

```bash
cd /opt/meallog && git pull && bash deploy/update.sh
```

При изменении файлов в `webapp/` поднять версию `CACHE` в `service-worker.js`, тогда приложение
на телефоне само перезагрузится при следующем открытии.
