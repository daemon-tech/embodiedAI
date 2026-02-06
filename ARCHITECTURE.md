# LAURA — Full Architecture & Processes (paste to GPT)

This document describes the complete architecture, data flow, and processes of **LAURA** (Learning, Autonomous, Universal, Reasoning, Agent): an embodied, self-improving coding agent that runs in an Electron app with an autonomous mind loop, brain-like memory, and Cursor-style behavior.

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ELECTRON MAIN (main.js)                                                      │
│  Loads config, creates Memory, Perception, Action, Thinking, Curiosity,       │
│  Embedding, Metrics, MindLoop. Starts loop. Exposes IPC for renderer.        │
└─────────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  MIND LOOP (mind/loop.js) — The heartbeat                                     │
│  Every N ms: Curiosity → Thinking.decideAction() → [allow checks] →            │
│  Perception/Action execute → Thinking.reflect → Memory (thoughts, episodes,   │
│  learnings, hormones). Optional: judge, meta-review, runaway recovery.         │
└─────────────────────────────────────────────────────────────────────────────┘
        │                │                │                │                │
        ▼                ▼                ▼                ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Memory       │ │ Thinking     │ │ Perception   │ │ Action       │ │ Curiosity    │
│ mind/memory  │ │ mind/thinking│ │ mind/        │ │ mind/action  │ │ mind/        │
│              │ │              │ │ perception   │ │              │ │ curiosity    │
│ Brain (n/s), │ │ LLM: decide, │ │ readFile,    │ │ writeFile,   │ │ Suggestions  │
│ state, facts,│ │ reflect,     │ │ listDir,     │ │ run terminal,│ │ (paths/URLs  │
│ episodes,    │ │ judge,       │ │ fetchUrl     │ │ openUrl,     │ │ to explore)  │
│ goals, plan  │ │ metaReview,  │ │              │ │ clipboard,   │ │              │
│              │ │ chat         │ │              │ │ speak        │ │              │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
        │                │
        ▼                ▼
