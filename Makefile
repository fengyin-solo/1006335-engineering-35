.PHONY: install ci frontend verify build build-deploy docker-up

# 安装一律走锁文件，保证本地与线上依赖版本逐位一致
install:
	cd frontend && npm ci

frontend:
	cd frontend && npm run dev

# 应急演练链路自检（构建部署共用这一条链路的一环）
verify:
	cd frontend && npm run verify

build:
	cd frontend && npm run build

# 构建部署同一条链路：先自检，后构建；自检不过不产出
build-deploy:
	cd frontend && npm run build:deploy

docker-up:
	docker compose up --build
