"""Loads and validates the deck. The deck is the single source for the UI,
the system prompt, and the facts the agent is allowed to state.

Each deck lives in its own folder, decks/<name>/deck.json, and carries both
its content (slides, blocks, facts) and how the agent should present it (the
"agent" section: role, audience, style, what to refuse). Switching decks is a
matter of setting DECK; no code changes.
"""

from functools import lru_cache
import json
from pathlib import Path

from .settings import get_settings

BLOCK_TYPES = {"stat", "chart", "table", "steps", "callout"}
AGENT_TEXT_FIELDS = ("role", "audience", "refusal_line")
AGENT_LIST_FIELDS = ("style", "out_of_scope", "guardrails")


def validate_agent(agent: dict) -> None:
    for field in AGENT_TEXT_FIELDS:
        if not isinstance(agent.get(field), str) or not agent[field].strip():
            raise ValueError(f"agent.{field} must be a non-empty string")
    for field in AGENT_LIST_FIELDS:
        value = agent.get(field, [])
        if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
            raise ValueError(f"agent.{field} must be a list of non-empty strings")


def validate_deck(deck: dict) -> None:
    for field in ("id", "name"):
        if not isinstance(deck.get(field), str) or not deck[field].strip():
            raise ValueError(f"deck.{field} must be a non-empty string")
    if "agent" not in deck:
        raise ValueError("deck needs an agent section")
    validate_agent(deck["agent"])
    seen: set[str] = set()
    if not 5 <= len(deck["slides"]) <= 6:
        raise ValueError("deck must have 5-6 slides")
    for slide in deck["slides"]:
        if slide["id"] in seen:
            raise ValueError(f"duplicate id {slide['id']}")
        seen.add(slide["id"])
        if not slide["blocks"]:
            raise ValueError(f"slide {slide['id']} has no blocks")
        for block in slide["blocks"]:
            bid = block["id"]
            if bid in seen:
                raise ValueError(f"duplicate id {bid}")
            seen.add(bid)
            if not bid.startswith(slide["id"] + "."):
                raise ValueError(f"block {bid} must be prefixed with its slide id")
            if block["type"] not in BLOCK_TYPES:
                raise ValueError(f"block {bid} has unknown type {block['type']}")
            if not block["talking_point"] or not block["facts"]:
                raise ValueError(f"block {bid} needs a talking_point and facts")


def deck_path(decks_dir: Path, name: str) -> Path:
    path = (decks_dir / name / "deck.json").resolve()
    if decks_dir.resolve() not in path.parents:
        raise ValueError(f"bad deck name {name!r}")
    if not path.is_file():
        available = sorted(p.parent.name for p in decks_dir.glob("*/deck.json"))
        raise ValueError(f"no deck named {name!r} in {decks_dir}; available: {', '.join(available) or 'none'}")
    return path


@lru_cache
def read_deck(decks_dir: Path, name: str) -> dict:
    deck = json.loads(deck_path(decks_dir, name).read_text())
    validate_deck(deck)
    return deck


def load_deck() -> dict:
    """The deck chosen by the DECK setting."""
    settings = get_settings()
    return read_deck(settings.decks_dir, settings.deck)
