// Posicionamento das sugestões ghost.
//
// O autocomplete devolve só a CONTINUAÇÃO; onde ela entra é decisão nossa.
// Emendar cru no cursor cola a sugestão na linha do título ("## 2. MetodologiaA
// metodologia adotada…") e parte linhas ao meio. Aqui a sugestão vira uma edição
// POSICIONAL — âncora + separadores — no mesmo padrão do kit de edições
// (`editKit.ts`): `planGhost` decide o ponto e as quebras, `applyGhostPlan`
// aplica por `applyEditKit` com âncora literal (offset exato como reserva).
//
// A decisão é local e determinística de propósito: pedir a âncora ao modelo a
// cada tecla dobraria a latência do ghost. Na dúvida, o plano mantém o
// comportamento antigo (emendar no cursor) — um falso positivo aqui escreveria
// no lugar errado do texto do usuário.

import { applyEditKit, padForInsert, type EditOp } from './editKit'

export interface GhostPlan {
  /** Offset no texto ATUAL onde a sugestão entra (pode diferir do cursor). */
  at: number
  /** Quebras de linha que faltam antes do texto (o parágrafo que não vinha). */
  lead: string
  /** Quebras de linha que faltam depois do texto. */
  tail: string
  /** Texto da sugestão já normalizado (numeração corrigida, sem quebras soltas). */
  text: string
  /** `inline` emenda na linha; `bloco` abre um bloco novo. */
  kind: 'inline' | 'bloco'
}

