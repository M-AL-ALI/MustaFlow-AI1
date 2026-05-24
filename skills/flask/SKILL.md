---
name: flask
description: Build Flask web apps with blueprints, Jinja2 templates, and SQLAlchemy.
triggers: [flask, python web, jinja, wsgi]
---

# Flask skill

Use when the user asks for a Flask, Python web app, or "Python server-rendered" app.

## Required structure

Small app:

- `app.py` — `Flask(__name__)` + routes.
- `templates/*.html` — Jinja2 templates.
- `static/*` — assets.
- `requirements.txt` — `flask`, `gunicorn`, plus extensions.

Larger app (factory pattern):

- `app/__init__.py` — `create_app()` factory.
- `app/<blueprint>/routes.py` — blueprint routes.
- `app/models.py` — SQLAlchemy models.

Run with `flask --app app.py run --host 0.0.0.0 --port $PORT` in dev, `gunicorn app:app --bind 0.0.0.0:$PORT` in prod.

## Do

- Use `render_template("page.html", **context)` for HTML pages.
- Use `jsonify({...})` (or just return a dict in modern Flask) for JSON.
- Use blueprints (`Blueprint("auth", __name__, url_prefix="/auth")`) to split routes.
- Store config in env vars; use `flask-sqlalchemy` if you want an ORM with sessions wired up.
- Always declare `SECRET_KEY` for sessions/csrf — never hardcode.

## Don't

- Don't run `app.run(debug=True)` in production.
- Don't return raw user input as HTML — Jinja2 autoescapes by default, but never `{{ x | safe }}` untrusted data.
- Don't share a SQLAlchemy session across threads — use `scoped_session` or flask-sqlalchemy's per-request session.

## Examples

### Minimal app

```py
from flask import Flask, render_template, request, redirect, url_for

app = Flask(__name__)
TODOS = []

@app.get("/")
def index():
    return render_template("index.html", todos=TODOS)

@app.post("/todos")
def create_todo():
    text = request.form.get("text", "").strip()
    if text:
        TODOS.append({"text": text, "done": False})
    return redirect(url_for("index"))
```

```html
<!-- templates/index.html -->
<!doctype html>
<title>Todos</title>
<ul>
  {% for t in todos %}
  <li>{{ t.text }}</li>
  {% endfor %}
</ul>
<form method="post" action="{{ url_for('create_todo') }}">
  <input name="text" required />
  <button>Add</button>
</form>
```

### Factory + blueprint

```py
# app/__init__.py
from flask import Flask
from .auth.routes import bp as auth_bp

def create_app():
    app = Flask(__name__)
    app.config.from_prefixed_env()  # FLASK_SECRET_KEY → app.config["SECRET_KEY"]
    app.register_blueprint(auth_bp)
    return app
```

```py
# app/auth/routes.py
from flask import Blueprint, request, jsonify

bp = Blueprint("auth", __name__, url_prefix="/auth")

@bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    return jsonify({"ok": True, "email": data.get("email")})
```
