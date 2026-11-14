"""Environment-driven configuration."""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    openai_api_key: str
    realtime_model: str
    realtime_voice: str
    transcription_model: str
    session_max_seconds: int
    sessions_per_ip_per_hour: int
    demo_access_code: str
    deck: str
    decks_dir: Path
    static_dir: Path
    log_dir: Path


def get_settings() -> Settings:
    return Settings(
        openai_api_key=os.getenv("OPENAI_API_KEY", ""),
        realtime_model=os.getenv("REALTIME_MODEL", "gpt-realtime"),
        realtime_voice=os.getenv("REALTIME_VOICE", "marin"),
        transcription_model=os.getenv("TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe"),
        session_max_seconds=int(os.getenv("SESSION_MAX_SECONDS", "600")),
        sessions_per_ip_per_hour=int(os.getenv("SESSIONS_PER_IP_PER_HOUR", "10")),
        demo_access_code=os.getenv("DEMO_ACCESS_CODE", ""),
        # Which deck to present: a folder name under DECKS_DIR holding deck.json.
        deck=os.getenv("DECK", "cardiovex"),
        decks_dir=Path(os.getenv("DECKS_DIR", ROOT / "backend" / "decks")),
        static_dir=Path(os.getenv("STATIC_DIR", ROOT / "frontend" / "dist")),
        log_dir=Path(os.getenv("LOG_DIR", ROOT / "backend" / "logs")),
    )
