# syntax=docker/dockerfile:1

# Образ закреплён по digest, а не только по тегу: тег alpine мутирует при
# пересборках апстримом, и без digest один и тот же `docker build` в разное
# время может внезапно получить другой набор системных пакетов. Один ARG на
# оба FROM — иначе рассинхрон между `base` и `production` при ручном
# обновлении одного из двух литералов остался бы незамеченным.
ARG NODE_ALPINE_DIGEST=sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

FROM node:22-alpine@${NODE_ALPINE_DIGEST} AS base

WORKDIR /app

# Монорепо на yarn workspaces: для установки нужны package.json всех
# пакетов, а не только корневой — иначе yarn не увидит их зависимостей.
COPY package.json yarn.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# Кэш yarn смонтирован (не COPY-слоем) и в образ не попадает; его же
# переиспользует обрезка до продовых зависимостей в стадии `build`.
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn,sharing=locked \
    yarn install --frozen-lockfile


# =========================
# Development
# =========================
FROM base AS dev

COPY . .

WORKDIR /app/apps/api

EXPOSE 3000

CMD ["sh", "-c", "yarn prisma generate && yarn start:dev"]


# =========================
# Build
# =========================
FROM base AS build

COPY . .

# prisma generate не подключается к БД,
# но prisma.config.ts требует наличие DATABASE_URL
ARG DATABASE_URL="postgresql://user:password@localhost:5432/database"
ENV DATABASE_URL=$DATABASE_URL

RUN yarn workspace @white-bot/api prisma generate
# Корневой `build` собирает и API, и панель (`apps/web`) — Nest отдаёт её
# сборку по `/app`. Зависимости панели — devDependencies: они вшиваются в
# бандл и обрезкой ниже в образ не попадают, копируется один `apps/web/dist`.
RUN yarn build

# Продовые зависимости — обрезкой уже установленного node_modules, а не
# вторым `yarn install` в стадии production: там заново запускались бы
# postinstall-скрипты, а `@prisma/engines` в своём качает бинарник миграций с
# binaries.prisma.sh — при закрытой/кривой сети (VPN) сборка на этом
# бесконечно висела. `--ignore-scripts` это и убирает: бинарники уже лежат в
# node_modules из `base`. Без `--offline`: слой `base` может прийти из кэша,
# а кэш yarn (cache mount) — быть вычищенным (`docker builder prune`), и
# тогда `--offline` ронял бы сборку; с живым кэшем в сеть и так не ходим.
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn,sharing=locked \
    yarn install --frozen-lockfile --production --ignore-scripts
# Пакеты, которым не нашлось места в корневом node_modules (конфликт версий),
# yarn кладёт в node_modules самого workspace. Папка создаётся заранее, чтобы
# COPY в production не падал, когда таких нет.
RUN mkdir -p apps/api/node_modules


# =========================
# Production
# =========================
FROM node:22-alpine@${NODE_ALPINE_DIGEST} AS production

WORKDIR /app

ENV NODE_ENV=production

# Раскладка как в репозитории: `main.ts` ищет панель по пути
# `apps/api/dist/../../web/dist`.
COPY package.json yarn.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

# Нужны для prisma migrate deploy
COPY apps/api/prisma ./apps/api/prisma
COPY apps/api/prisma.config.ts ./apps/api/

# Непривилегированный пользователь `node` (встроен в базовый образ,
# uid/gid 1000): процесс, скомпрометированный через уязвимость в
# зависимости, не должен иметь root внутри контейнера. Файлы выше читаются
# им и без chown — COPY/yarn кладут их с правами на чтение для всех; писать
# во время работы процессу некуда, кроме смонтированных volume (для них
# владельца настраивают отдельно, на стороне volume).
# MEDIA_STORAGE_PATH в проде — `/app/storage/media` (deploy/env.example; по
# умолчанию был бы относительный `./storage/media` от `apps/api`): без этой
# папки и её владельца первая же загрузка файла упадёт `EACCES` — `/app`
# принадлежит root, а процесс ниже уже нет.
# Volume, смонтированный поверх в проде, всё равно потребует владельца
# `node`(1000) отдельно — это не отменяет.
RUN mkdir -p /app/storage/media && chown -R node:node /app/storage

USER node

WORKDIR /app/apps/api

EXPOSE 3000

# Порт — из того же `PORT`, что слушает приложение (по умолчанию 3000):
# shell-форма раскрывает переменную при каждой проверке.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" || exit 1

CMD ["node", "dist/main.js"]