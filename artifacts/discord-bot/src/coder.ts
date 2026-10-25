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
        auto_init: false,
      }),
    });
    return res.ok || res.status === 422; // 422 means repo already exists
  } catch (err) {
    console.error("[GitHub API] Error creating repo:", err);
    return false;
  }
}

export async function handleCoder(interaction: ChatInputCommandInteraction): Promise<void> {
  const task = interaction.options.getString("задача", true);
  const customRepo = interaction.options.getString("репозиторий", false);

  const novitaKey = process.env.NOVITA_API_KEY;
  if (!novitaKey) {
    await interaction.reply({
      content:
        "❌ **NOVITA_API_KEY не задан!** Добавьте переменную окружения `NOVITA_API_KEY` в панели Render во вкладке Environment.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    // ─── ШАГ 1: Проектирование кода через River AI (GLM-5.3-Flash) ────────────
    await interaction.editReply("⏳ **[1/5] Архитектор проектирует код...** (River AI: GLM-5.3-Flash)");

    const systemPrompt = `Ты — Senior Software Engineer и DevOps. Создай полный, рабочий и качественный проект по ТЗ пользователя.
Ответь СТРОГО валидным JSON без лишних рассуждений:
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

    const project = await geminiJSON<GeneratedProject>(
      `${systemPrompt}\n\nТЗ ПОЛЬЗОВАТЕЛЯ:\n${task}`,
      undefined,
      { maxTokens: 8192 }
    );

    if (!project || !project.files || Object.keys(project.files).length === 0) {
      throw new Error("Нейросеть вернула пустую структуру файлов. Попробуйте уточнить запрос.");
    }

    // ─── ШАГ 2: Запуск Ubuntu MicroVM в Novita Sandbox ─────────────────────────
    await interaction.editReply("⚡ **[2/5] Поднимаю виртуальную машину Ubuntu...** (Novita Agent Sandbox)");

    const sbx = await Sandbox.create({
      apiKey: novitaKey,
      timeoutMs: 300_000, // 5 минут тайм-аут
    });

    const workdir = "/home/user/app";
    let autoFixed = false;
    let testOutput = "";
    let repoUrl: string | null = null;
    const repoName = (customRepo || project.projectName || "ai-agent-project")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-");

    try {
      // ─── ШАГ 3: Запись файлов и установка библиотек ─────────────────────────
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
            await sbx.files.write(`${workdir}/${entry}`, fixResult.fixedCode);
            runRes = await sbx.commands.run(`timeout 10s python3 ${entry}`, {
              cwd: workdir,
              timeoutMs: 20_000,
            });
            autoFixed = true;
          }
        } catch (err) {
          console.error("[Coder auto-fix error]:", err);
        }
      }

      testOutput = runRes.stdout || runRes.stderr || "Скрипт успешно запущен без вывода ошибок.";

      // ─── ШАГ 5: Пуш на GitHub и упаковка в ZIP ──────────────────────────────
      await interaction.editReply("🚀 **[5/5] Создаю репозиторий на GitHub и упаковываю архив...**");

      const ghUser = process.env.GITHUB_USER;
      const ghToken = process.env.GITHUB_TOKEN;

      if (ghUser && ghToken) {
        await createGitHubRepo(ghToken, repoName, project.description);
        const remoteUrl = `https://${ghUser}:${ghToken}@github.com/${ghUser}/${repoName}.git`;
        const gitCmd = `git init && git config user.name "AI Agent" && git config user.email "agent@river.ai" && git branch -M main && git add . && git commit -m "Auto-generated by AI Agent" && git remote add origin ${remoteUrl} && git push -u origin main --force`;
        await sbx.commands.run(gitCmd, { cwd: workdir, timeoutMs: 30_000 });
        repoUrl = `https://github.com/${ghUser}/${repoName}`;
      }

      // Создаем ZIP-архив внутри ВМ
      await sbx.commands.run("zip -r /home/user/project.zip . -x '*.git*'", {
        cwd: workdir,
        timeoutMs: 20_000,
      });

      const zipBytes = await sbx.files.read("/home/user/project.zip", { format: "bytes" });
      const zipBuffer = Buffer.from(zipBytes);

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
            value: `Статус: **${runRes.exitCode === 0 || runRes.exitCode === 124 ? "✅ Успешно" : "⚠️ Завершён с кодом " + runRes.exitCode}**${autoFixed ? " *(Баг автоматически исправлен ИИ!)*" : ""}\n\`\`\`bash\n${testOutput.slice(0, 400)}\n\`\`\``,
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
            "*Чтобы бот сам заливал проект на GitHub, добавьте `GITHUB_TOKEN` и `GITHUB_USER` в Environment на Render.*",
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
        content: `✅ **Готово! Проект разработан и протестирован в виртуальной машине.**`,
        embeds: [embed],
        components: rows,
        files: [new AttachmentBuilder(zipBuffer, { name: `${repoName}.zip` })],
      });
    } finally {
      // Обязательно уничтожаем виртуальную машину, чтобы не тратить ваучер
      await sbx.kill().catch(() => {});
    }
  } catch (error: any) {
    console.error("[handleCoder error]:", error);
    const msg = error?.message ? String(error.message) : "Неизвестная ошибка";
    await interaction.editReply(`❌ **Ошибка при работе агента:** ${msg.slice(0, 300)}`);
  }
}
