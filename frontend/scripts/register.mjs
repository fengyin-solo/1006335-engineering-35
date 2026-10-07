// 让 Node 直接跑 TypeScript：用 esbuild（版本已钉进 package-lock.json）在加载期转译，
// 初始化脚本、自检脚本、测试脚本共用这一个注册钩子，不引入第二套工具链。
import { register } from 'node:module'

register(new URL('./esbuild-hook.mjs', import.meta.url))
