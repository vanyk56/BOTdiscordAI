export interface GitHubRepoInfo {
  owner: string;
  repo: string;
}

export interface GitHubRepoContext {
  owner: string;
  repo: string;
  defaultBranch: string;
  description: string;
  fileList: string[];
  context: string;
}

/**
 * Извлекает владельца и название репозитория из строки или URL
 */
export function parseGitHubRepo(text: string): GitHubRepoInfo | null {
  if (!text) return null;

  // 1. Прямая ссылка: https://github.com/owner/repo (с возможными ветками или .git)
  const urlMatch = text.match(
    /(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\/tree\/[^\s]+|\/blob\/[^\s]+|\.git|\/|\s|$|[)\]"',])/i
  );
  if (urlMatch && urlMatch[1] && urlMatch[2]) {
    const owner = urlMatch[1].trim();
    const repo = urlMatch[2].replace(/\.git$/i, "").trim();
    if (owner && repo && owner.toLowerCase() !== "topics" && owner.toLowerCase() !== "trending") {
      return { owner, repo };
    }
  }

  // 2. Формат owner/repo (если не содержит пробелов и двоеточий)
  const shortMatch = text.trim().match(/^([a-zA-Z0-9_-]{2,40})\/([a-zA-Z0-9_.-]{2,50})$/);
  if (shortMatch && shortMatch[1] && shortMatch[2] && !shortMatch[1].includes(".")) {
    return { owner: shortMatch[1], repo: shortMatch[2].replace(/\.git$/i, "") };
  }

  return null;
}

const IGNORED_DIRS = [
  "node_modules", ".git", "venv", ".venv", "env", ".env", "dist", "build",
  "__pycache__", ".next", ".cache", "coverage", ".idea", ".vscode", "vendor",
  "bin", "obj", ".turbo", ".nuxt", "target"
];

const IGNORED_EXTS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".flac",
  ".zip", ".tar", ".gz", ".7z", ".rar", ".bz2",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".iso",
  ".sqlite", ".db", ".sqlite3", ".pyc", ".class", ".wasm",
  ".woff", ".woff2", ".ttf", ".eot", ".lock"
];

function getFilePriority(path: string): number {
  const lower = path.toLowerCase();
  const name = lower.split("/").pop() || "";

  if (name === "readme.md" || name === "readme") return 100;
  if (name === "package.json" || name === "requirements.txt" || name === "pyproject.toml" || name === "go.mod" || name === "cargo.toml") return 95;
  if (name.startsWith(".env.example") || name === "dockerfile" || name === "docker-compose.yml" || name === "discloud.config") return 90;
  if (name === "main.py" || name === "index.ts" || name === "index.js" || name === "app.py" || name === "server.js" || name === "bot.py") return 85;
  if (lower.startsWith("src/") || lower.startsWith("lib/")) return 75;
  if (lower.endsWith(".ts") || lower.endsWith(".py") || lower.endsWith(".js") || lower.endsWith(".html") || lower.endsWith(".css")) return 70;
  return 50;
}

/**
 * Загружает структуру и ключевые файлы репозитория GitHub
 */
export async function fetchGitHubRepoContext(
  owner: string,
  repo: string,
  token?: string
): Promise<GitHubRepoContext | null> {
  const headers: Record<string, string> = {
    "User-Agent": "SWAGAgpt-Discord-Bot",
    "Accept": "application/vnd.github.v3+json",
  };
  const activeToken = token || process.env.GITHUB_TOKEN || "";
  if (activeToken) {
    headers["Authorization"] = `Bearer ${activeToken}`;
  }

  try {
    // 1. Метаданные репозитория
    let defaultBranch = "main";
    let description = "";
    try {
      const infoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (infoRes.ok) {
        const info = (await infoRes.json()) as any;
        defaultBranch = info.default_branch || "main";
        description = info.description || "";
      }
    } catch {}

    // 2. Дерево файлов
    let tree: Array<{ path: string; type: string; size?: number }> = [];
    for (const branch of [defaultBranch, "main", "master"]) {
      try {
        const treeRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
          { headers, signal: AbortSignal.timeout(15_000) }
        );
        if (treeRes.ok) {
          const data = (await treeRes.json()) as any;
          if (Array.isArray(data.tree)) {
            tree = data.tree;
            defaultBranch = branch;
            break;
          }
        }
      } catch {}
    }

    if (tree.length === 0) {
      return null;
    }

    // 3. Фильтрация и выбор файлов
    const sourceFiles = tree.filter((item) => {
      if (item.type !== "blob") return false;
      const parts = item.path.split("/");
      if (parts.some((p) => IGNORED_DIRS.includes(p.toLowerCase()))) return false;
      const ext = "." + item.path.split(".").pop()?.toLowerCase();
      if (IGNORED_EXTS.includes(ext)) return false;
      if (item.size && item.size > 250_000) return false; // Пропускаем файлы > 250КБ
      return true;
    });

    sourceFiles.sort((a, b) => getFilePriority(b.path) - getFilePriority(a.path));

    const selectedFiles: Array<{ path: string; content: string }> = [];
    let totalChars = 0;
    const MAX_TOTAL_CHARS = 35_000;

    // Скачиваем до 18 наиболее приоритетных файлов
    for (const file of sourceFiles.slice(0, 18)) {
      if (totalChars >= MAX_TOTAL_CHARS) break;
      try {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${file.path}`;
        const fileRes = await fetch(rawUrl, {
          headers: activeToken ? { Authorization: `Bearer ${activeToken}` } : {},
          signal: AbortSignal.timeout(8_000),
        });
        if (fileRes.ok) {
          let content = await fileRes.text();
          if (content.length > 8000) {
            content = content.slice(0, 8000) + "\n... [файл обрезан из-за объёма]";
          }
          selectedFiles.push({ path: file.path, content });
          totalChars += content.length;
        }
      } catch {}
    }

    // 4. Формирование контекста для нейросети
    const structureList = sourceFiles
      .slice(0, 35)
      .map((f) => `• ${f.path}`)
      .join("\n");
    const moreCount = sourceFiles.length > 35 ? `\n... и ещё ${sourceFiles.length - 35} файлов` : "";

    let context = `=== ИСХОДНЫЙ РЕПОЗИТОРИЙ GITHUB (https://github.com/${owner}/${repo}) ===\n`;
    if (description) context += `Описание репозитория: ${description}\n`;
    context += `Ветка по умолчанию: ${defaultBranch}\n\n`;
    context += `СТРУКТУРА ФАЙЛОВ:\n${structureList}${moreCount}\n\n`;
    context += `СОДЕРЖИМОЕ КЛЮЧЕВЫХ ФАЙЛОВ РЕПОЗИТОРИЯ:\n`;

    for (const f of selectedFiles) {
      context += `\n--- ФАЙЛ: ${f.path} ---\n${f.content}\n`;
    }
    context += `=== КОНЕЦ КОНТЕКСТА РЕПОЗИТОРИЯ ===\n`;

    return {
      owner,
      repo,
      defaultBranch,
      description,
      fileList: sourceFiles.map((f) => f.path),
      context,
    };
  } catch (err) {
    console.error(`[GitHub Context] Error fetching ${owner}/${repo}:`, err);
    return null;
  }
}
