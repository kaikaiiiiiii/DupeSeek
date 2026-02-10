import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './Main.vue'
import { RecycleScroller } from 'vue-virtual-scroller'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)

app.component('RecycleScroller', RecycleScroller)
app.mount('#app')