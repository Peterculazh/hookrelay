FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build -- --all

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Keep the installed toolchain in the shared image so the one-off service can
# run drizzle-kit. Application services still execute only compiled JavaScript.
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle.config.ts ./
COPY --from=build --chown=node:node /app/libs/database/src ./libs/database/src

USER node

EXPOSE 3000 3001

CMD ["node", "dist/apps/hookrelay/main.js"]
