import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Toaster, toast } from 'sonner'
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Command,
  Eye,
  FileDown,
  FileText,
  FileType2,
  Github,
  HelpCircle,
  Image,
  KeyRound,
  Lightbulb,
  Loader2,
  Maximize2,
  Menu,
  Mic,
  MicOff,
  Minimize2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Redo2,
  RefreshCw,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Wand2,
  X,
} from 'lucide-react'
import GhostEditor, {
  staticMirrorHtml,
  type GhostEditorHandle,
} from '@/components/GhostEditor'
import MarkdownPreview from '@/components/MarkdownPreview'
import ApiKeyDialog, { type KeyStatus } from '@/components/ApiKeyDialog'
import LockScreen from '@/components/LockScreen'
import PageSheet, { type LeavingPage } from '@/components/PageSheet'
import AttachmentsPanel from '@/components/AttachmentsPanel'
import GitHubContextDialog from '@/components/GitHubContextDialog'
import AiEditDialog from '@/components/AiEditDialog'
import AskSuggestionDialog from '@/components/AskSuggestionDialog'
import IdeasDialog from '@/components/IdeasDialog'
import TourOverlay from '@/components/tour/TourOverlay'
import ToolbarButton from '@/components/toolbar/ToolbarButton'
import CommandPalette from '@/components/CommandPalette'
import Dock from '@/components/Dock'
import {
  FONT_OPTIONS,
  FONT_FAMILY_CSS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
} from '@/lib/fonts'
import { useTour } from '@/hooks/useTour'
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts'
import { formatShortcut, type Command as AppCommand, type Shortcut } from '@/lib/commands'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  applyInstruction,
  classifyUtterance,
  fetchCompletion,
  fetchEditKit,
  fetchGuidedSuggestion,
  fetchIdeas,
  looksLikeCommand,
  transcribeAudio,
  validateApiKey,
  type Idea,
} from '@/lib/openai'
import {
  applyEditKit,
  describeEditKit,
  insertTextAtAnchor,
  type EditOp,
} from '@/lib/editKit'
import { LOGO_URL } from '@/lib/brand'
import { getCached, invalidate, setCached } from '@/lib/suggestionCache'
import {
  dbDelete,
  dbGetAll,
  dbPut,
  downloadNote,
  newProject,
  type Attachment,
  type Project,
} from '@/lib/db'
import { downloadNoteImage, downloadNotePdf } from '@/lib/export'

interface Suggestion {
  text: string
  source: 'api' | 'memoria'
}

interface HistoryItem {
  content: string
  cursor: number
}

/**
 * Como uma edição da IA será aplicada. `selection` troca só o intervalo
 * selecionado; `kit` aplica edições cirúrgicas em vários pontos (sem reescrever
 * o documento inteiro).
 */
type AiEditPlan =
  | { kind: 'kit'; edits: EditOp[] }
  | { kind: 'selection'; start: number; end: number; text: string }

type ViewMode = 'edit' | 'split' | 'preview'
type RecState = 'idle' | 'recording' | 'transcribing'

const LS = {
  key: 'noteghost_api_key',
  legacyText: 'noteghost_text',
  model: 'noteghost_model',
  fontSize: 'noteghost_font_size',
  fontFamily: 'noteghost_font_family',
  githubPat: 'noteghost_github_pat',
  // 'noteghost_tutorial_seen' (legado) agora pertence a lib/tour.ts
}

const MODEL_OPTIONS = [
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'o4-mini', label: 'o4-mini' },
  { id: 'o3', label: 'o3' },
]
const DEFAULT_MODEL = MODEL_OPTIONS[1].id
const AUTOCOMPLETE_DELAY_MS = 800

/**
 * Atalhos globais.
 *
 * `mod+alt+…` porque as combinações mais curtas já pertencem ao navegador
 * (Ctrl/Cmd+N nova janela, +T nova aba, +W fechar, +Shift+N anônima) e porque
 * Tab, Esc, Ctrl+Espaço, Ctrl+Enter e Ctrl+Z/Y continuam sendo do editor.
 * `mod+K` para a paleta é a convenção estabelecida na web.
 */
const SC = {
  palette: { key: 'k', mod: true } satisfies Shortcut,
  prevPage: { key: 'ArrowLeft', mod: true, alt: true } satisfies Shortcut,
  nextPage: { key: 'ArrowRight', mod: true, alt: true } satisfies Shortcut,
  newPage: { key: 'n', mod: true, alt: true } satisfies Shortcut,
  dictate: { key: 'd', mod: true, alt: true } satisfies Shortcut,
  aiEdit: { key: 'e', mod: true, alt: true } satisfies Shortcut,
  askSuggestion: { key: 's', mod: true, alt: true } satisfies Shortcut,
  // +shift mantém o mnemônico "i" sem colidir com ⌘⌥I (DevTools no macOS).
  ideas: { key: 'i', mod: true, alt: true, shift: true } satisfies Shortcut,
  fullscreen: { key: 'f', mod: true, alt: true } satisfies Shortcut,
  retry: { key: 'r', mod: true, alt: true } satisfies Shortcut,
  attach: { key: 'a', mod: true, alt: true } satisfies Shortcut,
  modeEdit: { key: '1', mod: true, alt: true } satisfies Shortcut,
  modeSplit: { key: '2', mod: true, alt: true } satisfies Shortcut,
  modePreview: { key: '3', mod: true, alt: true } satisfies Shortcut,
}

/** Segmentos do controle de exibição. Rótulos são substantivos, como pede a HIG. */
const MODES = [
  {
    id: 'edit' as const,
    label: 'Editor',
    hint: 'Só o texto',
    icon: Pencil,
    shortcut: SC.modeEdit,
  },
  {
    id: 'split' as const,
    label: 'Dividido',
    hint: 'Texto e resultado lado a lado',
    icon: Columns2,
    shortcut: SC.modeSplit,
  },
  {
    id: 'preview' as const,
    label: 'Leitura',
    hint: 'Markdown renderizado',
    icon: Eye,
    shortcut: SC.modePreview,
  },
]

/** Classe repetida dos itens de menu. */
const MI = 'cursor-pointer focus:bg-[#44475a] focus:text-[#f8f8f2]'

/** Atalho alinhado à direita dentro de um item de menu. */
function MenuHint({ s }: { s: Shortcut }) {
  return (
    <span className="ml-auto pl-3 text-[11px] tabular-nums text-[#6272a4]">
      {formatShortcut(s)}
    </span>
  )
}

