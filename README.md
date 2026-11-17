# Voice-led slide presenter

An AI voice agent that presents a deck of six slides behind a title page, jumps to the right slide when you ask a question, and stops talking the moment you interrupt.

**Live demo: https://voice-slide-presenter.onrender.com/** (the access code is in the submission email; to run it on your own machine with your own key, see [Run it](#run-it). The first load can take about a minute while the free instance wakes).

Press **Start presentation**, allow the microphone, then try:

1. Say nothing: it presents the whole deck on its own.
2. Cut in with "What are the side effects?": it stops, shows the Safety slide and highlights the table it answers from.
3. Stay quiet: after five seconds it goes back to where you interrupted.

More in [What to try](#what-to-try). How it works is in [Architecture](#architecture).

The deck is a detail aid for **Cardiovex, a fictional drug**, presented to a physician. The agent answers only from the deck's approved facts.

## Run it

### 1. Use your own OpenAI key

The live demo runs on my key behind an access code. To run it yourself, use your own:

1. Get an API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys). It needs billing set up and access to the Realtime API; a ChatGPT subscription is not an API key.
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY` to that key.
3. Leave `DEMO_ACCESS_CODE` empty. No access code is needed locally; it only protects the public demo.

The key stays on your machine: `.env` is git-ignored, and the browser only ever receives a session token that expires in two minutes. The server reads `.env` when it starts, so restart it after changing the file.

### 2a. Quickest: Docker

Needs only Docker; no Python or Node.

```bash
docker build -t presenter .
docker run -p 8000:8000 --env-file .env presenter
```

### 2b. Without Docker

Needs Python 3.11+ and Node 20+.

macOS / Linux:

```bash
cp .env.example .env          # then put your key in OPENAI_API_KEY
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
cd frontend && npm install && npm run build && cd ..
cd backend && ../.venv/bin/uvicorn app.main:app --port 8000
```

Windows (PowerShell):

```powershell
copy .env.example .env        # then put your key in OPENAI_API_KEY
py -m venv .venv
.venv\Scripts\pip install -r backend\requirements.txt
cd frontend; npm install; npm run build; cd ..
cd backend; ..\.venv\Scripts\uvicorn app.main:app --port 8000
```

### 3. Open it

Open http://localhost:8000, press **Start presentation**, and allow the microphone. Headphones give the cleanest interruption.

- **Open it as `localhost`.** Browsers only allow the microphone on `localhost` or HTTPS, so `http://<another-machine's-ip>:8000` will not get mic access. To use it from another machine, put it behind HTTPS (or deploy it as below).
- To watch it without a microphone, open http://localhost:8000/?silent: the agent presents the whole deck to a silent input.
- "Server is missing OPENAI_API_KEY" when you press Start means `.env` has no key, or the server was started before you added it.

### Development and tests

- Frontend development: run `npm run dev` in `frontend/` alongside the backend; Vite proxies `/api` to port 8000.
- Tests: `cd backend && ../.venv/bin/python -m pytest` for the backend (Windows: `..\.venv\Scripts\python -m pytest`), `cd frontend && npm test` for the presentation flow.

### Deploy

The live demo runs on Render's free tier from `render.yaml`: one Docker web service that builds the frontend and serves it from FastAPI. In Render, choose **New > Blueprint**, pick this repository, and fill in the two secrets it asks for: `OPENAI_API_KEY` and `DEMO_ACCESS_CODE` (visitors enter the code before a call starts, so a public URL can't spend the key). Every push to `main` redeploys.

- Settings such as `REALTIME_MODEL`, `DECK` and the call limits can be changed in the service's Environment tab; **Save and deploy** applies them.
- A free service sleeps after 15 minutes without traffic and takes about a minute to wake. A free uptime monitor requesting `/api/health` every few minutes keeps it awake.
- The free instance (0.1 CPU, 512 MB) is enough: the server uses about 65 MB, and call audio goes from the browser straight to OpenAI, never through it. Session logs are lost when the service restarts.

## What to try

| Do or say | Expect |
|---|---|
| Nothing | The agent greets you over the title page, then presents every block of every slide without prompting |
| "What are the side effects?" mid-sentence | Speech stops, the Safety slide appears, the adverse-event table is highlighted |
| Stay quiet after the answer | After five seconds it returns to the block you interrupted and carries on |
| "Continue" after an answer | Same, immediately |
| "How do I dose it?" | Jumps to Dosing |
| "Is it better than drug X?" / "What does it cost?" | Polite refusal, pointer to Medical Information, no slide change |
| "Go back to slide two" | Presents the Mechanism slide from its start and continues from there |
| Click a slide thumbnail | The agent stops and presents that slide straight away |
| Press **Stop talking**, then **Continue** | Audio stops and it waits for you; Continue picks up the block it stopped on |
| "Is this a real drug?" | Says it is fictional |
| Stay quiet after the closing line | After 15 seconds the call ends on its own; a question first keeps it open, and the 15 seconds start again after the answer |

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
- A first slide with `"layout": "cover"` is the title page. Its `subtitle` is the line shown under the name, and its one block's talking point is what the greeting says the presentation is about.
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

- **The app sequences.** A small state machine, the `Presenter` in `frontend/src/session/presenter.ts`, owns a cursor into the deck. It holds deck logic only: `responses.ts` tells it when the model has finished a turn and cancels one safely, and `transcript.ts` records what was said. It opens with a greeting spoken over the title page (a `GREET` note), then asks the model to speak one block from a `PRESENT` note holding that block's talking point, and highlights that block. Each note goes out as a clean prompt (the system instructions plus the note, not the conversation so far), so leftovers such as an earlier answer instruction or background noise cannot pull the model off script; what it says still joins the conversation. When that block's audio has finished playing, it moves on to the next one. No tool call is needed to narrate.
- **The model judges.** When the user speaks, the model picks one of three tools: `show_answer(slide_id, block_id)` for a question, `continue_presentation()` to resume, `present_slide(slide_id)` to go to a slide. Off-topic questions get a spoken refusal and no tool.

