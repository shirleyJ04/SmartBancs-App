import { randomUUID } from 'crypto';
import http from 'http';
import { URL } from 'url';
import pino from 'pino';
import { ensureSchema, getContext, getLedger, listAdvices, poolStats, saveAdvice, stats } from './db';
import { adviseWithGemini, geminiConfigured, geminiModel, historyQuality, percentChange } from './gemini';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'smartbancs-ai' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

const port = Number(process.env.PORT ?? 3001);
const simulatedDelayMs = Number(process.env.AI_DELAY_MS ?? 80);

type RecommendRequest = {
  accountId?: string;
  accountNumber?: string;
  balance?: string;
  currency?: string;
  transferAmount?: string;
  correlationId?: string;
};

function buildAdvice(
  input: RecommendRequest,
  context: Awaited<ReturnType<typeof getContext>>,
  ledger: Awaited<ReturnType<typeof getLedger>>,
) {
  const balance = Number(input.balance ?? 0);
  const amount = Number(input.transferAmount ?? 0);
  const currency = input.currency ?? 'USD';
  const quality = historyQuality(ledger, context);
  const prompt = context
    ? `${context.prompt} Consulté ${ledger.length} registros de ${input.accountNumber}. Movimiento actual: ${amount} ${currency}; saldo ${balance}.`
    : `Eres un asesor de salud financiera de SmartBancs. Historial limitado para ${input.accountNumber}. Saldo ${balance}. Movimiento ${amount}.`;

  if (quality.thin) {
    const food = context?.categories?.food;
    if (food && Number(food.previous) > 0 && Number(food.current) > Number(food.previous)) {
      return {
        category: 'NEED_MORE_DATA',
        confidence: '0.7000',
        promptUsed: prompt,
        message: `En comida pasaste de ${Number(food.previous).toFixed(2)} a ${Number(food.current).toFixed(2)} ${currency}, pero aún necesitamos más meses de historial para un consejo firme. Sigue operando; compararemos el próximo ciclo.`,
      };
    }
    return {
      category: 'NEED_MORE_DATA',
      confidence: '0.6500',
      promptUsed: prompt,
      message: `Aún necesitamos más movimientos de meses anteriores en ${input.accountNumber} para comparar tu gasto (tarjeta, comida, etc.). Con lo registrado hoy solo vemos un movimiento puntual de ${amount.toFixed(2)} ${currency}.`,
    };
  }

  if (context) {
    const categories = context.categories ?? {};
    const ranked = Object.entries(categories)
      .map(([name, detail]) => ({
        name,
        current: Number(detail.current ?? 0),
        previous: Number(detail.previous ?? 0),
        ratio: detail.ratio != null ? Number(detail.ratio) : null,
        pct: percentChange(Number(detail.current ?? 0), Number(detail.previous ?? 0)),
      }))
      .filter((row) => row.pct != null && row.previous > 0)
      .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));

    const top = ranked[0];
    if (top && (top.ratio ?? 0) >= 2) {
      return {
        category: 'CATEGORY_SPIKE',
        confidence: '0.9300',
        promptUsed: prompt,
        message: `En ${top.name} pasaste de ${top.previous.toFixed(2)} a ${top.current.toFixed(2)} ${currency} (${top.pct! >= 0 ? '+' : ''}${top.pct}% vs el mes pasado). Recorta esa categoría y fija un tope semanal.`,
      };
    }

    const totalPct = percentChange(Number(context.current_total), Number(context.previous_total));
    const totalRatio = context.total_ratio ? Number(context.total_ratio) : null;
    if (totalPct != null && totalRatio && totalRatio >= 1.5) {
      return {
        category: 'MONTHLY_SPIKE',
        confidence: '0.8800',
        promptUsed: prompt,
        message: `Tu gasto total pasó de ${Number(context.previous_total).toFixed(2)} a ${Number(context.current_total).toFixed(2)} ${currency} (${totalPct >= 0 ? '+' : ''}${totalPct}%). Prioriza ahorro y baja gastos discrecionales.`,
      };
    }
    if (context.rejected_cards > 0) {
      return {
        category: 'CARD_REJECTION',
        confidence: '0.8100',
        promptUsed: prompt,
        message: `Detectamos ${context.rejected_cards} consumo(s) de tarjeta rechazados en tu historial. Revisa cupo disponible y comercios antes del próximo intento.`,
      };
    }
  }

  if (balance < 200) {
    return {
      category: 'ALERT_LOW_BALANCE',
      confidence: '0.9100',
      promptUsed: prompt,
      message: `El saldo de ${input.accountNumber} quedó en ${input.balance} ${currency}. Conviene reducir gastos discrecionales.`,
    };
  }
  return {
    category: 'SPENDING_INSIGHT',
    confidence: '0.7200',
    promptUsed: prompt,
    message: `Movimiento registrado en ${input.accountNumber}. Tu gasto se mantiene sin un pico claro frente al mes pasado; sigue monitoreando tarjeta y comida.`,
  };
}

