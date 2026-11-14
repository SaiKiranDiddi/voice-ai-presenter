"""FastAPI app. Serves the API and, when built, the frontend from one origin."""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .deck import load_deck
from .routes import router
from .settings import get_settings

app = FastAPI(title="Voice slide presenter")
app.include_router(router)
# The JS bundle is ~250 KB raw and ~80 KB compressed; it matters on a small instance.
app.add_middleware(GZipMiddleware, minimum_size=1000)

load_deck()  # fail fast on a malformed deck

static_dir = get_settings().static_dir
if static_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=static_dir / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        if path.startswith("api/"):
            raise HTTPException(404)
        candidate = (static_dir / path).resolve()
        if path and candidate.is_file() and static_dir.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(static_dir / "index.html")
