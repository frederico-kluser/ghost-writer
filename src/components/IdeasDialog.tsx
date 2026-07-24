import { useEffect, useRef } from 'react'
import { Check, Loader2, Mic, MicOff, Sparkles } from 'lucide-react'
import type { Idea } from '@/lib/openai'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

type RecState = 'idle' | 'recording' | 'transcribing'

interface IdeasDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  need: string
  onNeedChange: (value: string) => void
  ideas: Idea[] | null
  loading: boolean
  recState: RecState
  onToggleRecord: () => void
  onGenerate: (need: string) => void
  onApply: (idea: Idea) => void
}

export default function IdeasDialog({
  open,
  onOpenChange,
  need,
  onNeedChange,
  ideas,
  loading,
  recState,
  onToggleRecord,
  onGenerate,
  onApply,
}: IdeasDialogProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) setTimeout(() => textareaRef.current?.focus(), 50)
  }, [open])

  const canGenerate = Boolean(need.trim()) && !loading && recState !== 'transcribing'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="border-[#44475a] bg-[#282a36] text-[#f8f8f2] sm:max-w-lg"
        // sem isso o Radix devolve o foco ao botão que abriu e rouba o foco do editor
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#ffb86c]">
            <Sparkles className="h-5 w-5" />
            Ideias
          </DialogTitle>
          <DialogDescription className="text-[#6272a4]">
            Descreva por voz ou por escrito a ajuda que você precisa. A IA gera ideias e
            você aplica a que quiser no cursor.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-2">
            <Textarea
              ref={textareaRef}
              maxLength={2000}
              placeholder="Ex.: preciso de argumentos para um texto sobre trabalho remoto; me dê ganchos de introdução; ideias de título..."
              value={need}
              onChange={(e) => onNeedChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canGenerate) {
                  e.preventDefault()
                  onGenerate(need)
                }
              }}
              className="min-h-[80px] resize-none border-[#44475a] bg-[#21222c] text-[#f8f8f2] placeholder:text-[#6272a4] focus-visible:ring-[#ffb86c]"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onToggleRecord}
                disabled={recState === 'transcribing'}
                aria-label={recState === 'recording' ? 'Parar gravação' : 'Descrever por voz'}
                className={`flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors disabled:opacity-50 ${
                  recState === 'recording'
                    ? 'rec-pulse bg-[#ff5555]/15 text-[#ff5555]'
                    : 'bg-[#50fa7b]/15 text-[#50fa7b] hover:bg-[#50fa7b]/25'
                }`}
              >
                {recState === 'transcribing' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : recState === 'recording' ? (
                  <MicOff className="h-4 w-4" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
                {recState === 'transcribing'
                  ? 'Transcrevendo…'
                  : recState === 'recording'
                    ? 'Parar'
                    : 'Falar'}
              </button>
              <Button
                onClick={() => onGenerate(need)}
                disabled={!canGenerate}
                className="flex-1 bg-[#8be9fd] font-semibold text-[#282a36] hover:bg-[#8be9fd]/85 disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Gerando ideias…
                  </>
                ) : (
                  'Gerar ideias'
                )}
              </Button>
            </div>
          </div>

          {ideas && ideas.length > 0 && (
            <div className="grid max-h-[320px] gap-2 overflow-auto pr-1">
              {ideas.map((idea, i) => (
                <div
                  key={`idea-${i}`}
                  className="grid gap-2 rounded-md border border-[#44475a] bg-[#21222c] p-3"
                >
                  <span className="text-sm font-semibold text-[#ffb86c]">{idea.title}</span>
                  <p className="whitespace-pre-wrap text-sm text-[#f8f8f2]">{idea.content}</p>
                  <Button
                    onClick={() => onApply(idea)}
                    className="h-8 justify-center self-end bg-[#50fa7b] px-3 text-xs font-semibold text-[#282a36] hover:bg-[#50fa7b]/85"
                  >
                    <Check className="mr-1 h-4 w-4" />
                    Aplicar
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="text-[#6272a4] hover:bg-[#44475a] hover:text-[#f8f8f2]"
          >
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