State transitions:

| Event | What happens |
|---|---|
| Block audio finishes | Cursor and highlight move to the next block, which is requested. After the last block, a closing line |
| User interrupts | Server cancels speech. Cursor stays on the interrupted block |
| `show_answer` | Slide and block are highlighted as the answer source; facts are returned in the tool result; the model answers |
| Answer or refusal finishes | Wait five seconds; if the user is silent, resume from the cursor |
| `continue_presentation` | Resume from the cursor at once |
| `present_slide` or a thumbnail click | Cursor moves to that slide's first block; presenting continues from there |
| Stop talking | Speech is cancelled; nothing resumes until the user speaks or clicks. The button becomes Continue, which resumes from the cursor |
| Closing line, or an answer after it, finishes | Wait 15 seconds; if the user is silent, the call ends. Speech, a slide click or Stop talking cancels the wait |

A turn counts as finished only when the model has stopped generating and the audio has stopped playing. The model generates faster than it speaks, so acting on generation alone would change the slide mid-sentence.

The Presenter has no React, WebRTC or DOM in it: it takes server events and button presses, and acts through functions it is given. `presenter.test.ts` drives it with scripted events, one test per thing a listener can do (ask a question, interrupt, say "continue", ask for a slide, press Stop).

### Interface

- **Welcome screen** until the first call connects, then the workspace: the slide, a filmstrip, and a side panel.
- **The title page is the deck's first slide**, drawn by the `cover` layout: name, one-line description, the agenda, and a reminder that you can interrupt. It has a thumbnail like any other slide, and the agent greets over it in two short sentences.
- **The slide scales like a real slide.** Every size inside it is in container units, so the same component draws the stage, the filmstrip thumbnails, and the welcome preview.
- **The highlighted block says why it is highlighted**: teal "Presenting" while the agent narrates, amber "Source for this answer" when it answers a question.
- **The voice visual is live.** An orb swells with the agent's voice, breathes while listening with a ring that follows the microphone, and swirls while thinking, so the user can see they are heard. Teal while presenting, amber while answering from a source.
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
  cardiovex/deck.json   the title page, the six slides, and how the agent presents them
backend/app/
  deck.py        pick (DECK), load and validate
  prompt.py      system instructions and tool schema, built from the deck
  realtime.py    session config, ephemeral secret
  routes.py      /api endpoints, rate limit, event log
  main.py        app, static file serving
frontend/src/
  session/presenter.ts          the presentation flow: cursor, tool calls, timers
  session/responses.ts          the model's current response: when a turn is over, safe cancelling
  session/tools.ts              tool call -> action (pure), incl. loose id matching
  session/notes.ts              GREET / PRESENT / CLOSE notes sent to the model (pure)
  session/transcript.ts         the on-screen transcript, built from server events
  session/connection.ts         the WebRTC call to OpenAI
  session/audio.ts              microphone and level meters
  hooks/useRealtimeSession.ts   React glue: wires the call, the Presenter and the backend
  components/SlideView.tsx      the slide: layouts, transitions, highlight
  components/Blocks.tsx         one renderer per block type
  components/Panel.tsx          voice card, controls, transcript
  components/VoiceOrb.tsx       live voice orb
  components/Welcome.tsx        start screen
  components/Icons.tsx          inline icons
  styles/                       tokens, slide, panel
backend/scripts/simulate.py     typed, text-only run against the real API
```

## How to extend

- **A new deck:** add `backend/decks/<name>/deck.json` and set `DECK=<name>`. No code changes.
- **A new block type:** add its content type in `frontend/src/types.ts`, one renderer in `components/Blocks.tsx`, and its name to `BLOCK_TYPES` in `backend/app/deck.py`.
- **A new voice command:** add the tool to `build_tools` in `backend/app/prompt.py`, one case in `frontend/src/session/tools.ts` that turns it into an action, and one case in the Presenter's `runToolCall`.

## Trade-offs and limits

- **Speech-to-speech over a custom STT, LLM, TTS pipeline.** Lower latency and far less code, at the cost of less control over each stage and a single vendor.
- **Each block is its own model turn**, requested once the previous block's audio ends, so there is a pause between blocks while the model starts speaking (measured at about 1.2 s, sometimes longer, before the version below). An earlier version requested the next block ahead of time to shorten this (median 0.8 s); it was removed because it roughly doubled the state the presenter had to track. It could come back as a separate module. No word-level highlighting: the API gives no word timings for spoken audio.
- **Grounding is by prompt and tool result, not enforced.** A production system in a regulated setting would add an output check against approved claims before audio is released.
- **What the model is told lives in two places.** The system prompt and tool schema are built in `backend/app/prompt.py`; the `GREET`, `PRESENT` and `CLOSE` notes are written in `frontend/src/session/notes.ts`, because the browser is what sequences the deck. Moving the presenter to the backend (see next steps) would bring them together.
- **Rate limit is in memory** and trusts `X-Forwarded-For`; fine for one demo instance.
- The user transcript comes from a separate transcription model and can differ slightly from what the voice model heard.

## Next steps

- Automated evaluation: replay the utterances above as audio or text and score slide, block, and factual accuracy.
- Retrieval over real prescribing information instead of a fixed fact list.
- Move the presenter to the backend: keep audio on WebRTC between the browser and OpenAI, and have the server join the same call over OpenAI's sideband WebSocket (`?call_id=`) to sequence the deck, answer tool calls, log every event, and check answers against approved claims.
- Deck authoring, and choosing a deck per call instead of per server.
