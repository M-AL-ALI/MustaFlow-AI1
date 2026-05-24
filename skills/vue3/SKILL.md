---
name: vue3
description: Build Vue 3 + Vite apps with the Composition API, <script setup>, and Pinia for state.
triggers: [vue, vue3, vue.js, composition api, pinia, script setup]
---

# Vue 3 skill

Use this when the user asks for a Vue, Vue 3, or Vite-Vue app. Always use the Composition API with `<script setup>` — never the Options API.

## Required structure

- `index.html` — Vite entry with `<div id="app">`.
- `src/main.ts` — `createApp(App).mount('#app')`.
- `src/App.vue` — root component.
- `src/components/*.vue` — SFCs.
- `vite.config.ts` — `@vitejs/plugin-vue`.
- `tsconfig.json` — `"types": ["vite/client"]`.

## Reactivity primitives

- `ref(value)` — single reactive value, access with `.value` in script, auto-unwrapped in template.
- `reactive(obj)` — deep-reactive object (no `.value`).
- `computed(() => ...)` — derived value.
- `watch(source, cb)` / `watchEffect(cb)` — side effects.

## Do

- Use `<script setup lang="ts">` — that's the modern, type-safe SFC syntax.
- Use `defineProps<{ ... }>()` and `defineEmits<{ ... }>()` for typed props/events.
- For global state, use **Pinia** stores (not Vuex).
- Use `v-model` on form inputs; for components, declare a `modelValue` prop and `update:modelValue` emit.

## Don't

- Don't mutate props directly.
- Don't reach into refs with `.value` inside templates — Vue unwraps them automatically there.
- Don't mix Options API and Composition API in the same component.

## Examples

### A typed SFC

```vue
<script setup lang="ts">
import { ref, computed } from "vue";

const props = defineProps<{ initial: number }>();
const emit = defineEmits<{ (e: "change", value: number): void }>();

const count = ref(props.initial);
const doubled = computed(() => count.value * 2);

function increment() {
  count.value++;
  emit("change", count.value);
}
</script>

<template>
  <div>
    <p>Count: {{ count }} (doubled: {{ doubled }})</p>
    <button @click="increment">+1</button>
  </div>
</template>
```

### A Pinia store

```ts
// src/stores/counter.ts
import { defineStore } from "pinia";
import { ref, computed } from "vue";

export const useCounterStore = defineStore("counter", () => {
  const count = ref(0);
  const double = computed(() => count.value * 2);
  function increment() {
    count.value++;
  }
  return { count, double, increment };
});
```

```ts
// src/main.ts
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";

createApp(App).use(createPinia()).mount("#app");
```
