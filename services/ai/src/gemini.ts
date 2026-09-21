import type { LedgerRow, StoredContext } from './db';

export type GeminiAdvice = {
  category: string;
  message: string;
  confidence: string;
  promptUsed: string;
  source: 'gemini';
  model: string;
};

const ALLOWED = new Set([
  'CATEGORY_SPIKE',
  'MONTHLY_SPIKE',
  'CARD_REJECTION',
  'ALERT_LOW_BALANCE',
  'SPENDING_INSIGHT',
  'NEED_MORE_DATA',
]);

export function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY?.trim()) && process.env.AI_PROVIDER !== 'rules';
}

export function geminiModel() {
  return process.env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash';
}

export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function historyQuality(ledger: LedgerRow[], context: StoredContext | null) {
  const completed = ledger.filter((row) => row.status === 'COMPLETED');
  const months = new Set(completed.map((row) => row.month));
  const previousTotal = context ? Number(context.previous_total) : 0;
  const currentTotal = context ? Number(context.current_total) : 0;
  const hasTwoMonths = months.size >= 2 || (previousTotal > 0 && currentTotal >= 0);
  const thin =
    completed.length < 3 ||
    !context ||
    (!hasTwoMonths && completed.length < 8) ||
    (previousTotal <= 0 && currentTotal <= 0 && completed.length < 5);
  return {
    completedCount: completed.length,
    monthsSeen: months.size,
    previousTotal,
    currentTotal,
    hasTwoMonths,
    thin,
  };
}

function categoryLines(context: StoredContext | null): string[] {
  if (!context?.categories) return [];
  const lines: string[] = [];
  for (const [name, detail] of Object.entries(context.categories)) {
    const cur = Number(detail.current ?? 0);
    const prev = Number(detail.previous ?? 0);
    const pct = percentChange(cur, prev);
    const pctText = pct === null ? 'sin base comparable' : `${pct >= 0 ? '+' : ''}${pct}%`;
    lines.push(
      `- ${name}: mes actual ${cur.toFixed(2)} USD vs mes anterior ${prev.toFixed(2)} USD (${pctText}` +
        `${detail.ratio != null ? `; ratio ${detail.ratio}x` : ''})`,
    );
  }
  return lines;
}