async function advise(body: RecommendRequest) {
  if (!body.accountNumber) {
    throw new Error('ACCOUNT_REQUIRED');
  }
  const [ledger, context] = await Promise.all([getLedger(body.accountNumber), getContext(body.accountNumber)]);
  let result: {
    category: string;
    message: string;
    confidence: string;
    promptUsed: string;
    source: 'gemini' | 'rules';
    model: string | null;
  };
  if (geminiConfigured()) {
    try {
      result = await adviseWithGemini({
        accountNumber: body.accountNumber,
        balance: body.balance,
        currency: body.currency,
        transferAmount: body.transferAmount,
        ledger,
        context,
      });
    } catch (error) {
      logger.warn({ err: error, account: body.accountNumber }, 'Gemini no respondió; se usa el motor de reglas');
      result = { ...buildAdvice(body, context, ledger), source: 'rules', model: null };
    }
  } else {
    result = { ...buildAdvice(body, context, ledger), source: 'rules', model: null };
  }
  const id = randomUUID();
  await saveAdvice({
    id,
    accountNumber: body.accountNumber,
    correlationId: body.correlationId,
    category: result.category,
    message: result.message,
    promptUsed: result.promptUsed,
    source: result.source,
    model: result.model,
  });
  return {
    id,
    ...result,
    recordsUsed: ledger.length,
    ledger: ledger.slice(-8),
    correlationId: body.correlationId ?? '',
  };
}

function json(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readBody(req: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        status: 'ok',
        provider: geminiConfigured() ? 'gemini' : 'rules',
        model: geminiConfigured() ? geminiModel() : null,
        pool: poolStats(),
        db: await stats(),
      });
      return;
    }
    const ledgerMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/ledger$/);
    if (req.method === 'GET' && ledgerMatch?.[1]) {
      json(res, 200, { items: await getLedger(decodeURIComponent(ledgerMatch[1])) });
      return;
    }
    const adviceMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/advices$/);
    if (req.method === 'GET' && adviceMatch?.[1]) {
      json(res, 200, { items: await listAdvices(decodeURIComponent(adviceMatch[1])) });
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/v1/recommend' || url.pathname === '/v1/financial-health')) {
      await sleep(simulatedDelayMs);
      const body = JSON.parse((await readBody(req)) || '{}') as RecommendRequest;
      body.correlationId = body.correlationId || String(req.headers['x-correlation-id'] ?? '');
      const result = await advise(body);
      logger.info(
        {
          correlation_id: result.correlationId,
          operation: 'ai.advise',
          category: result.category,
          source: result.source,
          model: result.model,
          account: body.accountNumber,
          records_used: result.recordsUsed,
        },
        'Consejo generado desde la DB de IA',
      );
      json(res, 200, result);
      return;
    }
    json(res, 404, { code: 'NOT_FOUND' });
  })().catch((error) => {
    logger.error({ err: error }, 'Error en el servicio de IA');
    json(res, error instanceof Error && error.message === 'ACCOUNT_REQUIRED' ? 400 : 500, {
      code: error instanceof Error && error.message === 'ACCOUNT_REQUIRED' ? 'ACCOUNT_REQUIRED' : 'AI_ERROR',
    });
  });
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

ensureSchema()
  .then(() => {
    server.listen(port, () => {
      logger.info({ port }, 'Servicio de IA con base propia iniciado');
    });
  })
  .catch((error) => {
    logger.error({ err: error }, 'No se pudo iniciar la base de la IA');
    process.exit(1);
  });
