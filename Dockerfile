# HongguoWeb 容器镜像
#   docker build --build-arg BASE_PATH=/hongguo -t hongguoweb .
# BASE_PATH 为站点挂载的子路径（反向代理负责去掉该前缀再转发），挂在域名根路径时留空。

# ---------- 构建前端 ----------
FROM node:22-alpine AS web
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json ./
RUN npm ci --registry=$NPM_REGISTRY --no-audit --no-fund
COPY vite.config.mjs ./
COPY web ./web
ARG BASE_PATH=
RUN BASE_PATH=$BASE_PATH npx vite build

# ---------- 运行 ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=$NPM_REGISTRY --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY --from=web /app/web/dist ./web/dist
USER node
CMD ["node", "server/index.js"]
