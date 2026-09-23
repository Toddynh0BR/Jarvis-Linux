import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commandExists } from "../setup/diagnostics";

const TTS_HOME = path.join(
    os.homedir(),
    ".local",
    "share",
    "jarvis",
    "tts"
);

async function run(command: string, args: string[]): Promise<number> {
    return new Promise(resolve => {
        const child = spawn(command, args, {
            stdio: "inherit"
        });

        child.on("error", () => resolve(1));
        child.on("close", code => resolve(code ?? 1));
    });
}

async function main(): Promise<void> {
    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║              JARVIS AUDIO SETUP              ║");
    console.log("╚══════════════════════════════════════════════╝\n");

    if (!(await commandExists("python3"))) {
        throw new Error(
            "Python 3 não foi encontrado. Instale Python 3 antes do setup de áudio."
        );
    }

    const python = "python3";
    const venv = path.join(TTS_HOME, ".venv");

    await fs.mkdir(TTS_HOME, { recursive: true });

    try {
        await fs.access(path.join(venv, "bin", "python"));
        console.log("✓ Ambiente Python do TTS já existe.");
    } catch {
        console.log("Criando ambiente Python isolado para o TTS...");
        const code = await run(python, ["-m", "venv", venv]);

        if (code !== 0) {
            throw new Error("Não foi possível criar o ambiente Python do TTS.");
        }
    }

    const venvPython = path.join(venv, "bin", "python");

    console.log("\nAtualizando pip...");
    if (
        (await run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"])) !==
        0
    ) {
        throw new Error("Falha ao atualizar o pip do ambiente de TTS.");
    }

    console.log("\nInstalando qwen-tts...");
    console.log(
        "Isso instala o motor local e suas dependências Python. " +
        "O modelo de voz será baixado somente no primeiro uso."
    );

    if (
        (await run(venvPython, [
            "-m",
            "pip",
            "install",
            "--upgrade",
            "qwen-tts"
        ])) !== 0
    ) {
        throw new Error("Falha ao instalar qwen-tts.");
    }

    console.log("\n✓ Ambiente de voz instalado.");
    console.log(
        "✓ Motor: Qwen3-TTS VoiceDesign 1.7B (local)."
    );
    console.log(
        "✓ Voz: masculina brasileira, grave, calma e sofisticada."
    );
    console.log(
        "\nO modelo principal tem 4.52 GB e o tokenizer 682 MB; " +
        "o download ocorre do Hugging Face na primeira fala."
    );
    console.log(
        "Depois do download, a inferência é executada localmente no computador."
    );
}

main().catch(error => {
    console.error(
        "\n✗ Setup de áudio falhou:",
        error instanceof Error ? error.message : error
    );
    process.exit(1);
});
