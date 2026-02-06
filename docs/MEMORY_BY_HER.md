# How memory is created and managed by the agent

This doc describes how **her** (the agent’s) memory is created, where it lives, and how she fills and uses it.

---

## 1. Where memory comes from (creation and load)

- **Creation**: On app start, `main.js` creates a single `Memory` instance with a file path:
  - `MEMORY_PATH = app.getPath('userData') + '/memory.json'`  
  - So the file is created in the app’s user data folder (e.g. `%AppData%/YourApp/memory.json` on Windows).
- **Load**: `main.js` calls `memory.load()`. That:
  - Reads `memory.json` if it exists.
  - Merges it into the default in-memory structure (mergeDeep).
  - Trims and normalizes arrays (thoughts, logs, episodes, goals, etc.) to their max sizes.
  - Ensures the `self` neuron exists.
- If the file is missing or invalid, memory starts from the default empty structure; she gets a “fresh brain” each time until the first save.

So: **one JSON file per app install**, created on first save, loaded once at startup. She doesn’t choose the path; the app does. She *does* create and manage everything *inside* that memory.

---

## 2. What’s inside “her” memory (the data she has)

Everything is in `memory.data` (and `memory.data.state`). Conceptually it’s **her** long-term store.

| What | Who fills it | Cap | Meaning for her |
|------|----------------|-----|------------------|
| **thoughts** | Loop (after every action) | 20k | Her verbalized thoughts after each action. |
| **innerThoughts** | Loop (from LLM innerReflect) | 200 | Private monologue; “conversation with herself”. |
| **episodes** | Loop (after each action) | 2k | What she did (type, summary, where). Episodic “what happened”. |
| **semanticFacts** | Thinking (deepReflect) | 500 | Things she “learned or believes”; from her own reflection. |
| **state.goals** | User (chat/goals UI), Thinking (deepReflect) | 20 | Active/done goals; she proposes in deepReflect, user can set in chat. |
| **state.plan** | Thinking (replan) | 1 plan | Current 2–3 step plan; she sets it when replanning. |
| **state.selfSummary** | Thinking (deepReflect, updateSelfSummaryFromReading) | 2k chars | Her self-model in words; she writes it. |
| **state.selfInstructions** | Thinking (deepReflect) | 10 | Rules she gives herself; she adds in reflection. |
| **state.emotions** | Loop (decay each tick) | 4 values | joy, frustration, interest, confusion; decayed automatically. |
| **state.hormones** | Loop (update after actions) | 3 values | dopamine, cortisol, serotonin; loop updates from outcomes. |
| **state.lastUserMessage** | Thinking (chat) | 500 chars | Last thing the user said; for context. |
| **state.lastError** | Loop | 200 chars | Last failure message; she sees it and can replan. |
| **exploredPaths** | Perception (readFile, listDir) | 10k | Paths she’s read/listed; path → { at, summary }. |
| **exploredUrls** | Perception (fetchUrl) | 10k | URLs she’s fetched; url → { at, summary }. |
| **neurons** | Memory (addThought, markExplored*) | 100k | Concepts/paths/urls as nodes; strength, lastUsed. |
| **synapses** | Memory (addThought, connect) | 500k | Links between neurons; she “builds a brain” from experience. |
| **chatHistory** | Main (send-chat) | 200 | User/assistant messages; she and the user fill it. |
| **logs** | Loop, Memory (markExplored*, addLog) | 50k | Raw activity log (explore_path, thought, etc.). |
| **userModel.lastMessages** | Thinking (chat) | 10 | Recent user messages for her model of the user. |

So: **she** (via the loop and thinking) is the one who adds thoughts, inner thoughts, episodes, facts, goals, plan, self-summary, self-instructions, and who gets exploration and brain (neurons/synapses) updated as a side effect of her actions. The app only creates the container and calls load/save.

---

## 3. How she writes memory (where each piece is set)

