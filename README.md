# москвещи v2 — PostgreSQL + загрузка фото

## Что исправлено

- Товары больше не должны пропадать после перезапуска Render, если подключен `DATABASE_URL`.
- Фото товара теперь можно загружать с компьютера.
- Фото сохраняется в базе как `imageData`, поэтому не зависит от локальных файлов Render.
- Если `DATABASE_URL` не указан, сайт работает через локальный `data/db.json`, но на Render Free это может сбрасываться.

## Что нужно сделать на Render

Добавьте переменную Environment:

```env
DATABASE_URL=ваш_postgres_connection_string
```

Подойдут:
- Render Postgres;
- Supabase;
- Neon.

Также нужны:

```env
ADMIN_EMAIL=admin@moskveshi.ru
ADMIN_PASSWORD=ваш_пароль
PAYMENT_CARD=2200 7021 1871 3952
CONTACT_TELEGRAM=@kadwss
SITE_NAME=москвещи
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

## Команды Render

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

## Как обновить GitHub

Замените в репозитории файлы:

- `server.js`
- `package.json`
- `public/index.html`
- `.env.example`
- `README.md`

После этого Render сделает redeploy.
