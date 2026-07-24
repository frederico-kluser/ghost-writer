// Integração com a API da OpenAI: validação de chave, autocomplete e Whisper.

import { coerceEditOp, type EditOp } from './editKit'

export interface AttachmentContext {
  name: string
  content: string
}

export interface CompletionRequest {
  apiKey: string
  model: string
  beforeCursor: string
  afterCursor: string
  attachments: AttachmentContext[]
  signal?: AbortSignal
}

const MAX_BEFORE = 6000
const MAX_AFTER = 2000
const MAX_ATTACH_TOTAL = 8000
const MAX_BRIEFING = 2000

/**
 * Modelos com parâmetros restritos na API de chat: a família de raciocínio
 * (o1, o3, o4…) e a família GPT-5 não aceitam `temperature` (só o padrão 1)
 * e exigem `max_completion_tokens` em vez de `max_tokens`. Sem este filtro a
 * API responde "Unsupported value: 'temperature'…" — era o que quebrava o
 * fluxo do microfone logo após a transcrição.
 */
function isRestrictedModel(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model)
}

interface ChatOptions {
  apiKey: string
  model: string
  messages: Array<{ role: 'system' | 'user'; content: string }>
  temperature?: number
  maxTokens?: number
  responseFormat?: { type: 'json_object' }
  signal?: AbortSignal
  trim?: boolean
}

async function chatCompletion({
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  responseFormat,
  signal,
  trim = true,
}: ChatOptions): Promise<string> {
  const restricted = isRestrictedModel(model)
  const body: Record<string, unknown> = {
    model,
    messages,
  }
  if (restricted) {
    if (maxTokens) body.max_completion_tokens = maxTokens
  } else {
    if (temperature !== undefined) body.temperature = temperature
    if (maxTokens) body.max_tokens = maxTokens
  }
  if (responseFormat) body.response_format = responseFormat

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error?.message ?? `Erro HTTP ${res.status} na requisição à OpenAI.`)
  }

  const data = await res.json()
  let content = data.choices?.[0]?.message?.content ?? ''
  if (trim) content = content.trim()
  return content
}

export async function validateApiKey(
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (res.ok) return { ok: true }
    if (res.status === 401) return { ok: false, error: 'Chave inválida ou revogada.' }
    if (res.status === 429)
      return { ok: false, error: 'Limite de requisições atingido. Tente novamente.' }
    const data = await res.json().catch(() => null)
    return { ok: false, error: data?.error?.message ?? `Erro HTTP ${res.status}` }
  } catch {
    return { ok: false, error: 'Falha de rede ao contatar a OpenAI.' }
  }
}

function buildSystemPrompt(): string {
  return [
    'Você é o motor de autocompletar de um bloco de notas, no estilo "ghost text" do VS Code / GitHub Copilot.',
    'Regras obrigatórias:',
    '- Continue o texto EXATAMENTE a partir da posição do cursor ([CURSOR]).',
    '- Retorne APENAS a continuação: sem explicações, sem aspas envolventes, sem repetir o texto já escrito.',
    '- A continuação deve ser curta (no máximo ~2 frases ou poucas linhas) e seguir o idioma, o estilo e a formatação do usuário.',
    '- Se existir texto depois do cursor, a continuação deve conectar-se de forma coerente com ele (complete a palavra/frase quebrada, não a repita).',
    '- Use os arquivos anexados somente como contexto (termos, nomes, estilo); nunca os reproduza por inteiro.',
    '- Se o documento for Markdown, respeite a sintaxe Markdown.',
    '- Se não houver continuação razoável, retorne uma string vazia.',
  ].join('\n')
}

/** Bloco de contexto dos anexos, consumindo MAX_ATTACH_TOTAL em cascata. */
function buildAttachmentsBlock(attachments: AttachmentContext[]): string {
  if (attachments.length === 0) return ''
  let budget = MAX_ATTACH_TOTAL
  const parts: string[] = []
  for (const a of attachments) {
    if (budget <= 0) break
    const slice = a.content.slice(0, budget)
    budget -= slice.length
    parts.push(`--- arquivo anexado: ${a.name} ---\n${slice}`)
  }
  return `<contexto_de_arquivos_anexados>\n${parts.join('\n\n')}\n</contexto_de_arquivos_anexados>\n\n`
}

function buildUserPrompt(req: CompletionRequest): string {
  const before = req.beforeCursor.slice(-MAX_BEFORE)
  const after = req.afterCursor.slice(0, MAX_AFTER)

  return (
    buildAttachmentsBlock(req.attachments) +
    `<texto_antes_do_cursor>\n${before}\n</texto_antes_do_cursor>\n` +
    `[CURSOR]\n` +
    `<texto_depois_do_cursor>\n${after}\n</texto_depois_do_cursor>\n\n` +
    'Escreva somente a continuação a partir de [CURSOR]:'
  )
}

