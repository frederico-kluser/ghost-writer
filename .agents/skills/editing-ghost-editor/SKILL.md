---
name: editing-ghost-editor
description: Guides changes to the AI ghost autocomplete, suggestion cache, and OpenAI completion flow. Use whenever the user touches GhostEditor.tsx, suggestionCache.ts, lib/openai.ts completions, or Tab/Esc/manual-trigger behavior.
metadata:
  type: task
  verification_signal: yarn build in project root + ghost-editor eval suite
---
# editing-ghost-editor

## When to use

The user wants to change how the AI inline suggestion works: prompt engineering, acceptance/dismissal keys, the transparent textarea mirror, debouncing, caching, or error handling.

## Injected knowledge

### Architecture

- `GhostEditor.tsx` is a transparent `<textarea>` with a synchronized `<div>` mirror that renders the suggestion as dimmed "ghost" text (`components/GhostEditor.tsx:14-41`).
- `Home.tsx` owns the completion orchestration: debounce, abort, cache lookup, OpenAI call, ghost display, and an undo/redo stack for accepted suggestions / AI edits / voice insertions (`pages/Home.tsx:388-481`, `pages/Home.tsx:330-387`).
- `lib/suggestionCache.ts` is a `localStorage` LRU keyed by a hash of 400 chars before + 60 chars after the cursor (`lib/suggestionCache.ts:7-8`).
- `lib/openai.ts` contains `fetchCompletion`, which is **non-streaming** (`lib/openai.ts:163-176`). All chat calls funnel through one `chatCompletion` wrapper (`lib/openai.ts:37`).
- `lib/openai.ts` has **several** generation paths, and they are not interchangeable:
  - `fetchCompletion` continues the text on its own (ghost + Tab).
  - `fetchGuidedSuggestion` takes a user **briefing** and writes new text delivered through a preview dialog (`components/AskSuggestionDialog.tsx`).
  - `applyInstruction` only rewrites text that already exists (used **only** for the "aplicar só na seleção" case — it still has a whole-document branch, kept for that API shape).
  - `fetchEditKit` returns a **positional edit kit** — JSON `{edicoes:[…]}` of anchor-based ops (`substituir`/`inserir_apos`/`inserir_antes`/`inicio`/`fim`) applied by `applyEditKit` in `lib/editKit.ts`. This is what "Editar com IA" (whole document) and voice **commands** use now, instead of replacing the whole document. The caret lands at the last applied edit, never at the document end. `applyEditKit` orders multiple inserts at the **same** anchor (repeated `inserir_apos` / multiple `inicio`) by continuing after the previous insert — a plain `indexOf` from 0 would reverse them.
  - `fetchIdeas` returns `{ideias:[{titulo,conteudo}]}`; applying an idea inserts `conteudo` at the cursor via `insertTextAtAnchor` (Ideas feature, mobile "?" pill button + `mod+alt+shift+i`).

### Contracts and constants

- Context windows in `lib/openai.ts:17-19`:
  - `MAX_BEFORE = 6000` chars before cursor.
  - `MAX_AFTER = 2000` chars after cursor.
  - `MAX_ATTACH_TOTAL = 8000` chars total for attachments.