/** Título markdown: recuo + 1-6 `#` + espaço. */
const HEADING = /^(\s*)(#{1,6})[ \t]+/
/**
 * Marcador numerado: `1.` ou `1)`. Até 3 dígitos — listas maiores que isso não
 * existem na prática, e `2010. ` no começo de uma frase é um ano, não um item.
 */
const NUMBERED = /^(\d{1,3})([.)])[ \t]+/
/** Marcador de lista simples. */
const BULLET = /^([-*+])[ \t]+/
/** Início de linha que já abre um bloco por conta própria. */
const BLOCK_START = /^[ \t]*(#{1,6}[ \t]|[-*+][ \t]|\d{1,3}[.)][ \t]|>[ \t]?)/
/** Primeiro caractere típico de frase nova (maiúscula ou abre-aspas/parêntese). */
const NEW_SENTENCE = /^["'“«([A-ZÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ]/
/**
 * Fim de linha que denuncia frase EM ABERTO logo antes do cursor. Sem isto,
 * "## Relatório de " + "Vendas" seria empurrado para um parágrafo novo em vez
 * de completar o título.
 */
const OPEN_END = /[ \t\-–—,;(“«"'/]$/

interface BlockInfo {
  lineStart: number
  lineEnd: number
  /** Recuo da linha. */
  indent: string
  /** Prefixo de título (`##`), vazio se a linha não for título. */
  heading: string
  /** Marcador de lista simples (`-`), vazio se não houver. */
  bullet: string
  /** Número do item/seção, 0 se a linha não for numerada. */
  num: number
  /** Separador do número (`.` ou `)`). */
  numSep: string
  /** Conteúdo da linha depois do marcador. */
  body: string
  /** O cursor está no fim do conteúdo da linha (só espaços à frente). */
  atLineEnd: boolean
  /** O cursor está dentro de uma cerca de código. */
  inFence: boolean
}

function lineStartOf(text: string, pos: number): number {
  const i = text.lastIndexOf('\n', pos - 1)
  return i < 0 ? 0 : i + 1
}

function lineEndOf(text: string, pos: number): number {
  const i = text.indexOf('\n', pos)
  return i < 0 ? text.length : i
}

/** Cerca ``` aberta antes do cursor: número ímpar de cercas. */
function insideFence(text: string, pos: number): boolean {
  const fences = text.slice(0, pos).match(/^[ \t]*```/gm)
  return (fences?.length ?? 0) % 2 === 1
}

function blockAt(text: string, pos: number): BlockInfo {
  const lineStart = lineStartOf(text, pos)
  const lineEnd = lineEndOf(text, pos)
  const line = text.slice(lineStart, lineEnd)

  let rest = line
  const indent = /^[ \t]*/.exec(line)?.[0] ?? ''
  rest = rest.slice(indent.length)

  let heading = ''
  const h = HEADING.exec(line)
  if (h) {
    heading = h[2]
    rest = line.slice(h[0].length)
  }

  let num = 0
  let numSep = '.'
  let bullet = ''
  const n = NUMBERED.exec(rest)
  if (n) {
    num = Number(n[1])
    numSep = n[2]
    rest = rest.slice(n[0].length)
  } else {
    const b = BULLET.exec(rest)
    if (b) {
      bullet = b[1]
      rest = rest.slice(b[0].length)
    }
  }

  return {
    lineStart,
    lineEnd,
    indent,
    heading,
    bullet,
    num,
    numSep,
    body: rest,
    atLineEnd: text.slice(pos, lineEnd).trim() === '',
    inFence: insideFence(text, pos),
  }
}

/** Fim do parágrafo que contém `pos` (até a próxima linha em branco). */
function endOfParagraph(text: string, pos: number): number {
  const rest = text.slice(pos)
  const m = /\n[ \t]*\n/.exec(rest)
  return m ? pos + m.index : text.length
}

/**
 * Lista "solta" tem linha em branco entre os itens; nesse caso o item seguinte
 * também precisa de duas quebras para o Markdown não fundir os parágrafos.
 */
function isLooseList(text: string, lineStart: number): boolean {
  if (lineStart === 0) return false
  const prevEnd = text.slice(0, lineStart).replace(/\n$/, '')
  const prevStart = lineStartOf(prevEnd, prevEnd.length)
  return prevEnd.slice(prevStart).trim() === ''
}

/**
 * Renumera os itens do topo da sugestão a partir de `start`, no estilo do bloco
 * onde ela vai entrar. O modelo costuma repetir o número atual ou recomeçar do
 * 1 — o documento é a fonte da verdade da numeração, não a resposta da IA.
 */
function renumber(text: string, start: number, sep: string, heading: string): string {
  let next = start
  return text
    .split('\n')
    .map((line) => {
      const h = HEADING.exec(line)
      const afterHeading = h ? line.slice(h[0].length) : line
      const n = NUMBERED.exec(afterHeading)
      if (!n) return line
      // só a numeração de topo é reescrita: sub-itens recuados seguem o modelo
      if (!h && /^[ \t]/.test(line)) return line
      const prefix = h ? `${h[2]} ` : heading ? `${heading} ` : ''
      const body = afterHeading.slice(n[0].length)
      const out = `${prefix}${next}${sep} ${body}`
      next++
      return out
    })
    .join('\n')
}

/**
 * Decide onde a sugestão entra e com quais separadores. Devolve `null` quando
 * não há nada a sugerir.
 */
export function planGhost(full: string, cursor: number, raw: string): GhostPlan | null {
  if (!raw) return null
  const at0 = Math.min(Math.max(cursor, 0), full.length)
  const blk = blockAt(full, at0)

  // dentro de cerca de código o texto é literal: nem reposiciona, nem espaça
  if (blk.inFence) {
    return raw.trim() ? { at: at0, lead: '', tail: '', text: raw, kind: 'inline' } : null
  }

  // quebras que o modelo já mandou viram decisão nossa: sem isso, `\n\n` do
  // modelo somaria ao `lead` calculado e abriria um vão duplo
  const trimmed = raw.replace(/^[ \t]*\n[\s\n]*/, '')
  const modelOpenedBlock = trimmed !== raw
  let text = trimmed.replace(/\s+$/, '')
  if (!text.trim()) return null

  // Uma sugestão que já começa com marcador (#, -, 1., >) é outro bloco, não
  // importa onde o cursor esteja: ela nunca emenda no fim da linha atual.
  const opensBlock = BLOCK_START.test(text)
  // Um título ocupa uma linha só: com o cursor no fim de um título já escrito,
  // qualquer frase nova pertence ao corpo, não à mesma linha. Continuação em
  // minúscula, ou cursor depois de espaço/vírgula, segue sendo parte do título
  // (aí o modelo está completando a frase, não abrindo o corpo).
  const afterHeading =
    blk.heading !== '' &&
    blk.body.trim() !== '' &&
    blk.atLineEnd &&
    !OPEN_END.test(full.slice(0, at0)) &&
    NEW_SENTENCE.test(text.trimStart())
  const isListLine = blk.num > 0 || blk.bullet !== ''

  const kind: GhostPlan['kind'] =
    modelOpenedBlock || opensBlock || afterHeading ? 'bloco' : 'inline'

  // Emenda literal: o texto vai como veio (o espaço inicial da continuação faz
  // parte dela, e `sanitizeCompletion` já cuidou do fim).
  if (kind === 'inline') {
    return { at: at0, lead: '', tail: '', text: raw, kind }
  }

  // A sugestão abre bloco: ela não pode partir a linha onde o cursor está.
  // É isto que faz a sugestão entrar "não necessariamente onde estamos".
  const at = blk.atLineEnd
    ? at0
    : blk.heading !== '' || isListLine
      ? blk.lineEnd
      : endOfParagraph(full, at0)

  // Item de lista encosta no anterior (uma quebra); título e parágrafo pedem
  // linha em branco. Listas soltas voltam a pedir duas.
  const want =
    isListLine && opensBlock && blk.heading === '' && !isLooseList(full, blk.lineStart) ? 1 : 2
  const { lead, tail } = padForInsert(full.slice(0, at), full.slice(at), want)

  if (blk.num > 0) {
    text = renumber(text, blk.num + 1, blk.numSep, blk.heading)
  }

  return { at, lead, tail, text, kind }
}

/** Anexa a menor âncora literal que termina exatamente em `at` e é única. */
function uniqueAnchorBefore(full: string, at: number): string | null {
  for (let len = 16; len <= 240; len += 16) {
    const start = Math.max(0, at - len)
    const anchor = full.slice(start, at)
    if (!anchor) return null
    if (full.indexOf(anchor) + anchor.length === at) return anchor
    if (start === 0) return null
  }
  return null
}

/** Converte o plano numa operação do kit de edições (o padrão da edição). */
export function ghostPlanToEditOp(full: string, plan: GhostPlan): EditOp | null {
  const texto = plan.lead + plan.text + plan.tail
  if (!texto) return null
  if (plan.at <= 0) return { tipo: 'inicio', texto }
  if (plan.at >= full.length) return { tipo: 'fim', texto }
  const encontrar = uniqueAnchorBefore(full, plan.at)
  return encontrar ? { tipo: 'inserir_apos', encontrar, texto } : null
}

/**
 * Aplica o plano e devolve o caret logo APÓS o texto sugerido (antes do `tail`),
 * para o usuário continuar escrevendo onde a sugestão terminou.
 */
export function applyGhostPlan(full: string, plan: GhostPlan): { text: string; caret: number } {
  const at = Math.min(Math.max(plan.at, 0), full.length)
  const caret = at + plan.lead.length + plan.text.length
  const op = ghostPlanToEditOp(full, plan)
  if (op) {
    const r = applyEditKit(full, [op])
    if (r.applied === 1) return { text: r.text, caret }
  }
  // Sem âncora literal única sobra o offset — que aqui é exato: o texto não
  // mudou desde o cálculo do plano (digitar ou mover o cursor descarta a
  // sugestão antes de qualquer aceite).
  return {
    text: full.slice(0, at) + plan.lead + plan.text + plan.tail + full.slice(at),
    caret,
  }
}

/** Descrição curta do bloco sob o cursor, injetada no prompt do autocomplete. */
export function describeCursorContext(full: string, cursor: number): string {
  const at = Math.min(Math.max(cursor, 0), full.length)
  if (!full.trim()) return 'documento vazio'
  const blk = blockAt(full, at)
  if (blk.inFence) return 'o cursor está dentro de um bloco de código'

  const onde = blk.atLineEnd ? 'no fim' : 'no meio'
  const numero = blk.num > 0 ? `, numerado "${blk.num}${blk.numSep}"` : ''
  if (blk.heading) {
    return `o cursor está ${onde} de um título de nível ${blk.heading.length}${numero}: "${blk.body.trim()}"`
  }
  if (blk.num > 0) {
    return `o cursor está ${onde} do item "${blk.num}${blk.numSep}" de uma lista numerada`
  }
  if (blk.bullet) {
    return `o cursor está ${onde} de um item de lista ("${blk.bullet}")`
  }
  if (blk.body.trim() === '') return 'o cursor está numa linha em branco'
  return `o cursor está ${onde} de um parágrafo`
}