export function buildPrompt(input: {
  accountNumber: string;
  balance?: string;
  currency?: string;
  transferAmount?: string;
  ledger: LedgerRow[];
  context: StoredContext | null;
}) {
  const currency = input.currency ?? 'USD';
  const quality = historyQuality(input.ledger, input.context);
  const rows = input.ledger
    .slice(-40)
    .map(
      (row) =>
        `${row.booked_on} | UAFE ${row.type_code} ${row.nature_code} ${row.product_code} | ${row.type_label} | ${row.status} | ${row.amount} ${row.currency} | ${row.category} | ${row.counterpart_name}`,
    )
    .join('\n');

  const totalPct =
    input.context != null
      ? percentChange(Number(input.context.current_total), Number(input.context.previous_total))
      : null;

  const etlBlock = input.context
    ? [
        'Contexto ETL (ya limpio, sin infra):',
        input.context.prompt,
        `Gasto total ${input.context.as_of_month}: ${input.context.current_total} ${currency}.`,
        `Gasto total ${input.context.compare_month}: ${input.context.previous_total} ${currency}.`,
        totalPct === null
          ? 'No hay % comparable del gasto total (falta mes anterior o es 0).'
          : `Variación del gasto total: ${totalPct >= 0 ? '+' : ''}${totalPct}% (ratio ${input.context.total_ratio ?? 'n/a'}).`,
        `Rechazos de tarjeta (TJC) en el ledger: ${input.context.rejected_cards}.`,
        'Gasto por categoría (solo débitos COMPLETED):',
        ...(categoryLines(input.context).length
          ? categoryLines(input.context)
          : ['- (sin categorías)']),
      ].join('\n')
    : `No hay contexto ETL para ${input.accountNumber}.`;

  const historyHint = quality.thin
    ? [
        'HISTORIAL INSUFICIENTE para un consejo comparativo fuerte.',
        'Si faltan meses o hay muy pocos movimientos COMPLETED, usa category NEED_MORE_DATA.',
        'Ejemplo de tono: "Aún necesitamos más movimientos de meses anteriores para comparar tu gasto en tarjeta; con lo de hoy solo vemos un consumo puntual."',
        'Si hay al menos un gasto reciente y uno anterior en la misma categoría (aunque sean pocos), puedes contrastarlos con cifras concretas (ej. alimentos 10 vs 70 USD) y pedir más historial.',
      ].join(' ')
    : [
        'Hay historial suficiente. Prefiere consejos con cifras y %.',
        'Ejemplo: "En tarjeta pasaste de 450 a 890 USD este mes (+97%). Baja el cupo de comercios no esenciales."',
        'Ejemplo categoría: "En comida ibas en 10 USD y hoy sumas 70 USD; fija un tope semanal de delivery."',
      ].join(' ');

  return [
    'Eres el asesor de salud financiera de SmartBancs (Ecuador). Hablas al titular en español, claro y accionable.',
    'Catálogo UAFE: type_code (06 Inversión, 08 Pago TJC, 34 Transferencia enviada, 37 Nota de Débito…), nature_code D=débito C=crédito, product_code AHO/CTE/TJC/INV.',
    'Usa ÚNICAMENTE el ledger y el contexto ETL. No inventes montos ni comercios. No menciones timeouts, infraestructura, Gemini ni que eres un modelo.',
    'Ignora REJECTED al calcular gasto; sí puedes alertar por rechazos de tarjeta (CARD_REJECTION).',
    historyHint,
    etlBlock,
    `Cuenta: ${input.accountNumber}`,
    `Saldo actual: ${input.balance ?? 'desconocido'} ${currency}`,
    `Movimiento que disparó el consejo (transferencia reciente): ${input.transferAmount ?? '0'} ${currency}`,
    `Calidad de historial: movimientos COMPLETED=${quality.completedCount}, meses distintos=${quality.monthsSeen}, thin=${quality.thin}.`,
    `Últimos registros en la base de IA (${Math.min(input.ledger.length, 40)} de ${input.ledger.length}):`,
    rows || '(sin movimientos)',
    'Responde SOLO JSON válido con esta forma:',
    '{"category":"CATEGORY_SPIKE|MONTHLY_SPIKE|CARD_REJECTION|ALERT_LOW_BALANCE|SPENDING_INSIGHT|NEED_MORE_DATA","message":"máximo 2 frases en español, con cifras/% del ledger o pidiendo más historial","confidence":"0.00"}',
  ].join('\n');
}

export async function adviseWithGemini(input: {
  accountNumber: string;
  balance?: string;
  currency?: string;
  transferAmount?: string;
  ledger: LedgerRow[];
  context: StoredContext | null;
}): Promise<GeminiAdvice> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_NOT_CONFIGURED');
  }

  const model = geminiModel();
  const promptUsed = buildPrompt(input);
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS ?? 8000);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const raw = await generateContent(url, apiKey, promptUsed, timeoutMs, true);

  const payload = JSON.parse(raw) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    }>;
  };
  const text = (payload.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (!text) {
    throw new Error('GEMINI_EMPTY');
  }

  const parsed = parseAdviceJson(text);
  const category = ALLOWED.has(parsed.category ?? '') ? parsed.category! : 'SPENDING_INSIGHT';
  if (!parsed.message?.trim()) {
    throw new Error('GEMINI_BAD_JSON');
  }

  return {
    category,
    message: parsed.message.trim(),
    confidence: parsed.confidence?.trim() || '0.8000',
    promptUsed,
    source: 'gemini',
    model,
  };
}

async function generateContent(
  url: string,
  apiKey: string,
  promptUsed: string,
  timeoutMs: number,
  withThinkingBudget: boolean,
) {
  const generationConfig: Record<string, unknown> = {
    temperature: 0.3,
    maxOutputTokens: 2048,
    responseMimeType: 'application/json',
  };
  if (withThinkingBudget) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: promptUsed }] }],
      generationConfig,
    }),
  });
  const raw = await response.text();
  if (response.status === 400 && withThinkingBudget) {
    return generateContent(url, apiKey, promptUsed, timeoutMs, false);
  }
  if (!response.ok) {
    throw new Error(`GEMINI_HTTP_${response.status}: ${raw.slice(0, 240)}`);
  }
  return raw;
}

function parseAdviceJson(text: string) {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const slice = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(slice) as { category?: string; message?: string; confidence?: string };
  } catch {
    throw new Error(`GEMINI_BAD_JSON: ${slice.slice(0, 180)}`);
  }
}