export default function Home() {
  // ---------- projetos (páginas) ----------
  const [projects, setProjects] = useState<Project[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [dbReady, setDbReady] = useState(false)
  const [leaving, setLeaving] = useState<LeavingPage | null>(null)

  // ---------- editor ----------
  const [cursor, setCursor] = useState(0)
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<ViewMode>('edit')
  const [history, setHistory] = useState<{ past: HistoryItem[]; future: HistoryItem[] }>({
    past: [],
    future: [],
  })
  const [fontSize, setFontSize] = useState(
    () => Number(localStorage.getItem(LS.fontSize)) || 17,
  )
  const [fontFamily, setFontFamily] = useState(
    () => localStorage.getItem(LS.fontFamily) ?? FONT_OPTIONS[0].id,
  )

  // ---------- OpenAI ----------
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(LS.key) ?? '')
  const [keyStatus, setKeyStatus] = useState<KeyStatus>('idle')
  const [keyError, setKeyError] = useState<string | undefined>()
  const [keyDialogOpen, setKeyDialogOpen] = useState(false)
  const [storedChecked, setStoredChecked] = useState(false)
  const [model, setModel] = useState(() => localStorage.getItem(LS.model) ?? DEFAULT_MODEL)

  // ---------- extras ----------
  const [recState, setRecState] = useState<RecState>('idle')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [pseudoFs, setPseudoFs] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [githubDialogOpen, setGithubDialogOpen] = useState(false)
  const [githubPat, setGithubPat] = useState(() => localStorage.getItem(LS.githubPat) ?? '')

  // ---------- tutorial ----------
  // O estado por passo vive em useTour; a chave legada só é lida na migração.

  // ---------- editar com IA ----------
  const [aiEditOpen, setAiEditOpen] = useState(false)
  const [aiEditPreview, setAiEditPreview] = useState<string | null>(null)
  const [aiEditLoading, setAiEditLoading] = useState(false)
  const [aiEditPlan, setAiEditPlan] = useState<AiEditPlan | null>(null)
  const [aiEditSelection, setAiEditSelection] = useState<{
    start: number
    end: number
  } | null>(null)

  // ---------- ideias ----------
  const [ideasOpen, setIdeasOpen] = useState(false)
  const [ideasNeed, setIdeasNeed] = useState('')
  const [ideas, setIdeas] = useState<Idea[] | null>(null)
  const [ideasLoading, setIdeasLoading] = useState(false)
  const [ideasAnchor, setIdeasAnchor] = useState(0)

  // ---------- pedir sugestão ----------
  const [askOpen, setAskOpen] = useState(false)
  const [askPreview, setAskPreview] = useState<string | null>(null)
  const [askLoading, setAskLoading] = useState(false)
  const [askAnchor, setAskAnchor] = useState(0)

  // ---------- refs ----------
  const textRef = useRef('')
  const cursorRef = useRef(0)
  const isAcceptingRef = useRef(false)
  const debounceRef = useRef<number | undefined>(undefined)
  const saveTimerRef = useRef<number | undefined>(undefined)
  const abortRef = useRef<AbortController | null>(null)
  // controller próprio: compartilhar com o autocomplete faria uma tecla digitada
  // cancelar a geração guiada em andamento
  const askAbortRef = useRef<AbortController | null>(null)
  const ideasAbortRef = useRef<AbortController | null>(null)
  // Para onde vai a próxima transcrição de voz. Fica num ref (não na closure do
  // onstop) para que "Parar" no diálogo de Ideias entregue o texto ao campo de
  // Ideias mesmo que a gravação tenha começado pelo microfone do editor.
  const transcriptSinkRef = useRef<((transcript: string) => void) | null>(null)
  const editorRef = useRef<GhostEditorHandle>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const isTouch = useMemo(
    () =>
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window),
    [],
  )

  const [paletteOpen, setPaletteOpen] = useState(false)

  /** Abaixo disso os segmentos de exibição ficam só com o símbolo. */
  const [wideDesktop, setWideDesktop] = useState(
    () => window.matchMedia?.('(min-width: 1140px)').matches ?? false,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1140px)')
    const on = () => setWideDesktop(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const canUndo = history.past.length > 0
  const canRedo = history.future.length > 0

  const active = useMemo(
    () => projects.find((p) => p.id === activeId) ?? null,
    [projects, activeId],
  )
  const activeIndex = useMemo(
    () => projects.findIndex((p) => p.id === activeId),
    [projects, activeId],
  )
  const unlocked = keyStatus === 'valid'
  const busy = leaving !== null

  // sincroniza o ref de texto ao trocar de página
  useEffect(() => {
    textRef.current = projects.find((p) => p.id === activeId)?.content ?? ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // ---------- carregar projetos do IndexedDB ----------
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        let list = await dbGetAll()
        if (list.length === 0) {
          // migra a nota antiga do localStorage, se existir
          const migrated = localStorage.getItem(LS.legacyText) ?? ''
          const p = newProject('Página 1', migrated)
          await dbPut(p)
          list = [p]
        }
        if (!cancelled) {
          setProjects(list)
          setActiveId(list[0].id)
        }
      } catch {
        if (!cancelled) {
          const p = newProject('Página 1')
          setProjects([p])
          setActiveId(p.id)
          toast.error('IndexedDB indisponível: as notas não serão salvas.')
        }
      } finally {
        if (!cancelled) setDbReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // ---------- salvar projeto ativo (debounce) ----------
  useEffect(() => {
    if (!dbReady || !active) return
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      void dbPut({ ...active, updatedAt: Date.now() })
    }, 500)
  }, [active, dbReady])

  // ---------- persistência simples ----------
  useEffect(() => {
    localStorage.setItem(LS.fontSize, String(fontSize))
  }, [fontSize])
  useEffect(() => {
    localStorage.setItem(LS.fontFamily, fontFamily)
  }, [fontFamily])
  useEffect(() => {
    localStorage.setItem(LS.model, model)
  }, [model])
  useEffect(() => {
    localStorage.setItem(LS.githubPat, githubPat)
  }, [githubPat])

  // ---------- tutorial ancorado ----------
  const tour = useTour(isTouch)
  const { autoStart: tourAutoStart, recordAction: tourAction } = tour

  // Só depois que a folha existe de fato — o primeiro passo aponta para ela.
  useEffect(() => {
    if (dbReady && unlocked) tourAutoStart()
  }, [dbReady, unlocked, tourAutoStart])

  // ---------- validação da chave ----------
  const runValidation = useCallback(async (key: string) => {
    setKeyStatus('checking')
    setKeyError(undefined)
    const r = await validateApiKey(key)
    setKeyStatus(r.ok ? 'valid' : 'invalid')
    setKeyError(r.error)
    return r.ok
  }, [])

  // revalida a chave salva ao abrir — o app fica bloqueado até ser válida
  useEffect(() => {
    if (apiKey) {
      void runValidation(apiKey).finally(() => setStoredChecked(true))
    } else {
      setStoredChecked(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveKey = useCallback((key: string) => {
    localStorage.setItem(LS.key, key)
    setApiKey(key)
  }, [])

  const handleLockSubmit = useCallback(
    async (key: string) => {
      const ok = await runValidation(key)
      if (ok) saveKey(key)
      return ok
    },
    [runValidation, saveKey],
  )

  // ---------- helpers de edição ----------
  const updateActive = useCallback(
    (patch: Partial<Project>) => {
      if (!activeId) return
      setProjects((prev) => prev.map((p) => (p.id === activeId ? { ...p, ...patch } : p)))
    },
    [activeId],
  )

  const resetEditorState = useCallback(() => {
    window.clearTimeout(debounceRef.current)
    abortRef.current?.abort()
    setSuggestion(null)
    setCursor(0)
    cursorRef.current = 0
    setHistory({ past: [], future: [] })
  }, [])

  const handleDownloadImage = useCallback(async () => {
    if (!active || !pageRef.current) return
    try {
      await downloadNoteImage(pageRef.current, active)
      toast.success('Imagem da nota baixada.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Falha ao gerar imagem da nota.')
    }
  }, [active])

  const handleDownloadPdf = useCallback(async () => {
    if (!active || !pageRef.current) return
    try {
      await downloadNotePdf(pageRef.current, active)
      toast.success('PDF da nota baixado.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Falha ao gerar PDF da nota.')
    }
  }, [active])

  // ---------- histórico (undo/redo) ----------
  const recordHistory = useCallback(() => {
    const current = { content: textRef.current, cursor: cursorRef.current }
    setHistory((h) => {
      const last = h.past[h.past.length - 1]
      if (last && last.content === current.content && last.cursor === current.cursor) return h
      return { past: [...h.past, current], future: [] }
    })
  }, [])

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.past.length === 0) return h
      const prev = h.past[h.past.length - 1]
      const current = { content: textRef.current, cursor: cursorRef.current }
      textRef.current = prev.content
      cursorRef.current = prev.cursor
      updateActive({ content: prev.content })
      setCursor(prev.cursor)
      setSuggestion(null)
      editorRef.current?.setCursor(prev.cursor)
      return { past: h.past.slice(0, -1), future: [...h.future, current] }
    })
  }, [updateActive])

  const redo = useCallback(() => {
    setHistory((h) => {
      if (h.future.length === 0) return h
      const next = h.future[h.future.length - 1]
      const current = { content: textRef.current, cursor: cursorRef.current }
      textRef.current = next.content
      cursorRef.current = next.cursor
      updateActive({ content: next.content })
      setCursor(next.cursor)
      setSuggestion(null)
      editorRef.current?.setCursor(next.cursor)
      return { past: [...h.past, current], future: h.future.slice(0, -1) }
    })
  }, [updateActive])

  // ---------- editar com IA ----------
  const openAiEdit = useCallback(() => {
    const sel = editorRef.current?.getSelection() ?? { start: 0, end: 0 }
    setAiEditSelection(sel.start === sel.end ? null : sel)
    setAiEditPreview(null)
    setAiEditPlan(null)
    setAiEditOpen(true)
    tourAction('editar-ia')
  }, [tourAction])

  const handleAiEditGenerate = useCallback(
    async (instruction: string, onlySelection: boolean) => {
      if (!apiKey || !unlocked) return
      setAiEditLoading(true)
      setAiEditPreview(null)
      setAiEditPlan(null)
      try {
        const full = textRef.current
        if (aiEditSelection && onlySelection) {
          // Só a seleção: já é posicional, troca apenas o intervalo escolhido.
          const selected = full.slice(aiEditSelection.start, aiEditSelection.end)
          const result = await applyInstruction({
            apiKey,
            model,
            instruction,
            fullText: full,
            selectedText: selected,
          })
          setAiEditPlan({
            kind: 'selection',
            start: aiEditSelection.start,
            end: aiEditSelection.end,
            text: result,
          })
          setAiEditPreview(result)
        } else {
          // Documento inteiro: kit de edições cirúrgicas em vez de reescrever tudo.
          const edits = await fetchEditKit({
            apiKey,
            model,
            instruction,
            fullText: full,
            attachments: (active?.attachments ?? []).map((a) => ({
              name: a.name,
              content: a.content,
            })),
          })
          if (edits.length === 0) {
            toast('A IA não retornou edições para essa instrução. Tente reformular.')
            return
          }
          const { applied, missed } = applyEditKit(full, edits)
          if (applied === 0) {
            toast.error(
              'Nenhuma edição pôde ser aplicada: os trechos não foram encontrados no texto.',
            )
            return
          }
          setAiEditPlan({ kind: 'kit', edits })
          setAiEditPreview(describeEditKit(edits, missed.length))
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Falha ao gerar edição.')
      } finally {
        setAiEditLoading(false)
      }
    },
    [apiKey, unlocked, model, aiEditSelection, active],
  )

  const handleAiEditApply = useCallback(() => {
    if (!aiEditPlan) return
    const full = textRef.current
    let next: string
    let caret: number
    if (aiEditPlan.kind === 'selection') {
      next = full.slice(0, aiEditPlan.start) + aiEditPlan.text + full.slice(aiEditPlan.end)
      caret = aiEditPlan.start + aiEditPlan.text.length
    } else {
      const r = applyEditKit(full, aiEditPlan.edits)
      if (r.applied === 0) {
        toast.error('Nenhuma edição pôde ser aplicada: os trechos não foram encontrados.')
        return
      }
      next = r.text
      caret = r.caret
      if (r.missed.length > 0) {
        toast(`${r.missed.length} edição(ões) foram ignoradas (trecho não encontrado).`)
      }
    }
    recordHistory()
    textRef.current = next
    cursorRef.current = caret
    updateActive({ content: next })
    setCursor(caret)
    editorRef.current?.setCursor(caret)
    setAiEditOpen(false)
    setAiEditPreview(null)
    setAiEditPlan(null)
    toast.success('Edição aplicada.')
  }, [aiEditPlan, recordHistory, updateActive])

  // ---------- pedir sugestão ----------
  const openAskSuggestion = useCallback(() => {
    // sem isso o debounce dispara com o modal aberto e um ghost aparece atrás dele
    window.clearTimeout(debounceRef.current)
    const sel = editorRef.current?.getSelection()
    // havendo seleção, escrevemos DEPOIS dela: aqui nunca destruímos texto
    setAskAnchor(sel ? sel.end : cursorRef.current)
    setAskPreview(null)
    setSuggestion(null)
    setAskOpen(true)
    tourAction('pedir-sugestao')
  }, [tourAction])

  const handleAskOpenChange = useCallback((open: boolean) => {
    if (!open) {
      askAbortRef.current?.abort()
      askAbortRef.current = null
      setAskLoading(false)
    }
    setAskOpen(open)
  }, [])

  const handleAskGenerate = useCallback(
    async (briefing: string) => {
      if (!apiKey || !unlocked) return
      const trimmed = briefing.trim()
      if (!trimmed) return

      askAbortRef.current?.abort()
      const ctrl = new AbortController()
      askAbortRef.current = ctrl
      setAskLoading(true)
      setAskPreview(null)
      try {
        const full = textRef.current
        const pos = Math.min(askAnchor, full.length)
        const out = await fetchGuidedSuggestion({
          apiKey,
          model,
          briefing: trimmed,
          beforeCursor: full.slice(0, pos),
          afterCursor: full.slice(pos),
          attachments: (active?.attachments ?? []).map((a) => ({
            name: a.name,
            content: a.content,
          })),
          signal: ctrl.signal,
        })
        if (ctrl.signal.aborted) return
        if (!out.trim()) {
          toast('A IA não conseguiu escrever para esse pedido. Tente detalhar mais o briefing.')
          return
        }
        setAskPreview(out)
      } catch (e) {
        if (!ctrl.signal.aborted) {
          toast.error(e instanceof Error ? e.message : 'Falha ao gerar a sugestão.')
        }
      } finally {
        if (askAbortRef.current === ctrl) {
          askAbortRef.current = null
          setAskLoading(false)
        }
      }
    },
    [apiKey, unlocked, model, active, askAnchor],
  )

  const handleAskInsert = useCallback(() => {
    const text = askPreview?.trim()
    if (!text || !active) return

    recordHistory() // fotografa textRef/cursorRef: tem que rodar antes da sobrescrita

    const { text: next, caret } = insertTextAtAnchor(textRef.current, askAnchor, text)

    textRef.current = next
    cursorRef.current = caret
    updateActive({ content: next })
    setCursor(caret)

    setAskOpen(false)
    setAskPreview(null)

    // o caret só pode ser reposicionado depois do commit do React e do fechamento do Radix
    window.setTimeout(() => {
      editorRef.current?.focus()
      editorRef.current?.setCursor(caret)
    }, 60)

    toast.success('Sugestão inserida.')
  }, [askPreview, askAnchor, active, recordHistory, updateActive])

  // ---------- autocomplete ----------
  const requestCompletion = useCallback(
    async (force: boolean) => {
      if (!apiKey || !unlocked) return
      const pos = cursorRef.current
      const full = textRef.current
      const before = full.slice(0, pos)
      const after = full.slice(pos)
      if (!before.trim() && !after.trim()) return

      // memória local primeiro: recall funciona sem nova chamada à API
      if (!force) {
        const mem = getCached(before, after)
        if (mem) {
          setSuggestion({ text: mem, source: 'memoria' })
          return
        }
      } else {
        invalidate(before, after)
      }

      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setLoading(true)
      try {
        const out = await fetchCompletion({
          apiKey,
          model,
          beforeCursor: before,
          afterCursor: after,
          attachments: (active?.attachments ?? []).map((a) => ({
            name: a.name,
            content: a.content,
          })),
          signal: ctrl.signal,
        })
        if (ctrl.signal.aborted) return
        if (out.trim()) {
          setCached(before, after, out)
          // se o usuário continuou digitando enquanto a API respondia,
          // guarda na memória mas não exibe a sugestão desatualizada
          if (cursorRef.current === pos && textRef.current === full) {
            setSuggestion({ text: out, source: 'api' })
          }
        } else if (force) {
          toast('A IA não encontrou continuação para este ponto.')
        }
      } catch (e) {
        if (!ctrl.signal.aborted) {
          toast.error(e instanceof Error ? e.message : 'Falha ao gerar autocomplete.')
        }
      } finally {
        if (abortRef.current === ctrl) {
          abortRef.current = null
          setLoading(false)
        }
      }
    },
    [apiKey, unlocked, model, active],
  )

  const scheduleCompletion = useCallback(() => {
    window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      void requestCompletion(false)
    }, AUTOCOMPLETE_DELAY_MS)
  }, [requestCompletion])

  const acceptSuggestion = useCallback(() => {
    if (!suggestion || isAcceptingRef.current) return
    isAcceptingRef.current = true
    recordHistory()
    const pos = cursorRef.current
    const full = textRef.current
    const next = full.slice(0, pos) + suggestion.text + full.slice(pos)
    textRef.current = next
    cursorRef.current = pos + suggestion.text.length
    updateActive({ content: next })
    setCursor(pos + suggestion.text.length)
    editorRef.current?.setCursor(pos + suggestion.text.length)
    setSuggestion(null)
    scheduleCompletion()
    tourAction('aceitar')
  }, [suggestion, recordHistory, scheduleCompletion, updateActive, tourAction])

  // libera a trava de aceitação quando a sugestão for efetivamente dispensada
  useEffect(() => {
    if (!suggestion) {
      isAcceptingRef.current = false
    }
  }, [suggestion])

  // ---------- handlers do editor ----------
  const handleChange = useCallback(
    (value: string, cursorPos: number) => {
      textRef.current = value
      cursorRef.current = cursorPos
      updateActive({ content: value })
      setCursor(cursorPos)
      setSuggestion(null)
      scheduleCompletion()
      if (value.trim().length >= 12) tourAction('escrever')
    },
    [scheduleCompletion, updateActive, tourAction],
  )

  const handleCursorChange = useCallback((pos: number) => {
    if (pos !== cursorRef.current) {
      cursorRef.current = pos
      setCursor(pos)
      setSuggestion(null) // mover o cursor dispensa a sugestão, como no VS Code
    }
  }, [])

  // ---------- cabeçalho da folha ----------
  const pageHeader = useMemo(() => {
    if (!active) return null
    const createdDate = new Date(active.createdAt)
    return (
      <>
        <input
          className="page-name"
          value={active.name}
          onChange={(e) => updateActive({ name: e.target.value })}
          aria-label="Nome da página"
          spellCheck={false}
        />
        <span className="page-meta">
          <span className="date-label">Data:</span>
          <span className="date-blank">{String(createdDate.getDate()).padStart(2, '0')}</span>
          <span className="date-sep">/</span>
          <span className="date-blank">
            {String(createdDate.getMonth() + 1).padStart(2, '0')}
          </span>
          <span className="date-sep">/</span>
          <span className="date-blank date-year">{createdDate.getFullYear()}</span>
          <span className="page-count">
            {' '}
            · {activeIndex + 1}/{projects.length}
          </span>
        </span>
      </>
    )
  }, [active, activeIndex, projects.length, updateActive])

  // ---------- navegação de páginas (slide CSS) ----------
  const startPageTransition = useCallback(
    (targetId: string, kind: 'slide' | 'tear' = 'slide') => {
      if (!active) return
      const direction =
        projects.findIndex((p) => p.id === targetId) > activeIndex ? 'next' : 'prev'
      setLeaving({
        kind,
        direction,
        header: pageHeader,
        bodyHtml: staticMirrorHtml(active.content),
      })
      resetEditorState()
      setActiveId(targetId)
      // libera o estado após a animação CSS
      window.setTimeout(() => setLeaving(null), kind === 'tear' ? 700 : 450)
    },
    [active, activeIndex, pageHeader, projects, resetEditorState],
  )

  const goTo = useCallback(
    (delta: number) => {
      if (busy || activeIndex < 0) return
      const target = projects[activeIndex + delta]
      if (!target) return
      void startPageTransition(target.id)
    },
    [busy, activeIndex, projects, startPageTransition],
  )

  const addPage = useCallback(() => {
    if (busy || !active) return
    const p = newProject(`Página ${projects.length + 1}`)
    void dbPut(p)
    setProjects((prev) => [...prev, p])
    void startPageTransition(p.id)
    toast.success(`Nova página criada: ${p.name}`)
    tourAction('paginas')
  }, [busy, active, projects.length, startPageTransition, tourAction])

  // ---------- arrancar página ----------
  const deletePage = useCallback(() => {
    if (!active || busy) return
    setDeleteOpen(true)
  }, [active, busy])

  const confirmDelete = useCallback(() => {
    if (!active) return
    const rest = projects.filter((p) => p.id !== active.id)
    let nextId: string
    if (rest.length === 0) {
      const p = newProject('Página 1')
      void dbPut(p)
      setProjects([p])
      nextId = p.id
    } else {
      setProjects(rest)
      nextId = rest[Math.min(activeIndex, rest.length - 1)].id
    }
    void dbDelete(active.id)
    void startPageTransition(nextId, 'tear')
  }, [active, projects, activeIndex, startPageTransition])

  // ---------- voz (Whisper) ----------
  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }, [])

  const startRecording = useCallback(
    async (onTranscript?: (transcript: string) => void) => {
      if (!apiKey) return
      transcriptSinkRef.current = onTranscript ?? null
      // O ditado do editor conta como passo do tour; a captura para um sink
      // externo (ex.: campo de Ideias) não.
      if (!onTranscript) tourAction('ditar')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : undefined
        const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
        chunksRef.current = []
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data)
        }
        rec.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop())
          const blob = new Blob(chunksRef.current, {
            type: rec.mimeType || 'audio/webm',
          })
          setRecState('transcribing')
          try {
            const transcript = await transcribeAudio(apiKey, blob)
            if (!transcript) {
              toast('Não consegui entender o áudio.')
              return
            }
            // Sink externo: entrega a transcrição crua e não mexe no editor.
            // Lido do ref (não da closure): reflete onde o usuário mandou parar.
            const sink = transcriptSinkRef.current
            if (sink) {
              sink(transcript)
              return
            }
            // Pré-filtro: só chama a IA se o transcript parecer um comando.
            // Isso evita que frases normais sejam confundidas com instruções
            // e substituam o documento por engano.
            let classified: { type: 'transcription' | 'instruction'; payload: string }
            if (looksLikeCommand(transcript)) {
              classified = await classifyUtterance(
                apiKey,
                model,
                transcript,
                textRef.current,
              )
            } else {
              classified = { type: 'transcription', payload: transcript }
            }
            if (classified.type === 'transcription') {
              recordHistory()
              editorRef.current?.insertAtCursor(classified.payload)
              toast.success('Transcrição inserida no cursor.')
            } else {
              // Comando de edição: kit de edições cirúrgicas, não reescreve o
              // documento inteiro nem joga o cursor para o fim.
              toast.info('Comando de edição detectado.')
              const edits = await fetchEditKit({
                apiKey,
                model,
                instruction: classified.payload,
                fullText: textRef.current,
                attachments: (active?.attachments ?? []).map((a) => ({
                  name: a.name,
                  content: a.content,
                })),
              })
              const { text: next, caret, applied, missed } = applyEditKit(
                textRef.current,
                edits,
              )
              if (applied === 0) {
                toast('Não consegui aplicar esse comando ao texto.')
                return
              }
              recordHistory()
              textRef.current = next
              cursorRef.current = caret
              updateActive({ content: next })
              setCursor(caret)
              editorRef.current?.setCursor(caret)
              if (missed.length > 0) {
                toast(`${missed.length} parte(s) do comando foram ignoradas.`)
              }
              toast.success('Edição aplicada pelo comando de voz.')
            }
          } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Falha na transcrição.')
          } finally {
            setRecState('idle')
          }
        }
        recorderRef.current = rec
        rec.start()
        setRecState('recording')
        toast.info('Gravando… toque no microfone novamente para parar.', {
          position: 'top-center',
        })
      } catch {
        toast.error('Não foi possível acessar o microfone. Verifique a permissão.')
      }
    },
    [apiKey, model, active, recordHistory, updateActive, tourAction],
  )

  // ---------- ideias ----------
  const openIdeas = useCallback(() => {
    // sem isso o debounce dispara com o modal aberto e um ghost aparece atrás dele
    window.clearTimeout(debounceRef.current)
    const sel = editorRef.current?.getSelection()
    // havendo seleção, aplicamos DEPOIS dela: nunca destruímos texto selecionado
    setIdeasAnchor(sel ? sel.end : cursorRef.current)
    setIdeas(null)
    setIdeasNeed('')
    setSuggestion(null)
    setIdeasOpen(true)
  }, [])

  const handleIdeasOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        ideasAbortRef.current?.abort()
        ideasAbortRef.current = null
        setIdeasLoading(false)
        if (recState === 'recording') stopRecording()
      }
      setIdeasOpen(open)
    },
    [recState, stopRecording],
  )

  const toggleIdeasRecording = useCallback(() => {
    const ideasSink = (transcript: string) =>
      setIdeasNeed((prev) => (prev.trim() ? prev.trim() + ' ' : '') + transcript)
    if (recState === 'recording') {
      // adota a gravação em curso: ao parar aqui, o texto vai para o campo de
      // Ideias mesmo que a gravação tenha começado pelo microfone do editor.
      transcriptSinkRef.current = ideasSink
      stopRecording()
      return
    }
    void startRecording(ideasSink)
  }, [recState, stopRecording, startRecording])

  const handleIdeasGenerate = useCallback(
    async (need: string) => {
      if (!apiKey || !unlocked) return
      const trimmed = need.trim()
      if (!trimmed) return

      ideasAbortRef.current?.abort()
      const ctrl = new AbortController()
      ideasAbortRef.current = ctrl
      setIdeasLoading(true)
      setIdeas(null)
      try {
        const full = textRef.current
        const pos = Math.min(ideasAnchor, full.length)
        const out = await fetchIdeas({
          apiKey,
          model,
          need: trimmed,
          beforeCursor: full.slice(0, pos),
          afterCursor: full.slice(pos),
          attachments: (active?.attachments ?? []).map((a) => ({
            name: a.name,
            content: a.content,
          })),
          signal: ctrl.signal,
        })
        if (ctrl.signal.aborted) return
        if (out.length === 0) {
          toast('A IA não gerou ideias. Tente detalhar mais o pedido.')
          return
        }
        setIdeas(out)
      } catch (e) {
        if (!ctrl.signal.aborted) {
          toast.error(e instanceof Error ? e.message : 'Falha ao gerar ideias.')
        }
      } finally {
        if (ideasAbortRef.current === ctrl) {
          ideasAbortRef.current = null
          setIdeasLoading(false)
        }
      }
    },
    [apiKey, unlocked, model, active, ideasAnchor],
  )

  const handleApplyIdea = useCallback(
    (idea: Idea) => {
      const text = idea.content.trim()
      if (!text || !active) return

      recordHistory()
      const { text: next, caret } = insertTextAtAnchor(textRef.current, ideasAnchor, text)
      textRef.current = next
      cursorRef.current = caret
      updateActive({ content: next })
      setCursor(caret)

      // fecha pelo mesmo caminho de limpeza: aborta geração em voo e para uma
      // gravação em curso (libera o microfone) em vez de deixá-la órfã.
      handleIdeasOpenChange(false)

      // o caret só pode ser reposicionado depois do commit do React e do Radix fechar
      window.setTimeout(() => {
        editorRef.current?.focus()
        editorRef.current?.setCursor(caret)
      }, 60)

      toast.success('Ideia aplicada.')
    },
    [active, ideasAnchor, recordHistory, updateActive, handleIdeasOpenChange],
  )

  // ---------- anexos (por página) ----------
  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || !active) return
      const added: Attachment[] = []
      for (const f of Array.from(files)) {
        if (f.size > 400_000) {
          toast.error(`${f.name}: grande demais (máx. 400 KB).`)
          continue
        }
        try {
          const content = (await f.text()).slice(0, 50_000)
          added.push({ id: crypto.randomUUID(), name: f.name, content })
        } catch {
          toast.error(`${f.name}: não foi possível ler como texto.`)
        }
      }
      if (added.length > 0) {
        updateActive({ attachments: [...active.attachments, ...added] })
        toast.success(
          added.length === 1
            ? `${added[0].name} anexado ao contexto.`
            : `${added.length} arquivos anexados ao contexto.`,
        )
      }
    },
    [active, updateActive],
  )

  const removeAttachment = useCallback(
    (id: string) => {
      if (!active) return
      updateActive({ attachments: active.attachments.filter((a) => a.id !== id) })
    },
    [active, updateActive],
  )

  const importGitHubAttachments = useCallback(
    (attachments: Attachment[]) => {
      if (!active || attachments.length === 0) return
      updateActive({ attachments: [...active.attachments, ...attachments] })
      setGithubDialogOpen(false)
      toast.success(
        attachments.length === 1
          ? `${attachments[0].name} importado do GitHub.`
          : `${attachments.length} arquivos importados do GitHub.`,
      )
    },
    [active, updateActive],
  )

  // ---------- fullscreen (elemento raiz + fallback) ----------
  const toggleFullscreen = useCallback(async () => {
    if (pseudoFs) {
      setPseudoFs(false)
      return
    }
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen()
      } else {
        await document.exitFullscreen()
      }
    } catch {
      // fallback para contextos que bloqueiam a Fullscreen API (ex.: iframes)
      setPseudoFs((v) => !v)
    }
  }, [pseudoFs])

  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const fullscreenActive = isFullscreen || pseudoFs

  // ---------- derivados ----------
  const content = active?.content ?? ''
  const words = useMemo(
    () => (content.trim() ? content.trim().split(/\s+/).length : 0),
    [content],
  )
  const { line, col } = useMemo(() => {
    const before = content.slice(0, cursor)
    const lines = before.split('\n')
    return { line: lines.length, col: lines[lines.length - 1].length + 1 }
  }, [content, cursor])

  const keyDot =
    keyStatus === 'valid'
      ? 'bg-[#50fa7b]'
      : keyStatus === 'invalid'
        ? 'bg-[#ff5555]'
        : keyStatus === 'checking'
          ? 'bg-[#8be9fd] animate-pulse'
          : 'bg-[#6272a4]'

  const attachCount = active?.attachments.length ?? 0

  /**
   * Registro único de comandos. Alimenta a paleta e os atalhos globais; a
   * barra de ferramentas desenha os mesmos comandos com layout próprio.
   * Declarar uma vez é o que impede a ação de ganhar nome diferente em cada
   * superfície, que era metade da confusão.
   */
  const commands = useMemo<AppCommand[]>(
    () => [
      {
        id: 'ia.editar',
        label: 'Editar com IA',
        hint: 'Reescrever, resumir, mudar o tom — com prévia',
        group: 'escrita',
        icon: Wand2,
        shortcut: SC.aiEdit,
        tone: '#bd93f9',
        run: openAiEdit,
      },
      {
        id: 'ia.pedir',
        label: 'Pedir sugestão',
        hint: 'A IA escreve um texto novo a partir do seu pedido',
        group: 'escrita',
        icon: Lightbulb,
        shortcut: SC.askSuggestion,
        tone: '#ff79c6',
        run: openAskSuggestion,
      },
      {
        id: 'ia.ideias',
        label: 'Ideias',
        hint: 'Descreva por voz o que precisa; a IA gera ideias para aplicar',
        group: 'escrita',
        icon: HelpCircle,
        shortcut: SC.ideas,
        tone: '#ffb86c',
        run: openIdeas,
      },
      {
        id: 'ia.ditar',
        label: recState === 'recording' ? 'Parar a gravação' : 'Ditar',
        hint: 'Falar em vez de digitar; também aceita ordens',
        group: 'escrita',
        icon: recState === 'recording' ? MicOff : Mic,
        shortcut: SC.dictate,
        tone: '#50fa7b',
        disabled: recState === 'transcribing',
        run: () => (recState === 'recording' ? stopRecording() : void startRecording()),
      },
      {
        id: 'ia.sugerir',
        label: 'Gerar sugestão de novo',
        hint: 'Pede outra continuação, ignorando a memória',
        group: 'escrita',
        icon: RefreshCw,
        shortcut: SC.retry,
        tone: '#8be9fd',
        disabled: loading,
        run: () => void requestCompletion(true),
      },
      {
        id: 'pagina.nova',
        label: 'Nova folha',
        hint: 'Cada folha tem texto e anexos próprios',
        group: 'pagina',
        icon: Plus,
        shortcut: SC.newPage,
        tone: '#50fa7b',
        disabled: busy,
        run: addPage,
      },
      {
        id: 'pagina.anterior',
        label: 'Folha anterior',
        group: 'pagina',
        icon: ChevronLeft,
        shortcut: SC.prevPage,
        tone: '#8be9fd',
        disabled: busy || activeIndex <= 0,
        run: () => goTo(-1),
      },
      {
        id: 'pagina.proxima',
        label: 'Próxima folha',
        group: 'pagina',
        icon: ChevronRight,
        shortcut: SC.nextPage,
        tone: '#8be9fd',
        disabled: busy || activeIndex < 0 || activeIndex >= projects.length - 1,
        run: () => goTo(1),
      },
      {
        id: 'pagina.baixar-md',
        label: 'Baixar como Markdown',
        group: 'pagina',
        icon: FileText,
        tone: '#bd93f9',
        run: () => active && downloadNote(active, 'md'),
      },
      {
        id: 'pagina.baixar-txt',
        label: 'Baixar como texto',
        group: 'pagina',
        icon: FileType2,
        tone: '#8be9fd',
        run: () => active && downloadNote(active, 'txt'),
      },
      {
        id: 'pagina.baixar-png',
        label: 'Baixar como imagem',
        hint: 'A folha inteira em .png, do jeito que está na tela',
        group: 'pagina',
        icon: Image,
        tone: '#ff79c6',
        run: () => void handleDownloadImage(),
      },
      {
        id: 'pagina.baixar-pdf',
        label: 'Baixar como PDF',
        group: 'pagina',
        icon: FileDown,
        tone: '#ff5555',
        run: () => void handleDownloadPdf(),
      },
      {
        id: 'pagina.arrancar',
        label: 'Arrancar esta folha',
        hint: 'Apaga a folha atual',
        group: 'pagina',
        icon: Trash2,
        danger: true,
        disabled: busy,
        run: deletePage,
      },
      {
        id: 'ctx.anexos',
        label: 'Arquivos de contexto',
        hint: 'O que a IA lê junto com a sua folha',
        group: 'contexto',
        icon: Paperclip,
        shortcut: SC.attach,
        tone: '#ffb86c',
        run: () => setAttachOpen(true),
      },
      {
        id: 'ctx.github',
        label: 'Contexto do GitHub',
        hint: 'Importar arquivos de um repositório',
        group: 'contexto',
        icon: Github,
        run: () => setGithubDialogOpen(true),
      },
      ...MODES.map<AppCommand>((m) => ({
        id: `ver.${m.id}`,
        label: `Modo ${m.label}`,
        hint: m.hint,
        group: 'exibicao',
        icon: m.icon,
        shortcut: m.shortcut,
        active: mode === m.id,
        run: () => setMode(m.id),
      })),
      {
        id: 'ver.telacheia',
        label: fullscreenActive ? 'Sair da tela cheia' : 'Tela cheia',
        group: 'exibicao',
        icon: fullscreenActive ? Minimize2 : Maximize2,
        shortcut: SC.fullscreen,
        tone: '#f1fa8c',
        run: () => void toggleFullscreen(),
      },
      {
        id: 'app.chave',
        label: 'Chave da OpenAI',
        hint: 'Guardada só neste navegador',
        group: 'app',
        icon: KeyRound,
        tone: '#bd93f9',
        run: () => setKeyDialogOpen(true),
      },
      {
        id: 'app.tutorial',
        label: 'Refazer o tutorial',
        hint: 'Mostra de novo os passos guiados',
        group: 'app',
        icon: HelpCircle,
        tone: '#8be9fd',
        run: () => tour.restart(),
      },
      {
        id: 'app.paleta',
        label: 'Todos os comandos',
        group: 'app',
        icon: Command,
        shortcut: SC.palette,
        hiddenInPalette: true,
        run: () => setPaletteOpen((o) => !o),
      },
    ],
    [
      openAiEdit,
      openAskSuggestion,
      openIdeas,
      handleDownloadImage,
      handleDownloadPdf,
      recState,
      stopRecording,
      startRecording,
      loading,
      requestCompletion,
      busy,
      addPage,
      activeIndex,
      projects.length,
      goTo,
      active,
      deletePage,
      mode,
      fullscreenActive,
      toggleFullscreen,
      tour,
    ],
  )

  useGlobalShortcuts(commands, unlocked)

  return (
    <div
      className={`app-root ${fullscreenActive ? 'is-fullscreen' : ''} ${
        pseudoFs ? 'pseudo-fs' : ''
      }`}
    >
      {/* ================= Barra de ferramentas ================= */}
      <header className="toolbar">
        {/* hambúrguer (mobile) */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Abrir menu"
          onClick={() => setDrawerOpen(true)}
          className="h-9 w-9 flex-none text-[#f8f8f2] hover:bg-[#44475a] md:hidden"
        >
          <Menu className="h-5 w-5" />
        </Button>

        <div className="flex flex-none items-center gap-2 pr-1">
          <img src={LOGO_URL} alt="" className="h-5 w-5" />
          <span className="inline text-sm font-bold">
            Ghost<span className="text-[#bd93f9]">Writer</span>
          </span>
        </div>

        {/* ações desktop */}
        <div className="hidden flex-1 items-center gap-1.5 md:flex">
          {/*
            GRUPO 1 — Folha. Navegação e criação, que a HIG manda agrupar em
            seção própria: "Group navigation controls and critical actions […]
            in dedicated, familiar, and visually distinct sections."
            Arrancar e Baixar saíram daqui para o menu Mais: são as ações menos
            frequentes deste grupo, e Arrancar é destrutiva ao lado de Nova.
          */}
          <div className="toolbar-group" role="group" aria-label="Folha">
            <ToolbarButton
              label="Folha anterior"
              icon={<ChevronLeft className="h-[18px] w-[18px]" />}
              onClick={() => goTo(-1)}
              disabled={busy || activeIndex <= 0}
              shortcut={SC.prevPage}
              tone="#8be9fd"
            />
            <span className="px-1 text-xs tabular-nums text-[#6272a4]">
              {activeIndex + 1}/{projects.length}
            </span>
            <ToolbarButton
              label="Próxima folha"
              icon={<ChevronRight className="h-[18px] w-[18px]" />}
              onClick={() => goTo(1)}
              disabled={busy || activeIndex < 0 || activeIndex >= projects.length - 1}
              shortcut={SC.nextPage}
              tone="#8be9fd"
            />
            <ToolbarButton
              label="Nova folha"
              icon={<Plus className="h-[18px] w-[18px]" />}
              onClick={addPage}
              disabled={busy}
              shortcut={SC.newPage}
              tone="#50fa7b"
              data-tour="new-page"
            />
          </div>

          {/*
            GRUPO 2 — Escrita com IA. As duas únicas ações com rótulo visível.
            A HIG prefere símbolo a texto, MAS abre exceção justamente para
            "actions like edit that aren't well-represented by symbols" — e
            uma varinha não diz "reescreva este texto com uma ordem em
            português" para ninguém. O teste que manda é o outro: "Don't make
            people guess or experiment to figure out what a toolbar item does."
          */}
          <div className="toolbar-group" role="group" aria-label="Escrita com IA">
            <ToolbarButton
              label={recState === 'recording' ? 'Parar gravação' : 'Ditar'}
              hint={
                recState === 'recording'
                  ? 'Encerra e transcreve'
                  : 'Fala vira texto no cursor'
              }
              icon={
                recState === 'transcribing' ? (
                  <Loader2 className="h-[18px] w-[18px] animate-spin" />
                ) : recState === 'recording' ? (
                  <MicOff className="h-[18px] w-[18px]" />
                ) : (
                  <Mic className="h-[18px] w-[18px]" />
                )
              }
              onClick={() =>
                recState === 'recording' ? stopRecording() : void startRecording()
              }
              disabled={recState === 'transcribing'}
              // Sem rótulo: o microfone é um dos poucos símbolos que a HIG
              // considera reconhecível, e a largura vale mais para as duas
              // ações de IA, que não têm símbolo estabelecido nenhum.
              showLabel={recState === 'recording'}
              shortcut={SC.dictate}
              tone={recState === 'recording' ? '#ff5555' : '#50fa7b'}
              className={
                recState === 'recording'
                  ? 'rec-pulse recording-ring'
                  : recState === 'transcribing'
                    ? 'transcribing-pulse'
                    : undefined
              }
              data-tour="mic"
            />
            {/*
              As duas ações de IA são simétricas e fáceis de confundir sem
              rótulo: uma escreve do zero, a outra reescreve o que já existe.
              Lâmpada e varinha não carregam essa diferença.
            */}
            <ToolbarButton
              label="Pedir sugestão"
              hint="A IA escreve um texto novo a partir do seu pedido"
              icon={<Lightbulb className="h-[18px] w-[18px]" />}
              onClick={openAskSuggestion}
              showLabel
              shortcut={SC.askSuggestion}
              tone="#ff79c6"
              data-tour="ask-suggestion"
            />
            <ToolbarButton
              label="Editar com IA"
              hint="Reescreve o que já está na folha; prévia antes de aplicar"
              icon={<Wand2 className="h-[18px] w-[18px]" />}
              onClick={openAiEdit}
              showLabel
              shortcut={SC.aiEdit}
              tone="#bd93f9"
              data-tour="ai-edit"
            />
          </div>

          {/*
            GRUPO 3 — Exibição. Controle segmentado, que é o caso que a HIG
            endossa: "Consider a segmented control when it's important to group
            functions together, or to clearly show their selection state."
            Três segmentos (o teto é "about five to seven"), largura igual, e
            rótulo ao lado do símbolo a partir de lg — a orientação de macOS
            pede rótulo junto do símbolo E tooltip por segmento.
          */}
          <div
            className="toolbar-group ml-auto"
            role="group"
            aria-label="Modo de exibição"
          >
            {MODES.map((m) => (
              <ToolbarButton
                key={m.id}
                label={m.label}
                hint={m.hint}
                icon={<m.icon className="h-[18px] w-[18px]" />}
                onClick={() => setMode(m.id)}
                active={mode === m.id}
                shortcut={m.shortcut}
                showLabel={wideDesktop}
                className="flex-1 justify-center"
              />
            ))}
          </div>

          {/* Zona final: fica visível em qualquer largura. */}
          <div className="flex flex-none items-center gap-1">
            <Popover open={attachOpen} onOpenChange={setAttachOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={
                    attachCount > 0
                      ? `Arquivos de contexto (${attachCount})`
                      : 'Arquivos de contexto'
                  }
                  className="relative flex h-9 w-9 flex-none items-center justify-center rounded-lg text-[#ffb86c] transition-colors hover:bg-[#44475a]"
                >
                  <Paperclip className="h-[18px] w-[18px]" />
                  {attachCount > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#ffb86c] px-1 text-[10px] font-bold text-[#282a36]">
                      {attachCount}
                    </span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-80 max-w-[calc(100vw-2rem)] border-[#44475a] bg-[#282a36] p-3 text-[#f8f8f2]"
              >
                <AttachmentsPanel
                  attachments={active?.attachments ?? []}
                  onRemove={removeAttachment}
                  onAdd={() => fileInputRef.current?.click()}
                />
              </PopoverContent>
            </Popover>

            {/*
              Menu Mais. A HIG: "Add a More menu to contain additional actions.
              Prioritize less important actions for inclusion in the More menu."
              No navegador não existe overflow automático, então o corte é
              declarado aqui.
            */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Mais ações"
                  data-tour="help"
                  className="flex h-9 w-9 flex-none items-center justify-center rounded-lg text-[#f8f8f2] transition-colors hover:bg-[#44475a]"
                >
                  <MoreHorizontal className="h-[18px] w-[18px]" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-64 border-[#44475a] bg-[#282a36] text-[#f8f8f2]"
              >
                <DropdownMenuItem onClick={() => setPaletteOpen(true)} className={MI}>
                  <Command className="mr-2 h-4 w-4 text-[#bd93f9]" />
                  Todos os comandos
                  <MenuHint s={SC.palette} />
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-[#44475a]" />

                <DropdownMenuItem onClick={openIdeas} className={MI}>
                  <HelpCircle className="mr-2 h-4 w-4 text-[#ffb86c]" />
                  Ideias
                  <MenuHint s={SC.ideas} />
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void requestCompletion(true)}
                  disabled={loading}
                  className={MI}
                >
                  <RefreshCw className="mr-2 h-4 w-4 text-[#8be9fd]" />
                  Gerar sugestão de novo
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setGithubDialogOpen(true)}
                  className={MI}
                >
                  <Github className="mr-2 h-4 w-4 text-[#f8f8f2]" />
                  Contexto do GitHub
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-[#44475a]" />

                <DropdownMenuItem
                  onClick={() => active && downloadNote(active, 'md')}
                  className={MI}
                >
                  <FileText className="mr-2 h-4 w-4 text-[#bd93f9]" />
                  Baixar como Markdown
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => active && downloadNote(active, 'txt')}
                  className={MI}
                >
                  <FileType2 className="mr-2 h-4 w-4 text-[#8be9fd]" />
                  Baixar como texto
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void handleDownloadImage()}
                  className={MI}
                >
                  <Image className="mr-2 h-4 w-4 text-[#ff79c6]" />
                  Baixar como imagem
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void handleDownloadPdf()}
                  className={MI}
                >
                  <FileDown className="mr-2 h-4 w-4 text-[#ff5555]" />
                  Baixar como PDF
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-[#44475a]" />

                {/*
                  Fonte. Saiu da dock inferior — lá ela roubava a largura do
                  Aceitar no mobile — e passou a viver no menu, junto do resto
                  das preferências de exibição.
                */}
                <DropdownMenuSub>
                  {/*
                    `data-[state=open]:bg-accent` do primitivo resolve para um
                    hsl() inválido neste projeto (não há tokens shadcn), então o
                    realce de submenu aberto precisa vir em hex literal.
                  */}
                  <DropdownMenuSubTrigger
                    className={`${MI} data-[state=open]:bg-[#44475a] data-[state=open]:text-[#f8f8f2]`}
                  >
                    <Type className="mr-2 h-4 w-4 text-[#f1fa8c]" />
                    Fonte
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56 border-[#44475a] bg-[#282a36] text-[#f8f8f2]">
                    <DropdownMenuRadioGroup
                      value={fontFamily}
                      onValueChange={setFontFamily}
                    >
                      {FONT_OPTIONS.map((f) => (
                        <DropdownMenuRadioItem
                          key={f.id}
                          value={f.id}
                          className={MI}
                          style={{ fontFamily: FONT_FAMILY_CSS[f.id] }}
                        >
                          {f.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator className="bg-[#44475a]" />
                    <div className="flex items-center justify-between px-2 py-1.5 text-xs text-[#6272a4]">
                      <span>Tamanho</span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-label="Diminuir fonte"
                          disabled={fontSize <= FONT_SIZE_MIN}
                          onClick={() =>
                            setFontSize((s) => Math.max(FONT_SIZE_MIN, s - 1))
                          }
                          className="font-step"
                        >
                          A−
                        </button>
                        <span className="w-6 text-center tabular-nums text-[#f8f8f2]">
                          {fontSize}
                        </span>
                        <button
                          type="button"
                          aria-label="Aumentar fonte"
                          disabled={fontSize >= FONT_SIZE_MAX}
                          onClick={() =>
                            setFontSize((s) => Math.min(FONT_SIZE_MAX, s + 1))
                          }
                          className="font-step"
                        >
                          A+
                        </button>
                      </div>
                    </div>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem
                  onClick={() => void toggleFullscreen()}
                  className={MI}
                >
                  {fullscreenActive ? (
                    <Minimize2 className="mr-2 h-4 w-4 text-[#f1fa8c]" />
                  ) : (
                    <Maximize2 className="mr-2 h-4 w-4 text-[#f1fa8c]" />
                  )}
                  {fullscreenActive ? 'Sair da tela cheia' : 'Tela cheia'}
                  <MenuHint s={SC.fullscreen} />
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setKeyDialogOpen(true)} className={MI}>
                  <KeyRound className="mr-2 h-4 w-4 text-[#bd93f9]" />
                  Chave da OpenAI
                  <span
                    className={`ml-auto h-2 w-2 flex-none rounded-full ${keyDot}`}
                  />
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-[#44475a]" />

                <DropdownMenuItem onClick={() => tour.restart()} className={MI}>
                  <HelpCircle className="mr-2 h-4 w-4 text-[#8be9fd]" />
                  Refazer o tutorial
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={deletePage}
                  disabled={busy}
                  className="cursor-pointer text-[#ff5555] focus:bg-[#ff5555]/15 focus:text-[#ff5555]"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Arrancar esta folha
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* seletor de modo no mobile */}
        <div className="flex flex-1 items-center justify-end gap-1 md:hidden">
          <button
            type="button"
            onClick={() => setMode('edit')}
            aria-label="Editor"
            aria-pressed={mode === 'edit'}
            className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
              mode === 'edit'
                ? 'bg-[#bd93f9] text-[#282a36]'
                : 'text-[#6272a4] hover:bg-[#44475a] hover:text-[#f8f8f2]'
            }`}
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setMode('preview')}
            aria-label="Markdown"
            aria-pressed={mode === 'preview'}
            className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
              mode === 'preview'
                ? 'bg-[#bd93f9] text-[#282a36]'
                : 'text-[#6272a4] hover:bg-[#44475a] hover:text-[#f8f8f2]'
            }`}
          >
            <Eye className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* ================= Folha full-page com flip CSS ================= */}
      <div className="stage-wrap" data-tour="editor">
        {dbReady && active && (
          <PageSheet
            ref={pageRef}
            header={pageHeader}
            fontSize={fontSize}
            leaving={leaving}
            onLeavingEnd={() => setLeaving(null)}
          >
            {mode === 'edit' && (
              <GhostEditor
                key={active.id}
                ref={editorRef}
                value={content}
                cursor={cursor}
                onChange={handleChange}
                onCursorChange={handleCursorChange}
                suggestion={suggestion?.text ?? null}
                onAcceptSuggestion={acceptSuggestion}
                onDismissSuggestion={() => setSuggestion(null)}
                onManualTrigger={() => void requestCompletion(false)}
                onUndo={undo}
                onRedo={redo}
                canUndo={canUndo}
                canRedo={canRedo}
                fontSize={fontSize}
                fontFamily={FONT_FAMILY_CSS[fontFamily]}
              />
            )}
            {mode === 'preview' && <MarkdownPreview source={content} />}
            {mode === 'split' && (
              <div className="grid flex-1 grid-cols-2">
                <div className="relative min-w-0 border-r border-[#44475a]">
                  <GhostEditor
                    key={active.id}
                    ref={editorRef}
                    value={content}
                    cursor={cursor}
                    onChange={handleChange}
                    onCursorChange={handleCursorChange}
                    suggestion={suggestion?.text ?? null}
                    onAcceptSuggestion={acceptSuggestion}
                    onDismissSuggestion={() => setSuggestion(null)}
                    onManualTrigger={() => void requestCompletion(false)}
                    onUndo={undo}
                    onRedo={redo}
                    canUndo={canUndo}
                    canRedo={canRedo}
                    fontSize={fontSize}
                    fontFamily={FONT_FAMILY_CSS[fontFamily]}
                  />
                </div>
                <div className="relative min-w-0">
                  <MarkdownPreview source={content} />
                </div>
              </div>
            )}
          </PageSheet>
        )}

        {!dbReady && (
          <div className="absolute inset-0 z-20 flex items-center justify-center text-[#6272a4]">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Abrindo o bloco…
          </div>
        )}
      </div>

      {/*
        ================= Dock (ponteiro fino) =================
        No toque quem cumpre este papel é a pílula flutuante logo abaixo, que
        já traz Aceitar/Dispensar. Renderizar as duas empilharia duas barras
        inferiores oferecendo a mesma ação.
      */}
      {!isTouch && (
        <Dock
          hasSuggestion={suggestion !== null}
          onAcceptSuggestion={acceptSuggestion}
          onDismissSuggestion={() => setSuggestion(null)}
        />
      )}

      {/* ================= Barra de status ================= */}
      <footer className="flex flex-none items-center gap-3 border-t border-[#44475a] bg-[#21222c] px-3 py-1.5 text-xs text-[#6272a4] sm:px-4">
        <span className="whitespace-nowrap">
          Ln {line}, Col {col}
        </span>
        <span className="hidden whitespace-nowrap sm:inline">{words} palavras</span>
        <span className="hidden whitespace-nowrap text-[#ffb86c]/70 md:inline">
          salvo no IndexedDB
        </span>

        {loading && (
          <span className="flex items-center gap-1 text-[#8be9fd]">
            <Loader2 className="h-3 w-3 animate-spin" /> gerando…
          </span>
        )}
        {suggestion && (
          <span
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${
              suggestion.source === 'memoria'
                ? 'bg-[#8be9fd]/15 text-[#8be9fd]'
                : 'bg-[#bd93f9]/15 text-[#bd93f9]'
            }`}
          >
            {suggestion.source === 'memoria' ? (
              <>
                <CheckCircle2 className="h-3 w-3" /> da memória
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3" /> via API
              </>
            )}
          </span>
        )}

        <div className="flex-1" />

        {!isTouch && (
          <button
            onClick={() => setPaletteOpen(true)}
            // lg, não md: em md a dica empurrava o seletor de modelo para fora
            // da barra de status.
            className="hidden whitespace-nowrap rounded px-1.5 py-0.5 transition-colors hover:bg-[#44475a] hover:text-[#f8f8f2] lg:inline"
          >
            Tab aceita · Esc dispensa ·{' '}
            <span className="text-[#8be9fd]">{formatShortcut(SC.palette)}</span> abre
            os comandos
          </button>
        )}

        <Select value={model} onValueChange={setModel}>
          <SelectTrigger className="hidden h-7 w-40 border-[#44475a] bg-[#282a36] text-xs text-[#8be9fd] sm:flex">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-[#44475a] bg-[#282a36] text-[#f8f8f2]">
            {MODEL_OPTIONS.map((m) => (
              <SelectItem
                key={m.id}
                value={m.id}
                className="text-xs focus:bg-[#44475a] focus:text-[#f8f8f2]"
              >
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </footer>

      {/* ================= Ações rápidas flutuantes no mobile (touch) ================= */}
      {isTouch && mode !== 'preview' && (
        // 7 botões de 36px (h-9) com gap-1.5: 7×36 + 6×6 + px-3 (24) + borda (2)
        // = 314px, ainda cabe numa viewport de 320px. Foi por isso que os botões
        // encolheram de 40px para 36px ao entrar o botão de Ideias (?).
        <div className="fade-in-up fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[#44475a] bg-[#21222c]/95 px-3 py-2 shadow-xl shadow-black/40 backdrop-blur-sm">
          <button
            onClick={() =>
              recState === 'recording' ? stopRecording() : void startRecording()
            }
            aria-label={recState === 'recording' ? 'Parar gravação' : 'Ditar'}
            data-tour="mic"
            disabled={recState === 'transcribing'}
            className={`flex h-9 w-9 items-center justify-center rounded-full transition-transform active:scale-95 disabled:opacity-50 ${
              recState === 'recording'
                ? 'rec-pulse recording-ring bg-[#ff5555]/20 text-[#ff5555]'
                : recState === 'transcribing'
                  ? 'transcribing-pulse bg-[#50fa7b]/15 text-[#50fa7b]'
                  : 'bg-[#50fa7b]/15 text-[#50fa7b]'
            }`}
          >
            {recState === 'transcribing' ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : recState === 'recording' ? (
              <MicOff className="h-5 w-5" />
            ) : (
              <Mic className="h-5 w-5" />
            )}
          </button>
          <button
            onClick={() => void undo()}
            aria-label="Desfazer"
            disabled={!canUndo}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#8be9fd]/15 text-[#8be9fd] transition-transform active:scale-95 disabled:opacity-30"
          >
            <Undo2 className="h-5 w-5" />
          </button>
          <button
            onClick={() => void redo()}
            aria-label="Refazer"
            disabled={!canRedo}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#8be9fd]/15 text-[#8be9fd] transition-transform active:scale-95 disabled:opacity-30"
          >
            <Redo2 className="h-5 w-5" />
          </button>
          <button
            onClick={() => {
              openAiEdit()
            }}
            aria-label="Editar com IA"
            data-tour="ai-edit"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#bd93f9]/15 text-[#bd93f9] transition-transform active:scale-95"
          >
            <Wand2 className="h-5 w-5" />
          </button>
          {/*
            Botão de Ideias (interrogação): descrevo por voz o que preciso e a IA
            gera ideias para aplicar. Fica junto das ações de escrita com IA.
          */}
          <button
            onClick={openIdeas}
            aria-label="Ideias"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#ffb86c]/15 text-[#ffb86c] transition-transform active:scale-95"
          >
            <HelpCircle className="h-5 w-5" />
          </button>
          {/*
            Aceitar/dispensar ficam sempre montados e apenas desabilitam sem
            sugestão: no toque não existe Tab nem Esc, então esta é a única
            forma de resolver o ghost — e um botão que aparece e some faria a
            pílula pular de largura a cada sugestão.
          */}
          <button
            onClick={acceptSuggestion}
            aria-label="Aceitar sugestão"
            disabled={suggestion === null}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#50fa7b]/15 text-[#50fa7b] transition-transform active:scale-95 disabled:opacity-30"
          >
            <CheckCircle2 className="h-5 w-5" />
          </button>
          <button
            onClick={() => setSuggestion(null)}
            aria-label="Dispensar sugestão"
            disabled={suggestion === null}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#ff5555]/15 text-[#ff5555] transition-transform active:scale-95 disabled:opacity-30"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* ================= Menu lateral (mobile) ================= */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="left"
          className="w-80 max-w-[calc(100vw-2rem)] overflow-y-auto border-r border-[#44475a] bg-[#21222c] p-0 text-[#f8f8f2]"
        >
          <SheetHeader className="border-b border-[#44475a] px-4 py-4">
            <SheetTitle className="flex items-center gap-2 text-[#f8f8f2]">
              <img src={LOGO_URL} alt="" className="h-5 w-5" />
              Ghost<span className="text-[#bd93f9]">Writer</span>
            </SheetTitle>
          </SheetHeader>

          {/* páginas */}
          <div className="drawer-section">
            <div className="drawer-section-title">
              Páginas · {activeIndex + 1}/{projects.length}
            </div>
            <div className="drawer-grid">
              <button
                className="drawer-btn"
                disabled={busy || activeIndex <= 0}
                onClick={() => {
                  goTo(-1)
                  setDrawerOpen(false)
                }}
              >
                <ChevronLeft className="h-5 w-5 text-[#8be9fd]" />
                Anterior
              </button>
              <button
                className="drawer-btn"
                disabled={busy || activeIndex < 0 || activeIndex >= projects.length - 1}
                onClick={() => {
                  goTo(1)
                  setDrawerOpen(false)
                }}
              >
                <ChevronRight className="h-5 w-5 text-[#8be9fd]" />
                Próxima
              </button>
              <button
                className="drawer-btn"
                disabled={busy}
                onClick={() => {
                  addPage()
                  setDrawerOpen(false)
                }}
              >
                <Plus className="h-5 w-5 text-[#50fa7b]" />
                Nova
              </button>
              <button
                className="drawer-btn"
                disabled={busy}
                onClick={() => {
                  deletePage()
                  setDrawerOpen(false)
                }}
              >
                <Trash2 className="h-5 w-5 text-[#ff5555]" />
                Arrancar
              </button>
            </div>
          </div>

          {/* contexto */}
          <div className="drawer-section">
            <AttachmentsPanel
              attachments={active?.attachments ?? []}
              onRemove={removeAttachment}
              onAdd={() => fileInputRef.current?.click()}
            />
            <button
              className="drawer-btn mt-3 w-full"
              onClick={() => {
                setGithubDialogOpen(true)
                setDrawerOpen(false)
              }}
            >
              <Github className="h-5 w-5 text-[#f8f8f2]" />
              Contexto do GitHub
            </button>
          </div>

          {/* IA */}
          <div className="drawer-section">
            <div className="drawer-section-title">Inteligência artificial</div>
            <div className="drawer-grid">
              <button
                className="drawer-btn"
                disabled={loading}
                onClick={() => {
                  void requestCompletion(true)
                  setDrawerOpen(false)
                }}
              >
                {loading ? (
                  <Loader2 className="h-5 w-5 animate-spin text-[#8be9fd]" />
                ) : (
                  <RefreshCw className="h-5 w-5 text-[#8be9fd]" />
                )}
                Retry
              </button>
              <button
                className="drawer-btn"
                disabled={recState === 'transcribing'}
                onClick={() => {
                  if (recState === 'recording') stopRecording()
                  else void startRecording()
                  setDrawerOpen(false)
                }}
              >
                {recState === 'transcribing' ? (
                  <Loader2 className="h-5 w-5 animate-spin text-[#50fa7b]" />
                ) : recState === 'recording' ? (
                  <MicOff className="h-5 w-5 text-[#ff5555]" />
                ) : (
                  <Mic className="h-5 w-5 text-[#50fa7b]" />
                )}
                Ditar
              </button>
              <button
                className="drawer-btn"
                onClick={() => {
                  openAiEdit()
                  setDrawerOpen(false)
                }}
              >
                <Wand2 className="h-5 w-5 text-[#bd93f9]" />
                IA edit
              </button>
              <button
                className="drawer-btn"
                onClick={() => {
                  openAskSuggestion()
                  setDrawerOpen(false)
                }}
              >
                <Lightbulb className="h-5 w-5 text-[#ff79c6]" />
                Sugestão
              </button>
              <button
                className="drawer-btn"
                onClick={() => {
                  openIdeas()
                  setDrawerOpen(false)
                }}
              >
                <HelpCircle className="h-5 w-5 text-[#ffb86c]" />
                Ideias
              </button>
            </div>
            <div className="mt-3">
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="h-9 w-full border-[#44475a] bg-[#282a36] text-xs text-[#8be9fd]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-[#44475a] bg-[#282a36] text-[#f8f8f2]">
                  {MODEL_OPTIONS.map((m) => (
                    <SelectItem
                      key={m.id}
                      value={m.id}
                      className="text-xs focus:bg-[#44475a] focus:text-[#f8f8f2]"
                    >
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* nota */}
          <div className="drawer-section">
            <div className="drawer-section-title">Esta nota</div>
            <div className="drawer-grid">
              <button
                className="drawer-btn"
                onClick={() => {
                  setMode('edit')
                  setDrawerOpen(false)
                }}
              >
                <Pencil className="h-5 w-5 text-[#bd93f9]" />
                Editar
              </button>
              <button
                className="drawer-btn"
                onClick={() => {
                  setMode('preview')
                  setDrawerOpen(false)
                }}
              >
                <Eye className="h-5 w-5 text-[#bd93f9]" />
                Markdown
              </button>
              <button
                className="drawer-btn"
                onClick={() => {
                  if (active) downloadNote(active, 'md')
                  setDrawerOpen(false)
                }}
              >
                <FileText className="h-5 w-5 text-[#f1fa8c]" />
                .md
              </button>
              <button
                className="drawer-btn"
                onClick={() => {
                  void handleDownloadImage()
                  setDrawerOpen(false)
                }}
              >
                <Image className="h-5 w-5 text-[#ff79c6]" />
                .png
              </button>
              <button
                className="drawer-btn"
                onClick={() => {
                  void handleDownloadPdf()
                  setDrawerOpen(false)
                }}
              >
                <FileDown className="h-5 w-5 text-[#ff5555]" />
                .pdf
              </button>
              <button
                className="drawer-btn"
                onClick={() => {
                  if (active) downloadNote(active, 'txt')
                  setDrawerOpen(false)
                }}
              >
                <FileType2 className="h-5 w-5 text-[#8be9fd]" />
                .txt
              </button>
            </div>
          </div>

          {/* fonte */}
          <div className="drawer-section">
            <div className="drawer-section-title">Fonte</div>
            <Select value={fontFamily} onValueChange={setFontFamily}>
              <SelectTrigger className="h-9 w-full border-[#44475a] bg-[#282a36] text-xs text-[#f1fa8c]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-[#44475a] bg-[#282a36] text-[#f8f8f2]">
                {FONT_OPTIONS.map((f) => (
                  <SelectItem
                    key={f.id}
                    value={f.id}
                    className="text-xs focus:bg-[#44475a] focus:text-[#f8f8f2]"
                    style={{ fontFamily: FONT_FAMILY_CSS[f.id] }}
                  >
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs text-[#6272a4]">Tamanho</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Diminuir fonte"
                  disabled={fontSize <= FONT_SIZE_MIN}
                  onClick={() => setFontSize((s) => Math.max(FONT_SIZE_MIN, s - 1))}
                  className="font-step font-step-lg"
                >
                  A−
                </button>
                <span className="w-7 text-center text-sm tabular-nums text-[#f8f8f2]">
                  {fontSize}
                </span>
                <button
                  type="button"
                  aria-label="Aumentar fonte"
                  disabled={fontSize >= FONT_SIZE_MAX}
                  onClick={() => setFontSize((s) => Math.min(FONT_SIZE_MAX, s + 1))}
                  className="font-step font-step-lg"
                >
                  A+
                </button>
              </div>
            </div>
          </div>

          {/* exibição e conta */}
          <div className="drawer-section">
            <div className="drawer-section-title">Exibição e conta</div>
            <div className="drawer-grid">
              <button
                className="drawer-btn"
                onClick={() => {
                  void toggleFullscreen()
                  setDrawerOpen(false)
                }}
              >
                {fullscreenActive ? (
                  <Minimize2 className="h-5 w-5 text-[#f1fa8c]" />
                ) : (
                  <Maximize2 className="h-5 w-5 text-[#f1fa8c]" />
                )}
                Tela
              </button>
              <button
                className="drawer-btn"
                onClick={() => {
                  setKeyDialogOpen(true)
                  setDrawerOpen(false)
                }}
              >
                <KeyRound className="h-5 w-5 text-[#bd93f9]" />
                Chave
              </button>
            </div>
          </div>

          {/* ajuda */}
          <div className="drawer-section">
            <div className="drawer-section-title">Ajuda</div>
            <div className="drawer-grid">
              <button
                className="drawer-btn"
                onClick={() => {
                  setDrawerOpen(false)
                  tour.restart()
                }}
              >
                <HelpCircle className="h-5 w-5 text-[#8be9fd]" />
                Tutorial
              </button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <ApiKeyDialog
        open={keyDialogOpen}
        onOpenChange={setKeyDialogOpen}
        apiKey={apiKey}
        status={keyStatus}
        statusMessage={keyError}
        onSave={saveKey}
        onValidate={runValidation}
      />

      <GitHubContextDialog
        open={githubDialogOpen}
        onOpenChange={setGithubDialogOpen}
        storedPat={githubPat}
        onPatChange={setGithubPat}
        onImport={importGitHubAttachments}
      />

      {/* confirmação de arrancar página */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent className="border-[#44475a] bg-[#282a36] text-[#f8f8f2]">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-[#ff5555]">
              <Trash2 className="h-5 w-5" />
              Arrancar página
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[#6272a4]">
              A página "{active?.name}" será arrancada do bloco e apagada para
              sempre, junto com seus {active?.attachments.length ?? 0} anexo(s).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-[#44475a] bg-transparent text-[#f8f8f2] hover:bg-[#44475a] hover:text-[#f8f8f2]">
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-[#ff5555] font-semibold text-[#282a36] hover:bg-[#ff5555]/85"
            >
              Arrancar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* input de arquivos (compartilhado) */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        accept=".txt,.md,.markdown,.js,.jsx,.ts,.tsx,.py,.json,.html,.css,.csv,.xml,.yml,.yaml,.java,.c,.cpp,.go,.rs,.sql,.sh,.log,text/*"
        onChange={(e) => {
          void handleFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {/* ================= Bloqueio até ter chave válida ================= */}
      {!unlocked && (
        <LockScreen
          initialKey={apiKey}
          status={keyStatus}
          error={keyError}
          checkingStored={!storedChecked}
          onSubmit={handleLockSubmit}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={commands}
      />

      {tour.active && tour.step && (
        <TourOverlay
          step={tour.step}
          index={tour.index}
          total={tour.total}
          isTouch={isTouch}
          justDone={tour.justDone}
          onNext={tour.next}
          onBack={tour.back}
          onSkip={tour.skipAll}
        />
      )}

      <AiEditDialog
        open={aiEditOpen}
        onOpenChange={setAiEditOpen}
        hasSelection={Boolean(aiEditSelection)}
        preview={aiEditPreview}
        loading={aiEditLoading}
        onGenerate={handleAiEditGenerate}
        onApply={handleAiEditApply}
      />

      <AskSuggestionDialog
        open={askOpen}
        onOpenChange={handleAskOpenChange}
        preview={askPreview}
        loading={askLoading}
        onGenerate={(b) => void handleAskGenerate(b)}
        onInsert={handleAskInsert}
      />

      <IdeasDialog
        open={ideasOpen}
        onOpenChange={handleIdeasOpenChange}
        need={ideasNeed}
        onNeedChange={setIdeasNeed}
        ideas={ideas}
        loading={ideasLoading}
        recState={recState}
        onToggleRecord={toggleIdeasRecording}
        onGenerate={(n) => void handleIdeasGenerate(n)}
        onApply={handleApplyIdea}
      />

      <Toaster
        theme="dark"
        position="bottom-left"
        toastOptions={{
          style: {
            background: '#21222c',
            border: '1px solid #44475a',
            color: '#f8f8f2',
            fontFamily: "'Fira Code', monospace",
          },
        }}
      />
    </div>
  )
}
