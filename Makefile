.PHONY: install ci frontend build test verify image up

install:
	cd frontend && npm install

# 部署/CI 用：严格按锁文件安装，依赖版本与本地一致
ci:
	cd frontend && npm ci

frontend:
	cd frontend && npm run dev

# 应急演练样例生成 + 校验（build 会自动再跑一遍，这里供单独自检）
verify:
	cd frontend && npm run emergency:generate && npm run emergency:verify

# 全链路测试：27 组用例，覆盖初始化幂等/中断续跑/岗位把关/并发/迁移/条数一致
test:
	cd frontend && npm test

# 完整构建：生成样例 -> 校验 -> 类型检查 -> 打包，构建与部署同一条链路
build:
	cd frontend && npm run build

# 与线上一致的镜像构建（内部同样执行 npm ci + npm run build）
image:
	docker compose build

up:
	docker compose up --build
