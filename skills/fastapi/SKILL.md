---
name: fastapi
description: Build FastAPI services with pydantic models, dependency injection, and async routes.
triggers: [fastapi, python api, pydantic, uvicorn]
---

# FastAPI skill

Use when the user asks for a FastAPI, Python API, or "Python REST" service.

## Required structure

- `main.py` — `FastAPI()` app + routes (small apps).
- For larger apps: `app/__init__.py`, `app/main.py`, `app/routers/<name>.py`, `app/models.py` (pydantic), `app/db.py`.
- `requirements.txt` — `fastapi`, `uvicorn[standard]`, `pydantic`, plus your DB driver.
- Run with `uvicorn main:app --host 0.0.0.0 --port $PORT --reload` in dev.

## Pydantic models

```py
from pydantic import BaseModel, Field
from typing import Optional

class TodoIn(BaseModel):
    text: str = Field(min_length=1, max_length=200)
    done: bool = False

class Todo(TodoIn):
    id: int
```

## Do

- Type every route parameter and return value — FastAPI uses them to generate OpenAPI + Swagger UI automatically.
- Use `Depends(...)` for shared dependencies (auth, db session).
- Use `async def` only when you actually `await` something — otherwise `def` is fine and runs in a thread pool.
- Raise `HTTPException(status_code=404, detail="...")` for error responses.
- For request bodies: declare the model as a function parameter; FastAPI parses + validates JSON automatically.

## Don't

- Don't use `@app.route` (Flask-style) — use `@app.get` / `@app.post` / etc.
- Don't block the event loop with sync DB calls inside `async def` — use sync `def` or async drivers (`asyncpg`, `databases`).
- Don't put secrets in code — read them from `os.environ`.

## Examples

### Minimal CRUD

```py
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
DB: dict[int, dict] = {}
next_id = 1

class Item(BaseModel):
    name: str
    price: float

@app.get("/items")
def list_items():
    return list(DB.values())

@app.post("/items", status_code=201)
def create_item(item: Item):
    global next_id
    record = {"id": next_id, **item.model_dump()}
    DB[next_id] = record
    next_id += 1
    return record

@app.get("/items/{item_id}")
def get_item(item_id: int):
    if item_id not in DB:
        raise HTTPException(404, "Item not found")
    return DB[item_id]
```

### Dependency for auth

```py
from fastapi import Depends, Header, HTTPException

def require_user(authorization: str = Header(...)) -> str:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = authorization.removeprefix("Bearer ")
    user_id = verify_token(token)  # your impl
    if not user_id:
        raise HTTPException(401, "Invalid token")
    return user_id

@app.get("/me")
def me(user_id: str = Depends(require_user)):
    return {"user_id": user_id}
```

### CORS for a separate frontend

```py
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```