┌──────────────┐ ┌──────────────┐
│ Embedding    │ │ Metrics      │
│ mind/        │ │ mind/metrics │
│ embedding    │ │              │
│ Vectors for  │ │ Activity,    │
│ similarity   │ │ decide/action│
│ search       │ │ /tick times  │
└──────────────┘ └──────────────┘
```

- **Single process**: Electron main runs everything; renderer is the UI (Three.js scene + HTML/JS for HUD, chat, vitals).
- **Loop-driven**: The agent does not wait for user input to act. Each **tick** = decide → execute → reflect → save; then schedule next tick after `nextIntervalMs` (bounded by config).
- **LLM at the core**: All high-level decisions go through the LLM (Ollama or OpenAI-compatible API): next action, reflection sentence, inner thought, chat reply, self-dialogue, judge, meta-review, learnings.

---

## 2. Directory & File Layout

| Path | Role |
|------|------|
| `main.js` | Entry; config load/save; creates Memory, Perception, Action, Thinking, Curiosity, Embedding, Metrics, MindLoop; IPC handlers; window. |
| `config.json` | User-editable config (workspacePath, allowedDirs, allowedHosts, ollamaModel, thinkIntervalMs, etc.). |
| `mind/loop.js` | Autonomous mind loop: tick(), path/URL/command allow checks, execution branches per action type, hormones, save, runaway detection, meta-review schedule. |
| `mind/thinking.js` | LLM calls: decideAction (with optional judge), reflect, innerReflect, learnFromAction, selfConversation, chat, deepReflect, replan, metaReview, judgeAction. Uses agent_extensions for identity/prompts. |
| `mind/memory.js` | Persistent brain: neurons, synapses, thoughts, episodes, semanticFacts, state (goals, plan, workingMemory, hormones, emotions, lastHumanFeedback), embeddings; load/save; getAGIContext (includes safety + human feedback). |
| `mind/agent_extensions.js` | **Only agent-editable file.** Identity, systemPrompt, chatPrompt, extraPrompt, featureNotes, defaultSelfSummary, defaultAGISelfModel, seedFacts. Core cannot edit this. |
| `mind/safety_principles.js` | **Read-only.** List of immutable safety principles; getAGIContext() injects them; agent cannot edit. |
| `mind/allow.js` | isAllowedPath, isAllowedHost, isAllowedUrlProtocol, isAllowedCommand. Used by loop, perception, action. |
| `mind/perception.js` | readFile, listDir, fetchUrl (within allowed dirs/hosts); updates memory exploredPaths/exploredUrls. |
| `mind/action.js` | writeFile, openUrl (browser), run terminal (exec), clipboard, speak (TTS). |
| `mind/curiosity.js` | getSuggestions(): suggests read_file, list_dir, fetch_url, browse from least-recently-explored paths/URLs. |
| `mind/embedding.js` | embed(text): Ollama or OpenAI embeddings; used to store vectors and similaritySearch in memory. |
| `mind/metrics.js` | setActivity(phase, detail), recordTiming(name, ms), recordCount(name), getMetrics(). |
| `preload.js` | contextBridge: exposes api (invoke + subscribe) for renderer. |
| `src/renderer/index.html` | UI: scene container, HUD (stats, vitals, model, buttons), chat panel (messages, live block, feedback row, input), toast. |
| `src/renderer/renderer.js` | Subscribes to thought, hormones, log, activity, metrics; updates DOM; chat send; feedback buttons (humanFeedback); vitals drawer; stats. |
| `src/renderer/scene.js` | Three.js scene (background / ambient visuals). |

**Persistence:**  
- `memory.json` (userData): full memory (thoughts, logs, state, episodes, semanticFacts, etc.).  
- `memory_brain.json` (userData, optional): embeddings, neurons, synapses (can be split for size).

---

## 3. Config (config.json + defaults in main.js)

| Key | Meaning |
|-----|--------|
| workspacePath, allowedDirs | Where the agent can read/write/list/edit. |
| allowedHosts | Allowed URL hosts for fetch/browse (* = all). |
| ollamaUrl, ollamaModel | Ollama API and model for LLM. |
| openaiBaseUrl, openaiApiKey | If set, LLM uses OpenAI-compatible API. |
| embeddingModel | e.g. nomic-embed-text for embeddings. |
| thinkIntervalMs, minIntervalMs, maxIntervalMs | Bounds for next tick delay. |
| continuousMode | If true, shorter max interval and different deep-reflect behavior. |
| focusMode | Shorter intervals; focus on read_self / think. |
| curiosityWeight | Weight for curiosity suggestions. |
| allowClipboard | Allow read_clipboard / write_clipboard. |
| allowedCommandPrefixes | Allowed run_terminal prefixes (npm , npx , node , git , etc.). |
| useJudge | If true, thinking.judgeAction() runs after decide; can override action to think with suggestion. |
| metaReviewEveryTicks | Every N ticks run thinking.metaReview() (strategy + self-instructions). |
| runawaySameActionThreshold | Same action repeated this many times → force rest + replan. |
| runawayConsecutiveErrors | This many consecutive errors → replan. |
| appPath | App root (for resolving mind/agent_extensions.js and core files). |

---

## 4. Action Types (what the agent can do)

All actions are chosen by the LLM in `decideAction`; the loop executes them and enforces allow rules.

| Type | Args | Allowed check | Effect |
|------|------|---------------|--------|
| read_file | path | isAllowedPath | Perception.readFile; memory markExploredPath. |
| list_dir | path | isAllowedPath | Perception.listDir. |
| write_file | path, content | isAllowedPath | Action.writeFile. |
| delete_file | path | isAllowedPath | fs.unlink. |
| fetch_url | url | isAllowedHost | Perception.fetchUrl. |
| browse | url | isAllowedHost | Action.openUrl (external browser). |
| read_self | target (memory_summary \| config \| code \| all) | — | Reads memory/config/code; can update self-summary. |
| edit_code | path, oldText, newText | isAllowedEditPath | Exact replace in file; path must be in allowed dirs or mind/agent_extensions.js; core files (loop, memory, thinking, action, perception, curiosity, embedding, allow, safety_principles, main) are read-only. |
| run_terminal | command | isAllowedCommand | exec in workspace; prefixes from config; blocked patterns (rm -rf /, sudo, etc.). |
| read_clipboard | — | allowClipboard | clipboard.readText. |
| write_clipboard | text | allowClipboard | clipboard.writeText. |
| write_journal | — | — | Append line to userData/journal.txt. |
| rest | — | — | No I/O; reflect. |
| think | — | — | Reflect only. |
| self_dialogue | — | — | Multi-turn conversation with self; then act on CONCLUSION. |

---

## 5. One Tick (loop) — Step by Step

1. **Pre-tick**  
   - If paused, return.  
   - `decayHormones()`, `memory.decayEmotions()`, `_tickCount++`.  
   - `curiosity.getSuggestions()` (paths/URLs to suggest).

2. **Decide**  
   - `thinking.decideAction(perception, { focusMode, suggestions, timeSinceLastActionMs })` (with 90s timeout).  
   - Builds prompt from: getAGIContext() (self-model + safety principles + last human feedback), state, goals, plan, working memory, last actions, recent learnings, facts, episodes, retrieved-by-meaning (if embedding), suggestions.  
   - LLM returns two lines: reason (live) + JSON action.  
   - If `config.useJudge`, call `thinking.judgeAction(action, reason, working)`; if not approved, replace action with think + suggestion.  
   - On timeout/error: fallbackAction (think) + replan.

3. **Runaway checks**  
   - Append `action.type` to `_lastActionTypes`; if same action repeated ≥ `runawaySameActionThreshold`, replace with rest + replan, clear buffer.  
   - (Consecutive-error runaway is applied after execution, below.)

4. **Allow checks**  
   - Paths: read_file, list_dir, write_file, delete_file must pass `isAllowedPath(path, allowedDirs)`.  
   - URLs: fetch_url, browse must pass `isAllowedHost(url, allowedHosts)`.  
   - edit_code: `isAllowedEditPath(targetPath, appPath, allowedDirs)` (allowed dirs or mind/agent_extensions.js; not core).  
   - run_terminal: `isAllowedCommand(command, config)`.  
   - If any fail → action replaced with think + reason.

5. **Execute**  
   - Branch on `action.type`; call perception or action; set `thought` from `thinking.reflect(action, result, outcome)`.  
   - For read_self: optionally `thinking.updateSelfSummaryFromReading()`.  
   - For self_dialogue: `thinking.selfConversation()` → transcript + conclusion; then set lastSelfConclusion; thought from conclusion.  
   - For edit_code: read file, replace oldText with newText, backup, write, optional syntax check.  
   - Hormones updated on success/failure (dopamine, cortisol, serotonin).

6. **After execution**  
   - `outcomeStr = lastError ? 'error' : 'ok'`.  
   - Track `_consecutiveErrors`; if ≥ `runawayConsecutiveErrors`, call replan and reset.  
   - `memory.addLastAction()`, `memory.applyOutcomeToRecentConcepts(conceptIds, success)`, `thinking.learnFromAction()` → addRecentLearning + semanticFact; optionally embed.  
   - `thinking.innerReflect()` → inner thought → addInnerThought + sendToRenderer('inner-thought').  
   - Add episode (for think/rest/self_dialogue), addThought, optional embed thought, addLog, updateCapabilityRegister.  
   - If tick count % DEEP_REFLECT_EVERY_TICKS === 0: `thinking.deepReflect()` (self-summary, goals, facts, self-instructions).  
   - If tick count % metaReviewEveryTicks === 0: `thinking.metaReview()` (strategy note + optional new self-instruction).  
   - sendToRenderer('thought', { thought, action, payload, hormones, emotions, reason, stats, goals, living, metrics }).  
   - Optional TTS for thought.  
   - _debouncedSave().

7. **On tick error**  
   - Catch block: set lastError, replan, addThought (error), sendToRenderer thought with error flag, update hormones (cortisol).

8. **Schedule next**  
   - `_lastTickTime = now`, `_scheduleNext()` (setTimeout tick, `intervalMs`).

---

## 6. Memory (brain + state)

- **Neurons / synapses**  
  - Concepts extracted from thought text; getOrCreateNeuron per concept; connect to SELF and each other.  
  - Outcome-based learning: `applyOutcomeToRecentConcepts(conceptIds, success)` strengthens/weakens synapses.

- **Thoughts, logs, episodes, semanticFacts**  
  - Capped queues; new entries push, old shift.  
  - Episodes: type, what, summary, where.  
  - Semantic facts: fact, source, t.

- **State**  
  - goals, plan (steps, currentStepIndex), workingMemory (currentTask, lastActions, recentLearnings), lastUserMessage, lastError, lastSelfConclusion, lastSelfConversation, lastHumanFeedback, selfSummary, agiSelfModel, hormones, emotions, selfInstructions, capabilityRegister.

- **Human feedback (HITL)**  
  - `addHumanFeedback(rating, comment)` sets state.lastHumanFeedback.  
  - getAGIContext() and getWorkingContext() include it so the LLM can adapt.

- **Embeddings**  
  - Stored with text; similaritySearch(vector, k) for retrieval-by-meaning in decide prompt.

- **Safety**  
  - getAGIContext() appends immutable text from `safety_principles.getText()`.

---

## 7. Thinking (LLM flows)

- **decideAction(perception, options)**  
  - Builds big prompt: AGI context (with safety + feedback), state, goals, plan, current task, last actions, recent learnings, infinite-learning line, facts, episodes, self-instructions, extensions, retrieved-by-meaning, working block (including human feedback), paths/URLs, allowed dirs.  
  - Active retrieval: if working.lastError, use more episodes (10), facts (15), similarity hits (12).  
  - LLM returns line1 = reason, line2 = JSON; parse; if useJudge, judgeAction(); return action.

- **judgeAction(proposedAction, reason, workingContext)**  
  - Separate LLM call: evaluator approves or returns suggestion; loop uses it to replace action with think + suggestion if not approved.

- **metaReview()**  
  - LLM reviews goals, last actions, current task; returns strategyNote + selfInstruction; selfInstruction added to memory.

- **reflect(action, result, outcome)**  
  - One short sentence (first-person) after each action; timeout 7s.

- **learnFromAction(action, outcome, thought)**  
  - One-sentence learning; stored in recentLearnings and as semanticFact; optional embed.

- **innerReflect({ action, thought })**  
  - Inner voice sentence; shown in UI.

- **selfConversation(numTurns)**  
  - Multi-turn dialogue with self; final turn concludes with "CONCLUSION: ..."; conclusion stored and used on next decide.

- **chat(userMessage)**  
  - Full context (goals, plan, working, facts, episodes, extensions); reply as assistant; memory.addChatMessage.

- **deepReflect()**  
  - JSON: selfSummary, goals, facts, selfInstructions; updates memory.

- **replan(reason)**  
  - LLM returns steps; memory.setPlan({ steps, currentStepIndex: 0 }).

---

## 8. Allow & Safety

- **allow.js**  
  - Path in allowedDirs; host in allowedHosts; protocol http/https; command matches allowedCommandPrefixes and not in BLOCKED_PATTERNS.

- **Core files (not editable by agent)**  
  - mind/loop.js, memory.js, thinking.js, action.js, perception.js, curiosity.js, embedding.js, allow.js, mind/safety_principles.js, main.js.  
  - edit_code only for files in allowedDirs (and not core) or mind/agent_extensions.js.

- **safety_principles.js**  
  - Read-only list; injected into getAGIContext(); agent cannot edit.

---

## 9. IPC (main → renderer)

- **Channels sent from main:** thought, hormones, log, loop-status, error, inner-thought, self-conversation, chat-thinking, activity, metrics.  
- **Handlers (renderer invokes):** get-config, get-memory-stats, get-thoughts, get-logs, get-chat-history, get-goals, set-goal, complete-goal, human-feedback, send-chat, think-once, pause-loop, resume-loop, speak, browse, read-file, list-dir, write-file, fetch-url, choose-folder, save-config, get-metrics, get-current-activity, get-resource-usage, get-ollama-models, set-model, etc.

---

## 10. Renderer

- **HUD:** Status (run/pause), stats (paths, thoughts, neurons), vitals (hormones), model selector, Vitals drawer (detailed params), Think once / Pause / Focus buttons.  
- **Chat:** Message list, live block (reason, action, thought), Feedback (HITL) row with 👍/👎 calling api.humanFeedback('up'|'down'), input + Send.  
- **Subscriptions:** thought (set current thought, reason, action, payload, metrics), hormones, log, activity, metrics, inner-thought, error, loop-status.  
- **Other:** Toast for errors/feedback ack; resizable chat panel; scene in background.

---

## 11. End-to-End Data Flow (one tick, condensed)

Curiosity.getSuggestions → Thinking.decideAction (Memory state + AGI context + safety + feedback + retrieval) → LLM → (optional Judge) → Loop allow checks → Perception/Action execute → Memory (exploredPaths, lastError, addLastAction, addEpisode, etc.) → Thinking.reflect → thought → applyOutcomeToRecentConcepts, learnFromAction, addThought, addInnerThought → optional deepReflect / metaReview → sendToRenderer('thought', …) → _debouncedSave → _scheduleNext.

---

## 12. Self-Improvement & Governance (summary)

- **Performer–evaluator:** useJudge → judgeAction() can override proposed action.  
- **Recursive self-reflection:** metaReview() every N ticks updates self-instructions.  
- **Meta-cognition:** Decide prompt asks to note uncertainty in the reason.  
- **Active retrieval:** On lastError, more episodes/facts/hits in decide.  
- **Human-in-the-loop:** lastHumanFeedback in context; UI 👍/👎 → humanFeedback() → memory.  
- **Immutable safety:** safety_principles.js in AGI context; core + safety_principles not editable.  
- **Runaway monitoring:** Same action repeated or consecutive errors → rest + replan / replan only.

This is the full architecture and process set for LAURA as of this document.
