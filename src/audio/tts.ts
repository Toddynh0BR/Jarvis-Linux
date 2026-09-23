import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commandExists } from "../setup/diagnostics";

const DEFAULT_VOICE_INSTRUCTION =
    process.env.JARVIS_TTS_VOICE ??
    "Voz masculina adulta, muito natural e humana, com timbre grave, quente, encorpado e ressonante. Pronúncia exclusivamente em português brasileiro, com sotaque brasileiro neutro e sem qualquer característica de português europeu. Voz elegante, confiante, calma e extremamente articulada, com presença cinematográfica de um assistente de inteligência artificial avançado. Fale com autoridade serena e inteligência, em ritmo moderado, usando pausas curtas e naturais. Pouca dramaticidade, nenhuma empolgação exagerada e nenhuma voz robótica. O resultado deve soar sofisticado, maduro, tecnológico e convincente, como um assistente pessoal de IA de um filme de ficção científica, sem imitar a voz de uma pessoa real.";

const TTS_DESIGN_MODEL =
    process.env.JARVIS_TTS_DESIGN_MODEL ??
    "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign";

const TTS_CLONE_MODEL =
    process.env.JARVIS_TTS_CLONE_MODEL ??
    "Qwen/Qwen3-TTS-12Hz-0.6B-Base";

const TTS_REFERENCE_TEXT =
    process.env.JARVIS_TTS_REFERENCE_TEXT ??
    "Boa tarde. Estou à sua disposição. Todos os sistemas estão operacionais e prontos para executar suas solicitações. Como posso ajudá-lo?";

const TTS_HOME = path.join(
    os.homedir(),
    ".local",
    "share",
    "jarvis",
    "tts"
);

const TTS_REFERENCE_PATH = path.join(
    TTS_HOME,
    "jarvis_voice_reference_v2.wav"
);

const TTS_LANGUAGE = "Portuguese";

interface WorkerReady {
    type: "ready";
    error?: string;
}

interface WorkerResult {
    type: "result";
    id: number;
    ok: boolean;
    path?: string;
    error?: string;
}

type WorkerMessage = WorkerReady | WorkerResult;

export class JarvisTTS {
    private worker: ChildProcessWithoutNullStreams | null = null;
    private lines: Interface | null = null;
    private readyPromise: Promise<void> | null = null;
    private requestId = 0;
    private readonly pending = new Map<
        number,
        {
            resolve: (filePath: string) => void;
            reject: (error: Error) => void;
        }
    >();
    private speaking = false;
    private warnedUnavailable = false;

    async start(): Promise<void> {
        if (this.readyPromise) {
            return this.readyPromise;
        }

        this.readyPromise = this.startWorker().catch(error => {
            this.readyPromise = null;
            throw error;
        });

        return this.readyPromise;
    }

    async speak(text: string): Promise<void> {
        const chunks = splitSpeechText(sanitizeSpeechText(text));

        if (chunks.length === 0) {
            return;
        }

        try {
            for (const chunk of chunks) {
                const filePath = await this.generate(chunk);
                await this.play(filePath);
            }
        } catch (error) {
            if (!this.warnedUnavailable) {
                this.warnedUnavailable = true;
                console.warn(
                    "[Audio] TTS indisponível; o Jarvis continuará respondendo por texto. " +
                    (error instanceof Error ? error.message : String(error))
                );
            }
        }
    }

    async stop(): Promise<void> {
        this.worker?.kill();
        this.worker = null;
        this.lines?.close();
        this.lines = null;

        for (const pending of this.pending.values()) {
            pending.reject(new Error("TTS encerrado."));
        }

        this.pending.clear();
        this.readyPromise = null;
    }

