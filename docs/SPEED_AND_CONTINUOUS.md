# Speed and continuous operation

The loop is bottlenecked by LLM latency. This doc covers what the app does to stay fast and never “stop thinking,” and what you can do to make it even faster.

---

## Config (speed and “never stop”)

| Key | Default | Effect |
|-----|---------|--------|
| **thinkIntervalMs** | 6000 | Default delay between ticks when the LLM doesn’t specify shorter. Lower = more frequent (e.g. 4000). |
| **minIntervalMs** | 2000 | Minimum delay between ticks. The LLM’s `nextIntervalMs` is clamped to this. Lower = loop can run as fast as the model allows (e.g. 1500). |
| **maxIntervalMs** | 25000 | Maximum delay. Prevents the LLM from scheduling very long pauses. |
| **continuousMode** | false | When **true**: min interval becomes 800ms, max 5s, deepReflect runs in background (non-blocking), inner thought runs every other tick. The agent keeps going with minimal artificial delay and doesn’t block on heavy reflection. |

**Example for “really fast and nonstop”:**

- In `config.json`: set `"continuousMode": true`, `"minIntervalMs": 1000`, `"thinkIntervalMs": 4000`.
- The loop will reschedule the next tick as soon as the bounds allow (down to 800ms in continuous mode), so the AI doesn’t “stop” between ticks; the only limit is how fast the LLM and actions complete.

---

## What the app does internally

- **Reflect timeout**: Post-action reflection is limited to 7 seconds. If the LLM is slow, the loop gets a fallback thought and continues instead of hanging.
- **Shorter reflection**: Reflect uses `num_predict: 50`; inner thought uses 55. Fewer tokens = faster replies.
- **Continuous mode**: When enabled, deepReflect is fire-and-forget and inner thought runs every other tick to reduce LLM calls and keep the loop moving.
- **Interval bounds**: `nextIntervalMs` from the LLM is clamped to `[minIntervalMs, maxIntervalMs]` so you can enforce a minimum “heartbeat” (e.g. 1–2s) and cap long sleeps.

---

## What you can do to make the LLM itself faster

1. **Use a smaller or quantized model**  
   e.g. `qwen2.5:3b` or `qwen3:8b-q4` instead of a large unquantized model. Fewer parameters and lower precision = lower latency per token.

2. **Use the GPU**  
   On Windows with an NVIDIA GPU, Ollama uses it by default. Ensure drivers are up to date and that the GPU is actually used (e.g. Task Manager) so inference isn’t CPU-bound.

3. **Keep the model loaded**  
   Run `ollama run <model>` once so the model stays in VRAM; the first request after a cold start is much slower.

4. **Run Ollama with more resources**  
   If you have RAM/VRAM, you can try increasing context or batch size in Ollama so that each request is served a bit faster (see Ollama docs).

5. **Same machine, low latency**  
   Run the app and Ollama on the same machine (e.g. `ollamaUrl: "http://127.0.0.1:11434"`) to avoid network delay.

6. **continuousMode + lower minIntervalMs**  
   Turn on `continuousMode` and set `minIntervalMs` to 1000 (or 1500). The agent will reschedule the next tick as soon as the interval allows, so it runs “nonstop” within the limits of the LLM and your hardware.

---

## Summary

- **App side**: Faster defaults, reflect timeout, continuous mode (shorter intervals, non-blocking deepReflect, throttled inner thought), and configurable min/max intervals so the loop never waits longer than you want.
- **Your side**: Smaller/faster model, GPU, keep model loaded, same-machine Ollama, and `continuousMode` + `minIntervalMs` for a “never stop” feel.
