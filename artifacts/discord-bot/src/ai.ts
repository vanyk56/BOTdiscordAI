// ─── AI API INTEGRATION (RIVER AI & YETA AI) ───────────────────────────────────
import { jsonrepair } from "jsonrepair";

export const RIVER_BASE_URL = process.env.RIVER_BASE_URL ?? "https://api.river.ai/v1";
export const RIVER_API_KEY =
  process.env.RIVER_API_KEY ??
  process.env.OPENAI_API_KEY ??
  process.env.OPENROUTER_API_KEY ??
  process.env.AI_INTEGRATIONS_GEMINI_API_KEY ??
  process.env.GEMINI_API_KEY ??
  "";

export const YETA_BASE_URL = process.env.YETA_BASE_URL ?? "https://platform.yeta.ai/v1";
export const YETA_API_KEY =
  process.env.YETA_API_KEY ??
  process.env.RIVER_API_KEY ??
  process.env.OPENAI_API_KEY ??
  process.env.OPENROUTER_API_KEY ??
  "";

// Image generation configuration
export const IMAGE_BASE_URL =
  process.env.IMAGE_BASE_URL ?? process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
export const IMAGE_API_KEY =
  process.env.IMAGE_API_KEY ?? process.env.OPENROUTER_API_KEY ?? RIVER_API_KEY;

if (!RIVER_API_KEY && !YETA_API_KEY) {
  console.warn("[AI] Warning: No API keys configured! Set RIVER_API_KEY and/or YETA_API_KEY.");
}

// ─── MODEL DESIGNATIONS ────────────────────────────────────────────────────────
// Все режимы кроме skala: River AI (zai-org/GLM-5.3-Flash)
export const MODEL_DEFAULT = process.env.RIVER_MODEL ?? "zai-org/GLM-5.3-Flash";
export const MODEL_CHAT = MODEL_DEFAULT;
export const MODEL_UTILS = MODEL_DEFAULT;

// Режим skala: Yeta AI (deepseek-v4.1-flash-uncensored)
export const MODEL_SKALA =
  process.env.YETA_MODEL ?? process.env.SKALA_MODEL ?? "deepseek-v4.1-flash-uncensored";

export const MODEL_IMAGE = process.env.IMAGE_MODEL ?? "krea/krea-2-large";
export const FALLBACK_MODEL = MODEL_DEFAULT;

export interface OpenRouterMessage {
  role: "user" | "assistant" | "system";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
        | { type: "input_audio"; input_audio: { data: string; format: string } }
      >;
}

export function isSkalaTarget(model: string): boolean {
  return (
    model === MODEL_SKALA ||
    model.toLowerCase().includes("deepseek") ||
    model.toLowerCase().includes("skala")
  );
}

async function readSSEStream(response: Response, abortSignal?: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let contentText = "";
  let reasoningText = "";

  // Защита от вечного зависания: если между чанками проходит > 25с, прерываем чтение
  const readWithIdleTimeout = async (timeoutMs = 25_000): Promise<{ done: boolean; value?: Uint8Array }> => {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<{ done: boolean; value?: Uint8Array }>((_, reject) => {
      timer = setTimeout(() => reject(new Error("SSE stream idle timeout (сервер перестал слать данные)")), timeoutMs);
    });
    try {
      return await Promise.race([reader.read(), timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  };

  try {
    while (true) {
      if (abortSignal?.aborted) {
        throw new Error("Запрос отменён по общему таймауту");
      }
      const { done, value } = await readWithIdleTimeout(25_000);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (trimmed.startsWith("data: ")) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            const delta = json.choices?.[0]?.delta;
            if (typeof delta?.content === "string") {
              contentText += delta.content;
            }
            if (typeof delta?.reasoning_content === "string") {
              reasoningText += delta.reasoning_content;
            }
          } catch {}
        }
      }
    }

    if (buffer.trim().startsWith("data: ") && buffer.trim() !== "data: [DONE]") {
      try {
        const json = JSON.parse(buffer.trim().slice(6));
        const delta = json.choices?.[0]?.delta;
        if (typeof delta?.content === "string") {
          contentText += delta.content;
        }
        if (typeof delta?.reasoning_content === "string") {
          reasoningText += delta.reasoning_content;
        }
      } catch {}
    }
  } catch (streamErr: any) {
    // При прерывании или сбое стрима выбрасываем ошибку, чтобы сработал retry / fallback на другой сервис,
    // а не отправлялся обрубленный на полуслове JSON
    throw streamErr;
  }

  if (contentText.trim().length > 0) {
    return contentText;
  }

  return reasoningText;
}

