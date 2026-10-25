// ─── AI API INTEGRATION (RIVER AI & YETA AI) ───────────────────────────────────

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

  const defaultMaxTokens = parseInt(process.env.MAX_TOKENS ?? "100000", 10);
  const payload: Record<string, unknown> = {
    model,
    messages: finalMessages,
    max_tokens: options.maxTokens ?? defaultMaxTokens,
  };

  if (options.temperature !== undefined) payload.temperature = options.temperature;
  if (options.responseFormat) payload.response_format = options.responseFormat;

  let response = await fetch(`${targetBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${targetApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://discord.com",
      "X-Title": "SWAGAgpt Discord Bot",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errBody = await response.text();
    const isTokensError =
      (response.status === 400 || response.status === 422) &&
      (errBody.toLowerCase().includes("max_tokens") ||
        errBody.toLowerCase().includes("maximum") ||
        errBody.toLowerCase().includes("token") ||
        errBody.toLowerCase().includes("context"));

    // Auto-retry if max_tokens was too large for server limits
    if (isTokensError && typeof payload.max_tokens === "number" && payload.max_tokens > 4096) {
      const numMatch = errBody.match(/(?:less than or equal to|maximum(?: of)?|limit is|at most|exceeds)\s*(\d+)/i);
      const safeLimit = numMatch && numMatch[1] ? parseInt(numMatch[1], 10) : 16384;
      console.warn(`[AI] max_tokens ${payload.max_tokens} rejected. Retrying with ${safeLimit}...`);
      payload.max_tokens = safeLimit;
      response = await fetch(`${targetBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${targetApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://discord.com",
          "X-Title": "SWAGAgpt Discord Bot",
        },
        body: JSON.stringify(payload),
      });
    }

    // Fallback check if requested model is unavailable
    if (!response.ok && model !== FALLBACK_MODEL && !isSkala) {
      if (response.status === 404 || errBody.includes("not found")) {
        console.warn(`[AI] Model ${model} unavailable (${response.status}), falling back to ${FALLBACK_MODEL}`);
        payload.model = FALLBACK_MODEL;
        response = await fetch(`${targetBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${targetApiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://discord.com",
            "X-Title": "SWAGAgpt Discord Bot",
          },
          body: JSON.stringify(payload),
        });
      } else {
        const provider = isSkala ? "Yeta AI" : "River AI";
        throw new Error(`${provider} API error (${response.status}): ${errBody.slice(0, 300)}`);
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      const provider = isSkala ? "Yeta AI" : "River AI";
      throw new Error(`${provider} API error (${response.status}): ${errorText.slice(0, 300)}`);
    }
  }

  const data = (await response.json()) as any;
  const choice = data.choices?.[0];
  const msg = choice?.message;
  let text = "";

  if (typeof msg?.content === "string" && msg.content.trim()) {
    text = msg.content;
  } else if (typeof msg?.reasoning_content === "string" && msg.reasoning_content.trim()) {
    text = msg.reasoning_content;
  } else if (typeof choice?.text === "string" && choice.text.trim()) {
    text = choice.text;
  } else if (Array.isArray(msg?.content)) {
    text = msg.content.map((p: any) => p.text || "").join("");
  }

  return text;
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
 * Extract and parse JSON safely, stripping <think>...</think> and markdown code blocks
 */
export function extractAndParseJSON<T>(raw: string): T {
  if (!raw || !raw.trim()) {
    throw new Error("Нейросеть вернула пустой ответ. Попробуйте повторить запрос.");
  }

  // 1. Убираем блоки размышлений <think>...</think>
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // 2. Ищем блок кода ```json ... ``` или ``` ... ```
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlock && codeBlock[1]) {
    text = codeBlock[1].trim();
  } else {
    // 3. Если блоков нет, ищем границы первого { и последнего }
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      text = text.substring(firstBrace, lastBrace + 1).trim();
    }
  }

  try {
    return JSON.parse(text) as T;
  } catch (err: any) {
    console.error("[JSON Parse Error]. Raw response was:\n", raw.slice(0, 500));
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
    [{ role: "user", content: prompt + "\n\nОтветь ТОЛЬКО валидным JSON без лишнего текста и без markdown." }],
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

/**
 * Image generation
 */
export async function geminiGenerateImage(
  prompt: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const targetUrl = IMAGE_BASE_URL;
    const targetKey = IMAGE_API_KEY;
    if (!targetKey) {
      console.warn("[Image] No IMAGE_API_KEY or RIVER_API_KEY set for image generation.");
      return null;
    }

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
        messages: [{ role: "user", content: prompt }],
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
        prompt: prompt,
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
