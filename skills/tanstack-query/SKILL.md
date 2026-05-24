---
name: tanstack-query
description: Fetch, cache, and mutate server data with TanStack Query (React Query) — queries, mutations, invalidation.
triggers: [tanstack query, react query, tanstack-query, usequery, usemutation, data fetching]
---

# TanStack Query skill

Use whenever a React app talks to a server API. TanStack Query (formerly React Query) handles caching, background refetching, deduping, retry, and optimistic updates — replacing 90% of `useEffect` + `useState` data-fetching patterns.

## Install

```sh
npm install @tanstack/react-query
```

```tsx
// src/main.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
```

## Do

- **Stable query keys**: include every variable the query depends on. `["todos", { status }]` not `["todos"]`.
- Use `enabled: false` to defer until dependencies are ready.
- Use `useMutation` for writes; in `onSuccess`, call `queryClient.invalidateQueries({ queryKey: [...] })` to refetch affected lists.
- For optimistic updates, snapshot the cache with `getQueryData`, mutate with `setQueryData`, and roll back in `onError`.
- Reach for `select: (data) => ...` to derive a slice without re-renders elsewhere.

## Don't

- Don't fetch in `useEffect` when you can use `useQuery` — you'll re-implement caching and never get it right.
- Don't use Query state for client-only UI state — use `useState` or Zustand.
- Don't disable `staleTime` — defaulting to `Infinity` plus explicit invalidation is often cleaner than constant refetch.

## Examples

### List + create with invalidation

```tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

type Todo = { id: number; text: string };

function useTodos() {
  return useQuery({
    queryKey: ["todos"],
    queryFn: async (): Promise<Todo[]> => (await fetch("/api/todos")).json(),
  });
}

function useCreateTodo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) =>
      (
        await fetch("/api/todos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        })
      ).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["todos"] }),
  });
}
```

### Optimistic update

```tsx
const qc = useQueryClient();
const m = useMutation({
  mutationFn: async (id: number) => fetch(`/api/todos/${id}`, { method: "DELETE" }),
  onMutate: async (id) => {
    await qc.cancelQueries({ queryKey: ["todos"] });
    const prev = qc.getQueryData<Todo[]>(["todos"]);
    qc.setQueryData<Todo[]>(["todos"], (old) => old?.filter((t) => t.id !== id) ?? []);
    return { prev };
  },
  onError: (_e, _v, ctx) => ctx && qc.setQueryData(["todos"], ctx.prev),
  onSettled: () => qc.invalidateQueries({ queryKey: ["todos"] }),
});
```

### Dependent query

```tsx
const { data: user } = useQuery({ queryKey: ["me"], queryFn: fetchMe });
const { data: posts } = useQuery({
  queryKey: ["posts", user?.id],
  queryFn: () => fetchPostsByUser(user!.id),
  enabled: !!user,
});
```
