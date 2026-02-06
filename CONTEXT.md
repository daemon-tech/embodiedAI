# Project Context for LLMs

Use this file to get full context when working on or discussing this codebase.

---

## TL;DR

**What it is:** An Electron desktop app that runs an **autonomous agent** on the user’s machine. **The LLM is the deepest core:** it is implemented at the center of cognition; everything else (memory, perception, curiosity, action) builds on top of it. The agent’s next action is always decided by the LLM (Ollama or OpenAI); Curiosity only **suggests** exploration options (paths/URLs), and the LLM chooses. Thoughts, reflections, inner monologue, and chat are all LLM-generated. On LLM failure the loop uses only a minimal “think” fallback—no separate module replaces the LLM’s decision. The user can add folders, pause, **Think once**, and toggle voice. Errors are reported to the renderer (toast) and console.

**Stack:** Electron (main + renderer), Node.js in main for fs/http, no build step. Memory and config are JSON files. LLM: **llama.cpp** (default on startup: downloads server + Qwen3-8B Q4_K_M GGUF, then uses OpenAI-compatible API), or Ollama, or any OpenAI-compatible API.

**Important paths:** `main.js` = entry + IPC + config; `mind/loop.js` = tick: Curiosity.getSuggestions() → **Thinking.decideAction(perception, { suggestions })** → act → Thinking.reflect() → memory; `mind/thinking.js` = **LLM as core**: decideAction, reflect, innerReflect, chat, evolve; `mind/curiosity.js` = **getSuggestions() only** (suggests read_file/list_dir/fetch_url/browse options; does not decide); `mind/perception.js` / `mind/action.js` = read/list/fetch, write/browse/speak; `mind/memory.js` = state; `mind/allow.js` = path/URL checks; renderer = dashboard.

---

## 1. Purpose and high-level behavior