/** Normaliza quebras de linha e desembrulha cercas ``` que o modelo às vezes adiciona. */
function normalizeModelText(raw: string): string {
  const text = raw.replace(/\r\n/g, '\n')
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)```\s*$/)
  return fence ? fence[1] : text
}

/** Remove cercas de código e sobreposição com o texto já digitado. */
function sanitizeCompletion(raw: string, beforeCursor: string): string {
  let text = normalizeModelText(raw)

  // Remover eco do final do texto anterior (o modelo às vezes repete o rabinho)
  const maxOverlap = Math.min(60, beforeCursor.length, text.length - 1)
  for (let k = maxOverlap; k >= 4; k--) {
    if (text.startsWith(beforeCursor.slice(-k))) {
      text = text.slice(k)
      break
    }
  }

  return text.trimEnd()
}

export async function fetchCompletion(req: CompletionRequest): Promise<string> {
  const text = await chatCompletion({
    apiKey: req.apiKey,
    model: req.model,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(req) },
    ],
    temperature: 0.3,
    maxTokens: 180,
    signal: req.signal,
    trim: false,
  })
  return sanitizeCompletion(text, req.beforeCursor)
}

// ---------- sugestão guiada por briefing ----------

export interface GuidedSuggestionRequest {
  apiKey: string
  model: string
  briefing: string
  beforeCursor: string
  afterCursor: string
  attachments: AttachmentContext[]
  signal?: AbortSignal
}

function buildGuidedSystemPrompt(): string {
  return [
    'Você é um escritor assistente dentro de um bloco de notas. O usuário escreveu um briefing descrevendo o texto que quer.',
    'Regras obrigatórias:',
    '- Escreva um texto NOVO que atenda ao briefing. Não é a continuação literal da última frase: é um trecho que será inserido na posição [CURSOR].',
    '- Retorne APENAS o texto pedido: sem preâmbulo, sem explicações, sem comentários, sem aspas envolventes, sem cercas de código e sem repetir o briefing.',
    '- Nunca escreva frases como "Claro!", "Aqui está" ou "Segue o texto", nem qualquer meta-comentário.',
    '- Use o texto antes e depois do cursor apenas como referência de assunto, idioma, tom, pessoa gramatical e formatação. NÃO repita trechos que já estão escritos.',
    '- Escreva no mesmo idioma do documento. Se o documento estiver vazio, escreva no idioma do briefing.',
    '- Respeite o tamanho pedido no briefing. Se o briefing não disser o tamanho, escreva de 1 a 3 parágrafos.',
    '- Se o documento usa Markdown, mantenha a sintaxe Markdown coerente com o restante.',
    '- Use os arquivos anexados somente como fonte de contexto (fatos, nomes, termos, estilo); nunca os reproduza por inteiro.',
    '- Não invente fatos verificáveis (datas, números, citações) que não estejam no contexto; prefira uma formulação genérica.',
    '- Comece direto na primeira palavra do conteúdo, sem linha em branco inicial.',
  ].join('\n')
}

function buildGuidedUserPrompt(req: GuidedSuggestionRequest): string {
  const before = req.beforeCursor.slice(-MAX_BEFORE)
  const after = req.afterCursor.slice(0, MAX_AFTER)
  const briefing = req.briefing.trim().slice(0, MAX_BRIEFING)

  return (
    buildAttachmentsBlock(req.attachments) +
    `<briefing_do_usuario>\n${briefing}\n</briefing_do_usuario>\n\n` +
    `<texto_antes_do_cursor>\n${before}\n</texto_antes_do_cursor>\n` +
    `[CURSOR]\n` +
    `<texto_depois_do_cursor>\n${after}\n</texto_depois_do_cursor>\n\n` +
    'Escreva somente o texto que atende ao briefing, para ser inserido em [CURSOR]:'
  )
}

export async function fetchGuidedSuggestion(
  req: GuidedSuggestionRequest,
): Promise<string> {
  const raw = await chatCompletion({
    apiKey: req.apiKey,
    model: req.model,
    messages: [
      { role: 'system', content: buildGuidedSystemPrompt() },
      { role: 'user', content: buildGuidedUserPrompt(req) },
    ],
    temperature: 0.7,
    // Em modelos restritos o teto vira max_completion_tokens, que inclui os
    // tokens de raciocínio: um limite baixo faz a API devolver conteúdo vazio.
    maxTokens: isRestrictedModel(req.model) ? 4000 : 1200,
    signal: req.signal,
    trim: false,
  })
  return normalizeModelText(raw).trim()
}

export interface ClassifyResult {
  type: 'transcription' | 'instruction'
  payload: string
}

/**
 * Verbos imperativos e padrões que indicam comando de edição em português.
 * Falso negativo é seguro: a frase é inserida como ditado normal.
 * Falso positivo é perigoso: substitui o documento inteiro.
 */
const COMMAND_IMPERATIVES = [
  'apague', 'apaga', 'remova', 'remove', 'adicione', 'adiciona',
  'troque', 'troca', 'mude', 'muda', 'converta', 'converte',
  'formate', 'formata', 'alinhe', 'alinha', 'recorte', 'recorta',
  'cole', 'cola', 'insira', 'insere', 'escreva', 'escreve',
  'corrija', 'corrige', 'substitua', 'substitui', 'transforme',
  'transforma', 'resuma', 'resume', 'expanda', 'expande',
  'reescreva', 'reescreve', 'traduza', 'traduz', 'reorganize',
  'reorganiza', 'liste', 'lista', 'enumere', 'enumera',
  'justifique', 'justifica', 'centralize', 'centraliza',
  'destaque', 'destaca', 'apagar', 'remover', 'trocar', 'mudar',
  'adicionar', 'converter', 'formatar', 'alinhar', 'inserir',
  'escrever', 'corrigir', 'substituir', 'transformar', 'resumir',
  'expandir', 'reescrever', 'traduzir', 'reorganizar', 'listar',
  'enumerar', 'justificar', 'centralizar', 'destacar',
  'recortar', 'colar', 'excluir', 'exclua', 'exclui',
  'delete', 'deleta', 'deletar',
]

const COMMAND_PHRASES = [
  'coloque em', 'coloca em', 'colocar em',
  'passe para', 'passa para', 'passar para',
  'faça com que', 'faz com que', 'fazer com que',
  'quero que você', 'quero que voce',
  'pode por favor', 'podes por favor', 'poderia por favor',
  'coloque tudo em', 'coloca tudo em',
]

/**
 * Verifica se o transcript PARECE um comando de edição.
 * Heurística rápida, sem IA: economiza latência e evita falsos positivos
 * que substituiriam o documento inteiro por engano.
 */
export function looksLikeCommand(transcript: string): boolean {
  const lower = transcript.toLowerCase().trim()
  if (!lower) return false

  // Frases muito curtas (1-3 palavras) são quase sempre ditado
  const wordCount = lower.split(/\s+/).length
  if (wordCount <= 3) return false

  // Começa com verbo imperativo/infinitivo de edição
  for (const imp of COMMAND_IMPERATIVES) {
    if (lower.startsWith(imp + ' ')) return true
  }

  // Contém frase típica de comando
  for (const phrase of COMMAND_PHRASES) {
    if (lower.includes(phrase)) return true
  }

  return false
}

export async function classifyUtterance(
  apiKey: string,
  model: string,
  transcript: string,
  context: string,
): Promise<ClassifyResult> {
  const system = [
    'Você é um classificador de comandos de voz para um app de notas.',
    'SEMPRE prefira "transcription" a menos que a fala seja CLARAMENTE um comando de edição.',
    'Regras:',
    '- "transcription": para QUALQUER texto que o usuário está ditando para ser inserido no cursor. Isso inclui frases descritivas, opiniões, listas, e até frases que MENCIONAM edição (ex: "acho que deveria apagar a última frase" NÃO é um comando — é uma opinião ditada).',
    '- "instruction": SOMENTE se a frase é um comando explícito com verbo imperativo ou infinitivo de edição (apague, remova, troque, converta, resuma, reescreva, etc.). Exemplos: "apague a última frase", "converta tudo para maiúsculas", "resuma o parágrafo".',
    'Na dúvida, escolha "transcription".',
    'Para "transcription", o payload é o texto exato a ser inserido.',
    'Para "instruction", o payload é a instrução de edição, mantida clara e curta.',
    'Responda APENAS com JSON no formato: {"type":"transcription|instruction","payload":"..."}',
  ].join('\n')

  const user = `Trecho atual do documento (contexto):\n${context.slice(-800)}\n\nFala do usuário:\n${transcript}\n\nClassifique:`

  const raw = await chatCompletion({
    apiKey,
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0,
    maxTokens: 120,
    responseFormat: { type: 'json_object' },
  })

  try {
    const parsed = JSON.parse(raw) as Partial<ClassifyResult>
    if (
      (parsed.type === 'transcription' || parsed.type === 'instruction') &&
      typeof parsed.payload === 'string'
    ) {
      return { type: parsed.type, payload: parsed.payload }
    }
  } catch {
    // fall back to transcription
  }
  return { type: 'transcription', payload: transcript }
}

export interface ApplyInstructionRequest {
  apiKey: string
  model: string
  instruction: string
  fullText: string
  selectedText?: string
}

export async function applyInstruction(req: ApplyInstructionRequest): Promise<string> {
  let system: string
  let user: string

  if (req.selectedText) {
    system = [
      'Você é um editor de texto. O usuário selecionou um trecho e deu uma instrução.',
      'Aplique a instrução APENAS no trecho selecionado.',
      'Retorne APENAS o trecho modificado, sem explicações, sem cercas de código, sem comentários.',
    ].join('\n')
    user = `Trecho selecionado:\n${req.selectedText}\n\nInstrução:\n${req.instruction}\n\nTrecho modificado:`
  } else {
    system = [
      'Você é um editor de texto. O usuário deu uma instrução sobre o documento inteiro.',
      'Aplique a instrução e retorne o TEXTO COMPLETO resultante.',
      'Não inclua explicações, cercas de código ou comentários.',
    ].join('\n')
    user = `Texto atual:\n${req.fullText}\n\nInstrução:\n${req.instruction}\n\nTexto resultante:`
  }

  return chatCompletion({
    apiKey: req.apiKey,
    model: req.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    maxTokens: 4096,
  })
}

// ---------- kit de edições posicionais ----------

export interface EditKitRequest {
  apiKey: string
  model: string
  instruction: string
  fullText: string
  attachments?: AttachmentContext[]
  signal?: AbortSignal
}

function buildEditKitSystemPrompt(): string {
  return [
    'Você é um editor de texto que trabalha por EDIÇÕES CIRÚRGICAS: nunca reescreve o documento inteiro.',
    'O usuário deu uma instrução. Devolva um "kit" de edições em JSON que aplique a instrução mexendo SOMENTE nos trechos necessários, possivelmente em vários pontos diferentes.',
    'Formato EXATO: {"edicoes":[ ... ]}. Cada item é um objeto com "tipo" e campos:',
    '- {"tipo":"substituir","encontrar":"<trecho EXATO já existente>","texto":"<novo trecho>"}',
    '- {"tipo":"inserir_apos","encontrar":"<trecho EXATO já existente>","texto":"<texto a inserir depois dele>"}',
    '- {"tipo":"inserir_antes","encontrar":"<trecho EXATO já existente>","texto":"<texto a inserir antes dele>"}',
    '- {"tipo":"inicio","texto":"<texto a inserir no começo do documento>"}',
    '- {"tipo":"fim","texto":"<texto a inserir no fim do documento>"}',
    'Regras obrigatórias:',
    '- "encontrar" deve ser uma cópia LITERAL e curta de um trecho que existe no documento atual — o menor trecho que identifique o ponto sem ambiguidade. Copie pontuação, acentos e maiúsculas exatamente.',
    '- Prefira o MENOR número de edições. Não repita trechos que não mudam.',
    '- Para acrescentar conteúdo novo, use inserir_apos / inserir_antes / inicio / fim; use substituir só quando realmente troca texto existente.',
    '- Liste as edições na ordem em que aparecem no documento.',
    '- Respeite o idioma e a formatação (Markdown) do documento.',
    '- Responda APENAS com o JSON, sem explicações nem cercas de código.',
    '- Se nada precisar mudar, devolva {"edicoes":[]}.',
  ].join('\n')
}

/** Extrai o array de operações de uma resposta JSON tolerante a formatos. */
function parseEditKit(raw: string): EditOp[] {
  let data: unknown
  try {
    data = JSON.parse(normalizeModelText(raw))
  } catch {
    return []
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown>)?.edicoes)
      ? ((data as Record<string, unknown>).edicoes as unknown[])
      : Array.isArray((data as Record<string, unknown>)?.edits)
        ? ((data as Record<string, unknown>).edits as unknown[])
        : []
  const ops: EditOp[] = []
  for (const item of list) {
    const op = coerceEditOp(item)
    if (op) ops.push(op)
  }
  return ops
}

export async function fetchEditKit(req: EditKitRequest): Promise<EditOp[]> {
  const attachments = buildAttachmentsBlock(req.attachments ?? [])
  const user =
    attachments +
    `<documento>\n${req.fullText}\n</documento>\n\n` +
    `Instrução do usuário:\n${req.instruction.slice(0, MAX_BRIEFING)}\n\n` +
    'Devolva o kit de edições em JSON:'

  const raw = await chatCompletion({
    apiKey: req.apiKey,
    model: req.model,
    messages: [
      { role: 'system', content: buildEditKitSystemPrompt() },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    // Teto alto: em modelos restritos inclui os tokens de raciocínio, e o JSON
    // com vários trechos copiados pode ser longo.
    maxTokens: isRestrictedModel(req.model) ? 8000 : 4096,
    responseFormat: { type: 'json_object' },
    signal: req.signal,
  })
  return parseEditKit(raw)
}

// ---------- ideias (brainstorming guiado) ----------

export interface Idea {
  title: string
  content: string
}

export interface IdeasRequest {
  apiKey: string
  model: string
  need: string
  beforeCursor: string
  afterCursor: string
  attachments: AttachmentContext[]
  signal?: AbortSignal
}

function buildIdeasSystemPrompt(): string {
  return [
    'Você é um parceiro de brainstorming dentro de um bloco de notas. O usuário descreve uma necessidade e você propõe IDEIAS distintas para ajudá-lo.',
    'Formato EXATO: {"ideias":[{"titulo":"<rótulo curto>","conteudo":"<texto pronto para inserir no documento>"}]}.',
    'Regras obrigatórias:',
    '- Gere de 4 a 6 ideias claramente diferentes entre si (ângulos, abordagens ou conteúdos distintos).',
    '- "titulo": curto (até ~6 palavras), descreve a ideia.',
    '- "conteudo": o texto que será INSERIDO no documento se o usuário escolher a ideia. Escreva-o pronto, sem preâmbulo, sem meta-comentário e sem repetir o título.',
    '- Escreva no idioma do documento; se o documento estiver vazio, no idioma da necessidade.',
    '- Use o texto ao redor do cursor e os anexos apenas como contexto (assunto, tom, termos); não os reproduza por inteiro.',
    '- Se o documento usa Markdown, mantenha a sintaxe coerente.',
    '- Responda APENAS com o JSON, sem explicações nem cercas de código.',
  ].join('\n')
}

function parseIdeas(raw: string): Idea[] {
  let data: unknown
  try {
    data = JSON.parse(normalizeModelText(raw))
  } catch {
    return []
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown>)?.ideias)
      ? ((data as Record<string, unknown>).ideias as unknown[])
      : Array.isArray((data as Record<string, unknown>)?.ideas)
        ? ((data as Record<string, unknown>).ideas as unknown[])
        : []
  const ideas: Idea[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const title = typeof o.titulo === 'string' ? o.titulo : typeof o.title === 'string' ? o.title : ''
    const content =
      typeof o.conteudo === 'string' ? o.conteudo : typeof o.content === 'string' ? o.content : ''
    if (content.trim()) {
      ideas.push({ title: title.trim() || 'Ideia', content: content.trim() })
    }
    if (ideas.length >= 8) break
  }
  return ideas
}

export async function fetchIdeas(req: IdeasRequest): Promise<Idea[]> {
  const before = req.beforeCursor.slice(-MAX_BEFORE)
  const after = req.afterCursor.slice(0, MAX_AFTER)
  const user =
    buildAttachmentsBlock(req.attachments) +
    `<necessidade_do_usuario>\n${req.need.slice(0, MAX_BRIEFING)}\n</necessidade_do_usuario>\n\n` +
    `<texto_antes_do_cursor>\n${before}\n</texto_antes_do_cursor>\n` +
    `[CURSOR]\n` +
    `<texto_depois_do_cursor>\n${after}\n</texto_depois_do_cursor>\n\n` +
    'Gere as ideias em JSON:'

  const raw = await chatCompletion({
    apiKey: req.apiKey,
    model: req.model,
    messages: [
      { role: 'system', content: buildIdeasSystemPrompt() },
      { role: 'user', content: user },
    ],
    temperature: 0.8,
    maxTokens: isRestrictedModel(req.model) ? 6000 : 2000,
    responseFormat: { type: 'json_object' },
    signal: req.signal,
  })
  return parseIdeas(raw)
}

export async function transcribeAudio(apiKey: string, blob: Blob): Promise<string> {
  const mime = blob.type || 'audio/webm'
  const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm'
  const form = new FormData()
  form.append('file', blob, `gravacao.${ext}`)
  form.append('model', 'whisper-1')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error?.message ?? `Erro HTTP ${res.status} na transcrição.`)
  }
  const data = await res.json()
  return (data.text ?? '').trim()
}
