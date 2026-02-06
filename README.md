# Autonomous Living AI

An **autonomous, curious, thinkable, speakable** AI that runs on **this computer**, figures itself out, and can **read/write**, **browse**, and use **GET/POST** (and more) with full agency. Built with a best-effort scientific model: **curiosity-driven exploration** (information-gap style) and optional **LLM-backed thinking** (Ollama or OpenAI).

## What it does

- **Perception**: Reads files (from allowed directories), lists directories (with shallow recursion), fetches URLs (GET/POST, any headers).
- **Cognition**: LLM (Ollama or OpenAI) decides the next action when available; **Curiosity** engine is used as fallback (least-recently-seen or never-seen paths/URLs). Optional LLM for natural-language “thoughts” and reflections.
- **Action**: Writes files (e.g. its own journal in app data), opens URLs in the system browser, speaks thoughts via TTS, and performs HTTP requests.
- **Memory**: Persistent JSON store of explored paths/URLs, thoughts, and activity logs so it learns the environment over time.
- **Rights**: Runs as an Electron app with full Node/OS access you grant (allowed dirs, optional API keys). It can do everything you allow in config.

## Tech stack (overkill)

| Layer        | Tech |
|-------------|------|
| Runtime     | **Electron** (main + renderer, IPC) |
| Perception  | Node **fs**, **http**/**https** (no external fetch for core) |
| Memory      | JSON file in `userData` |
| LLM (primary) | **Ollama** (local) or **OpenAI-compatible** API for action choice and thought generation |
| Curiosity (fallback) | Information-gap style when LLM unavailable or fails |
| UI          | Vanilla JS + CSS (no build), TTS via **SpeechSynthesis** |
| HTTP        | GET/POST from main process; renderer can trigger any URL + optional JSON body |

## Quick start

1. **Install and run**
   ```bash
   npm install
   npm start
   ```
2. **Add folders** the AI is allowed to read (and optionally write): click **Add folder** and choose a directory (e.g. your project or Documents). It will list/read files under that tree (depth 2).
3. **Let it run**: The loop runs every few seconds (see `config.json` → `thinkIntervalMs`). It will read files, list dirs, fetch URLs, open links in the browser, write to its journal, and “think” (with or without an LLM).
4. **Optional LLM**
   - **Ollama**: Install [Ollama](https://ollama.com). With **llama.cpp** (default): app downloads **Qwen3-8B Q4_K_M** (~5GB) on first run. With Ollama: default model **qwen3:8b**; pull and run: `ollama run qwen3:8b`. Set `ollamaModel` in config for others. Set `ollamaModel` and `ollamaUrl` in `config.json` if needed.
   - **OpenAI**: Set `openaiBaseUrl` and `openaiApiKey` in `config.json`.

### CPU vs GPU (why only CPU/memory is used)

The app only sends HTTP requests to **Ollama**; Ollama runs the model and decides whether to use the GPU or CPU. If you see high CPU and RAM but low GPU usage:

- **Use the GPU**: On Windows with an NVIDIA GPU, Ollama uses it by default. Ensure you have recent NVIDIA drivers (e.g. 531+). If Ollama is still using CPU, quit Ollama completely, then start it again (e.g. from the tray or `ollama serve`) and run a model once (`ollama run qwen2.5:3b`). Watch Task Manager: GPU should go up when the model is answering.
- **Don’t force CPU**: Avoid setting `CUDA_VISIBLE_DEVICES=-1` (that forces CPU). Leave it unset so Ollama can use the GPU.
- **VRAM**: Models like **qwen3:8b-q4** fit easily on an RTX 4070. If you use a much larger model and VRAM is full, Ollama may offload some layers to CPU, which increases CPU and RAM use.
- **This app**: The 3D orb in the UI is lightweight; almost all heavy work is inside the Ollama process.

## Config (`config.json`)

- **workspacePath** / **allowedDirs**: Where the AI can read (and where it can write, if you add those paths). Filled on first run or when you use “Add folder.”
- **allowedHosts**: `["*"]` = any host for fetch; restrict to a list of hostnames if you want.
- **thinkIntervalMs**: Delay between autonomous steps (default 8000).
- **curiosityWeight**: Used by Curiosity fallback (when LLM is not used); kept for tuning.
- **speakThoughts**: If `true`, TTS speaks each thought (uses system TTS in the renderer).
- **ollamaUrl** / **openaiBaseUrl** + **openaiApiKey**: Optional LLM for thought text.

## UI

- **Think once**: Run one autonomous step immediately (LLM or Curiosity picks action, then perceive/act/reflect).
- **Thoughts**: Rolling list of thoughts (and optional action badge).
- **Activity log**: Recent explore/read/fetch/browse/write events.
- **Current thought**: Latest thought + action.
- **Voice / Pause**: Toggle TTS and pause/resume the autonomous loop.
- **Error toast**: If the main process reports an error (e.g. config save, decide action, tick), a red toast appears at the bottom for a few seconds.
- **Chat**: Talk to the agent; replies use the same LLM and context (hormones, recent thoughts).

## Safety

- Only **allowedDirs** are used for file read/list; write is limited to journal in `userData` and any path under allowedDirs you expose via future actions.
- **allowedHosts** restrict which URLs can be fetched (default `*`).
- No arbitrary shell/command execution in the autonomous loop; all actions are file/HTTP/browse/speak.

## Files

- **main.js** – Electron main: config load (dedupe allowedDirs), centralized config save, memory/perception/action/thinking/curiosity/loop init, IPC handlers, error reporting to renderer.
- **preload.js** – Context bridge (invoke + subscribe with unsubscribe).
- **src/renderer/index.html** + **renderer.js** – Dashboard: Think once, Voice, Pause, hormone bars (aria), thoughts, activity, chat, error toast.
- **mind/allow.js** – isAllowedPath, isAllowedHost (used by loop, perception, action).
- **mind/memory.js** – Persistent state (explored paths/URLs, thoughts, logs, chat history, hormones).
- **mind/perception.js** – readFile, listDir, fetchUrl (GET/POST); uses allow.js.
- **mind/action.js** – writeFile, openUrl, speak, httpRequest; uses allow.js.
- **mind/thinking.js** – LLM (Ollama + OpenAI) decideAction, reflect, chat, evolve.
- **mind/curiosity.js** – Fallback: picks next action when LLM fails (read_file, list_dir, fetch_url, browse, write_journal, think).
- **mind/loop.js** – Autonomous loop: decideAction (Thinking or Curiosity) → validate path/url → perceive/act → reflect → remember; setTimeout for next tick.
- **config.json** – User-editable config (paths, hosts, LLM, interval).

Memory and journal are stored in Electron `userData` (e.g. `%AppData%/autonomous-living-ai` on Windows).

## Tests

Run unit tests (no Electron):

```bash
npm test
```

Tests cover: `mind/allow.js` (path and host checks), `mind/memory.js` (load/save, addThought, getState), `mind/thinking.js` (fallbackAction).

## Roadmap: optimization & AGI features

See **[docs/ROADMAP_OPTIMIZATION_AND_AGI.md](docs/ROADMAP_OPTIMIZATION_AND_AGI.md)** for a research-backed list of:

- **Optimizations**: prompt compression, retry/backoff, debounced save, adaptive interval, suggestion caching.
- **AGI / human-like features**: goals & intrinsic motivation, episodic & semantic memory, emotional/affective system, attention & working memory, reflection & self-modification, planning & replanning, user model & ethics, meta-learning.

The doc suggests an order of implementation so we build a human step by step on top of the existing LLM core.

## Legacy 3D sim

The previous browser-only 3D embodied sim is still available as **index.html** (open in a browser or use `npm run serve-legacy`). This Electron app replaces it as the “autonomous living AI on this computer” build.
