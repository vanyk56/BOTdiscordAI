import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { geminiJSON } from "./ai.js";
import { Sandbox } from "novita-sandbox";
import AdmZip from "adm-zip";

interface GeneratedProject {
  projectName: string;
  description: string;
  entrypoint: string;
  requirements?: string;
  files: Record<string, string>;
}

async function createGitHubRepo(token: string, repoName: string, description: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "SWAGAgpt-Discord-Bot",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: repoName,
        description: description.slice(0, 300),
        private: false,
        auto_init: true,
      }),
    });
    return res.ok || res.status === 422; // 422 means repo already exists
  } catch (err) {
    console.error("[GitHub API] Error creating repo:", err);
    return false;
  }
}

async function uploadFilesToGitHub(
  token: string,
  owner: string,
  repo: string,
  files: Record<string, string>
): Promise<boolean> {
  try {
    for (const [filePath, content] of Object.entries(files)) {
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
      let sha: string | undefined;
      try {
        const getRes = await fetch(url, {
          headers: {
            "Authorization": `Bearer ${token}`,
            "User-Agent": "SWAGAgpt-Discord-Bot",
          },
        });
        if (getRes.ok) {
          const info = (await getRes.json()) as any;
          sha = info.sha;
        }
      } catch {}

      await fetch(url, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "SWAGAgpt-Discord-Bot",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `Add ${filePath} via AI Agent`,
          content: Buffer.from(content).toString("base64"),
          ...(sha ? { sha } : {}),
        }),
      });
    }
    return true;
  } catch (err) {
    console.error("[GitHub API] uploadFiles error:", err);
    return false;
  }
}