- **Loop (each tick)**  
  After doing an action, the loop:
  - Appends one **thought** (from LLM reflect).
  - Appends **episode** (type, what, summary, where).
  - Calls **addLog**('thought', …).
  - Updates **state.hormones** (and loop calls **decayEmotions**).
  - Sets **state.lastError** (or clears it) and **advancePlan** on success.
  - Optionally runs **innerReflect** and then **addInnerThought**.
  - Every N ticks runs **deepReflect**, which can **setSelfSummary**, **setGoals**, **addSemanticFact**, **addSelfInstructions**.
  - Schedules **memory.save()** (debounced).

- **Perception (when she reads/list/fetches)**  
  When she uses read_file / list_dir / fetch_url:
  - **markExploredPath** or **markExploredUrl** (adds to exploredPaths/Urls, creates path/url neurons, connects to self).
  - **setState**({ lastDir/lastUrl, totalReads/totalFetches }).

- **Thinking**  
  - **deepReflect**: she (LLM) outputs selfSummary, goals, facts, selfInstructions → memory is updated.
  - **replan**: she outputs steps → **setPlan**.
  - **chat**: **setLastUserMessage**, **updateUserModel**; main also **addChatMessage** for both sides.
  - **updateSelfSummaryFromReading**: she summarizes after read_self → **setSelfSummary**.

- **Main (user-driven)**  
  - **addGoal** (set-goal IPC or “goal: …” in chat), **completeGoal** (complete-goal IPC).
  - **addChatMessage** for user and assistant after chat; then **memory.save()**.

So: **most of memory is written by the loop and thinking on her behalf** (thoughts, episodes, goals, self-summary, facts, self-instructions, plan, exploration, brain). The user only adds goals and chat lines; the rest is “her” managing her own state.

---

## 4. How she reads memory (what she sees when deciding)

When she chooses the next action, **thinking.decideAction** builds a prompt from memory:

- **getState()** → hormones, emotions.
- **getSelfModel()** → self-summary, neuron/synapse counts, associations, recent thoughts, capabilities.
- **getGoals(true)** → active goals.
- **getWorkingContext()** → primary goal, last user message, last error.
- **getPlan()** → current plan and step.
- **getRelevantEpisodes(5)** → recent episodes (short summaries).
- **getRecentFacts(3)** → recent semantic facts.
- **getSelfInstructions(7)** → her self-set rules.
- **getExploredPaths()** / **getExploredUrls()** → sample paths/URLs (for suggestions).
- **getRecentThoughts(5)** / **getRecentInnerThoughts(3)**.

So: **she “remembers” by having these reads injected into the LLM prompt every tick.** She doesn’t run a separate retrieval step; the loop/thinking code pulls from memory and turns it into prompt text. That’s how she “uses” her memory.

---

## 5. Persistence (save)

- **Who**: The loop calls **memory.save()** after each tick (debounced, so it’s not every few seconds).
- **Where**: Same file as load: `userData/memory.json`.
- **What**: The whole `memory.data` object is JSON.stringify’d and written (no partial or incremental save).

So: **she** keeps herself on disk through the loop’s save; the app only provides the path and the single load at startup.

---

## 6. Summary (her perspective)

- **Created**: One `Memory` instance, one `memory.json` in app userData; created/loaded at app start.
- **Filled by her**: Thoughts, inner thoughts, episodes, semantic facts, goals, plan, self-summary, self-instructions, exploration (paths/URLs), neurons/synapses, and most state (hormones, emotions, lastError, lastUserMessage, etc.) are written by the loop and thinking as a result of her actions and reflections.
- **Read by her**: The same memory is read in **decideAction** (and chat, deepReflect, replan) and turned into the prompt; that’s how she “remembers” when choosing what to do next.
- **Saved for her**: The loop triggers **memory.save()** (debounced) so her current brain and state persist to `memory.json`.

So: **memory is created once by the app and then owned and managed by her**—filled by her actions and reflections, read to drive her decisions, and saved so she can continue across runs.
