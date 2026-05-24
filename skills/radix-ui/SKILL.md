---
name: radix-ui
description: Build accessible component primitives with Radix UI — unstyled, ARIA-correct dialogs, menus, popovers.
triggers: [radix, radix-ui, accessible components, a11y primitives]
---

# Radix UI skill

Use when the user wants accessible, unstyled primitives (the layer shadcn/ui builds on). Each primitive ships full ARIA, keyboard, focus, and portal handling — you bring the styles.

## Install per-primitive

```sh
npm install @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-popover
```

(Each component is its own package, kept small.)

## Anatomy

Most primitives expose `Root`, `Trigger`, `Portal`, `Content`, plus part-specific subcomponents. `Root` is uncontrolled by default; pass `open` + `onOpenChange` to control it.

## Do

- Use `Portal` for floating UI (dialogs, popovers, menus) so they escape `overflow: hidden` parents.
- Use the `asChild` prop to merge Radix behavior onto your own element (`<Trigger asChild><button>...</button></Trigger>`).
- Style with `data-state="open"` / `data-state="closed"` selectors for animations.
- For forms, use `@radix-ui/react-label` to wire label → input correctly.

## Don't

- Don't double-wrap focus management — Radix handles focus traps inside dialogs already.
- Don't render dialogs/menus inside scrollable containers without `Portal`.

## Examples

### Dialog

```tsx
import * as Dialog from "@radix-ui/react-dialog";

<Dialog.Root>
  <Dialog.Trigger asChild>
    <button>Open</button>
  </Dialog.Trigger>
  <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 bg-black/50" />
    <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white p-6 rounded-md">
      <Dialog.Title>Confirm</Dialog.Title>
      <Dialog.Description>Continue with this action?</Dialog.Description>
      <Dialog.Close asChild>
        <button>Cancel</button>
      </Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>;
```

### Dropdown menu

```tsx
import * as Menu from "@radix-ui/react-dropdown-menu";

<Menu.Root>
  <Menu.Trigger asChild>
    <button>Options ▾</button>
  </Menu.Trigger>
  <Menu.Portal>
    <Menu.Content sideOffset={4} className="bg-white shadow rounded p-1">
      <Menu.Item onSelect={() => console.log("edit")} className="px-3 py-1 hover:bg-gray-100">
        Edit
      </Menu.Item>
      <Menu.Item onSelect={() => console.log("dup")} className="px-3 py-1 hover:bg-gray-100">
        Duplicate
      </Menu.Item>
      <Menu.Separator className="h-px bg-gray-200 my-1" />
      <Menu.Item
        onSelect={() => console.log("del")}
        className="px-3 py-1 hover:bg-red-50 text-red-600"
      >
        Delete
      </Menu.Item>
    </Menu.Content>
  </Menu.Portal>
</Menu.Root>;
```

### Controlled popover

```tsx
import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";

const [open, setOpen] = useState(false);
<Popover.Root open={open} onOpenChange={setOpen}>
  <Popover.Trigger asChild>
    <button>Info</button>
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content className="bg-white shadow p-3 rounded">Hello!</Popover.Content>
  </Popover.Portal>
</Popover.Root>;
```
