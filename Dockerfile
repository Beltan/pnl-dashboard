FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/dist ./dist
# The database lives here and the process runs unprivileged, so the directory has to exist and be
# owned before the drop: WORKDIR leaves /app to root, and main.ts creates DB_PATH's parent at boot.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "--experimental-sqlite", "dist/main.js"]