    private async startWorker(): Promise<void> {
        const python = await resolvePython();

        const scriptPath = path.resolve(
            process.cwd(),
            "scripts",
            "jarvis_tts_worker.py"
        );

        const child = spawn(
            python,
            [
                scriptPath,
                "--design-model",
                TTS_DESIGN_MODEL,
                "--clone-model",
                TTS_CLONE_MODEL,
                "--voice",
                DEFAULT_VOICE_INSTRUCTION,
                "--reference",
                TTS_REFERENCE_PATH,
                "--reference-text",
                TTS_REFERENCE_TEXT
            ],
            {
                stdio: ["pipe", "pipe", "pipe"],
                env: {
                    ...process.env,
                    PYTHONUNBUFFERED: "1"
                }
            }
        );

        this.worker = child;

        child.stderr.on("data", () => {
            // stderr do worker contém apenas diagnóstico interno do motor de voz.
        });

        child.on("error", error => {
            this.rejectAll(error);
        });

        child.on("exit", code => {
            if (code !== 0) {
                this.rejectAll(
                    new Error(
                        "O processo local de TTS foi encerrado com código " +
                        String(code)
                    )
                );
            }

            this.worker = null;
            this.lines?.close();
            this.lines = null;
        });

        this.lines = createInterface({
            input: child.stdout,
            crlfDelay: Infinity
        });

        const ready = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(
                    new Error(
                        "Tempo limite aguardando o motor de voz local. " +
                        "Na primeira execução o modelo pode precisar ser baixado."
                    )
                );
            }, 900_000);

            const onLine = (line: string) => {
                let message: WorkerMessage;

                try {
                    message = JSON.parse(line) as WorkerMessage;
                } catch {
                    return;
                }

                if (message.type === "ready") {
                    clearTimeout(timeout);

                    if (message.error) {
                        reject(new Error(message.error));
                    } else {
                        resolve();
                    }

                    return;
                }

                this.handleWorkerMessage(message);
            };

            this.lines?.on("line", onLine);
        });

        await ready;
    }

    private async generate(text: string): Promise<string> {
        await this.start();

        if (!this.worker) {
            throw new Error("Processo de TTS não está disponível.");
        }

        const id = ++this.requestId;
        const outputDirectory = await fs.mkdtemp(
            path.join(os.tmpdir(), "jarvis-tts-")
        );
        const outputPath = path.join(
            outputDirectory,
            "response.wav"
        );

        const result = new Promise<string>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });

        this.worker.stdin.write(
            JSON.stringify({
                id,
                text,
                output: outputPath,
                language: TTS_LANGUAGE
            }) + "\n"
        );

        return result;
    }

    private handleWorkerMessage(message: WorkerMessage): void {
        if (message.type !== "result") {
            return;
        }

        const pending = this.pending.get(message.id);

        if (!pending) {
            return;
        }

        this.pending.delete(message.id);

        if (message.ok && message.path) {
            pending.resolve(message.path);
        } else {
            pending.reject(
                new Error(message.error ?? "Falha na síntese de voz.")
            );
        }
    }

    private rejectAll(error: Error): void {
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }

        this.pending.clear();
    }

    private async play(filePath: string): Promise<void> {
        if (this.speaking) {
            return;
        }

        const player = await resolveAudioPlayer();

        this.speaking = true;

        try {
            await new Promise<void>((resolve, reject) => {
                const child = spawn(player.command, [
                    ...player.args,
                    filePath
                ], {
                    stdio: "ignore"
                });

                child.on("error", reject);
                child.on("close", code => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(
                            new Error(
                                "O reprodutor de áudio encerrou com código " +
                                String(code)
                            )
                        );
                    }
                });
            });
        } finally {
            this.speaking = false;

            try {
                await fs.rm(path.dirname(filePath), {
                    recursive: true,
                    force: true
                });
            } catch {
                // O arquivo temporário não deve impedir o Jarvis de continuar.
            }
        }
    }
}

async function resolvePython(): Promise<string> {
    const configured = process.env.JARVIS_TTS_PYTHON;

    if (configured) {
        return configured;
    }

    const home = os.homedir();
    const venvPython = path.join(
        home,
        ".local",
        "share",
        "jarvis",
        "tts",
        ".venv",
        "bin",
        "python"
    );

    try {
        await fs.access(venvPython);
        return venvPython;
    } catch {
        // Fallback para python3 para permitir diagnóstico e instalação guiada.
    }

    if (await commandExists("python3")) {
        return "python3";
    }

    throw new Error(
        "Python 3 não foi encontrado. Execute npm run audio:setup."
    );
}

async function resolveAudioPlayer(): Promise<{
    command: string;
    args: string[];
}> {
    const candidates: Array<{
        command: string;
        args: string[];
    }> = [
        { command: "pw-play", args: [] },
        { command: "paplay", args: [] },
        { command: "aplay", args: ["-q"] },
        { command: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet"] }
    ];

    for (const candidate of candidates) {
        if (await commandExists(candidate.command)) {
            return candidate;
        }
    }

    throw new Error(
        "Nenhum reprodutor de áudio local foi encontrado. " +
        "Instale/ative PipeWire (pw-play), PulseAudio (paplay), ALSA (aplay) ou FFmpeg (ffplay)."
    );
}

function sanitizeSpeechText(text: string): string {
    return text
        .replace(/[`]/g, "")
        .replace(/https?:\/\/\S+/g, " link ")
        .replace(/\s+/g, " ")
        .trim();
}

