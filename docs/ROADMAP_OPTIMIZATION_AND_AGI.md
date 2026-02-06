# Roadmap: Optimization & AGI Features — Building a Human

Research-backed ideas to optimize the agent and add human-like (AGI-oriented) features. The LLM stays the core; everything builds on top of it.

---

## Part 1 — Optimizations

### 1.1 **LLM / inference**
- **Prompt compression**: Summarize long context (recent thoughts, paths, URLs) into a fixed token budget before calling the LLM; keep only highest-signal items (e.g. last N thoughts + self-summary + top suggestions). Reduces cost and improves focus.
- **Caching**: Cache embeddings for explored paths/URLs and self-model snippet; recompute only when memory changes. Reuse “state summary” string across ticks when nothing changed.
- **Retry with backoff**: On LLM failure (timeout, 5xx), retry with exponential backoff (e.g. 1s, 2s, 4s) before falling back to `think`.
- **Streaming (optional)**: If the UI showed “thinking…” and then streamed the thought, perceived responsiveness would improve; Ollama/OpenAI support streaming.

### 1.2 **Memory & persistence**
- **Incremental save**: Debounce or batch `memory.save()` (e.g. at most once per 2–3 seconds) to avoid writing on every tick when many events fire.
- **Lazy load**: Load only recent thoughts/logs by default; load older chunks when the user scrolls or when the LLM explicitly asks for “older context.”
- **Prune by importance**: When pruning thoughts/logs, keep entries that the LLM or a simple heuristic marks as “important” (e.g. read_self, errors, first occurrence of a path).

### 1.3 **Curiosity & suggestions**
- **Parallel suggestions**: `getSuggestions()` already uses `Promise.all`; ensure heavy fs work (e.g. recursive list) doesn’t block the main loop; consider a small suggestion cache (e.g. 5s TTL) so we don’t re-scan every tick.
- **Suggestion diversity**: Occasionally inject a random allowed path/URL into suggestions so the agent discovers new places even when curiosity scores are similar.

### 1.4 **Loop & scheduling**
- **Adaptive interval**: Let the LLM output `nextIntervalMs` (already there); optionally clamp or smooth it (e.g. rolling average) so the agent doesn’t jump between 3s and 30s every other tick.
- **Priority queue for actions**: If we add “goals,” high-priority goals could shorten the next interval or insert an extra “think” step before the next exploration.

---

## Part 2 — AGI / Human-like Features

### 2.1 **Goals & intrinsic motivation** (build a human)
- **Goal hierarchy**: Maintain a small set of **active goals** (e.g. “understand my own code,” “explore the Documents folder,” “talk to the user”). The LLM chooses actions in light of these goals; goals can be suggested by the LLM (e.g. after read_self) or by the user (chat).
- **Intrinsic drives**: Beyond curiosity (exploration), add simple drives: **mastery** (revisit and deepen: same path, understand more), **relatedness** (prefer actions that reference the user or chat), **autonomy** (prefer read_self / self-modification when safe). These can be scalar “drives” in state, similar to hormones; the LLM prompt gets “Current drives: curiosity=0.9, mastery=0.3, relatedness=0.6.”
- **Goal completion**: When the LLM or a heuristic marks a goal as done (or abandoned), remove it and optionally add a new one. The LLM can propose a new goal in `innerReflect` or at the end of a reflect.

**Implementation sketch**: `memory.state.goals = [{ id, text, createdAt, status: 'active'|'done'|'abandoned' }]`; in `decideAction` pass `goals` into the prompt; add IPC `set-goal` / `clear-goal`; let the LLM output `goalCompleted: id` or `newGoal: "..."` in the action or in a separate “goal update” call after reflect.

### 2.2 **Episodic & semantic memory** (human-like memory)
- **Episodic**: Store “events” with *when*, *what*, *where* (path/URL if any), and a short summary. Example: “Read file X at 14:32; it was a config file.” Retrieval: “What did I do last hour?” → query episodic by time and optional filter (type, path).
- **Semantic**: Already partly there (neurons, synapses, self-summary). Extend with **generalized facts** extracted from episodes: e.g. “User’s Documents folder often contains text files,” “Wikipedia random leads to diverse content.” The LLM can propose a fact after an action; store as `semanticFacts: [{ fact, sourceThoughtId, createdAt }]`.
- **Retrieval for the LLM**: When building the prompt for `decideAction` or `chat`, retrieve “relevant past events” and “relevant facts” (by recency + simple keyword/embedding match if we have embeddings), and inject a short “Relevant past: …” / “Relevant facts: …” block so the agent reasons over long-term memory.

