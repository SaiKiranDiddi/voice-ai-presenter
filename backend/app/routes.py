"""HTTP API: deck, session creation, and session event logging."""

import json
import re
import time
import uuid
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import realtime
from .deck import load_deck
from .settings import Settings, get_settings

router = APIRouter(prefix="/api")

_session_starts: dict[str, deque[float]] = defaultdict(deque)
SESSION_ID_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_LOG_BYTES = 2_000_000


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check_rate_limit(ip: str, limit: int, now: float | None = None) -> bool:
    """Sliding one-hour window per IP. Returns False when over the limit."""
    now = time.time() if now is None else now
    starts = _session_starts[ip]
    while starts and now - starts[0] > 3600:
        starts.popleft()
    if len(starts) >= limit:
        return False
    starts.append(now)
    return True


class SessionRequest(BaseModel):
    access_code: str = ""


class SessionEvent(BaseModel):
    type: str = Field(max_length=64)
    at_ms: int
    data: dict = Field(default_factory=dict)


class EventBatch(BaseModel):
    events: list[SessionEvent] = Field(max_length=200)


@router.get("/health")
def health() -> dict:
    return {"ok": True}


@router.get("/deck")
def get_deck() -> dict:
    return load_deck()


@router.get("/config")
def get_config(settings: Settings = Depends(get_settings)) -> dict:
    return {
        "session_max_seconds": settings.session_max_seconds,
        "access_code_required": bool(settings.demo_access_code),
    }


@router.post("/session")
async def create_session(
    body: SessionRequest, request: Request, settings: Settings = Depends(get_settings)
) -> dict:
    if not settings.openai_api_key:
        raise HTTPException(503, "Server is missing OPENAI_API_KEY.")
    if settings.demo_access_code and body.access_code != settings.demo_access_code:
        raise HTTPException(401, "Wrong access code.")
    if not check_rate_limit(client_ip(request), settings.sessions_per_ip_per_hour):
        raise HTTPException(429, "Too many sessions from this address. Try again later.")
    try:
        secret = await realtime.mint_client_secret(load_deck(), settings)
    except realtime.RealtimeError as exc:
        raise HTTPException(502, str(exc)) from exc
    return {
        "session_id": uuid.uuid4().hex,
        "client_secret": secret["value"],
        "expires_at": secret["expires_at"],
        "model": settings.realtime_model,
        "max_seconds": settings.session_max_seconds,
        "next_block_lead_ms": settings.next_block_lead_ms,
    }


@router.post("/sessions/{session_id}/events")
def log_events(
    session_id: str, batch: EventBatch, settings: Settings = Depends(get_settings)
) -> dict:
    """Appends transcript, tool-call and latency events to a per-session JSONL file."""
    if not SESSION_ID_RE.match(session_id):
        raise HTTPException(400, "Bad session id.")
    settings.log_dir.mkdir(parents=True, exist_ok=True)
    path = settings.log_dir / f"{session_id}.jsonl"
    if path.exists() and path.stat().st_size > MAX_LOG_BYTES:
        raise HTTPException(413, "Session log is full.")
    with path.open("a") as handle:
        for event in batch.events:
            handle.write(json.dumps(event.model_dump()) + "\n")
    return {"ok": True, "written": len(batch.events)}
