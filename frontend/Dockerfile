# 构建与部署共用同一条链路：
# 1) 严格按 package-lock.json 安装（依赖版本钉死）
# 2) npm run build 内含「确定性生成 seed -> 校验和/自检 verify -> 类型检查 -> 打包」
# 3) 产物是纯静态文件，nginx 托管；线上落库的样例就是 verify 过的同一份 seed.json
FROM node:20-alpine AS build
WORKDIR /srv/web
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /srv/web/dist /usr/share/nginx/html
# 纯前端 history 路由回退
RUN printf 'server {\n  listen 5173;\n  root /usr/share/nginx/html;\n  location / { try_files $uri $uri/ /index.html; }\n}\n' \
  > /etc/nginx/conf.d/default.conf
EXPOSE 5173
CMD ["nginx", "-g", "daemon off;"]
