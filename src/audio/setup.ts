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

const TTS_NATIVE_HOME = path.join(
    os.homedir(),
    ".local",
    "share",
    "jarvis",
    "tts-native"
);

const TTS_NATIVE_REPOSITORY =
    "https://github.com/gabriele-mastrapasqua/qwen3-tts.git";

const TTS_NATIVE_SOURCE = path.join(
    TTS_NATIVE_HOME,
    "qwen3-tts"
);

const TTS_NATIVE_BINARY = path.join(
    TTS_NATIVE_SOURCE,
    "qwen_tts"
);

const TTS_NATIVE_MODEL = path.join(
    TTS_NATIVE_SOURCE,
    "qwen3-tts-0.6b"
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


async function installNativeTTS(): Promise<void> {
    console.log("\nConfigurando backend nativo de TTS (Qwen3-TTS C)...");

    for (const command of ["git", "make", "cc"]) {
        if (!(await commandExists(command))) {
            throw new Error(
                "O comando " +
                command +
                " é necessário para o backend nativo de TTS."
            );
        }
    }

    await fs.mkdir(TTS_NATIVE_HOME, { recursive: true });

    try {
        await fs.access(TTS_NATIVE_SOURCE);
        console.log("✓ Código do Qwen3-TTS nativo já existe.");
    } catch {
        console.log("Baixando o backend nativo do Qwen3-TTS...");

        const code = await run(
            "git",
            [
                "clone",
                "--depth",
                "1",
                TTS_NATIVE_REPOSITORY,
                TTS_NATIVE_SOURCE
            ]
        );

        if (code !== 0) {
            throw new Error(
                "Falha ao baixar o backend nativo do Qwen3-TTS."
            );
        }
    }

    console.log("Compilando Qwen3-TTS com otimizações para CPU...");

    if (
        (await run(
            "make",
            ["blas"],
        )) !== 0
    ) {
        throw new Error(
            "Falha ao compilar o backend nativo do Qwen3-TTS."
        );
    }

    try {
        await fs.access(
            path.join(TTS_NATIVE_MODEL, "config.json")
        );
        console.log("✓ Modelo Qwen3-TTS 0.6B já está instalado.");
    } catch {
        console.log("Baixando modelo Qwen3-TTS 0.6B...");

        if (
            (await run(
                "./download_model.sh",
                ["--model", "small"],
            )) !== 0
        ) {
            throw new Error(
                "Falha ao baixar o modelo Qwen3-TTS 0.6B."
            );
        }
    }

    try {
        await fs.access(TTS_NATIVE_BINARY);
    } catch {
        throw new Error(
            "O executável qwen_tts não foi criado durante a compilação."
        );
    }

    console.log("✓ Backend nativo de TTS configurado.");
    console.log("✓ Qwen3-TTS 0.6B com INT4 será usado no Jarvis.");
    console.log("✓ Streaming de áudio será usado para reduzir o tempo até a primeira fala.");
}

async function installSystemSox(): Promise<void> {
    if (await commandExists("sox")) {
        console.log("✓ SoX já está instalado.");
        return;
    }

    console.log("\nSoX é necessário pelo Qwen3-TTS para processamento de áudio.");

    const commands: Array<[string, string[]]> = [
        ["sudo", ["pacman", "-S", "--needed", "--noconfirm", "sox"]],
        ["sudo", ["apt-get", "install", "-y", "sox"]],
        ["sudo", ["dnf", "install", "-y", "sox"]],
        ["sudo", ["zypper", "install", "-y", "sox"]],
    ];

    for (const [command, args] of commands) {
        if (
            args[0] === "pacman" &&
            !(await commandExists("pacman"))
        ) continue;
        if (
            args[0] === "apt-get" &&
            !(await commandExists("apt-get"))
        ) continue;
        if (
            args[0] === "dnf" &&
            !(await commandExists("dnf"))
        ) continue;
        if (
            args[0] === "zypper" &&
            !(await commandExists("zypper"))
        ) continue;

        console.log(
            "Instalando SoX pelo gerenciador de pacotes. " +
            "Se o sistema solicitar sua senha, ela será tratada somente pelo sudo."
        );

        const code = await run(command, args);

        if (code === 0 && (await commandExists("sox"))) {
            console.log("✓ SoX instalado.");
            return;
        }
    }

    throw new Error(
        "Não foi possível instalar o SoX automaticamente. " +
        "Instale o pacote 'sox' pelo gerenciador de pacotes do seu Linux e execute npm run audio:test novamente."
    );
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

    await installSystemSox();
    await installNativeTTS();

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
        "✓ Design: Qwen3-TTS VoiceDesign 1.7B (cria a voz base)."
    );
    console.log(
        "✓ Síntese: Qwen3-TTS Base 0.6B (reutiliza a mesma voz local)."
    );
    console.log(
        "✓ Voz: masculina brasileira, grave, calma e sofisticada."
    );
    console.log(
        "\nO backend nativo mantém o modelo 0.6B carregado em memória e usa " +
        "INT4 com streaming para reduzir drasticamente a latência da fala."
    );
    console.log(
        "O backend Python antigo permanece instalado como fallback."
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
