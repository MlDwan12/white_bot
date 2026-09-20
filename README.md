# white_bot

Панель и сервис для рассылки постов и проведения конкурсов в **VK** и **MAX**.
Один владелец, много целевых групп; не SaaS.

## Что умеет

- **Посты** в группы VK и MAX сразу: текст, картинки, файлы; отложенная
  публикация; повторяющиеся посты по расписанию (cron); остановка и «отправить
  оставшимся»; автоудаление; правка и удаление уже опубликованного (в MAX; в VK
  ждёт одобрения прав).
- **Конкурсы в MAX**: кнопка под постом ведёт в бота, участие записывается при
  старте; розыгрыш воспроизводимый (сид и список участников в журнале), призовые
  места, замена победителя; итоги дописываются в пост и приходят победителю в
  личные сообщения.
- **Веб-панель** `/panel`: посты, повторяющиеся посты, конкурсы, группы; роли
  `developer` и `admin`.

Пока не умеет: видео как видео (уходит файлом), конкурсы в VK, мини-приложение
MAX. Токен для загрузки вложений в VK живёт сутки и продлевается вручную.

## Стек

Node 22 · NestJS + TypeScript · PostgreSQL 16 + Prisma 7 · Redis 7 + BullMQ ·
EJS + Tabler (панель без сборки фронтенда) · `@maxhub/max-bot-api` · sharp.
Обновления MAX приходят через long polling, входящих соединений для этого не
нужно. Архитектура и принятые решения — в [`PLAN.md`](PLAN.md).

## Локальный запуск

```bash
cp .env.example .env                    # заполнить TOKEN_ENCRYPTION_KEY и JWT_SECRET
docker compose up -d postgres redis     # именно эти два сервиса, без `api`
yarn install
yarn prisma generate                    # клиент в git не хранится
yarn prisma migrate deploy
yarn start:dev                          # http://localhost:3000/panel/login

yarn build && yarn seed:admin you@example.com   # первый админ, пароль печатается один раз
yarn test                               # юнит-тесты; yarn lint; yarn test:e2e
```

Ключи генерируются так (команды — в комментариях `.env.example`):
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
для `TOKEN_ENCRYPTION_KEY` и `openssl rand -base64 48` для `JWT_SECRET`.

## Настройки

Полный список с пояснениями — в `.env.example`. Для продакшена важны:

| Переменная | Значение |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | адреса Postgres и Redis (обязательны) |
| `TOKEN_ENCRYPTION_KEY` | ключ шифрования токенов групп, base64 от 32 байт (обязателен) |
| `JWT_SECRET` | секрет входа в панель, не короче 32 символов (обязателен) |
| `MAX_BOT_TOKEN` | токен бота MAX; пусто — интеграция с MAX выключена |
| `VK_APP_ID`, `VK_APP_CLIENT_SECRET` | нужны только для загрузки вложений в VK |
| `COOKIE_SECURE` | `true` за HTTPS (иначе браузер выбросит куки входа) |
| `TRUST_PROXY_HOPS` | `1`, если перед приложением один прокси |
| `MEDIA_STORAGE_PATH` | каталог загруженных файлов — под отдельный том |
| `DEFAULT_TIMEZONE` | `Europe/Moscow` |

## Деплой: образ на сервер, без реестра

Образ собирается у вас, пакуется в архив и по ssh загружается на сервер.
Реестр не нужен.

```
ваша машина                              сервер (VPS, Docker + compose)
───────────                              ──────────────────────────────
docker build ─► docker save | gzip ─ssh─► docker load
                                          caddy :80/:443 ─► app :3000 ─► postgres
                                          (TLS)              │        └► redis
                                                             └► том с медиа
```

Снаружи открыты только 22, 80 и 443. Postgres, Redis и приложение порты не
публикуют. Приложение запускается **в одном экземпляре**: long polling MAX и
воркеры очереди не рассчитаны на две реплики.

### Один раз: подготовка

