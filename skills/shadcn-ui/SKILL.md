---
name: shadcn-ui
description: Add shadcn/ui components — copy-in primitives built on Radix and Tailwind, owned by your repo.
triggers: [shadcn, shadcn/ui, shadcn-ui, ui kit]
---

# shadcn/ui skill

Use when the user asks for shadcn, "polished UI", or component primitives. shadcn/ui is NOT an npm package — it's a CLI that copies component source files into your project so you own and customize them.

## Setup

```sh
npx shadcn@latest init
```

Choose:

- Style: `default` or `new-york`
- Base color: `zinc` (most neutral) or `slate`
- CSS variables: yes (required for theming)

Then add components on demand:

```sh
npx shadcn@latest add button card dialog input form
```

This drops files into `src/components/ui/`. They are yours — edit freely.

## Required structure

- `components.json` — CLI config (paths, style, base color).
- `src/components/ui/*` — copied component sources.
- `src/lib/utils.ts` — `cn(...)` helper (clsx + tailwind-merge).
- `src/index.css` — CSS variables for theming (`:root` light, `.dark` dark).

## Do

- Use `cn(...)` to compose classnames safely (handles conflict resolution).
- Build complex components by **composing** primitives — don't reach for a third-party kit.
- Use the `Form` component with `react-hook-form` + `zod` for typed validation.
- Edit copied components when you need different behavior — the whole point is ownership.

## Don't

- Don't `npm install shadcn-ui` — it isn't a runtime package.
- Don't fight the design tokens — change CSS variables instead of overriding every class.

## Examples

### Button + Card

```tsx
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export function Hello() {
  return (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>Hello</CardTitle>
      </CardHeader>
      <CardContent>
        <Button onClick={() => alert("hi")}>Click me</Button>
      </CardContent>
    </Card>
  );
}
```

### Dialog (modal)

```tsx
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

<Dialog>
  <DialogTrigger asChild>
    <Button>Open</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Confirm</DialogTitle>
    </DialogHeader>
    <p>Are you sure?</p>
  </DialogContent>
</Dialog>;
```

### Form with zod

```tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

const schema = z.object({ email: z.string().email() });
type Values = z.infer<typeof schema>;

function ContactForm() {
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "" } });
  return (
    <form onSubmit={form.handleSubmit((v) => console.log(v))}>
      <input {...form.register("email")} />
      {form.formState.errors.email && <p>{form.formState.errors.email.message}</p>}
      <button>Submit</button>
    </form>
  );
}
```
