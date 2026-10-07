import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { bootstrapEmergency } from './api/local-service'
import './styles/global.css'

// 启动先跑应急演练初始化链路：本地/线上同一份确定性示例 + 存量迁移，
// 幂等可续跑，重复启动不会改动已有演练记录。
bootstrapEmergency()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
