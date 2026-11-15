import { createApp } from 'vue'
import Antd from 'ant-design-vue'
import 'ant-design-vue/dist/reset.css'
import './theme.css'
import router from './router'
import App from './App.vue'
import { vResizableTable } from './directives/resizableTable'

const app = createApp(App)
app.use(Antd)
app.use(router)
app.directive('resizable-table', vResizableTable)
app.mount('#app')
