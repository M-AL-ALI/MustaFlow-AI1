---
name: WS upgrade socket must be resumed before async handler
description: Node.js HTTP server silently reclaims paused upgrade sockets when the upgrade handler returns without synchronously claiming them.
---

## Rule

Call `socket.resume()` (or `socket.pipe()`) **synchronously** in the `server.on("upgrade", ...)` handler before launching any async work (DB queries, file reads, etc.).

## Why

When an HTTP server fires the `upgrade` event, the underlying socket is in paused (non-flowing) mode. If the handler returns immediately without synchronously consuming the socket, Node.js treats it as unclaimed and may close it after the current tick — even though the application holds a closure reference to it. Subsequent async writes (`socket.write("HTTP/1.1 101 ...")`) silently fail or error: the echo server receives the proxied upgrade but the original client gets 0 bytes and its socket closes.

Symptom pattern: Case 1 (valid session) fails intermittently right after an api-server restart but ONLY on subsequent runs; validation logic is correct; echo server receives the upgrade; client receives 0 bytes.

## How to apply

Any `server.on("upgrade", ...)` handler that does async work before taking ownership of the socket must call `netSocket.resume()` as the first synchronous step:

```typescript
server.on("upgrade", (req, socket, head) => {
  const netSocket = socket as net.Socket;
  // ...
  if (isPreviewSubdomainHost(host)) {
    netSocket.resume(); // claim socket before async validation
    void validateSession(host, req.headers.cookie).then((result) => {
      if (!result) { netSocket.destroy(); return; }
      // proxy...
    });
    return;
  }
  // ...
});
```