export async function handleCoder(interaction: ChatInputCommandInteraction): Promise<void> {
  const task = interaction.options.getString("задача", true);
  const customRepo = interaction.options.getString("репозиторий", false);

  await interaction.deferReply();

  try {
    // ─── ШАГ 1: Проектирование кода через River AI (GLM-5.3-Flash) ────────────
    await interaction.editReply("⏳ **[1/5] Архитектор проектирует код...** (River AI: GLM-5.3-Flash)");

    const systemPrompt = `Ты — Senior Software Engineer и DevOps. Создай полный, рабочий и готовый к запуску проект по ТЗ пользователя.
Ответь СТРОГО валидным JSON-объектом в блоке \`\`\`json ... \`\`\`.
Пиши сразу JSON, без лишних размышлений, без приветствий и без текста вне JSON:
{
  "projectName": "latinskoe_nazvanie_cherez_defis",
  "description": "Краткое описание проекта на русском (1-2 предложения)",
  "entrypoint": "main.py",
  "requirements": "библиотеки для pip install через пробел (или пустая строка)",
  "files": {
    "main.py": "рабочий код файла",
    "requirements.txt": "библиотеки",
    "README.md": "# Описание"
  }
}`;

    let project: GeneratedProject;
    try {
      project = await geminiJSON<GeneratedProject>(
        `ТЗ ПОЛЬЗОВАТЕЛЯ:\n${task}`,
        undefined,
        {
          systemInstruction: systemPrompt,
          maxTokens: 100000,
        }
      );
    } catch (llmErr: any) {
      console.error("[River AI Code Generation Error]:", llmErr);
      const causeMsg = llmErr?.cause?.message ? ` (${llmErr.cause.message})` : "";
      await interaction.editReply(`❌ **Ошибка на этапе проектирования (River AI):** ${llmErr?.message || "ошибка запроса"}${causeMsg}`);
      return;
    }

    if (!project || !project.files || Object.keys(project.files).length === 0) {
      await interaction.editReply("❌ **Нейросеть вернула пустую структуру файлов.** Попробуйте уточнить запрос.");
      return;
    }

    const repoName = (customRepo || project.projectName || "ai-agent-project")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-");

    // ─── ШАГ 2: Запуск Ubuntu MicroVM в Novita Sandbox (если доступен) ────────
    await interaction.editReply("⚡ **[2/5] Подключаю виртуальную машину Ubuntu...** (Novita Agent Sandbox)");

    const novitaKey = (process.env.NOVITA_API_KEY || "").trim();
    let sbx: Sandbox | null = null;
    let sandboxStatusText = "";
    let autoFixed = false;
    let testOutput = "";

    if (novitaKey) {
      try {
        sbx = await Sandbox.create({
          apiKey: novitaKey,
          timeoutMs: 180_000,
          requestTimeoutMs: 30_000,
        });
      } catch (sbxErr: any) {
        console.warn("[Novita Sandbox Init Warning]:", sbxErr?.message || sbxErr);
        const cause = sbxErr?.cause?.message ? ` (${sbxErr.cause.message})` : "";
        sandboxStatusText = `⚠️ Виртуальная машина Novita временно недоступна (${sbxErr?.message || "сеть"}${cause}). Проект сгенерирован и упакован автономно.`;
      }
    } else {
      sandboxStatusText = "ℹ️ Переменная NOVITA_API_KEY не задана на Railway. Проект сгенерирован и упакован автономно.";
    }

    const workdir = "/home/user/app";

    if (sbx) {
      try {
        // ─── ШАГ 3: Запись файлов и установка библиотек в MicroVM ──────────────
        await interaction.editReply("📁 **[3/5] Записываю файлы и устанавливаю зависимости...**");

        await sbx.commands.run(`mkdir -p ${workdir}`);

        for (const [filePath, content] of Object.entries(project.files)) {
          await sbx.files.write(`${workdir}/${filePath}`, content);
        }

        if (project.requirements && project.requirements.trim()) {
          await sbx.commands.run(`pip install ${project.requirements}`, {
            cwd: workdir,
            timeoutMs: 60_000,
          });
        } else if (project.files["requirements.txt"]) {
          await sbx.commands.run("pip install -r requirements.txt", {
            cwd: workdir,
            timeoutMs: 60_000,
          });
        }

        // ─── ШАГ 4: Тестирование запуска кода ──────────────────────────────────
        await interaction.editReply("🧪 **[4/5] Тестирую запуск программы в Linux...**");

        const entry = project.entrypoint || "main.py";
        let runRes = await sbx.commands.run(`timeout 10s python3 ${entry}`, {
          cwd: workdir,
          timeoutMs: 20_000,
        });

        // Если упало с ошибкой (exit code не 0 и не 124 от timeout)
        if (runRes.exitCode !== 0 && runRes.exitCode !== 124 && runRes.stderr) {
          await interaction.editReply("🛠️ **[4/5] Найдена ошибка в коде! River AI исправляет баг...**");

          const fixPrompt = `Ты Senior Python Developer. Скрипт упал с ошибкой в Linux.
Файл: ${entry}
Код файла:
${project.files[entry]}

Ошибка из терминала:
${runRes.stderr}

Исправь ошибку. Ответь ТОЛЬКО валидным JSON:
{
  "fixedCode": "полный исправленный код файла без markdown"
}`;

          try {
            const fixResult = await geminiJSON<{ fixedCode: string }>(fixPrompt);
            if (fixResult?.fixedCode) {
              project.files[entry] = fixResult.fixedCode;
              await sbx.files.write(`${workdir}/${entry}`, fixResult.fixedCode);
              runRes = await sbx.commands.run(`timeout 10s python3 ${entry}`, {
                cwd: workdir,
                timeoutMs: 20_000,
              });
              autoFixed = true;
            }
          } catch (fixErr) {
            console.error("[Coder auto-fix error]:", fixErr);
          }
        }

        testOutput = runRes.stdout || runRes.stderr || "Скрипт успешно запущен без ошибок.";
        sandboxStatusText = `Статус: **${runRes.exitCode === 0 || runRes.exitCode === 124 ? "✅ Успешно" : "⚠️ Завершён с кодом " + runRes.exitCode}**${autoFixed ? " *(Баг автоматически исправлен ИИ!)*" : ""}\n\`\`\`bash\n${testOutput.slice(0, 400)}\n\`\`\``;
      } catch (vmRunErr: any) {
        console.error("[VM Execution Error]:", vmRunErr);
        sandboxStatusText = `⚠️ Ошибка выполнения внутри ВМ: ${vmRunErr?.message || "сбой"}. Проект скомпонован автономно.`;
      } finally {
        await sbx.kill().catch(() => {});
      }
    }

    // ─── ШАГ 5: Пуш на GitHub и упаковка в ZIP ────────────────────────────────
    await interaction.editReply("🚀 **[5/5] Создаю репозиторий на GitHub и упаковываю архив...**");

    const ghUser = (process.env.GITHUB_USER || "").trim();
    const ghToken = (process.env.GITHUB_TOKEN || "").trim();
    let repoUrl: string | null = null;

    if (ghUser && ghToken) {
      try {
        const created = await createGitHubRepo(ghToken, repoName, project.description);
        if (created) {
          const uploaded = await uploadFilesToGitHub(ghToken, ghUser, repoName, project.files);
          if (uploaded) {
            repoUrl = `https://github.com/${ghUser}/${repoName}`;
          }
        }
      } catch (ghErr) {
        console.error("[GitHub Sync Error]:", ghErr);
      }
    }

    // Создаем ZIP-архив через AdmZip в памяти (100% надёжно, без внешних утилит)
    const zip = new AdmZip();
    for (const [filePath, fileContent] of Object.entries(project.files)) {
      zip.addFile(filePath, Buffer.from(fileContent, "utf-8"));
    }
    const zipBuffer = zip.toBuffer();

    // Формируем красивый Embed с результатами
    const fileNames = Object.keys(project.files)
      .map((f) => `• \`${f}\``)
      .join("\n");

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(`🚀 Проект «${repoName}» успешно разработан!`)
      .setDescription(`**Задача:** ${task}\n\n**Описание:** ${project.description}`)
      .addFields(
        { name: "📁 Созданные файлы", value: fileNames.slice(0, 1000), inline: true },
        {
          name: "🧪 Тест в Ubuntu MicroVM",
          value: sandboxStatusText.slice(0, 1000),
        }
      )
      .setFooter({ text: "Разработано AI Agent • Модель: GLM-5.3-Flash • Sandbox: Novita Linux" })
      .setTimestamp();

    if (repoUrl) {
      embed.addFields({
        name: "🔗 GitHub Репозиторий",
        value: `[${ghUser}/${repoName}](${repoUrl}) — код уже запушен!`,
      });
    } else {
      embed.addFields({
        name: "ℹ️ GitHub",
        value:
          "*Чтобы бот сам заливал проект на GitHub, добавьте `GITHUB_TOKEN` и `GITHUB_USER` в Environment на Railway.*",
      });
    }

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    if (repoUrl) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setLabel("Открыть на GitHub")
            .setStyle(ButtonStyle.Link)
            .setURL(repoUrl)
            .setEmoji("🐙")
        )
      );
    }

    await interaction.editReply({
      content: `✅ **Готово! Проект разработан и упакован в архив.**`,
      embeds: [embed],
      components: rows,
      files: [new AttachmentBuilder(zipBuffer, { name: `${repoName}.zip` })],
    });
  } catch (error: any) {
    console.error("[handleCoder error]:", error);
    const msg = error?.message ? String(error.message) : "Неизвестная ошибка";
    const causeMsg = error?.cause?.message ? ` (${error.cause.message})` : "";
    await interaction.editReply(`❌ **Ошибка при работе агента:** ${msg.slice(0, 250)}${causeMsg}`);
  }
}
