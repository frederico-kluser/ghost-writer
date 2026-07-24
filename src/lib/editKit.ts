// Kit de edições posicionais.
//
// Em vez de reescrever o documento inteiro, a IA devolve uma LISTA de operações
// que mexem só nos trechos necessários. Cada operação localiza o ponto por uma
// âncora LITERAL (`encontrar`) — offsets de caractere são pouco confiáveis vindos
// de um modelo, um trecho copiado do texto não é. As operações são aplicadas em
// sequência, re-buscando o texto já modificado a cada passo, e o caret final vai
// para o fim da última edição aplicada (o ponto editado), nunca para o fim do
// documento.

export type EditOp =
  | { tipo: 'substituir'; encontrar: string; texto: string }
  | { tipo: 'inserir_apos'; encontrar: string; texto: string }
  | { tipo: 'inserir_antes'; encontrar: string; texto: string }
  | { tipo: 'inicio'; texto: string }
  | { tipo: 'fim'; texto: string }

export interface EditKitResult {
  /** Texto resultante após aplicar as operações que casaram. */
  text: string
  /** Posição do caret após a última edição aplicada. */
  caret: number
  /** Quantas operações foram efetivamente aplicadas. */
  applied: number
  /** Operações cuja âncora não foi encontrada no texto. */
  missed: EditOp[]
}

/** Coage um objeto solto (vindo de JSON) em EditOp, ou null se inválido. */
export function coerceEditOp(raw: unknown): EditOp | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const texto = typeof o.texto === 'string' ? o.texto : ''
  const encontrar = typeof o.encontrar === 'string' ? o.encontrar : ''
  switch (o.tipo) {
    case 'inicio':
      return texto ? { tipo: 'inicio', texto } : null
    case 'fim':
      return texto ? { tipo: 'fim', texto } : null
    case 'substituir':
      return encontrar ? { tipo: 'substituir', encontrar, texto } : null
    case 'inserir_apos':
      return encontrar ? { tipo: 'inserir_apos', encontrar, texto } : null
    case 'inserir_antes':
      return encontrar ? { tipo: 'inserir_antes', encontrar, texto } : null
    default:
      return null
  }
}

/**
 * Aplica o kit ao texto. Operações com âncora não encontrada são puladas e
 * registradas em `missed`; o restante é aplicado assim mesmo.
 */
export function applyEditKit(original: string, edits: EditOp[]): EditKitResult {
  let text = original
  let caret = -1
  let applied = 0
  const missed: EditOp[] = []

  // Quando várias inserções compartilham o MESMO ponto de entrada — mesma âncora
  // num `inserir_apos`, ou o início do documento num `inicio` —, a inserção
  // seguinte precisa entrar DEPOIS do texto que a anterior já colocou. Como o
  // ponto de entrada de uma dessas operações não se move (a âncora fica antes do
  // texto inserido), re-inserir logo após a âncora inverteria a ordem em que o
  // modelo listou as edições (que é a ordem do documento). Rastreamos o fim da
  // última inserção nesses pontos para continuar a partir dele.
  let lastApposAt = -1
  let lastApposEnd = -1
  let inicioEnd = 0

  for (const op of edits) {
    if (op.tipo === 'inicio') {
      const at = inicioEnd
      text = text.slice(0, at) + op.texto + text.slice(at)
      caret = at + op.texto.length
      inicioEnd = caret
      applied++
      continue
    }
    if (op.tipo === 'fim') {
      caret = text.length + op.texto.length
      text = text + op.texto
      applied++
      continue
    }

    const idx = text.indexOf(op.encontrar)
    if (idx < 0) {
      missed.push(op)
      continue
    }

    if (op.tipo === 'substituir') {
      text = text.slice(0, idx) + op.texto + text.slice(idx + op.encontrar.length)
      caret = idx + op.texto.length
    } else if (op.tipo === 'inserir_apos') {
      const anchorEnd = idx + op.encontrar.length
      // âncora repetida em sequência: continua depois do texto anterior
      const at = anchorEnd === lastApposAt ? lastApposEnd : anchorEnd
      text = text.slice(0, at) + op.texto + text.slice(at)
      caret = at + op.texto.length
      lastApposAt = anchorEnd
      lastApposEnd = caret
    } else {
      // inserir_antes: cada inserção empurra a âncora para a frente, então a
      // próxima com a mesma âncora já cai depois — a ordem se preserva sozinha.
      text = text.slice(0, idx) + op.texto + text.slice(idx)
      caret = idx + op.texto.length
    }
    applied++
  }

  if (caret < 0) caret = text.length
  caret = Math.min(caret, text.length)
  return { text, caret, applied, missed }
}

/** Corta um trecho longo para exibição na prévia. */
function ellipsize(s: string, max = 60): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max) + '…' : one
}

/** Resumo legível do kit, usado como prévia antes de aplicar. */
export function describeEditKit(edits: EditOp[], missed = 0): string {
  const lines = edits.map((op, i) => {
    const n = `${i + 1}.`
    switch (op.tipo) {
      case 'substituir':
        // Só é "Remover" quando o texto é vazio de fato; um texto com espaços
        // é uma SUBSTITUIÇÃO literal (a prévia não pode dizer que remove).
        return op.texto === ''
          ? `${n} Remover «${ellipsize(op.encontrar)}»`
          : `${n} Substituir «${ellipsize(op.encontrar)}»\n   → «${ellipsize(op.texto)}»`
      case 'inserir_apos':
        return `${n} Inserir depois de «${ellipsize(op.encontrar)}»\n   + «${ellipsize(op.texto)}»`
      case 'inserir_antes':
        return `${n} Inserir antes de «${ellipsize(op.encontrar)}»\n   + «${ellipsize(op.texto)}»`
      case 'inicio':
        return `${n} Inserir no início\n   + «${ellipsize(op.texto)}»`
      case 'fim':
        return `${n} Inserir no fim\n   + «${ellipsize(op.texto)}»`
    }
  })
  const header = `${edits.length} edição(ões) pontual(is):`
  const warn = missed > 0 ? `\n\n⚠ ${missed} edição(ões) não encontraram o trecho e serão ignoradas.` : ''
  return `${header}\n\n${lines.join('\n\n')}${warn}`
}

/**
 * Quebras de linha necessárias em volta de um texto inserido, contando as que já
 * existem: `\n\n` cego somaria a uma quebra existente e abriria um vão duplo no
 * preview de Markdown.
 */
export function padForInsert(
  before: string,
  after: string,
): { lead: string; tail: string } {
  const countBreaks = (s: string) => (s.match(/\n/g) ?? []).length
  const tailWs = /[ \t\n]*$/.exec(before)?.[0] ?? ''
  const headWs = /^[ \t\n]*/.exec(after)?.[0] ?? ''
  return {
    lead: before.trim() === '' ? '' : '\n'.repeat(Math.max(0, 2 - countBreaks(tailWs))),
    tail: after.trim() === '' ? '' : '\n'.repeat(Math.max(0, 2 - countBreaks(headWs))),
  }
}

/**
 * Insere `text` na posição `pos` do documento, com o espaçamento adequado, e
 * devolve o texto novo e o caret logo após o trecho inserido.
 */
export function insertTextAtAnchor(
  full: string,
  pos: number,
  text: string,
): { text: string; caret: number } {
  const clamped = Math.min(Math.max(pos, 0), full.length)
  const before = full.slice(0, clamped)
  const after = full.slice(clamped)
  const { lead, tail } = padForInsert(before, after)
  return {
    text: before + lead + text + tail + after,
    caret: clamped + lead.length + text.length,
  }
}
