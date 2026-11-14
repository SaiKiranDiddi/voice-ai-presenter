"""Loads and validates the deck. The deck is the single source for the UI,
the system prompt, and the facts the agent is allowed to state."""

import json
from functools import lru_cache
from pathlib import Path

BLOCK_TYPES = {"stat", "chart", "table", "steps", "callout"}
DECK_PATH = Path(__file__).with_name("deck.json")


def validate_deck(deck: dict) -> None:
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


@lru_cache
def load_deck() -> dict:
    deck = json.loads(DECK_PATH.read_text())
    validate_deck(deck)
    return deck