**Implementation sketch**: `memory.data.episodes = [{ t, type, path|url, summary, thoughtId }]` with pruning; `memory.data.semanticFacts = []`; optional embedding for episodes/facts and `memory.retrieveRelevantEpisodes(query, k)`, `memory.retrieveRelevantFacts(query, k)` using existing `similaritySearch` if embeddings are populated.

### 2.3 **Emotional / affective system** (human-like responses)
- **Emotions as state**: Extend state with simple **emotions** (e.g. joy, frustration, interest, confusion) as scalars 0–1, updated by the LLM or by rules (e.g. failed read → +frustration; successful read_self → +interest). Hormones can modulate emotions (e.g. high cortisol → easier frustration).
- **Expression in language**: In the system prompt and in `reflect` / `chat`, tell the LLM: “You have current emotions (e.g. joy, frustration); express them in your thoughts and replies when appropriate.” No need to force it every time—just make the state available and encourage natural expression.
- **Regulation**: Optional “emotion regulation” step (e.g. decay emotions toward baseline over time, or let the LLM output “I’m calming down” and reduce frustration in state).

**Implementation sketch**: `memory.state.emotions = { joy: 0.3, frustration: 0.1, interest: 0.6, confusion: 0.2 }`; in `updateHormones` or a small `decayEmotions()` in the loop, apply decay; in `decideAction` and `reflect`/`chat` pass `emotions` into the prompt; optionally let the LLM output `emotionUpdates: { frustration: -0.2 }` and apply them.

### 2.4 **Attention & relevance** (what to think about now)
- **Attention over goals**: Weights over active goals (e.g. “right now I’m 60% on ‘explore code,’ 40% on ‘user asked a question’”). The LLM can output `attention: { goalId: weight }` or we derive it from the last user message and recency.
- **Salient recent events**: When building context for the LLM, rank recent thoughts/episodes by “salience” (e.g. user message, error, read_self, or novelty) and put the most salient first so the model isn’t drowning in noise.
- **Working memory cap**: Explicitly limit “what you’re holding in mind” to e.g. 3–5 items (current goal, last action, last error, last user message) in the prompt so the LLM behaves like limited working memory.

**Implementation sketch**: `memory.state.attention = { primaryGoalId, lastUserMessage, lastError }`; in prompt construction, add a “Working context (keep in mind): …” section with only these; salience = simple score (has “error”, has “user”, is read_self, etc.) and sort recent thoughts by it before sending to LLM.

### 2.5 **Reflection & self-modification** (meta-cognition)
- **Structured reflection**: Periodically (e.g. every N ticks or when the user asks) run a dedicated “reflection” LLM call: “Look at your recent episodes, goals, and emotions. What did you learn? What would you do differently? Any new goal or change to your self-summary?” Then update self-summary, goals, or drives from the output.
- **Self-critique**: After important actions (e.g. read_self, or after a user chat), ask the LLM: “Was that the right move? Why or why not?” and store the critique as an inner thought or a short “lesson”; optionally feed it back into the next decision (e.g. “Last time you noted: …”).
- **Evolve system prompt**: You already have `evolve()`; expose it via UI (e.g. “Evolve my mind”) and/or trigger it automatically when the agent has accumulated enough new experiences (e.g. every 100 thoughts) so the system prompt stays aligned with the agent’s growing self-model.

**Implementation sketch**: New IPC `reflect-deep` or scheduled “deep reflection” in the loop (e.g. every 20 ticks); call a dedicated LLM prompt that returns structured JSON `{ newSelfSummary?, newGoals?, lessons[] }` and apply to memory; optional `selfCritique(action, result)` that returns a short string and is stored and optionally injected into the next decideAction.