- **Goal:** A single “living” agent that runs on **this computer**, explores it (files and web), and can read/write, browse, and “think” out loud. **The LLM is the cognitive core:** all behavior is decided by the LLM probabilistically; Memory, Perception, and Curiosity feed it; it decides and reflects; Action executes. Curiosity only suggests exploration options; it never decides the action.
- **Runs as:** One Electron window. Main process owns all privileged behavior (filesystem, HTTP, opening browser). Renderer is a dashboard: thoughts, logs, stats, hormone bars, and controls (Think once, Pause, Voice, chat). Errors from main are sent on the `error` channel and shown as a toast.
- **Autonomous loop:** Every tick: **Curiosity.getSuggestions()** → **Thinking.decideAction(perception, { focusMode, suggestions })** (LLM always decides; one retry with short delay if no response) → path/URL validated with **allow.js** → **perception** / **action** → **memory.addEpisode()**, hormones/emotions, **Thinking.reflect()** (LLM) → **memory.addThought/addLog**, debounced save → **sendToRenderer('thought', { goals, emotions, stats })**. Every N ticks **Thinking.deepReflect()** (self-summary, goals, semantic facts). On failure **Thinking.replan()** and **memory.setLastError()**. On decideAction failure only **Thinking.fallbackAction()** (type: think). Loop uses **setTimeout** for the next tick.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Electron Main Process (Node.js)                                │
│  main.js                                                        │
│    - loadConfig() with dedupe allowedDirs; scheduleConfigSave()  │
│    - Memory, Perception, Action, Thinking, Curiosity, MindLoop   │
│    - IPC: get-config, think-once, pause/resume, save-config, …   │
│    - sendToRenderer('thought'|'log'|'loop-status'|'hormones'|'error')│
├─────────────────────────────────────────────────────────────────┤
│  mind/loop.js     → tick(): curiosity.getSuggestions()           │
│                    → thinking.decideAction(perception, {suggestions})  │
│                    (LLM is core; on failure only think fallback) │
│                    → validate path/url → perception/action       │
│                    → thinking.reflect() → memory → sendToRenderer│
│  mind/thinking.js → LLM as deepest core. callLLM() on every     │
│                    cognition step. decideAction(), reflect(),    │
│                    innerReflect(), chat(), evolve()               │
│  mind/curiosity.js→ getSuggestions() only (suggests paths/URLs;  │
│                    does not decide; LLM chooses)                 │
│  mind/allow.js    → isAllowedPath(path, allowedDirs),            │
│                    isAllowedHost(url, allowedHosts)              │
│  mind/perception.js→ readFile, listDir, fetchUrl (use allow.js)  │
│  mind/action.js   → writeFile, openUrl, speak (use allow.js)     │
│  mind/memory.js   → exploredPaths, exploredUrls, thoughts[],     │
│                    logs[], episodes[], state{hormones, emotions,  │
│                    goals[], plan, lastUserMessage, lastError},     │
│                    semanticFacts[], userModel; addEpisode,         │
│                    getGoals/setGoals/addGoal/completeGoal,         │
│                    getRelevantEpisodes, getWorkingContext,         │
│                    setPlan/advancePlan, decayEmotions              │
└─────────────────────────────────────────────────────────────────┘
        │ IPC (invoke from renderer; send from main; preload exposes
        │ on* that return unsubscribe)
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  Renderer (src/renderer/)                                        │
│  - index.html: Think once, Voice, Pause, hormone bars (aria),     │
│    thoughts, activity, chat; toast for errors (onError)           │
│  - renderer.js: api.thinkOnce(), subscribe to thought/log/        │
│    loop-status/speak-request/error; TTS when voice on             │
└─────────────────────────────────────────────────────────────────┘
```

- **Config** is read at startup; `allowedDirs` are deduped. Saves go through `scheduleConfigSave()` / `flushConfigSave()` so only one write runs at a time.
- **Memory** path is `app.getPath('userData')/memory.json`. Journal path is `userData/journal.txt`.

---

## 3. File-by-file roles

| Path | Role |
|------|------|
| **main.js** | Entry. loadConfig (dedupe allowedDirs). If useLlamaCpp: start llama-cpp (download server + Qwen3-8B Q4 GGUF if needed), set openaiBaseUrl; then create Memory/Perception/Action/Thinking/Curiosity/MindLoop, createWindow, IPC handlers, mindLoop.start(). On quit: llamaCpp.stop(). |
| **config.json** | User-editable. useLlamaCpp (default true), llamaCppPort, ollamaModel (e.g. qwen3:8b), workspacePath, allowedDirs, allowedHosts, ollamaUrl, openaiBaseUrl, openaiApiKey, systemPrompt, thinkIntervalMs, curiosityWeight, maxFileSizeBytes, maxHttpResponseBytes, speakThoughts, browserExternal. |
| **preload.js** | contextBridge: invoke APIs + subscribe(channel, cb) returning unsubscribe; onError for error toast. |
| **mind/allow.js** | isAllowedPath(path, allowedDirs), isAllowedHost(url, allowedHosts). Used by perception, action, loop. |
| **mind/memory.js** | Load/save JSON. Brain: neurons, synapses. state: hormones, emotions, goals[], plan, lastUserMessage, lastError. data: episodes[], semanticFacts[], userModel. addEpisode, getGoals/addGoal/completeGoal/setGoals, getRelevantEpisodes, getWorkingContext, setPlan/advancePlan, decayEmotions, setLastError, setLastUserMessage, updateUserModel, addSemanticFact, getRecentFacts. addThought, getSelfModel, setSelfSummary, getStats (neurons, synapses, episodes, goals), embeddings/similaritySearch, pruneKeys. |
| **mind/perception.js** | Perception(config, memory). readFile, listDir, fetchUrl; all use allow.js and cap sizes. |
| **mind/action.js** | Action(config, sendToRenderer). writeFile, openUrl, speak, httpRequest; path check via allow.js. |
| **llama-cpp.js** | On startup: download llama.cpp server binary (per platform) and Qwen3-8B Q4 GGUF if missing; spawn server; wait until /v1/models responds. Exposes start(options), stop(). Used when config.useLlamaCpp is true. |
| **mind/thinking.js** | **LLM as deepest core.** decideAction uses goals, episodes, emotions, plan, working context; one retry with delay; fallbackAction on failure. reflect, innerReflect, chat (updates lastUserMessage, userModel), updateSelfSummaryFromReading, deepReflect (self-summary, goals, facts), replan, selfCritique, evolve. callLLM: OpenAI-compatible (incl. llama.cpp) first, then Ollama. |
| **mind/curiosity.js** | Curiosity(memory, config). getSuggestions() returns { readFile, listDir, fetchUrl, browseUrl }. Does not decide actions—LLM does. |
| **mind/loop.js** | tick: decayHormones, decayEmotions; getSuggestions → decideAction (on throw: setLastError, replan, fallbackAction); validate path/url; execute action; addEpisode, setLastError/advancePlan; reflect; innerReflect when think/rest or every 3 ticks; addThought, _debouncedSave(); every N ticks deepReflect; send thought with goals, emotions, stats. |
| **src/renderer/index.html** | Top bar (status, stats, hormone bars), Think once, Focus, Voice, Pause; rail (current thought, inner voice, Goals list + add goal input, thoughts, activity); chat panel; toast. |
| **src/renderer/renderer.js** | Subscribes to thought (refreshGoals when goals present), hormones, log, loop-status, speak-request, error. thinkOnce, voice toggle, pause, Goals (refreshGoals, setGoal, completeGoal), chat send. |
| **index.html** (root) | Legacy 3D sim; not used by Electron app. |

---

## 4. Data flow (one autonomous tick)

1. **setTimeout fires** → `MindLoop.tick()`.
2. **Curiosity.getSuggestions()** → `{ readFile, listDir, fetchUrl, browseUrl }`.
3. **Thinking.decideAction(perception, { suggestions })** (LLM only; one retry if no response) → e.g. `{ type: 'read_file', path, nextIntervalMs, reason }` or `read_self`/think/etc. On failure, **thinking.fallbackAction()** (type: think) only.
4. **Loop** validates path/url with `isAllowedPath` / `isAllowedHost`; if not allowed, replaces action with `think`.
5. **read_self:** If type is read_self, build content (getSelfModel(), config JSON, or readAppCode); reflect; optionally updateSelfSummaryFromReading. Else **Perception/Action** → readFile/listDir/fetchUrl/browse/write_journal/rest/think.
6. **Thinking.reflect()** (LLM) → thought string.
7. **Memory** → addThought, addLog, save(); sendToRenderer('thought', …); optionally innerReflect (LLM), addInnerThought, sendToRenderer('inner-thought').
8. **Next tick** → _scheduleNext() (setTimeout).

Manual: Think once, chat, browse, fetch, read file via IPC; errors surface as toast and in console.

---

## 5. Config and safety

- **allowedDirs:** Deduped on load and when adding folders. Only these (and subpaths) for readFile, listDir, writeFile.
- **allowedHosts:** `["*"]` or list of hostnames for fetchUrl; validated in loop and perception.
- **mind/allow.js** used by loop (before calling perception/action), perception, and action. No shell/exec in the loop.

---

## 6. Extending or modifying (for LLMs)

- **New action type:** In **thinking** prompts (ACTION_SCHEMA and decideAction prompt) add the type; in **loop.js** tick() add a case (validate then perception/action), set thought and logPayload. Curiosity only suggests; LLM decides.
- **New perception:** Add method in perception.js (use allow.js); call from loop and optionally store in memory.
- **New UI:** Button in renderer index.html, in renderer.js call window.api.*, in main.js add ipcMain.handle. Use preload subscribe() for new channels if needed (returns unsubscribe).
- **Goals:** User can set a goal via the Goals panel (input + Add) or in chat by starting a message with `goal: <text>`. IPC: get-goals, set-goal, complete-goal. LLM sees active goals and working context (primary goal, last user message, last error) in decideAction; deepReflect can update goals and self-summary.
- **Voice:** Toggle updates config.speakThoughts; renderer only speaks when voice on and speak-request received.

This document plus the file list and code is enough for another LLM to work on the project consistently.
