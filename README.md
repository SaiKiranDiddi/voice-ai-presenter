# Voice-led slide presenter

An AI voice agent that presents a six-slide deck, jumps to the right slide when you ask a question, and stops talking the moment you interrupt.

The deck is a detail aid for **Cardiovex, a fictional drug**, presented to a physician. The agent answers only from approved content, and every answer highlights the part of the slide it came from. Decks are swappable: see [Decks](#decks).

## Run it

Needs Python 3.11+, Node 20+, and an OpenAI API key with Realtime access.

```bash
cp .env.example .env          # then put your key in OPENAI_API_KEY
python -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
cd frontend && npm install && npm run build && cd ..
cd backend && ../.venv/bin/uvicorn app.main:app --port 8000
```

Open http://localhost:8000, press **Start presentation**, and allow the microphone. Headphones give the cleanest interruption.

To watch it without a microphone, open http://localhost:8000/?silent: the agent presents the whole deck to a silent input.

For frontend development, run `npm run dev` in `frontend/` alongside the backend; Vite proxies `/api` to port 8000.

Tests: `cd backend && ../.venv/bin/python -m pytest`

Docker: `docker build -t presenter . && docker run -p 8000:8000 --env-file .env presenter`

### Deploy

The live demo runs on Render's free tier from `render.yaml`: one Docker web service that builds the frontend and serves it from FastAPI. In Render, choose **New > Blueprint**, pick this repository, and fill in the two secrets it asks for: `OPENAI_API_KEY` and `DEMO_ACCESS_CODE` (visitors enter the code before a call starts, so a public URL can't spend the key). Every push to `main` redeploys.

- Settings such as `REALTIME_MODEL`, `DECK` and the call limits can be changed in the service's Environment tab; **Save and deploy** applies them. `VITE_VOICE_VISUAL` is read when the frontend is built, so it needs **Save, rebuild, and deploy**.
- A free service sleeps after 15 minutes without traffic and takes about a minute to wake. A free uptime monitor requesting `/api/health` every few minutes keeps it awake.
- The free instance (0.1 CPU, 512 MB) is enough: the server uses about 65 MB, and call audio goes from the browser straight to OpenAI, never through it. Session logs are lost when the service restarts.

## What to try

| Do or say | Expect |
|---|---|
| Nothing | The agent greets you and presents every block of every slide without prompting |
| "What are the side effects?" mid-sentence | Speech stops, the Safety slide appears, the adverse-event table is highlighted |
| Stay quiet after the answer | After five seconds it returns to the block you interrupted and carries on |
| "Continue" after an answer | Same, immediately |
| "How do I dose it?" | Jumps to Dosing |
| "Is it better than drug X?" / "What does it cost?" | Polite refusal, pointer to Medical Information, no slide change |
| "Go back to slide two" | Presents the Mechanism slide from its start and continues from there |
| Click a slide thumbnail | The agent stops and presents that slide straight away |
| Press **Stop talking** | Audio stops and it waits for you |
| Press **Pause**, then **Resume** | Speech stops and the microphone is muted; Resume presents the same block again |
| "Is this a real drug?" | Says it is fictional |

## Architecture

```
Browser (React)                        FastAPI                        OpenAI
  GET  /api/deck  ------------------->  decks/<DECK>/deck.json
  POST /api/session ----------------->  build prompt + tools  ------> mint ephemeral secret
  <-- ephemeral secret ---------------
  ===== WebRTC: mic up, voice down, JSON events on a data channel =====> Realtime model
  POST /api/sessions/{id}/events ---->  JSONL log (transcript, tool calls, latency)
```

- **The API key stays on the server.** The browser gets a secret that expires in two minutes and already carries the instructions, tool schema, and audio settings.
- **Audio never touches the backend**, so it adds nothing to voice latency.
- **One deck file drives everything.** `backend/decks/<name>/deck.json` is rendered by the UI, compiled into the system prompt, and used as the list of facts the agent may state.

### Decks

A deck carries both what is presented and how. Besides the slides, each `deck.json` has:

- `name`, and optional `tagline`, `badge`, `pronunciation` and `disclaimer`: shown in the UI and used in the prompt.
- `agent`: who the agent is and who it is talking to.
  - `role`: the opening of the prompt, e.g. "You are a medical science liaison presenting Cardiovex to a physician over a voice call."
  - `audience`: how the agent refers to the listener ("physician"); used in the rules, tool descriptions, greeting and closing.
  - `style`: tone lines added before the general voice rules.
  - `out_of_scope` and `refusal_line`: topics to decline and the exact words to decline with.
  - `guardrails`: extra rules added to the general ones (facts only, no role changes).

The prompt template in `prompt.py` holds only the rules that apply to every deck. To switch decks, add a folder under `backend/decks/` and set `DECK=<folder>` in `.env`; no code changes. The deck is validated at startup, so a missing field fails fast.

### Slides are made of blocks

Each slide has two to four typed blocks (`stat`, `chart`, `table`, `steps`, `callout`). A block carries what is drawn, a talking point for the agent to paraphrase, and its approved facts. Because the unit of grounding is also the unit of highlighting, the viewer can see where each answer came from.

### Who decides what

The first version let the model drive the deck with a tool call per block. A smaller model would speak one block and then wait, so the user had to keep saying "continue". The split now is:

