import copy
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app import realtime, routes
from app.deck import load_deck, validate_deck
from app.main import app
from app.prompt import REFUSAL_LINE, build_instructions, build_tools
from app.settings import get_settings


@pytest.fixture
def settings(tmp_path):
    return replace(
        get_settings(),
        openai_api_key="sk-test",
        demo_access_code="",
        sessions_per_ip_per_hour=2,
        log_dir=tmp_path,
    )


@pytest.fixture
def client(settings, monkeypatch):
    async def fake_mint(deck, _settings):
        return {"value": "ek_test", "expires_at": 123}

    monkeypatch.setattr(realtime, "mint_client_secret", fake_mint)
    routes._session_starts.clear()
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


def all_blocks(deck):
    return [b for s in deck["slides"] for b in s["blocks"]]


def test_deck_is_valid_and_has_six_slides():
    deck = load_deck()
    assert len(deck["slides"]) == 6
    assert all(2 <= len(s["blocks"]) <= 4 for s in deck["slides"])


def test_deck_validation_rejects_block_without_facts():
    deck = copy.deepcopy(load_deck())
    deck["slides"][0]["blocks"][0]["facts"] = []
    with pytest.raises(ValueError):
        validate_deck(deck)


def test_deck_validation_rejects_duplicate_ids():
    deck = copy.deepcopy(load_deck())
    deck["slides"][1]["id"] = deck["slides"][0]["id"]
    with pytest.raises(ValueError):
        validate_deck(deck)


def test_prompt_contains_every_block_and_fact():
    deck = load_deck()
    prompt = build_instructions(deck)
    for block in all_blocks(deck):
        assert block["id"] in prompt
        for fact in block["facts"]:
            assert fact in prompt
    assert REFUSAL_LINE in prompt


def test_tool_schema_lists_every_id():
    deck = load_deck()
    tools = {tool["name"]: tool for tool in build_tools(deck)}
    assert set(tools) == {"show_answer", "continue_presentation", "present_slide"}
    slide_ids = [s["id"] for s in deck["slides"]]
    answer_props = tools["show_answer"]["parameters"]["properties"]
    assert answer_props["slide_id"]["enum"] == slide_ids
    assert answer_props["block_id"]["enum"] == [b["id"] for b in all_blocks(deck)]
    assert tools["present_slide"]["parameters"]["properties"]["slide_id"]["enum"] == slide_ids


def test_session_config_shape(settings):
    config = realtime.build_session_config(load_deck(), settings)
    assert config["type"] == "realtime"
    assert config["audio"]["input"]["turn_detection"]["interrupt_response"] is True
    assert config["tools"][0]["name"] == "show_answer"


def test_get_deck(client):
    response = client.get("/api/deck")
    assert response.status_code == 200
    assert response.json()["product"] == "Cardiovex"


def test_create_session_returns_ephemeral_secret_only(client):
    response = client.post("/api/session", json={})
    assert response.status_code == 200
    body = response.json()
    assert body["client_secret"] == "ek_test"
    assert len(body["session_id"]) == 32
    assert "sk-test" not in response.text
    assert body["next_block_lead_ms"] == 700


def test_next_block_lead_is_configurable(client, settings):
    app.dependency_overrides[get_settings] = lambda: replace(settings, next_block_lead_ms=250)
    assert client.post("/api/session", json={}).json()["next_block_lead_ms"] == 250


def test_create_session_rate_limited(client):
    assert client.post("/api/session", json={}).status_code == 200
    assert client.post("/api/session", json={}).status_code == 200
    assert client.post("/api/session", json={}).status_code == 429


def test_create_session_requires_access_code(client, settings):
    app.dependency_overrides[get_settings] = lambda: replace(settings, demo_access_code="open")
    assert client.post("/api/session", json={}).status_code == 401
    assert client.post("/api/session", json={"access_code": "open"}).status_code == 200


def test_create_session_without_api_key(client, settings):
    app.dependency_overrides[get_settings] = lambda: replace(settings, openai_api_key="")
    assert client.post("/api/session", json={}).status_code == 503


def test_create_session_surfaces_openai_failure(client, monkeypatch):
    async def failing_mint(deck, _settings):
        raise realtime.RealtimeError("OpenAI returned 401")

    monkeypatch.setattr(realtime, "mint_client_secret", failing_mint)
    assert client.post("/api/session", json={}).status_code == 502


def test_log_events_writes_jsonl(client, settings):
    session_id = "a" * 32
    batch = {"events": [{"type": "latency", "at_ms": 10, "data": {"ms": 420}}]}
    response = client.post(f"/api/sessions/{session_id}/events", json=batch)
    assert response.status_code == 200
    assert '"ms": 420' in (settings.log_dir / f"{session_id}.jsonl").read_text()


def test_log_events_rejects_bad_session_id(client):
    assert client.post("/api/sessions/not-a-hex-id/events", json={"events": []}).status_code == 400
    # An encoded traversal never reaches the handler; what matters is that it is refused.
    traversal = client.post("/api/sessions/..%2Fevil/events", json={"events": []})
    assert traversal.status_code in (400, 404, 405)