1. VPS от 2 vCPU / 4 ГБ, Docker с плагином compose, пользователь для деплоя.
2. Домен: A-запись на IP сервера до первого запуска (Caddy сам получит
   сертификат Let's Encrypt).
3. Каталог `/opt/white_bot` с тремя файлами ниже. `.env` — с правами `600`.

`/opt/white_bot/docker-compose.yml`:

```yaml
services:
  app:
    image: white-bot:${APP_TAG}
    restart: unless-stopped
    env_file: .env
    volumes: [media:/data/media]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: white_bot
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: white_bot
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U white_bot"]
      interval: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes: [redisdata:/data]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 10

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on: [app]

volumes: { media: {}, pgdata: {}, redisdata: {}, caddy_data: {}, caddy_config: {} }
```

`/opt/white_bot/Caddyfile`:

```
panel.example.com {
    reverse_proxy app:3000
}
```

`/opt/white_bot/.env` (пароль Postgres — только hex, чтобы не экранировать в URL:
`openssl rand -hex 24`):

```
APP_TAG=первый-тег
POSTGRES_PASSWORD=<hex>
DATABASE_URL=postgresql://white_bot:<hex>@postgres:5432/white_bot
REDIS_URL=redis://redis:6379
NODE_ENV=production
PORT=3000
COOKIE_SECURE=true
TRUST_PROXY_HOPS=1
MEDIA_STORAGE_PATH=/data/media
DEFAULT_TIMEZONE=Europe/Moscow
TOKEN_ENCRYPTION_KEY=<base64>
JWT_SECRET=<не короче 32 символов>
MAX_BOT_TOKEN=<токен бота>
VK_APP_ID=<id приложения>
VK_APP_CLIENT_SECRET=<секрет>
```

**Ключ `TOKEN_ENCRYPTION_KEY` храните отдельно от дампов базы**: без него
сохранённые токены групп не расшифровать.

Если сервер не может тянуть образы с Docker Hub, `postgres:16-alpine`,
`redis:7-alpine` и `caddy:2-alpine` доставляются тем же способом, что и наш образ.

### Первый запуск

```bash
# у вас
TAG=$(git rev-parse --short HEAD)
docker build --target production -t white-bot:$TAG .
docker save white-bot:$TAG | gzip | ssh deploy@SERVER 'gunzip | docker load'

# на сервере, в /opt/white_bot (в .env поставить APP_TAG=<тот же тег>)
docker compose up -d postgres redis
docker compose run --rm app node_modules/.bin/prisma migrate deploy
docker compose run --rm app node dist/scripts/seed-admin.js you@example.com
docker compose up -d app caddy
curl -fsS https://panel.example.com/health        # {"success":true,"data":{"status":"ok"}}
```

Затем в панели: войти, подключить группы (бота MAX добавить админом в канал с
правами писать, править и удалять — группа появится в «Группах» на подтверждение;
для VK — токен сообщества) и отправить тестовый пост **в MAX**: пост в VK потом не
удалить, пока VK не одобрит права.

### Обновление

```bash
# у вас: собрать и отправить
TAG=$(git rev-parse --short HEAD)
docker build --target production -t white-bot:$TAG .
docker save white-bot:$TAG | gzip | ssh deploy@SERVER 'gunzip | docker load'

# на сервере
docker compose exec -T postgres pg_dump -U white_bot white_bot | gzip > backups/pre-$TAG.sql.gz
sed -i "s/^APP_TAG=.*/APP_TAG=$TAG/" .env
docker compose run --rm app node_modules/.bin/prisma migrate deploy
docker compose up -d app
curl -fsS https://panel.example.com/health
```

Простой — секунды на перезапуск приложения. Отложенные задачи лежат в Redis
(с включённым `appendonly`) и переживают его; источник правды по расписанию —
Postgres, и планировщик восстанавливает задачи, если Redis очистили.

**Откат**: вернуть прежний `APP_TAG` в `.env` и `docker compose up -d app`. Старые
образы остаются на сервере (держите три последних, лишние — `docker image rm`).
Миграции идут только вперёд: если новая схема несовместима со старым кодом,
откатывать базу придётся из дампа `pre-<тег>`.

### Резервные копии

- Postgres: `pg_dump` по cron раз в сутки, копии — за пределы сервера.
- Медиа: том `media` (`docker run --rm -v white_bot_media:/d -v $PWD:/b alpine tar czf /b/media.tgz -C /d .`).
- `.env` — отдельно и в надёжном месте.
- Раз в квартал проверять, что дамп действительно поднимается.

### Что проверено, а что нет

Проверено на обычной машине без Docker: продовые зависимости плюс каталог
`dist` запускаются, отвечают `/health`, отдают стили панели, пускают в панель и
принимают картинки; 16 миграций применяются к пустой базе за ~1,5 с продовым
`prisma`; сид админа работает без `.env`.

**Ещё не проверено:** сама сборка образа (на машине разработки VPN ломает сеть
Docker — `EAI_AGAIN` даже с `--network=host`), нативные модули `sharp` и
`argon2` под Alpine и размер образа.

**Нужно доделать в репозитории до первого деплоя:**

1. В стадию `production` в `Dockerfile` добавить `COPY prisma ./prisma` и
   `COPY prisma.config.ts ./` и перенести `prisma` из `devDependencies` в
   `dependencies`. Сейчас CLI попадает в продовые зависимости лишь транзитивно, а
   без папки `prisma/` в образе миграции запустить нечем.
2. Добавить `storage` в `.dockerignore`, чтобы локальные медиа не попадали в
   контекст сборки.
