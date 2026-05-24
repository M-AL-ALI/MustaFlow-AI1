---
name: threejs
description: Build 3D scenes with Three.js — perspective camera, lights, materials, and an animation loop.
triggers: [three, three.js, threejs, 3d, webgl]
---

# Three.js skill

Use when the user asks for 3D, WebGL, a 3D viewer, or a hero with depth. Vanilla Three.js for tight control; React Three Fiber when the rest of the app is React.

## Install

```sh
npm install three
npm install -D @types/three
```

## Anatomy

Every Three scene needs: a renderer, a scene, a camera, at least one light (for non-MeshBasicMaterial), and an animation loop calling `renderer.render(scene, camera)`.

## Do

- Set `renderer.setPixelRatio(window.devicePixelRatio)` and update size on resize.
- Use `MeshStandardMaterial` for PBR; `MeshBasicMaterial` if you don't want lighting.
- `requestAnimationFrame` for the loop; dispose of geometries/materials on unmount.
- For models, use `GLTFLoader` (`three/examples/jsm/loaders/GLTFLoader.js`) and call `scene.add(gltf.scene)`.
- Use `OrbitControls` to give the user mouse/touch navigation.

## Don't

- Don't create a new renderer per frame — instantiate once and re-render.
- Don't forget cleanup: `renderer.dispose()`, `geometry.dispose()`, `material.dispose()`, remove the canvas.
- Don't lay textures over models without setting `texture.colorSpace = THREE.SRGBColorSpace` — they'll look washed out.

## Examples

### Spinning cube (vanilla)

```ts
import * as THREE from "three";

const canvas = document.querySelector<HTMLCanvasElement>("#c")!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.z = 4;

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x66ccff }),
);
scene.add(cube);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 1);
dir.position.set(2, 3, 4);
scene.add(dir);

function tick() {
  cube.rotation.x += 0.01;
  cube.rotation.y += 0.01;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
```

### React Three Fiber

```tsx
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useRef } from "react";

function Box() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt;
  });
  return (
    <mesh ref={ref}>
      <boxGeometry />
      <meshStandardMaterial color="hotpink" />
    </mesh>
  );
}

export default function Scene() {
  return (
    <Canvas camera={{ position: [3, 3, 3] }}>
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 5, 5]} />
      <Box />
      <OrbitControls />
    </Canvas>
  );
}
```
