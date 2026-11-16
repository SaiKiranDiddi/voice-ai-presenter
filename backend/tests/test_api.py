import copy
import json
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app import realtime, routes
from app.deck import load_deck, read_deck, validate_deck
from app.main import app
from app.prompt import build_instructions, build_tools
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


def test_deck_is_valid_with_a_title_page_and_six_slides():
    deck = load_deck()
    title, *content = deck["slides"]
    assert title["layout"] == "cover" and len(title["blocks"]) == 1
    assert len(content) == 6
    assert all(2 <= len(s["blocks"]) <= 4 for s in content)


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


def test_deck_validation_rejects_missing_agent_fields():
    deck = copy.deepcopy(load_deck())
    deck["agent"]["refusal_line"] = ""
    with pytest.raises(ValueError):
        validate_deck(deck)
    del deck["agent"]
    with pytest.raises(ValueError):
        validate_deck(deck)


def other_deck() -> dict:
    """The Cardiovex slides with a different agent, standing in for a new deck."""
    deck = copy.deepcopy(load_deck())
    deck["id"] = "other"
    deck["name"] = "Northwind"
    del deck["pronunciation"]
    deck["agent"] = {
        "role": "You are a founder pitching Northwind to an investor over a voice call.",
        "audience": "investor",
        "style": ["Confident and concise."],
        "out_of_scope": ["valuation"],
        "refusal_line": "I can't speak to that here.",
    }
    return deck


def test_prompt_and_tools_follow_the_deck_agent():
    deck = other_deck()
    prompt = build_instructions(deck)
    tools = json.dumps(build_tools(deck))
    assert prompt.startswith("# Role and goal\nYou are a founder pitching Northwind")
    assert "# When the investor speaks" in prompt
    assert "- Confident and concise." in prompt
    assert 'Valuation, or anything the facts do not cover: say "I can\'t speak to that here."' in prompt
    assert "Pronounce" not in prompt
    assert "the investor's question" in tools
    # The stand-in reuses Cardiovex slides, so leave out the facts section.
    rules = prompt.split("# The deck")[0] + prompt.split("# Guardrails")[1]
    for text in (rules, tools):
        for word in ("physician", "clinician", "Cardiovex", "Medical Information", "off-label"):
            assert word not in text


def test_deck_setting_picks_the_folder(tmp_path):
    (tmp_path / "other").mkdir()
    (tmp_path / "other" / "deck.json").write_text(json.dumps(other_deck()))
    assert read_deck(tmp_path, "other")["name"] == "Northwind"
    with pytest.raises(ValueError, match="available: other"):
        read_deck(tmp_path, "missing")
    with pytest.raises(ValueError):
        read_deck(tmp_path, "../other")


def test_prompt_contains_every_block_and_fact():
    deck = load_deck()
    prompt = build_instructions(deck)
    for block in all_blocks(deck):
        assert block["id"] in prompt
        for fact in block["facts"]:
            assert fact in prompt
    assert deck["agent"]["refusal_line"] in prompt


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
    assert response.json()["name"] == "Cardiovex"
    assert response.json()["agent"]["audience"] == "physician"


def test_create_session_returns_ephemeral_secret_only(client):
    response = client.post("/api/session", json={})
    assert response.status_code == 200
    body = response.json()
    assert body["client_secret"] == "ek_test"
    assert len(body["session_id"]) == 32
    assert "sk-test" not in response.text


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
