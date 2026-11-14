"""OpenAI Realtime session config and ephemeral client secrets.

The browser never sees the real API key. It gets a short-lived secret that
already has the instructions, tools and audio settings baked in.
"""

import httpx

from .prompt import build_instructions, build_tools
from .settings import Settings

CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"
# The secret only has to live long enough for the browser to open the call.
SECRET_TTL_SECONDS = 120


class RealtimeError(Exception):
    pass


def build_session_config(deck: dict, settings: Settings) -> dict:
    return {
        "type": "realtime",
        "model": settings.realtime_model,
        "instructions": build_instructions(deck),
        "tools": build_tools(deck),
        "tool_choice": "auto",
        "output_modalities": ["audio"],
        "audio": {
            "input": {
                "transcription": {"model": settings.transcription_model, "language": "en"},
                "noise_reduction": {"type": "near_field"},
                # Semantic VAD waits for the end of a thought rather than a fixed
                # silence, and interrupt_response gives us barge-in.
                "turn_detection": {
                    "type": "semantic_vad",
                    "eagerness": "auto",
                    "create_response": True,
                    "interrupt_response": True,
                },
            },
            "output": {"voice": settings.realtime_voice},
        },
    }


async def mint_client_secret(deck: dict, settings: Settings) -> dict:
    body = {
        "expires_after": {"anchor": "created_at", "seconds": SECRET_TTL_SECONDS},
        "session": build_session_config(deck, settings),
    }
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                CLIENT_SECRETS_URL,
                headers={"Authorization": f"Bearer {settings.openai_api_key}"},
                json=body,
            )
    except httpx.HTTPError as exc:
        raise RealtimeError(f"could not reach OpenAI: {exc}") from exc
    if response.status_code >= 400:
        raise RealtimeError(f"OpenAI returned {response.status_code}: {response.text[:300]}")
    data = response.json()
    return {"value": data["value"], "expires_at": data.get("expires_at")}