- **The app sequences.** A small state machine in `useRealtimeSession.ts` owns a cursor into the deck. It sends the model a `PRESENT` note with one block's talking point and highlights that block. Shortly before that block's audio ends it asks for the next one, so the pause between blocks is short, and it moves the cursor and the highlight when the voice crosses over. No tool call is needed to narrate.
- **The model judges.** When the user speaks, the model picks one of three tools: `show_answer(slide_id, block_id)` for a question, `continue_presentation()` to resume, `present_slide(slide_id)` to go to a slide. Off-topic questions get a spoken refusal and no tool.

State transitions:

| Event | What happens |
|---|---|
| A block is close to finishing | The next block is requested (`NEXT_BLOCK_LEAD_MS` before the end, 700 ms by default) |
| Block audio finishes | Cursor and highlight move to the next block. After the last block, a closing line |
| User interrupts | Server cancels speech. Cursor stays on the interrupted block; a block requested ahead but not yet heard is discarded |
| `show_answer` | Slide and block are highlighted as the answer source; facts are returned in the tool result; the model answers |
| Answer or refusal finishes | Wait five seconds; if the user is silent, resume from the cursor |
| `continue_presentation` | Resume from the cursor at once |
| `present_slide` or a thumbnail click | Cursor moves to that slide's first block; presenting continues from there |
| Stop talking | Speech is cancelled; nothing resumes until the user speaks or clicks |
| Pause | Speech is cancelled, microphone muted, position held; Resume presents the cursor block again |

A turn counts as finished only when the model has stopped generating and the audio has stopped playing. The model generates faster than it speaks, so acting on generation alone would change the slide mid-sentence.

Timing the hand-over needs to know when a block's audio ends. Output audio is 50 ms per audio token, and the token count arrives with `response.done`, so the app computes the end time instead of waiting for silence. `NEXT_BLOCK_LEAD_MS` in `.env` sets how early the next block is requested: smaller gives a longer pause, a very large value removes the pause. `?lead=500` in the URL overrides it for one call.

### Interface

- **Welcome screen** until the first call connects, then the workspace: the slide, a filmstrip, and a side panel.
- **The slide scales like a real slide.** Every size inside it is in container units, so the same component draws the stage, the filmstrip thumbnails, and the welcome preview.
- **The highlighted block says why it is highlighted**: teal "Presenting" while the agent narrates, amber "Source for this answer" when it answers a question.
- **The voice visual is live**, in one of two styles chosen at build time with `VITE_VOICE_VISUAL` in `.env` (rebuild after changing it; for Docker, `--build-arg VITE_VOICE_VISUAL=orb`):
  - `wave` (default): a bar waveform that follows the agent's audio while it speaks and the microphone while it listens.
  - `orb`: an orb for the presenter. It swells with the agent's voice, breathes while listening with a ring that follows the microphone, and swirls while thinking. Teal while presenting, amber while answering from a source, grey when inactive, red on error.

  Either way the user can see they are heard. The analysers are display only.
- Plain CSS in `frontend/src/styles/`, Inter bundled with the app, no UI library. Motion respects `prefers-reduced-motion`.

### Interruption

Turn detection runs on OpenAI's side (semantic VAD with `interrupt_response`). When you start speaking, the server cancels the response and drops unplayed audio. The browser reacts to `input_audio_buffer.speech_started` by marking the transcript line as interrupted and discarding any queued tool call. **Stop talking** and thumbnail clicks do the same by hand with `response.cancel` and `output_audio_buffer.clear`, and wait for the cancel to be confirmed before asking for new speech.

### Guardrails

- Prompt: state only what is in the facts; fixed refusal line for off-label, competitor, pricing, and individual patient questions.
- Facts are re-supplied at the moment of speaking, in the PRESENT note or the tool result.
- Server: per-IP session limit, ten-minute call cap, optional access code.

## Layout

```
backend/decks/
  cardiovex/deck.json   the six slides and how the agent presents them
backend/app/
  deck.py        pick (DECK), load and validate
  prompt.py      system instructions and tool schema, built from the deck
  realtime.py    session config, ephemeral secret
  routes.py      /api endpoints, rate limit, event log
  main.py        app, static file serving
frontend/src/
  hooks/useRealtimeSession.ts   WebRTC call, events, tool calls, interruption
  components/SlideView.tsx      the slide: layouts, transitions, highlight
  components/Blocks.tsx         one renderer per block type
  components/Panel.tsx          voice card, controls, transcript
  components/VoiceVisual.tsx    live waveform (VITE_VOICE_VISUAL=wave)
  components/VoiceOrb.tsx       live orb (VITE_VOICE_VISUAL=orb)
  components/Welcome.tsx        start screen
  components/Icons.tsx          inline icons
  styles/                       tokens, slide, panel
backend/scripts/simulate.py     typed, text-only run against the real API
```

## Trade-offs and limits

- **Speech-to-speech over a custom STT, LLM, TTS pipeline.** Lower latency and far less code, at the cost of less control over each stage and a single vendor.
- **Each block is its own model turn**, so there is a short pause between blocks; its length varies with how quickly the model starts speaking. No word-level highlighting: the API gives no word timings for spoken audio.
- **Grounding is by prompt and tool result, not enforced.** A production system in a regulated setting would add an output check against approved claims before audio is released.
- **Rate limit is in memory** and trusts `X-Forwarded-For`; fine for one demo instance.
- The user transcript comes from a separate transcription model and can differ slightly from what the voice model heard.

## Next steps

- Automated evaluation: replay the utterances above as audio or text and score slide, block, and factual accuracy.
- Retrieval over real prescribing information instead of a fixed fact list.
- Server-side session relay for audit logging and claim checking.
- Deck authoring, and choosing a deck per call instead of per server.
