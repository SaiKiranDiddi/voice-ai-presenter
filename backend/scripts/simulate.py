"""Text-mode run of the presenter flow against the real Realtime API.

Mirrors what the browser sends (PRESENT notes, tool outputs, tool_choice none)
but with typed user turns and text output, to check protocol and routing.
"""

import asyncio
import json
import sys

import websockets

from app.deck import load_deck
from app.realtime import build_session_config
from app.settings import get_settings

settings = get_settings()
deck = load_deck()
flat = [(s, b) for s in deck["slides"] for b in s["blocks"]]


async def main() -> None:
    url = f"wss://api.openai.com/v1/realtime?model={settings.realtime_model}"
    headers = {"Authorization": f"Bearer {settings.openai_api_key}"}
    async with websockets.connect(url, additional_headers=headers) as ws:
        config = build_session_config(deck, settings)
        config["output_modalities"] = ["text"]
        config["audio"]["input"]["turn_detection"] = None
        await ws.send(json.dumps({"type": "session.update", "session": config}))

        async def respond(payload: dict | None = None) -> tuple[str, list[dict]]:
            event = {"type": "response.create"}
            if payload:
                event["response"] = payload
            await ws.send(json.dumps(event))
            text, calls = "", []
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=40))
                kind = msg["type"]
                if kind == "response.output_text.delta":
                    text += msg["delta"]
                elif kind == "response.function_call_arguments.done":
                    calls.append(msg)
                elif kind == "error":
                    print("   !! ERROR:", msg["error"].get("code"), msg["error"].get("message"))
                    if "response" not in str(msg["error"].get("message", "")).lower():
                        continue
                    return text, calls
                elif kind == "response.done":
                    status = msg["response"].get("status")
                    if status != "completed":
                        print("   !! status:", status, msg["response"].get("status_details"))
                    return text, calls

        async def item(role: str, text: str) -> None:
            await ws.send(json.dumps({
                "type": "conversation.item.create",
                "item": {"type": "message", "role": role, "content": [{"type": "input_text", "text": text}]},
            }))

        async def tool_output(call_id: str, output: dict) -> None:
            await ws.send(json.dumps({
                "type": "conversation.item.create",
                "item": {"type": "function_call_output", "call_id": call_id, "output": json.dumps(output)},
            }))

        async def present(index: int, opening: str) -> None:
            slide, block = flat[index]
            await item("system", (
                f"PRESENT: {opening}\nSlide: {slide['title']}\nTalking point: {block['talking_point']}\n"
                f"Facts: {' '.join(block['facts'])}\n"
                "Speak one or two sentences about this only, then stop. Do not ask a question, "
                "do not ask whether to continue, and do not mention what comes next."
            ))
            text, calls = await respond({"tool_choice": "none"})
            print(f"[present {block['id']}] calls={len(calls)}\n   {text}\n")

        async def user(text: str) -> None:
            await item("user", text)
            reply, calls = await respond()
            names = [(c["name"], c["arguments"]) for c in calls]
            print(f'USER: "{text}"\n   tool calls: {names}\n   spoken: {reply!r}')
            for call in calls:
                if call["name"] == "show_answer":
                    args = json.loads(call["arguments"])
                    block = next((b for _, b in flat if b["id"] == args.get("block_id")), None)
                    await tool_output(call["call_id"], {
                        "ok": True, "facts": block["facts"] if block else [],
                        "instruction": "Answer now in one to three sentences using only these facts. "
                        "End by saying you will carry on with the presentation unless they have another question.",
                    })
                    answer, more = await respond({"tool_choice": "none"})
                    print(f"   answer (calls={len(more)}): {answer}")
                else:
                    await tool_output(call["call_id"], {"ok": True})
            print()

        await present(0, "Open with one sentence introducing yourself as the presenter and saying they can interrupt with questions at any time. Then present this:")
        await present(1, "Carry straight on, with no greeting or recap, and present this:")
        await present(2, "Carry straight on, with no greeting or recap, and present this:")
        for line in sys.argv[1:] or [
            "Wait, what are the side effects?",
            "Continue.",
            "Can you go to slide 2 and explain again?",
            "What's the weather like in New York?",
            "Sure.",
            "How do I dose it?",
            "Is it better than spironolactone?",
            "What was the trial design?",
            "Can I give it to a pregnant patient?",
            "No more questions, go on.",
            "Show me the summary.",
        ]:
            await user(line)


asyncio.run(main())
