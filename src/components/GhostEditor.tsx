import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'

export interface GhostEditorHandle {
  insertAtCursor: (text: string) => void
  setCursor: (pos: number) => void
  focus: () => void
  getSelection: () => { start: number; end: number }
}

interface GhostEditorProps {
  value: string
  cursor: number
  onChange: (value: string, cursorPos: number) => void
  onCursorChange: (pos: number) => void
  suggestion: string | null
  onAcceptSuggestion: () => void
  onDismissSuggestion: () => void
  onManualTrigger: () => void
  onUndo?: () => void
  onRedo?: () => void
  canUndo?: boolean
  canRedo?: boolean
  fontSize: number
  fontFamily: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** HTML de espelho estático (usado na página que vira durante o flip). */
export function staticMirrorHtml(text: string): string {
  return text ? escapeHtml(text) + '&#8203;' : ''
}

const PLACEHOLDER =
  'Comece a escrever… o autocomplete fantasma aparece sozinho. Tab aceita, Esc dispensa.'

const GhostEditor = forwardRef<GhostEditorHandle, GhostEditorProps>(
  function GhostEditor(
    {
      value,
      cursor,
      onChange,
      onCursorChange,
      suggestion,
      onAcceptSuggestion,
      onDismissSuggestion,
      onManualTrigger,
      onUndo,
      onRedo,
      canUndo,
      canRedo,
      fontSize,
      fontFamily,
    },
    ref,
  ) {
    const taRef = useRef<HTMLTextAreaElement>(null)
    const mirrorRef = useRef<HTMLDivElement>(null)
    const pendingSelection = useRef<number | null>(null)
    const acceptCooldownRef = useRef(false)

    useImperativeHandle(ref, () => ({
      insertAtCursor(text: string) {
        const ta = taRef.current
        if (!ta) return
        const start = ta.selectionStart
        const end = ta.selectionEnd
        const next = value.slice(0, start) + text + value.slice(end)
        pendingSelection.current = start + text.length
        onChange(next, start + text.length)
      },
      setCursor(pos: number) {
        // Aplica já no DOM atual e deixa pendente: quando `value` mudar no mesmo
        // commit (aceitar sugestão, undo/redo, aplicar edição), o efeito de
        // layout reposiciona o caret depois que o React grava o novo texto.
        pendingSelection.current = pos
        const ta = taRef.current
        if (ta) {
          ta.selectionStart = pos
          ta.selectionEnd = pos
        }
      },
      focus() {
        taRef.current?.focus()
      },
      getSelection() {
        const ta = taRef.current
        return ta
          ? { start: ta.selectionStart, end: ta.selectionEnd }
          : { start: 0, end: 0 }
      },
    }))

    const mirrorHtml = useMemo(() => {
      if (value.length === 0) {
        return `<span style="color: var(--dracula-comment)">${escapeHtml(PLACEHOLDER)}</span>`
      }
      const pos = Math.min(cursor, value.length)
      const before = escapeHtml(value.slice(0, pos))
      const after = escapeHtml(value.slice(pos))
      const ghost = suggestion
        ? `<span class="ghost-suggestion">${escapeHtml(suggestion)}</span>`
        : ''
      // \u200B final garante a altura quando o texto termina em quebra de linha
      return before + ghost + after + '&#8203;'
    }, [value, cursor, suggestion])

    // faz o textarea crescer junto com o conteúdo, eliminando scroll interno
    useLayoutEffect(() => {
      const ta = taRef.current
      if (!ta) return
      ta.style.height = 'auto'
      ta.style.height = `${ta.scrollHeight}px`
    }, [value, suggestion])

    // Reposiciona o caret DEPOIS que o React grava o novo `value`. Reposicionar
    // um textarea controlado antes do commit não adianta (o browser joga o caret
    // para o fim ao regravar `value`), e drenar isto no rAF do onChange fazia o
    // valor pendente ser reaplicado na PRÓXIMA tecla — era o "salto de cursor"
    // após aceitar sugestão/undo/redo. Aqui drenamos uma única vez, no commit.
    useLayoutEffect(() => {
      if (pendingSelection.current == null) return
      const ta = taRef.current
      if (ta) {
        ta.selectionStart = pendingSelection.current
        ta.selectionEnd = pendingSelection.current
      }
      pendingSelection.current = null
    }, [value])

    return (
      <div
        className="ghost-editor-wrap"
        style={{
          ['--editor-font-size' as string]: `${fontSize}px`,
          ['--editor-lh' as string]: `${fontSize * 2}px`,
          ['--editor-font-family' as string]: fontFamily,
        }}
      >
        <div
          ref={mirrorRef}
          className="ghost-editor-mirror"
          aria-hidden
          dangerouslySetInnerHTML={{ __html: mirrorHtml }}
        />
        <textarea
          ref={taRef}
          className="ghost-editor-input"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Editor de notas"
          onChange={(e) => {
            // Digitação nativa manda no caret: qualquer reposição programática
            // pendente vira obsoleta e não pode ser reaplicada por cima.
            pendingSelection.current = null
            onChange(e.target.value, e.target.selectionStart)
          }}
          onSelect={(e) => {
            onCursorChange(e.currentTarget.selectionStart)
          }}
          onKeyDown={(e) => {
            if (e.repeat) return

            if (e.key === 'Tab') {
              e.preventDefault()
              if (suggestion) {
                if (acceptCooldownRef.current) return
                acceptCooldownRef.current = true
                window.setTimeout(() => {
                  acceptCooldownRef.current = false
                }, 400)
                onAcceptSuggestion()
              } else {
                // Sem sugestão: Tab insere dois espaços, como num editor de código
                const ta = e.currentTarget
                const start = ta.selectionStart
                const next = value.slice(0, start) + '  ' + value.slice(ta.selectionEnd)
                pendingSelection.current = start + 2
                onChange(next, start + 2)
              }
              return
            }
            if (e.key === 'Escape' && suggestion) {
              e.preventDefault()
              e.stopPropagation()
              onDismissSuggestion()
              return
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === ' ' || e.key === 'Enter')) {
              e.preventDefault()
              onManualTrigger()
              return
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
              if (e.shiftKey) {
                if (canRedo) {
                  e.preventDefault()
                  onRedo?.()
                }
              } else if (canUndo) {
                e.preventDefault()
                onUndo?.()
              }
              return
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
              if (canRedo) {
                e.preventDefault()
                onRedo?.()
              }
              return
            }
          }}
        />
      </div>
    )
  },
)

export default GhostEditor
