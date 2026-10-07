# ---- 构建阶段：严格按锁文件装依赖，跑链路自检，再产出静态产物 ----
FROM node:20-alpine AS build
WORKDIR /srv/web
# 锁文件与多平台架构声明一起拷入，npm ci 在任何平台装出的依赖都与本地一致
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# 构建部署同一条链路：先过应急演练链路自检，再构建；自检不过则镜像构建失败
RUN npm run build:deploy

# ---- 部署阶段：nginx 托管静态产物 ----
FROM nginx:1.27-alpine AS deploy
COPY --from=build /srv/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
