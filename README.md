# Tabby AI Agent

<p align="center">
	<img src="https://raw.githubusercontent.com/jvit/tabby-ai-agent/main/screenshot.png" alt="Tabby AI Agent screenshot" width="50%">
</p>

Tabby AI Agent adds an AI assistant panel directly inside [Tabby](https://tabby.sh/). It can handle terminal tasks more autonomously, execute shell commands, and help you understand terminal output without leaving your active terminal tab.

It is built for terminal workflows where you want AI help, but still want command execution to stay visible and reviewable.

## Safety and disclaimer

Giving an AI agent access to your terminal is inherently risky. If you use it without care, it can run destructive commands, change files, or damage your system or data, so review its actions carefully and use auto-approval sparingly.

You are responsible for how you use this plugin. The plugin and its authors are not responsible for damage, data loss, or other consequences caused by unsafe, incorrect, or careless use.

## What it does

- Adds an **AI Chat** side panel to terminal tabs.
- Uses recent terminal output as context.
- Answers questions about the current terminal session.
- Can act autonomously and **execute shell commands** in the active terminal.
- Shows each proposed command with its risk level, explanation, and estimated runtime.
- Supports manual approval, with optional auto-approval for low-risk commands.
- Connects to OpenAI-compatible endpoints, including local and **self-hosted** services.
- Supports extra request parameters for providers such as LiteLLM, llama.cpp, and vLLM.

## Extra features (local build)

- **Model picker**: the settings page has a **Модель** dropdown with ready presets —
  `Kibborg_Flash_v5.7` on the local brain (`http://127.0.0.1:8083`) and DeepSeek's
  `deepseek-flash` / `deepseek-v4-pro` (`https://api.deepseek.com`). Picking a preset
  fills in the base URL, the model id and the context window; "Своя модель" leaves the
  manual Base URL / Model fields in charge.
- **Reasoning level**: the **Уровень размышления** dropdown (`off` / `low` / `medium` /
  `high` / `max`) is translated per provider — `reasoning_effort` for DeepSeek,
  `chat_template_kwargs.enable_thinking` plus `thinking_budget_tokens` for llama.cpp
  models. The chosen level overrides a stale value in the JSON parameters box while the
  other keys of that box survive.
- **Live model switching**: changing the model, endpoint, token or reasoning level
  rebuilds the chat session on the spot and carries the dialogue over, so no chat reset
  is needed after a switch.
- **Smart auto-scroll**: while you are at the bottom of the message feed, new agent
  messages scroll the feed down automatically. Scroll up to pause auto-scroll and read;
  a floating **↓** button appears, and clicking it (or scrolling back to the bottom)
  re-enables auto-scroll.
- **Context usage meter**: the bar under the panel header shows how much of the context
  window is occupied, in tokens and percent (default window: **256,000 tokens** for local
  models; overridable via `aiAgent.contextWindowTokens` in the Tabby config).
- **Context compaction (Compact)**: the **Compact** button in the panel header compresses
  the whole conversation into a dense summary, replacing the history so the agent keeps
  working with a much smaller context window. Compaction also runs **automatically when
  usage reaches 70%** of the window (after the current response finishes). A system notice
  in the feed reports how many tokens were freed.

## Using the plugin

You can configure the plugin in Tabby's settings.

Inside terminal, open the AI Agent panel using the **AI Agent** button in the toolbar.

You can also toggle the panel with the keyboard shortcut:

- **Windows and Linux:** `Ctrl+Alt+A`
- **macOS:** `Cmd+Shift+A`

## Privacy Warning

Prefer self-hosting. Third-party AI services may collect your terminal commands, logs, and file paths. Be wary of "privacy promises" from large providers; their incentives, data collection and model training, are rarely aligned with your own. While self-hosting requires more setup, it ensures you set the rules for your data rather than hoping a vendor follows theirs.

## License

MIT