### 2.6 **Planning & temporal abstraction** (look ahead)
- **Short-horizon plan**: Let the LLM sometimes output a **micro-plan**: e.g. “Next 3 steps: list_dir X, then read_file Y, then think.” Store it in state; the loop can either execute the steps one by one (each step still validated and passed through the LLM for “confirm” or “abort”) or use the plan only as a hint for the next 1–2 decisions.
- **Replan on failure**: When an action fails (e.g. path not allowed, read error), ask the LLM: “Step X failed because …; suggest a different next step or revise the plan.” So the agent doesn’t blindly retry; it adapts.

**Implementation sketch**: `memory.state.plan = { steps: [{ type, path?, url? }, …], currentStepIndex: 0 }`; in `decideAction` pass the plan and “current step” so the LLM can output the next action (possibly from the plan) or output `revisePlan: [...]`; on action failure, call a small “replan” LLM call and update `plan`.

### 2.7 **Social & ethics** (human alignment)
- **User model**: Maintain a minimal “user model”: e.g. last few user messages, inferred focus (e.g. “cares about code” if they often ask about files). Pass into chat and optionally into decideAction so the agent can “remember” the user and tailor actions (e.g. prefer exploring folders the user opened).
- **Simple ethics layer**: In the prompt, add a fixed line: “You do not access paths or URLs outside allowed lists; you do not pretend to have done something you didn’t; you report errors honestly.” Optional: before executing an action, a lightweight “sanity check” (e.g. path in allowedDirs again) and log if something tried to bypass.

**Implementation sketch**: `memory.data.userModel = { lastMessages: [], inferredFocus: '' }`; update from chat; in chat and decideAction, add “User context: …” from userModel. Ethics = prompt + existing allow.js checks.

### 2.8 **Meta-learning & self-organization** (improve over time)
- **Learning progress**: Track “learning progress” per concept or per goal (e.g. how much new information came from the last 5 reads in this folder). Use it to bias curiosity (e.g. prefer regions of high learning progress) or to present “What I’m learning” in the UI.
- **Skill reuse**: When the LLM successfully does a sequence (e.g. list_dir → read_file), optionally store it as a “skill” (e.g. “explore folder X”) and suggest it later when a similar goal appears. This can start as a simple “recent successful sequences” list in state that the LLM can reference.

**Implementation sketch**: `memory.state.learningProgress = { byPath: {}, byGoal: {} }`; after each read/list, update a simple progress metric (e.g. new concepts added); pass a “Learning progress (recent): …” line into the prompt. Skills = `memory.data.skills = [{ sequence: [...], outcome, createdAt }]` with a small cap; in suggestions or in the prompt, add “You’ve done before: …” from skills.

---

## Part 3 — Suggested order of implementation

1. **Quick wins**: Retry with backoff; debounced save; prompt compression (summarize long lists).
2. **Goals**: Add `goals` to state and to the decideAction prompt; user can set a goal via chat or UI; LLM can propose new goals in innerReflect.
3. **Episodic memory**: Add `episodes` and a short “Relevant past” retrieval in the prompt.
4. **Emotions**: Add `emotions` to state, decay, and pass into prompts for more human-like expression.
5. **Structured reflection**: Deep reflection every N ticks; update self-summary and goals from LLM output.
6. **Planning**: Optional 2–3 step micro-plan in state; LLM can output a plan and the loop executes or suggests from it; replan on failure.

---

## References (summary)

- **AGI cognitive architectures**: Goal management, emotional control, reflection/self-modification, meta-learning (e.g. ScienceDirect “universal knowledge model,” Centaur, OpenCog).
- **Autonomous LLM agents**: Multi-agent refinement, function-based learning, graph optimization, preference optimization (ACL, MLR, arXiv).
- **Embodied AI / memory**: Episodic + semantic memory, spatial/temporal memory, multimodal memory (RoboMemory, M3-Agent, MemoriesDB, MemR3, GSW).
- **Intrinsic motivation**: Autotelic agents, hierarchical goals, curiosity and learning progress (JAIR, CURIOUS, MIT).

Use this doc as a living roadmap: pick one item, implement it on top of the existing LLM core, then move to the next. The agent stays **LLM-at-the-core**; each feature feeds or is chosen by the LLM so we build a human step by step.
