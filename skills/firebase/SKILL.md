---
name: firebase
description: Use Firebase for Auth, Firestore, and Cloud Storage with the modular v9+ web SDK.
triggers: [firebase, firestore, firebase auth, cloud firestore]
---

# Firebase skill

Use when the user wants Firebase Auth + Firestore + Storage. Always use the modular SDK (v9+) — tree-shakeable function imports, not the old `firebase.auth()` namespace.

## Install

```sh
npm install firebase
```

## Initialize once

```ts
// src/lib/firebase.ts
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
});

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
```

The web API key is safe to ship — Firestore Security Rules decide what clients can read/write.

## Auth

```ts
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
} from "firebase/auth";
import { auth } from "./firebase";

await createUserWithEmailAndPassword(auth, email, password);
await signInWithEmailAndPassword(auth, email, password);
await signInWithPopup(auth, new GoogleAuthProvider());
await signOut(auth);
onAuthStateChanged(auth, (user) => {
  /* ... */
});
```

## Firestore

```ts
import {
  collection,
  doc,
  addDoc,
  getDocs,
  getDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "./firebase";

// create
const ref = await addDoc(collection(db, "todos"), {
  text: "milk",
  done: false,
  uid: user.uid,
  createdAt: serverTimestamp(),
});

// query
const q = query(
  collection(db, "todos"),
  where("uid", "==", user.uid),
  orderBy("createdAt", "desc"),
);
const snap = await getDocs(q);
const todos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

// update / delete
await updateDoc(doc(db, "todos", id), { done: true });
await deleteDoc(doc(db, "todos", id));

// realtime
const unsub = onSnapshot(q, (snap) => {
  setTodos(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
});
```

## Security Rules — required

```
service cloud.firestore {
  match /databases/{database}/documents {
    match /todos/{id} {
      allow read, update, delete: if request.auth != null && resource.data.uid == request.auth.uid;
      allow create: if request.auth != null && request.resource.data.uid == request.auth.uid;
    }
  }
}
```

## Do

- Always include the auth UID in every doc you intend to scope.
- Use `serverTimestamp()` for created/updated times — never `new Date()` (client clock drift).
- Use indexes (Firebase suggests them when a query fails) — composite indexes for multi-field `where` + `orderBy`.
- Use `onSnapshot` for live data; remember to call the returned unsubscribe on unmount.

## Don't

- Don't ship admin SDK creds to the browser — admin SDK is server-only.
- Don't leave rules at "allow if true" — that's a public database.

## Examples

### Storage upload

```ts
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./firebase";

const fileRef = ref(storage, `avatars/${user.uid}.png`);
await uploadBytes(fileRef, file);
const url = await getDownloadURL(fileRef);
```
