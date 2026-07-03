# Agent Instructions

## Caveman Skill

- Use the project-local `caveman` skill when the user asks for caveman mode, says to use caveman, asks for fewer tokens, asks to be brief, or invokes `/caveman`.
- Skill file: `.agents/skills/caveman/SKILL.md`.
- Read that file before applying the mode. Default intensity is `full` unless the user requests another level.
- Keep technical terms, code, command names, API names, error strings, and file paths exact.
- Stop using the mode only when the user says `stop caveman` or `normal mode`.
- For security warnings, destructive confirmations, or multi-step instructions where compression could make order ambiguous, use normal clear prose for that part, then resume caveman mode.

## Project Notes

- Use Bun directly for server and frontend builds. Do not add Vite.
- React frontend lives under `frontend/`; built assets are served from `public/`.
- tRPC API is mounted at `/api/trpc`; proxy routes are mounted at `/v1/*`.
- Prefer focused changes that match existing repo patterns.
