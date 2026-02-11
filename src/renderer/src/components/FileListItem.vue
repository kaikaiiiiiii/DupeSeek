<script setup lang="ts">
import { ref } from 'vue'

interface Props {
    file: string
}

defineProps<Props>()

const checked = ref(false)
</script>

<template>
    <div class="file-item">
        <span class="file-name">{{ file }}</span>
        <input type="checkbox" v-model="checked" />
    </div>
</template>

<style scoped>
.file-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px;
}

.file-name {
    flex: 1;
}
</style>