- Completion parameters: `temperature: 0.3`, `max_tokens: 180` (`lib/openai.ts:171-172`).
- Guided-suggestion parameters: `temperature: 0.7` (creative composition, unlike the 0.3 of autocomplete and the 0.2 of `applyInstruction`), `MAX_BRIEFING = 2000` chars (`lib/openai.ts:20`, `lib/openai.ts:233-236`). It reuses `MAX_BEFORE`/`MAX_AFTER`/`MAX_ATTACH_TOTAL` untouched.
- The attachment block builder is shared by both prompts (`buildAttachmentsBlock`, `lib/openai.ts:114`); the 8000-char budget is consumed **in array order**, so the first attachment can eat it all.
- Cache: max 120 entries, values capped at 600 chars (`lib/suggestionCache.ts:7-8`).
- Sanitization is split in two: `normalizeModelText` (CRLF + ``` fence unwrap) is generic and shared, while `sanitizeCompletion` adds the **continuation-only** parts — stripping overlaps of **4+** chars and `trimEnd()` that preserves leading whitespace (`lib/openai.ts:141-161`). **Do not apply the overlap strip to guided suggestions**: it is a literal-continuation heuristic and would amputate the first word of a legitimately new block.
- `fetchCompletion` asks `chatCompletion` **not** to trim the raw model output, so a leading space in the continuation is kept (`lib/openai.ts:158-170`).

### Key behaviors

- `Tab` accepts the suggestion once per keypress (repeat events and a 400 ms cooldown prevent double acceptance); `Esc` dismisses; `Ctrl/Cmd+Space|Enter` triggers manually; otherwise two-space tab insertion (`components/GhostEditor.tsx:164-191`).
- The acceptance handler in `Home.tsx` is guarded by `isAcceptingRef` to prevent concurrent calls from inserting the suggestion more than once before `setSuggestion(null)` propagates (`pages/Home.tsx:514-539@fc63c8f`).
- **"Dock" é ambíguo neste app: existem DUAS barras inferiores.** Confirmar qual antes de mexer — confundi-las já custou um commit inteiro no alvo errado.
  - `components/Dock.tsx` (`.dock`): barra chapada, largura total, `border-top`. Renderiza **só com ponteiro fino** (`{!isTouch && <Dock …/>}`).
  - A pílula flutuante em `pages/Home.tsx` (`fixed bottom-4`, arredondada, Mic/Undo/Redo/IA/Aceitar/Dispensar): renderiza com `isTouch && mode !== 'preview'`. **É esta que o usuário chama de "a dock do mobile"** — flutua, é arredondada e é a única visível no celular.
  - As duas são mutuamente exclusivas por `isTouch`: renderizar ambas empilha duas barras oferecendo a mesma ação.
- **No toque, a pílula é o único caminho para aceitar ou dispensar** (não há `Tab` nem `Esc`). Aceitar/Dispensar ficam **sempre montados** e apenas `disabled` sem sugestão — montá-los condicionalmente faria a pílula pular de largura a cada sugestão. Qualquer mudança que os esconda quebra o fluxo em mobile.
- Os controles de fonte **não moram em nenhuma das duas barras**: ficam no menu — seção "Fonte" no drawer (mobile) e submenu "Fonte" no menu "Mais" (desktop), sobre `lib/fonts.ts`.
- `Ctrl/Cmd+Z` undoes the last accepted suggestion (and other recorded edits), `Ctrl/Cmd+Shift+Z` / `Ctrl/Cmd+Y` redoes; mobile shows undo/redo icons (`pages/Home.tsx:330-387`, `components/GhostEditor.tsx:164-191`).
- Every new completion aborts the previous `AbortController` (`pages/Home.tsx:296-298`).
- After the API returns, a guard compares `cursorRef.current === pos && textRef.current === full` to avoid stale suggestions (`pages/Home.tsx:317`).
- Errors surface via `toast` (`pages/Home.tsx:325`). Aborted requests are ignored.

### Gotchas

- `dangerouslySetInnerHTML` renders user content + suggestion after a custom escape (`components/GhostEditor.tsx:26-32`). The escape list does not include `'`, which is usually safe but worth noting.
- Ghost text overlaps of 1–3 chars are left in; only 4+ char overlaps are removed (`lib/openai.ts:88-94`).
- `localStorage` full errors in the cache are silently swallowed (`lib/suggestionCache.ts:21-27`).
- **Reasoning models need a much higher token ceiling.** For `/^o\d/` models `chatCompletion` sends `max_completion_tokens` instead of `max_tokens` (`lib/openai.ts:53`), and that budget **includes the reasoning tokens**. A ceiling sized for the visible answer alone gets consumed by reasoning and the API returns `content: ''` — a silently blank result, not an error. `fetchGuidedSuggestion` therefore scales the ceiling per family (`lib/openai.ts:236`). `applyInstruction` still has a flat 4096 for both branches plus a vestigial `const reasoning` that computes the same value twice (`lib/openai.ts:302`) — untouched so far.
- **`pendingSelection` is now drained from a `useLayoutEffect([value])`, not the `onChange` rAF** (fixed). The old rAF drain re-applied the stale caret on the *next* keystroke after any programmatic reposition, which was the "cursor jumps out of nowhere" bug (accept suggestion / undo / redo / voice insert). Now: the layout effect applies `pendingSelection` once, right after React commits the new `value`, then clears it; and the native textarea `onChange` clears `pendingSelection` first (a real keystroke owns the caret, a stale programmatic value must never win). This also fixed the latent caret bug in `insertAtCursor` and the Tab-two-spaces path, which called the `onChange` prop directly and so never triggered the old rAF drain. When touching caret logic, keep both drains: layout-effect-on-value (programmatic changes) and clear-on-native-onChange (typing).

## Procedure

1. Load `working-in-ghostwriter` first.
2. Identify the layer being changed (editor UI, debounce logic, prompt, cache, or OpenAI client).
3. Keep the ref/state guard pattern when touching async completion handlers.
4. Run `yarn build` in the project root.
5. Run the ghost-editor eval suite (`scripts/eval-ghost-editor.sh`).

## References

- `references/ghost-editor-contracts.md` — prompt template, context windows, sanitization rules.

## <evolution>

On task completion, run the <memory_pipeline>: if there is IMPORTANT and VERIFIED information to retain, update THIS SKILL.md DIRECTLY. Do NOT create learnings files. Do NOT self-merge anything that has not passed `yarn build` in the project root and the ghost-editor eval suite.
