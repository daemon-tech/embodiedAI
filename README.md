# LAURA — Learning, Autonomous, Universal, Reasoning, Agent

LAURA is an **autonomous coding agent** that runs inside an Electron app. She has a continuous “mind loop”: she decides what to do (via an LLM), performs actions (read/write files, run commands, browse, chat), reflects on outcomes, and learns. She uses a **brain-like memory** (thoughts, episodes, semantic facts, neurons/synapses, embeddings) and **curiosity** to suggest what to explore. The UI shows her reasoning live (Cursor-style), her vitals (hormones, emotions), and a chat panel to talk to her. Core logic is **read-only**; only `mind/agent_extensions.js` is editable by the agent so she can change her identity and prompts without breaking the system.

---

## Quick start

**Requirements:** Node.js, [Ollama](https://ollama.ai) (or OpenAI-compatible API, or built-in llama.cpp).

```bash
npm install
npm start
```

1. **Ollama:** Install and run `ollama serve`, then pull a model, e.g. `ollama pull qwen3:8b`. Set `ollamaModel` in `config.json` to match.
2. **First run:** The app loads `config.json`, creates memory/perception/action/thinking/curiosity/embedding/metrics, starts the mind loop, and opens the window. Add **allowed directories** (e.g. via “Choose folder” or by editing `config.json` `allowedDirs`) so Laura can read/write there.
3. **UI:** HUD shows status (Autonomous / Paused), stats (paths, thoughts, neurons), vitals (D/C/S bars), model selector, Think / Pause / Focus. The **Vitals** drawer shows hormones, emotions, brain stats, loop interval, and speed/latency metrics. **Chat** lets you talk to her; she replies using the same memory and goals as the loop. Use 👍/👎 to send human feedback so she can adapt.

---

## Architecture overview

Everything runs in the **Electron main process** except the UI (renderer). The heartbeat is the **mind loop** in `mind/loop.js`: every N ms it runs one “tick.”

**One tick (simplified):**

1. **Curiosity** suggests paths/URLs to explore (least recently explored, optionally weighted by goals).
2. **Thinking** builds a large prompt from memory (state, goals, plan, last actions, facts, episodes, semantic retrieval via embeddings) and calls the **LLM** to get the next action (e.g. `read_file`, `edit_code`, `run_terminal`, `think`, `self_dialogue`).
3. **Loop** checks **allow** rules (path, host, command, edit_code only for allowed dirs or `mind/agent_extensions.js`; core files are read-only).
4. **Perception** or **Action** executes (read file, list dir, fetch URL, write file, run terminal, edit code, etc.). **Memory** is updated (explored paths/URLs, last action, episodes).
5. **Thinking** produces a short **reflection** sentence and optionally **learns** one sentence; these are stored as thoughts and semantic facts. Optionally **embeddings** are stored for similarity search later.
6. **Hormones** (dopamine, cortisol, serotonin) and **emotions** are updated; **metrics** (timings, activity phase) are recorded.
7. Periodically: **deepReflect** (self-summary, goals, facts), **metaReview** (strategy, self-instructions), **archive** (old thoughts/episodes/facts to `archive.json.gz`).
8. The **renderer** receives `thought`, `hormones`, `activity`, `metrics`, etc., and updates the HUD and chat.

So: **Curiosity → Thinking (LLM) → Allow checks → Perception/Action → Memory + Reflection + Learning → Metrics/Archive → Next tick.**

---

## Directory layout

| Path | Role |
|------|------|
| `main.js` | Electron entry: load config, create Memory/Perception/Action/Thinking/Curiosity/Embedding/Metrics/MindLoop, IPC handlers, window. |
| `config.json` | User-editable config (paths, hosts, LLM, intervals, caps, dry-run, etc.). |
| `preload.js` | Context bridge: exposes safe `window.api` (invoke + subscribe) for the renderer. |
| `llama-cpp.js` | Optional: download and run llama.cpp server + Qwen3 GGUF for local LLM without Ollama. |
| **mind/** | |
| `loop.js` | Mind loop: tick(), allow checks, execution branches, hormones, save, runaway detection, archive trigger, dry-run. |
| `thinking.js` | LLM: decideAction, reflect, innerReflect, learnFromAction, chat, deepReflect, metaReview, replan, judgeAction. Uses Ollama/OpenAI and optional embedding for retrieval. |
| `memory.js` | Persistent “brain”: load/save, thoughts, episodes, semanticFacts, state (goals, plan, workingMemory, hormones, emotions), embeddings, similaritySearch, archive, audit log, hormone reset. |
| `perception.js` | readFile, listDir, fetchUrl (within allowed dirs/hosts); updates memory exploredPaths/exploredUrls. |
| `action.js` | writeFile, openUrl (browser), speak (TTS via renderer), httpRequest. |
| `curiosity.js` | getSuggestions(): suggests read_file, list_dir, fetch_url, browse from least-recently-explored paths/URLs; recursive up to `curiosityDepth`; weighted by goal keywords. |
| `embedding.js` | embed(text): Ollama or OpenAI embeddings; used for vector storage and similarity search in memory. |
| `metrics.js` | setActivity(phase), recordTiming(name, ms), recordCount(name), getMetrics(), getResourceUsage(). |
| `allow.js` | isAllowedPath, isAllowedHost, isAllowedUrlProtocol, isAllowedCommand, isRiskyCommand, isAgentExtensionsPath. |
| `safety_principles.js` | Read-only list of safety principles; injected into AGI context; agent cannot edit. |
| `agent_extensions.js` | **Only agent-editable file.** Identity, systemPrompt, chatPrompt, extraPrompt, featureNotes, defaultSelfSummary, defaultAGISelfModel, seedFacts. |
| **src/renderer/** | |
| `index.html` | UI: scene container, HUD (stats, vitals, model, Vitals drawer, Think/Pause/Focus), chat panel, toast. |
| `renderer.js` | Subscribes to thought, hormones, log, activity, metrics, inner-thought, etc.; updates DOM; chat send; feedback buttons; simulation badge. |
| `scene.js` | Three.js scene: teal orb, neural nodes, motion/glow by action type and hormones. |
| **test/** | Unit tests: allow.test.js, memory.test.js, thinking.test.js, loop.test.js. |

**Persistence (Electron `userData`):**

- `memory.json` — main memory (thoughts, logs, state, episodes, semanticFacts, chatHistory, etc.).
- `memory_brain.json` — optional; embeddings, neurons, synapses (can be split for size).
- `archive.json.gz` — archived old thoughts, episodes, semanticFacts, chatHistory (gzip).
- `audit_log.json` — audit log of actions (type, args, outcome).

---

## Main process (`main.js`)

- **On ready:** Load `config.json` (with defaults from `getDefaultConfig()`). Optionally start **llama.cpp** (if `useLlamaCpp`), then create **Memory** (with paths for memory, brain, archive, audit log), **Perception**, **Action**, **Embedding**, **Thinking**, **Curiosity**, **Metrics**, **MindLoop**. Create window, start loop, optionally preload Ollama model.
- **IPC:** Handlers for get/set config, memory stats, metrics, activity, hormones, living state, thoughts, logs, chat history, goals, human feedback, send-chat, think-once, pause/resume, speak, browse, read-file, list-dir, write-file, fetch-url, choose-folder, **add-allowed-dir**, **add-allowed-host**, save-config, get-ollama-models, set-model, test-ollama, get-models-path, get-resource-usage.
- **sendToRenderer:** Used to push `thought`, `hormones`, `log`, `loop-status`, `error`, `inner-thought`, `self-conversation`, `chat-thinking`, `activity`, `metrics`, `toast`, `ollama-unavailable` to the renderer.

---

## Mind modules

### `loop.js` — The heartbeat

- **Constructor:** Receives memory, perception, action, thinking, curiosity, config, sendToRenderer, embedding, metrics.
- **tick():** If not paused: decay hormones (and call `memory.checkHormoneReset`), decay emotions, increment tick count, get **suggestions** from curiosity, call **thinking.decideAction()** (with timeout 90s). On failure: increment consecutive LLM errors, send toast if ≥2, fallback action + replan. Apply **runaway** checks (same action repeated → rest + replan; consecutive errors → replan). Apply **allow** checks for path/host/command/edit_code/clipboard; if any fail, replace action with think. **Execute** by type: read_self, read_file, list_dir, fetch_url, browse, write_file, delete_file, clipboard, write_journal, rest, self_dialogue, run_terminal, edit_code, or generic reflect. For **run_terminal** and **edit_code**, results are **audit-logged**; after risky run_terminal or edit_code on agent_extensions, **metaReview** is triggered. If **dryRun** is true, read_file/list_dir/run_terminal/edit_code are simulated (no real I/O). Then: add last action, apply outcome to recent concepts, **learnFromAction** (and optionally embed), **innerReflect**, add thought (and optionally embed), add episode for think/rest/self_dialogue, add log, update capability register, record **metrics**, **archive** every `archiveEveryTicks`, optional **deepReflect** / **metaReview**, send thought + metrics to renderer, debounced save, **schedule next** tick. **\_scheduleNext** doubles the interval when `metrics.getResourceUsage().rssMB >= highLoadMemoryMB` (throttle under load).

### `memory.js` — Persistent brain

- **Stores:** exploredPaths, exploredUrls, thoughts, logs, embeddings, chatHistory, innerThoughts, neurons, synapses, episodes, semanticFacts, state (goals, plan, workingMemory, hormones, emotions, lastError, lastHumanFeedback, selfSummary, agiSelfModel, selfInstructions, capabilityRegister).
- **Caps:** MAX_THOUGHTS, MAX_EPISODES, MAX_SEMANTIC_FACTS, MAX_CHAT (300), MAX_CHAT_MESSAGE_CHARS (1000), MAX_EMBEDDINGS, etc.
- **Key methods:** load/save, getAGIContext (self model + safety + human feedback), getWorkingContext, addThought (and concept extraction + synapses), addEmbedding, similaritySearch, addEpisode, addSemanticFact, addChatMessage (truncated), getChatHistory, getRecentThoughts/Episodes/Facts, getArchivedForPrompt, archive (to archive.json.gz), checkHormoneReset (halve hormones if cortisol high for N ticks), addAuditLog. **Brain:** getOrCreateNeuron, connect, applyOutcomeToRecentConcepts, pruneBrain.

### `thinking.js` — LLM core

- **Ollama:** callOllama(prompt, systemPrompt, options) → text or null. Uses Node http/https, 120s timeout.
- **OpenAI:** callOpenAI(...) for chat completions when openaiBaseUrl + openaiApiKey set.
- **callLLM:** Tries OpenAI first if configured, else Ollama.
- **callLLMWithRetry:** Up to 3 retries with exponential backoff; on final failure tries secondaryOllamaModel or the other provider (Ollama ↔ OpenAI).
- **decideAction(perception, options):** Builds prompt from AGI context, state, goals, plan, working memory, last actions, learnings, facts, episodes, **retrieved-by-meaning** (embedding + similaritySearch, k=5 or 10 on error), suggestions; returns { type, nextIntervalMs, reason, path/url/command/... }. Uses callLLMWithRetry. Optional **judgeAction** (useJudge) can replace action with think + suggestion.
- **reflect, innerReflect, learnFromAction, chat, deepReflect, metaReview, replan, judgeAction:** All use callLLM/callLLMWithRetry with appropriate prompts. **Chat** uses dynamic chat history size (20 or 50), token trimming, and similarity retrieval; fallback template replies if LLM fails. **deepReflect** can include **getArchivedForPrompt** for older context.

### `perception.js`

- **readFile(path):** Resolve path, check allowed, stat, size limit, read content, markExploredPath, update totalReads.
- **listDir(path):** List entries, markExploredPath for dir and each item (subpaths).
- **fetchUrl(url):** http/https only, allowed host, request with timeout, markExploredUrl, return status/body.

### `action.js`

- **writeFile(path, content):** Allowed path, size limit 5MB, mkdir + write.
- **openUrl(url):** Allowed protocol/host, shell.openExternal.
- **speak(text):** sendToRenderer('speak-request', text) for TTS in renderer.
- **httpRequest:** Optional fetch helper.

**Note:** `run_terminal` and `edit_code` are implemented **in the loop** (execSync, fs read/write + backup), not in action.js.

### `curiosity.js`

- **pickNextFileToRead:** Recursive list (up to `curiosityDepth`) in allowedDirs, score by least recently explored and by goal keyword match, return top path.
- **pickNextDirToList**, **pickNextUrlToFetch:** Similar scoring (recency + goal keywords).
- **getSuggestions:** Returns { readFile, listDir, fetchUrl, browseUrl } for the loop to pass to decideAction.

### `embedding.js`

- **embed(textOrTexts):** Ollama `/api/embed` or OpenAI embeddings; returns vector(s) or null/[] on failure. Timeout 15s, errors throttled.
- Used by memory (addEmbedding) and thinking (similarity search in decideAction and chat).

### `metrics.js`

- **setActivity(phase, detail):** phase = tick | decide | execute | reflect | idle | error | recovering.
- **recordTiming('decide_ms'|'action_ms'|'tick_ms', ms):** Rolling last 30 samples.
- **recordCount('action'|'thought'):** For actions/thoughts per minute.
- **getResourceUsage():** rssMB, heapMB, systemFreeMem, systemTotalMem.
- **getMetrics():** activity, speed (actions/thoughts per minute), latency (avg/last decide, action, tick), resource.

### `allow.js`

- **isAllowedPath(path, allowedDirs):** Path must be under one of the allowed dirs.
- **isAllowedHost(url, allowedHosts):** Host in list or `*`.
- **isAllowedUrlProtocol(url):** http or https only.
- **isAllowedCommand(cmd, config):** Command must start with an allowed prefix and must not match BLOCKED_PATTERNS (rm -rf, sudo, dd, fork bomb, pipe to sh, etc.).
- **isRiskyCommand(cmd):** Long (>200 chars), multiple pipes, or ;&.
- **isAgentExtensionsPath(path, appPath):** True iff path is `mind/agent_extensions.js`.

### `safety_principles.js`

- Exports **PRINCIPLES** (array of strings) and **getText()** for injection into getAGIContext(). Read-only; agent cannot edit.

### `agent_extensions.js`

- Exports: **identity**, **systemPrompt**, **chatPrompt**, **extraPrompt**, **featureNotes**, **defaultSelfSummary**, **defaultAGISelfModel**, **seedFacts**. Loaded by memory and thinking; agent can **edit_code** this file only (with core files locked).

---

## Action types (what the agent can do)

| Type | Args | Effect |
|------|------|--------|
| read_file | path | Perception.readFile; mark path explored. |
| list_dir | path | Perception.listDir; mark dir + items explored. |
| write_file | path, content | Action.writeFile. |
| delete_file | path | fs.unlink (in loop). |
| fetch_url | url | Perception.fetchUrl. |
| browse | url | Action.openUrl (external browser). |
| read_self | target: memory_summary \| config \| code \| all | Read self-model/config/app code; optional updateSelfSummaryFromReading. |
| edit_code | path, oldText, newText | Read file, replace exact oldText→newText, backup, write; path must be allowed or agent_extensions.js; core files read-only. |
| run_terminal | command | execSync in workspace; allowed prefixes + blocked patterns (allow.js). |
| read_clipboard / write_clipboard | text (for write) | Electron clipboard (if allowClipboard). |
| write_journal | — | Append line to userData/journal.txt. |
| rest / think | — | No I/O; reflect only. |
| self_dialogue | — | Multi-turn self-conversation; conclusion stored and used on next decide. |

---

## Config (`config.json` and defaults)

| Key | Meaning |
|-----|--------|
| workspacePath, allowedDirs, allowedHosts | Where the agent can read/write and which URL hosts are allowed. |
| ollamaUrl, ollamaModel, openaiBaseUrl, openaiApiKey | LLM: Ollama and/or OpenAI-compatible. |
| embeddingModel | e.g. nomic-embed-text for embeddings. |
| thinkIntervalMs, minIntervalMs, maxIntervalMs | Bounds for next tick delay. |
| continuousMode, focusMode | Shorter intervals; focus prefers read_self/think. |
| curiosityWeight, curiosityDepth | Weight and recursion depth for curiosity suggestions. |
| useJudge, metaReviewEveryTicks, runawaySameActionThreshold, runawayConsecutiveErrors | Judge step, meta-review period, runaway thresholds. |
| dryRun | If true, read_file/list_dir/run_terminal/edit_code are simulated (no real I/O). |
| archiveEveryTicks, highLoadMemoryMB | Archive period; throttle when RSS exceeds this MB. |
| chatHistoryCap, maxChatMessageChars | Chat history size and per-message truncation. |
| hormoneResetCortisolThreshold, hormoneResetTicks | Reset hormones (halve) when cortisol ≥ threshold for this many ticks. |
| allowClipboard, allowedCommandPrefixes | Clipboard and allowed command prefixes for run_terminal. |
| appPath | App root (for resolving agent_extensions and core paths). |

---

## Renderer and preload

- **preload.js:** Exposes `window.api` with invoke handlers (getConfig, getMemoryStats, sendChat, thinkOnce, pauseLoop, resumeLoop, addAllowedDir, addAllowedHost, …) and subscribe (onThought, onHormones, onLog, onActivity, onMetrics, onToast, onError, …).
- **index.html:** Single-page UI with HUD (brand, status, stats, vitals, model block, Vitals drawer, Think/Pause/Focus/Voice, simulation badge), main area (rail with current thought, goals, tabs: Thoughts / Self-talk / Inner / Activity), center (Three.js scene), chat panel (messages, live block, feedback row, input). Styles use CSS variables (teal accent, dark theme).
- **renderer.js:** Subscribes to thought (updates current thought, reason, action, metrics, hormones, goals), inner-thought, self-conversation, hormones, log, activity, metrics, loop-status, error, toast; initializes metrics and simulation badge from config; handles chat send, feedback buttons, Think once, Pause, Focus, Continuous, Voice; loads goals/thoughts/logs; resizable chat panel.
- **scene.js:** Three.js scene (teal orb, neural nodes, ring); init/update/resize/setMode/setNeuralStats; motion and glow depend on action mode and hormones.

---

## Security and safety

- **Paths:** Only under `allowedDirs` (or appPath for agent_extensions.js).
- **URLs:** Only http/https and hosts in `allowedHosts`.
- **Commands:** Must match `allowedCommandPrefixes` and not match BLOCKED_PATTERNS (e.g. rm -rf, sudo, dd, fork bomb, pipe to sh).
- **edit_code:** Allowed only for files in allowedDirs or `mind/agent_extensions.js`. **Core files** (loop, memory, thinking, action, perception, curiosity, embedding, allow, safety_principles, main) are **read-only**.
- **safety_principles.js** is read-only and injected into every AGI context.
- **Audit log:** run_terminal and edit_code outcomes are appended to `audit_log.json`. Risky run_terminal or edit_code on agent_extensions triggers a metaReview.

---

## Tests

- **test/allow.test.js:** isAllowedPath, isAllowedHost, isAllowedUrlProtocol, isAllowedCommand (including blocked patterns), isRiskyCommand, isAgentExtensionsPath.
- **test/memory.test.js:** load/save, getState, addThought/getRecentThoughts, setState, getStats, checkHormoneReset, addAuditLog.
- **test/thinking.test.js:** fallbackAction (type, nextIntervalMs, reason).
- **test/loop.test.js:** One tick with mocked perception/action/thinking and dryRun; checks thought added and loop.stop().

Run: `node test/allow.test.js`, `node test/memory.test.js`, `node test/thinking.test.js`, `node test/loop.test.js` (or add `loop.test.js` to `npm test`).

---

## Optional: llama.cpp

If `config.useLlamaCpp` is true, `llama-cpp.js` can download a llama.cpp server binary and a Qwen3 GGUF model, spawn the server on `llamaCppPort`, and set `openaiBaseUrl` so the app uses it as an OpenAI-compatible API. This provides a local LLM without Ollama.

---

## Summary

LAURA is a single-Electron-process autonomous agent: **loop** drives **ticks**; **thinking** uses the **LLM** to decide and reflect; **perception** and **action** (plus loop for run_terminal/edit_code) perform I/O; **memory** holds state, brain, and embeddings; **curiosity** suggests what to explore; **embedding** and **metrics** support retrieval and observability. The **renderer** shows her reasoning, vitals, and chat. Config, allow rules, and safety principles constrain behavior; only **agent_extensions.js** is agent-editable so she can evolve her identity and prompts without breaking the core.