/**
 * Send request to AI API (River AI for standard/utils, Yeta AI for skala)
 */
export async function openrouterRequest(
  messages: OpenRouterMessage[],
  model: string = MODEL_UTILS,
  options: {
    systemInstruction?: string;
    temperature?: number;
    maxTokens?: number;
    responseFormat?: { type: string };
    baseUrl?: string;
    apiKey?: string;
    isSkala?: boolean;
    stream?: boolean;
  } = {}
): Promise<string> {
  const isSkala = options.isSkala ?? isSkalaTarget(model);
  const targetBaseUrl = options.baseUrl ?? (isSkala ? YETA_BASE_URL : RIVER_BASE_URL);
  const targetApiKey = options.apiKey ?? (isSkala ? YETA_API_KEY : RIVER_API_KEY);

  if (!targetApiKey) {
    const keyName = isSkala ? "YETA_API_KEY (или RIVER_API_KEY)" : "RIVER_API_KEY";
    throw new Error(`API ключ не задан! Пожалуйста, укажите переменную окружения ${keyName}.`);
  }

  const finalMessages: OpenRouterMessage[] = [];

  if (options.systemInstruction) {
    finalMessages.push({ role: "system", content: options.systemInstruction });
  }
  finalMessages.push(...messages);

  // Для Yeta AI потолок токенов 16384 (во избежание Cloudflare 524 и сброса соединения ECONNRESET), для River AI 65536
  const defaultMaxTokens = isSkala ? 16384 : parseInt(process.env.MAX_TOKENS ?? "65536", 10);
  const useStream = options.stream ?? true; // Стриминг по умолчанию предотвращает тайм-аут Cloudflare 524

  const payload: Record<string, unknown> = {
    model,
    messages: finalMessages,
    stream: useStream,
  };
  if (options.maxTokens !== undefined) {
    payload.max_tokens = isSkala ? Math.min(options.maxTokens, 16384) : options.maxTokens;
  } else if (!isNaN(defaultMaxTokens) && defaultMaxTokens > 0) {
    payload.max_tokens = defaultMaxTokens;
  }

  if (options.temperature !== undefined) payload.temperature = options.temperature;
  if (options.responseFormat) payload.response_format = options.responseFormat;

  let lastFetchError: any = null;

  let currentBaseUrl = targetBaseUrl;
  let currentApiKey = targetApiKey;
  let currentModel = model;

  // Retry up to 3 times with automatic cross-provider fallback (River AI <-> Yeta AI)
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Если на предыдущей попытке произошел таймаут или сбой — переключаемся на резервный провайдер
    if (attempt >= 2) {
      if (currentBaseUrl === RIVER_BASE_URL && YETA_API_KEY) {
        console.warn(`[AI] River AI failed/aborted. Switching to fallback Yeta AI (DeepSeek) on attempt ${attempt}...`);
        currentBaseUrl = YETA_BASE_URL;
        currentApiKey = YETA_API_KEY;
        currentModel = MODEL_SKALA;
        payload.model = MODEL_SKALA;
        payload.max_tokens = Math.min(Number(payload.max_tokens) || 8192, 8192);
      } else if (currentBaseUrl === YETA_BASE_URL && RIVER_API_KEY) {
        console.warn(`[AI] Yeta AI failed/aborted. Switching to fallback River AI (GLM-5.3-Flash) on attempt ${attempt}...`);
        currentBaseUrl = RIVER_BASE_URL;
        currentApiKey = RIVER_API_KEY;
        currentModel = MODEL_DEFAULT;
        payload.model = MODEL_DEFAULT;
        payload.max_tokens = Math.min(Number(payload.max_tokens) || 8192, 8192);
      }
    }

    try {
      const controller = new AbortController();
      // Максимум 120 секунд на попытку генерации кода и стрима
      const timeout = setTimeout(() => controller.abort(), 120_000);
      let response: Response;

      try {
        response = await fetch(`${currentBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${currentApiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://discord.com",
            "X-Title": "SWAGAgpt Discord Bot",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

      if (!response.ok) {
        const errBody = await response.text();

        // Авто-повтор при Cloudflare 524 Timeout
        if (response.status === 524) {
          console.warn(`[AI] Cloudflare 524 timeout on ${targetBaseUrl}. Retrying with lower tokens...`);
          payload.stream = true;
          payload.max_tokens = 8192;
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
        }

        const isTokensError =
          (response.status === 400 || response.status === 422) &&
          (errBody.toLowerCase().includes("max_tokens") ||
            errBody.toLowerCase().includes("maximum") ||
            errBody.toLowerCase().includes("token") ||
            errBody.toLowerCase().includes("context") ||
            errBody.toLowerCase().includes("range"));

        // Auto-retry if max_tokens was too large for server limits
        if (isTokensError && typeof payload.max_tokens === "number" && payload.max_tokens > 4096) {
          const numMatch = errBody.match(/(?:<=|less than or equal to|maximum(?: of)?|limit is|at most|exceeds|between)\s*(\d+)/i);
          const safeLimit = numMatch && numMatch[1] ? parseInt(numMatch[1], 10) : 8192;
          console.warn(`[AI] max_tokens ${payload.max_tokens} rejected. Retrying with ${safeLimit}...`);
          payload.max_tokens = safeLimit;
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
        }

        // Fallback check if requested model is unavailable
        if (model !== FALLBACK_MODEL && !isSkala && (response.status === 404 || errBody.includes("not found"))) {
          console.warn(`[AI] Model ${model} unavailable (${response.status}), falling back to ${FALLBACK_MODEL}`);
          payload.model = FALLBACK_MODEL;
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
        }

        const status = response.status;
        const provider = isSkala ? "Yeta AI" : "River AI";

        // Авто-повтор при серверных сбоях 5xx или ошибках вышестоящего провайдера (upstream error)
        const isUpstreamError =
          (status >= 500 && status <= 504) ||
          errBody.includes("upstream error") ||
          errBody.includes("do_request_failed");

        if (isUpstreamError && attempt < 3) {
          console.warn(`[AI] ${provider} 5xx/upstream error on attempt ${attempt}/3 (${status}). Retrying in ${2 * attempt}s...`);
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }

        if (status === 524) {
          throw new Error(`${provider} таймаут (Cloudflare 524: сервер Yeta AI не ответил вовремя). Попробуйте повторить запрос.`);
        }

        if (isUpstreamError) {
          throw new Error(
            `Сервер ${provider} временно перегружен или перезагружает модель (upstream error: сбой воркера). Попробуйте повторить через 1-2 минуты или временно переключитесь на /mode стандартный.`
          );
        }

        const cleanError = errBody.startsWith("<!DOCTYPE") ? "Сервер вернул HTML страницу ошибки (возможно, перегружен)" : errBody;
        throw new Error(`${provider} API error (${status}): ${cleanError.slice(0, 300)}`);
      }

      // Успешный HTTP статус — читаем тело / стрим
      const contentType = response.headers.get("content-type") || "";
      let text = "";

      if (contentType.includes("text/event-stream") || payload.stream === true) {
        text = await readSSEStream(response, controller.signal);
      } else {
        const data = (await response.json()) as any;
        const choice = data.choices?.[0];
        const msg = choice?.message;

        if (typeof msg?.content === "string" && msg.content.trim()) {
          text = msg.content;
        } else if (typeof msg?.reasoning_content === "string" && msg.reasoning_content.trim()) {
          text = msg.reasoning_content;
        } else if (typeof choice?.text === "string" && choice.text.trim()) {
          text = choice.text;
        } else if (Array.isArray(msg?.content)) {
          text = msg.content.map((p: any) => p.text || "").join("");
        }
      }

      if (text && text.trim().length > 0) {
        return text;
      }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err: any) {
      lastFetchError = err;
      const errMsg = err?.message || String(err);
      const isReset = errMsg.includes("ECONNRESET") || errMsg.includes("terminated") || errMsg.includes("hang up");
      console.warn(`[AI] Attempt ${attempt}/3 failed (${targetBaseUrl}):`, errMsg);

      // При разрыве соединения снижаем токены для снижения нагрузки на воркер Yeta
      if (isReset && typeof payload.max_tokens === "number" && payload.max_tokens > 8192) {
        payload.max_tokens = Math.floor(payload.max_tokens * 0.75);
      }

      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }

  const provider = isSkala ? "Yeta AI" : "River AI";
  const causeMsg = lastFetchError?.cause?.message ? ` (${lastFetchError.cause.message})` : "";
  const baseMsg = lastFetchError?.message || "fetch failed";
  if (baseMsg.includes("ECONNRESET") || causeMsg.includes("ECONNRESET") || baseMsg.includes("terminated")) {
    throw new Error(`${provider} сбросил сетевое соединение (ECONNRESET / перегрузка воркера на сервере). Попробуйте повторить команду через минуту.`);
  }
  throw new Error(`${provider} недоступен (${targetBaseUrl}): ${baseMsg}${causeMsg}`);
}

/**
 * Primary text generation for utilities (uses River AI / zai-org/GLM-5.3-Flash)
 */
export async function geminiText(
  prompt: string,
  systemInstruction?: string,
  model: string = MODEL_UTILS
): Promise<string> {
  return openrouterRequest([{ role: "user", content: prompt }], model, { systemInstruction });
}

/**
 * Extract and parse JSON safely, handling ```json, outer braces, stripping <think>...</think>, and repairing truncated JSON
 */
export function extractAndParseJSON<T>(raw: string): T {
  if (!raw || !raw.trim()) {
    throw new Error("Нейросеть вернула пустой ответ. Попробуйте повторить запрос.");
  }

  // 1. Убираем блоки размышлений <think>...</think>
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // 2. Попытка распарсить текст напрямую (если модель выдала чистый JSON)
  try {
    return JSON.parse(text) as T;
  } catch {}
  try {
    return JSON.parse(jsonrepair(text)) as T;
  } catch {}

  const sanitizeCandidate = (str: string): string => {
    return str
      .replace(/\t/g, "  ")
      .replace(/([,:{}\[\]])\s*\\n\s*/g, "$1\n");
  };

  const tryParse = (candidate: string): T | null => {
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as T;
    } catch {}
    try {
      return JSON.parse(jsonrepair(trimmed)) as T;
    } catch {}
    const sanitized = sanitizeCandidate(trimmed);
    try {
      return JSON.parse(sanitized) as T;
    } catch {}
    try {
      return JSON.parse(jsonrepair(sanitized)) as T;
    } catch {}
    return null;
  };

  // 3. Поиск блоков ```json ... ``` или ``` ... ```
  // ВАЖНО: Закрывающие ``` ищем С КОНЦА (lastIndexOf), так как внутри строковых значений JSON (например, README.md)
  // почти всегда есть внутренние блоки ```bash, ```python и т.д.
  const jsonBlockMatches = [...text.matchAll(/```(?:json)?\s*(\{[\s\S]*)/gi)];
  for (let i = jsonBlockMatches.length - 1; i >= 0; i--) {
    const match = jsonBlockMatches[i];
    let candidate = match[1].trim();
    const lastFence = candidate.lastIndexOf("```");
    if (lastFence !== -1) {
      candidate = candidate.substring(0, lastFence).trim();
    }
    const lastBrace = candidate.lastIndexOf("}");
    if (lastBrace !== -1) {
      candidate = candidate.substring(0, lastBrace + 1).trim();
    }
    const res = tryParse(candidate);
    if (res !== null) return res;
  }

  // 4. Поиск внешних фигурных скобок { ... } (перебираем '{' слева направо до последней '}')
  const lastBrace = text.lastIndexOf("}");
  if (lastBrace !== -1) {
    let searchIdx = 0;
    while (searchIdx < lastBrace) {
      const braceIdx = text.indexOf("{", searchIdx);
      if (braceIdx === -1 || braceIdx >= lastBrace) break;
      const candidate = text.substring(braceIdx, lastBrace + 1).trim();
      const res = tryParse(candidate);
      if (res !== null) return res;
      searchIdx = braceIdx + 1;
    }
  }

  // 5. Поиск массива [ ... ]
  const lastBracket = text.lastIndexOf("]");
  if (lastBracket !== -1) {
    let searchIdx = 0;
    while (searchIdx < lastBracket) {
      const bracketIdx = text.indexOf("[", searchIdx);
      if (bracketIdx === -1 || bracketIdx >= lastBracket) break;
      const candidate = text.substring(bracketIdx, lastBracket + 1).trim();
      const res = tryParse(candidate);
      if (res !== null) return res;
      searchIdx = bracketIdx + 1;
    }
  }

  // Финальная попытка выбросит точную ошибку
  try {
    return JSON.parse(text) as T;
  } catch (err: any) {
    console.error("[JSON Parse Error]. Raw response was:\n", raw.slice(0, 1000));
    throw new Error(`Ошибка парсинга JSON: ${err.message}`);
  }
}

/**
 * JSON response helper for utilities, games and coder
 */
export async function geminiJSON<T>(
  prompt: string,
  model: string = MODEL_UTILS,
  options: { maxTokens?: number; systemInstruction?: string } = {}
): Promise<T> {
  const maxTokens = options.maxTokens ?? parseInt(process.env.MAX_TOKENS ?? "100000", 10);
  const raw = await openrouterRequest(
    [{ role: "user", content: prompt + "\n\nОтветь ТОЛЬКО валидным JSON-объектом." }],
    model,
    {
      maxTokens,
      systemInstruction: options.systemInstruction,
    }
  );
  return extractAndParseJSON<T>(raw);
}

/**
 * Multi-turn chat generation
 */
export async function openrouterChat(
  messages: OpenRouterMessage[],
  systemInstruction?: string,
  model: string = MODEL_CHAT
): Promise<string> {
  return openrouterRequest(messages, model, { systemInstruction });
}

/**
 * Extract image URL or Base64 from model text response or choices
 */
async function fetchImageFromResponse(
  content: string,
  rawChoices?: any[]
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (rawChoices && Array.isArray(rawChoices)) {
    for (const choice of rawChoices) {
      if (choice.message?.images && Array.isArray(choice.message.images)) {
        for (const img of choice.message.images) {
          const url = typeof img === "string" ? img : img.url;
          if (url) return fetchImageFromUrl(url);
        }
      }
    }
  }

  const urlMatch =
    content.match(/https?:\/\/[^\s\)\"]+\.(?:png|jpg|jpeg|webp|gif)/i) ??
    content.match(/https?:\/\/[^\s\)\"]+/i);

  if (urlMatch) {
    const fetched = await fetchImageFromUrl(urlMatch[0]);
    if (fetched) return fetched;
  }

  const dataUriMatch = content.match(/data:(image\/[a-zA-Z+]+);base64,([A-Za-z0-9+/=]+)/);
  if (dataUriMatch) {
    return {
      mimeType: dataUriMatch[1]!,
      buffer: Buffer.from(dataUriMatch[2]!, "base64"),
    };
  }

  return null;
}

async function fetchImageFromUrl(url: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    const contentType = res.headers.get("content-type") ?? "image/png";
    return {
      buffer: Buffer.from(arrayBuf),
      mimeType: contentType.split(";")[0]!,
    };
  } catch (err) {
    console.error("[Image] Failed to fetch image URL:", err);
    return null;
  }
}

export interface ImagePromptResult {
  allowed: boolean;
  enhancedPrompt: string;
  reason?: string;
  rejectionReason?: string;
  originalPrompt: string;
}

// Закодированный список маркеров нежелательного контента (NSFW / 18+ / нецензурная лексика)
const MODERATION_PATTERNS_B64 = [
  "0L/QuNGB0Y4=", // pis-yu
  "0L/QuNGB0LXRhw==", // pis-ech
  "0L/QuNGB0YzQug==", // pis-k
  "0YfQu9C10L0=", // ch-len
  "0L/QtdC90LjRgQ==", // pe-nis
  "0YXRg9C5", // khu-y
  "0YXRg9GP", // khu-ya
  "0YXRg9C1", // khu-ye
  "0LLQsNCz0LjQvQ==", // vag-in
  "0L/QuNC30LQ=", // piz-d
  "0LTQuNC70YzQtA==", // dil-do
  "0L/QvtGA0L3Qvg==", // por-no
  "0YXQtdC90YLQsNC5", // hen-tai
  "0YHQtdC60YE=", // se-ks
  "0YLRgNCw0YU=", // tra-kh
  "0LXQsdC7", // ye-bl
  "0LzQuNC90LXRgg==", // mi-net
  "0LTRgNC+0Yc=", // dro-ch
  "0YjQu9GO0YU=", // shlyu-kh
  "0L/QtdC00L7RhNC40Ls=", // ped-ofil
  "0YDQsNGB0YfQu9C10L0=", // ras-chlen
  "0LPRg9GA0L4=", // gu-ro
  "0YHRg9C40YbQuNC0", // sui-tsid
  "bnNmdw==", // n-s-f-w
  "bnVkZQ==", // nu-de
  "bmFrZWQ=", // na-ked
  "cG9ybg==", // po-rn
  "aGVudGFp", // hen-tai
  "Y29jaw==", // co-ck
  "ZGljaw==", // di-ck
  "cGVuaXM=", // pe-nis
  "dmFnaW5h", // vag-ina
  "cHVzc3k=", // pus-sy
  "Ym9vYnM=", // boo-bs
  "dGl0cw==", // ti-ts
  "Ymxvd2pvYg==", // blow-job
  "Z29yZQ==", // go-re
];

const MODERATION_KEYWORDS = MODERATION_PATTERNS_B64.map((b) =>
  Buffer.from(b, "base64").toString("utf-8")
);

/**
 * Быстрый фильтр очевидного NSFW, нежелательной лексики и запрещённого контента
 */
function checkQuickModeration(text: string): boolean {
  // Нормализация схожих латинских символов и цифр в кириллицу
  const normalized = text
    .toLowerCase()
    .replace(/@/g, "а")
    .replace(/0/g, "о")
    .replace(/1/g, "и")
    .replace(/3/g, "з")
    .replace(/4/g, "ч")
    .replace(/u/g, "и")
    .replace(/y/g, "у")
    .replace(/e/g, "е")
    .replace(/a/g, "а")
    .replace(/o/g, "о")
    .replace(/p/g, "р")
    .replace(/c/g, "с")
    .replace(/x/g, "х")
    .replace(/b/g, "б")
    .replace(/k/g, "к")
    .replace(/m/g, "м")
    .replace(/t/g, "т")
    .replace(/[\s\-_.,!?:;*()]+/g, " ");

  return MODERATION_KEYWORDS.some((kw) => normalized.includes(kw));
}

function cleanBasicPrompt(text: string): string {
  return (
    text
      .replace(/^(?:нарисуй|создай|сгенерируй|сделай)\s+(?:мне\s+)?(?:картинку|изображение|фото|арт)?\s*/i, "")
      .trim() || text
  );
}

const IMAGE_PROMPT_INSTRUCTION = `Ты — эксперт-модератор и арт-директор (промпт-инженер) для генератора изображений Flux.1 / SDXL.
Твоя задача — проверить запрос пользователя на безопасность и, если он безопасен, составить детальный художественный промпт на английском языке для генерации красивого изображения.

ПРАВИЛО 1: МОДЕРАЦИЯ И БЕЗОПАСНОСТЬ (NSFW / ЗАПРЕЩЁННЫЙ КОНТЕНТ):
Ты ОБЯЗАН отклонить запрос (allowed = false), если в нём присутствует:
- Любой эротический или 18+ контент, интимные части тела, нагота, порнография, сексуальные намёки, нецензурная брань.
- Жестокость, насилие, кровь, самоповреждение.
- Эксплуатация несовершеннолетних — абсолютный запрет.
- Разжигание ненависти, экстремизм, враждебные высказывания.

Если запрос нарушает правила безопасности:
{
  "allowed": false,
  "reason": "❌ Я не могу нарисовать такое изображение. Запросы с откровенным, сексуальным (18+) или запрещённым контентом отклоняются правилами безопасности Discord. Попробуй придумать другой сюжет!",
  "enhancedPrompt": ""
}

ПРАВИЛО 2: ЕСЛИ ЗАПРОС БЕЗОПАСЕН (allowed = true):
- Переведи запрос на английский язык.
- Очисти его от вводных слов пользователя ("нарисуй", "сгенерируй", "draw", "make an image").
- Обогати деталями для генератора изображений Flux (Prompt Expansion):
  - Главный объект/персонаж, его поза, ракурс, фактура, детали.
  - Окружение, фон, задний план.
  - Освещение и атмосфера (например: cinematic lighting, soft shadows, volumetric rays, neon glow, golden hour).
  - Художественный стиль (если указан anime, photorealistic, cyberpunk, fantasy, oil painting — строго соблюдай его; если не указан — сделай качественный атмосферный кинематографичный арт).
  - Качественные дескрипторы: "detailed, 8k resolution, masterpiece, intricate composition".
- Длина enhancedPrompt: 2-4 предложения на английском языке.

{
  "allowed": true,
  "reason": "",
  "enhancedPrompt": "<детальный промпт на английском языке>"
}

Отвечай СТРОГО валидным JSON-объектом без лишнего текста.`;

/**
 * Подготовка промпта для генерации: проверка на запретки и обогащение деталями через ИИ
 */
export async function prepareImagePrompt(userPrompt: string): Promise<ImagePromptResult> {
  const trimmed = userPrompt.trim();
  if (!trimmed) {
    const reason = "❌ Промпт не может быть пустым. Опиши, что ты хочешь нарисовать!";
    return {
      allowed: false,
      reason,
      rejectionReason: reason,
      enhancedPrompt: "",
      originalPrompt: userPrompt,
    };
  }

  // Быстрый локальный фильтр очевидных запреток
  if (checkQuickModeration(trimmed)) {
    const reason =
      "❌ Я не могу нарисовать такое изображение. Запросы с откровенным, сексуальным (18+) или запрещённым контентом отклоняются правилами безопасности Discord. Попробуй придумать другой сюжет!";
    return {
      allowed: false,
      reason,
      rejectionReason: reason,
      enhancedPrompt: "",
      originalPrompt: userPrompt,
    };
  }

  try {
    const response = await geminiJSON<{ allowed?: boolean; reason?: string; enhancedPrompt?: string }>(
      `Запрос пользователя на изображение:\n"${trimmed}"`,
      MODEL_UTILS,
      {
        systemInstruction: IMAGE_PROMPT_INSTRUCTION,
        maxTokens: 600,
      }
    );

    if (response.allowed === false) {
      const reason =
        response.reason ||
        "❌ Запрос отклонён модерацией по правилам безопасности Discord. Попробуй изменить описание!";
      return {
        allowed: false,
        reason,
        rejectionReason: reason,
        enhancedPrompt: "",
        originalPrompt: userPrompt,
      };
    }

    const enhanced = response.enhancedPrompt?.trim() || cleanBasicPrompt(trimmed);
    return {
      allowed: true,
      enhancedPrompt: enhanced,
      originalPrompt: userPrompt,
    };
  } catch (err) {
    console.warn("[prepareImagePrompt] Model prompt expansion failed, falling back to basic prompt:", err);
    return {
      allowed: true,
      enhancedPrompt: cleanBasicPrompt(trimmed),
      originalPrompt: userPrompt,
    };
  }
}

/**
 * Image generation
 */
export async function geminiGenerateImage(
  prompt: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    let finalPrompt = prompt.trim();
    // Защитный слой: если промпт содержит русские буквы или не был обработан
    if (/[а-яё]/i.test(finalPrompt)) {
      const check = await prepareImagePrompt(finalPrompt);
      if (!check.allowed) {
        console.warn("[Image] Prompt rejected by safety filter:", finalPrompt);
        return null;
      }
      finalPrompt = check.enhancedPrompt;
    }

    const targetUrl = IMAGE_BASE_URL;
    const targetKey = IMAGE_API_KEY;

    if (targetKey) {
      try {
        const response = await fetch(`${targetUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${targetKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://discord.com",
            "X-Title": "SWAGAgpt Discord Bot",
          },
          body: JSON.stringify({
            model: MODEL_IMAGE,
            messages: [{ role: "user", content: finalPrompt }],
            modalities: ["image", "text"],
          }),
        });

        if (response.ok) {
          const data = (await response.json()) as any;
          const content = data.choices?.[0]?.message?.content ?? "";
          const parsed = await fetchImageFromResponse(content, data.choices);
          if (parsed) return parsed;
        }

        const imgResponse = await fetch(`${targetUrl}/images/generations`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${targetKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: MODEL_IMAGE,
            prompt: finalPrompt,
            n: 1,
          }),
        });

        if (imgResponse.ok) {
          const imgData = (await imgResponse.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
          const item = imgData.data?.[0];
          if (item?.url) {
            return fetchImageFromUrl(item.url);
          } else if (item?.b64_json) {
            return {
              buffer: Buffer.from(item.b64_json, "base64"),
              mimeType: "image/png",
            };
          }
        }
      } catch (primaryErr) {
        console.warn("[Image] Primary image API failed, falling back to Flux:", primaryErr);
      }
    }

    // ─── Резервный генератор FLUX (Pollinations AI — быстрый качественный GPU-инференс) ───
    try {
      const encodedPrompt = encodeURIComponent(finalPrompt.slice(0, 1000));
      const fluxUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?model=flux&width=1024&height=1024&nologo=true`;
      const fluxRes = await fetch(fluxUrl, { signal: AbortSignal.timeout(35_000) });
      if (fluxRes.ok) {
        const arrayBuf = await fluxRes.arrayBuffer();
        const contentType = fluxRes.headers.get("content-type") ?? "image/jpeg";
        return {
          buffer: Buffer.from(arrayBuf),
          mimeType: contentType.split(";")[0]!,
        };
      }
    } catch (pollErr) {
      console.warn("[Image] Pollinations Flux fallback failed:", pollErr);
    }

    return null;
  } catch (error) {
    console.error("[Image] Image generation error:", error);
    return null;
  }
}

/**
 * Image editing
 */
export async function geminiEditImage(
  imageData: string,
  imageMimeType: string,
  prompt: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const targetUrl = IMAGE_BASE_URL;
    const targetKey = IMAGE_API_KEY;
    if (!targetKey) return null;

    const dataUrl = `data:${imageMimeType};base64,${imageData}`;
    const response = await fetch(`${targetUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${targetKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://discord.com",
        "X-Title": "SWAGAgpt Discord Bot",
      },
      body: JSON.stringify({
        model: MODEL_IMAGE,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        modalities: ["image", "text"],
      }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content ?? "";
    return fetchImageFromResponse(content, data.choices);
  } catch (error) {
    console.error("[Image] Image editing error:", error);
    return null;
  }
}

export const ai = {
  models: {
    generateContent: async (args: any) => {
      const prompt =
        typeof args.contents === "string"
          ? args.contents
          : JSON.stringify(args.contents);
      const text = await geminiText(prompt, args.config?.systemInstruction);
      return { text };
    },
  },
};

export type Part = any;
