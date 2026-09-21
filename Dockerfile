FROM node:22-alpine AS base
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM base AS dev
COPY . .
EXPOSE 3000
CMD ["sh", "-c", "yarn prisma generate && yarn start:dev"]

FROM base AS build
COPY . .
RUN yarn prisma generate && yarn build

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
# Миграции накатываются из этого же образа: `prisma migrate deploy` берёт
# схему и историю отсюда. Без этих двух строк в образе есть CLI, но нечего
# применять.
COPY prisma ./prisma
COPY prisma.config.ts ./
EXPOSE 3000
CMD ["node", "dist/main.js"]
