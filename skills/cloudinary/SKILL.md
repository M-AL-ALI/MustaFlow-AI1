---
name: cloudinary
description: Use Cloudinary for image upload, transformation, and delivery — unsigned uploads and URL-based transforms.
triggers: [cloudinary, image cdn, image transform, image upload]
---

# Cloudinary skill

Use for image/video hosting with on-the-fly transformations (resize, crop, format, quality, overlays) via URL.

## Setup

1. Create a Cloudinary account; copy your **cloud name** (public) and **API key/secret** (server-side).
2. For browser uploads without a backend, create an **unsigned upload preset** in Cloudinary settings.

## URL-based transformations

The general pattern:

```
https://res.cloudinary.com/<cloud>/image/upload/<transformations>/<public_id>.<format>
```

Common transforms:

- `w_600,h_400,c_fill,g_auto` — fill 600×400, smart crop.
- `q_auto,f_auto` — auto quality + auto format (WebP/AVIF when supported).
- `e_blur:200` — blur effect.
- `l_logo,w_100,g_south_east` — overlay.

```html
<img
  src="https://res.cloudinary.com/demo/image/upload/w_600,h_400,c_fill,g_auto,q_auto,f_auto/sample.jpg"
/>
```

## Browser upload (unsigned)

```ts
async function uploadToCloudinary(file: File, cloudName: string, preset: string) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("upload_preset", preset);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) throw new Error("Upload failed");
  return res.json() as Promise<{
    secure_url: string;
    public_id: string;
    width: number;
    height: number;
  }>;
}
```

## Server upload (signed, Node)

```sh
npm install cloudinary
```

```ts
import { v2 as cloudinary } from "cloudinary";
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const result = await cloudinary.uploader.upload("./photo.jpg", { folder: "avatars" });
console.log(result.secure_url);
```

## React component

```sh
npm install @cloudinary/url-gen @cloudinary/react
```

```tsx
import { Cloudinary } from "@cloudinary/url-gen";
import { AdvancedImage } from "@cloudinary/react";
import { fill } from "@cloudinary/url-gen/actions/resize";
import { autoGravity } from "@cloudinary/url-gen/qualifiers/gravity";

const cld = new Cloudinary({ cloud: { cloudName: "demo" } });
const img = cld
  .image("sample")
  .resize(fill().width(600).height(400).gravity(autoGravity()))
  .format("auto")
  .quality("auto");
<AdvancedImage cldImg={img} />;
```

## Do

- Always use `q_auto,f_auto` — huge bandwidth win.
- Use unsigned presets for client-side uploads + scope them by folder + max file size.
- Store the `public_id` (not the full URL) in your DB — transformations are then composable later.
- Use `c_fill,g_auto` for thumbnails (face/feature aware crop).

## Don't

- Don't expose `api_secret` in browser code.
- Don't generate URLs from user-supplied transformations without validation — they could overload your account.

## Examples

### Avatar URL

```ts
const avatar = (publicId: string) =>
  `https://res.cloudinary.com/${import.meta.env.VITE_CLOUD_NAME}/image/upload/w_80,h_80,c_fill,g_face,r_max,q_auto,f_auto/${publicId}`;
```

### Responsive srcSet

```tsx
function ResponsiveImg({ id, alt }: { id: string; alt: string }) {
  const cloud = import.meta.env.VITE_CLOUD_NAME;
  const url = (w: number) =>
    `https://res.cloudinary.com/${cloud}/image/upload/w_${w},c_limit,q_auto,f_auto/${id}`;
  return (
    <img
      src={url(800)}
      srcSet={[400, 800, 1200, 1600].map((w) => `${url(w)} ${w}w`).join(", ")}
      sizes="(min-width: 768px) 50vw, 100vw"
      alt={alt}
    />
  );
}
```
