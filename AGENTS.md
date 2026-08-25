# Repository Agent Rules

## External Research

- For external web research, prefer the runtime's native web search first whenever it is available.
- Use Exa as the second-round cross-check to broaden coverage, add structured extraction, or confirm source overlap.
- If the first two rounds still leave time-sensitive ambiguity, source conflicts, or a need for higher-confidence confirmation, return to native web search for a third verification pass.
- Use Perplexity only when native search is unavailable, Exa is unavailable, existing evidence still cannot close the question, or the user explicitly requests Perplexity.
- If Perplexity is used, state that it was used as fallback or by explicit user request.
- Default to 15 results where the tool supports fixed result counts.
- When a tool does not support fixed result counts, use the broadest practical context settings for the task.
- Prefer official documentation and other primary sources when choosing between conflicting results.

## Localization Workflow

- For locale pack / i18n / “语音包” tasks, follow `docs/I18N_LOCALE_SOP.md`.
- Treat `zh-CN` and `en` as required source locales that must stay in sync.
- Keep runtime fallback in English unless the user explicitly asks to change that product behavior.

## Provider Endpoint Workflow

- For Gemini endpoint / model list / bridge routing tasks, follow `docs/GEMINI_ENDPOINT_SOP.md`.
- Never equate `provider === gemini` with “Google 原生 Gemini API”; always classify the endpoint family first.

## Agent Workflow

- Repository-local `AGENTS.md` supplements user-level global agent rules; it does not replace them.
- For rule precedence, reply-language decisions, and agent-behavior disputes, follow `docs/AGENT_RULES_SOP.md`.
- Historical architecture notes live in `docs/AI_TECHNICAL_REFERENCE.md`; treat them as secondary context and verify implementation details against `README.md`, `package.json`, and current source before relying on them.
