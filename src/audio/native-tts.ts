import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";

const DEFAULT_HOME = path.join(
    os.homedir(),
    ".local",
    "share",
    "jarvis",
    "tts-native"
);

const REPOSITORY_URL =
    "https://github.com/gabriele-mastrapasqua/qwen3-tts.git";

const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = Number(
    process.env.JARVIS_TTS_NATIVE_PORT ?? "18742"
);

const MODEL_DIRECTORY = path.join(
    DEFAULT_HOME,
    "qwen3-tts",
    "qwen3-tts-0.6b"
);

const BINARY_PATH = path.join(
    DEFAULT_HOME,
    "qwen3-tts",
    "qwen_tts"
);

const VOICE =
    process.env.JARVIS_TTS_NATIVE_VOICE ?? "ryan";

const THREADS = Number(
    process.env.JARVIS_TTS_NATIVE_THREADS ?? "4"
);

const QUANTIZATION =
    process.env.JARVIS_TTS_NATIVE_QUANTIZATION ?? "int4";

interface NativeTTSOptions {
    home?: string;
    modelDirectory?: string;
    binaryPath?: string;
    port?: number;
}

export class NativeQwenTTS {
    private readonly home: string;
    private readonly modelDirectory: string;
    private readonly binaryPath: string;
    private readonly port: number;
    private server: ChildProcess | null = null;
    private readyPromise: Promise<void> | null = null;
    private player: ChildProcess | null = null;

    constructor(options: NativeTTSOptions = {}) {
        this.home = options.home ?? DEFAULT_HOME;
        this.modelDirectory =
            options.modelDirectory ?? MODEL_DIRECTORY;
        this.binaryPath =
            options.binaryPath ?? BINARY_PATH;
        this.port = options.port ?? SERVER_PORT;
    }

    async isInstalled(): Promise<boolean> {
        try {
            await fs.access(this.binaryPath);
            await fs.access(
                path.join(this.modelDirectory, "config.json")
            );
            return true;
        } catch {
            return false;
        }
    }

    async start(): Promise<void> {
        if (this.readyPromise) {
            return this.readyPromise;
        }

        this.readyPromise = this.startServer().catch(error => {
            this.readyPromise = null;
            throw error;
        });

        return this.readyPromise;
    }

    async speak(text: string): Promise<void> {
        const cleanText = text.trim();

        if (!cleanText) {
            return;
        }

        await this.start();

        const requestStartedAt = Date.now();

        const response = await fetch(
            "http://" +
                SERVER_HOST +
                ":" +
                String(this.port) +
                "/v1/tts/stream",
            {
                method: "POST",
                headers: {
                    "content-type": "application/json"
                },
                body: JSON.stringify({
                    text: cleanText,
                    language: "Portuguese",
                    speaker: VOICE,
                    temperature: 0.35,
                    topK: 30,
                    topP: 0.9,
                    repetitionPenalty: 1.05
                })
            }
        );

        if (!response.ok || !response.body) {
            throw new Error(
                "Servidor nativo de TTS respondeu com HTTP " +
                String(response.status)
            );
        }

        const firstByteAt = Date.now();

        console.log(
            "[Audio] TTS nativo: primeiro áudio recebido em " +
            String(firstByteAt - requestStartedAt) +
            " ms."
        );

        await this.playStream(response.body);
    }

    async stop(): Promise<void> {
        this.player?.kill("SIGTERM");
        this.player = null;

        this.server?.kill("SIGTERM");
        this.server = null;

        this.readyPromise = null;
    }

    private async startServer(): Promise<void> {
        if (await canConnect(SERVER_HOST, this.port)) {
            return;
        }

        if (!(await this.isInstalled())) {
            throw new Error(
                "Backend nativo do Qwen3-TTS não está instalado. " +
                "Execute npm run audio:setup."
            );
        }

        const args = [
            "-d",
            this.modelDirectory,
            "--serve",
            String(this.port),
            "--silent",
            "-j",
            String(THREADS)
        ];

        if (QUANTIZATION === "int8") {
            args.push("--int8");
        } else {
            args.push("--int4");
        }

        const child = spawn(this.binaryPath, args, {
            cwd: path.dirname(this.binaryPath),
            stdio: "ignore",
            env: {
                ...process.env
            }
        });

        this.server = child;

        child.on("error", () => {
            // O erro será propagado pelo timeout/requisição de fala.
        });

        child.on("exit", () => {
            this.server = null;
        });

        await waitForPort(
            SERVER_HOST,
            this.port,
            30_000
        );
    }

    private async playStream(
        body: ReadableStream<Uint8Array>
    ): Promise<void> {
        const playbackStartedAt = Date.now();
        let firstChunk = true;

        const player = spawn(
            "play",
            [
                "-q",
                "-t",
                "raw",
                "-r",
                "24000",
                "-e",
                "signed",
                "-b",
                "16",
                "-c",
                "1",
                "-"
            ],
            {
                stdio: ["pipe", "ignore", "ignore"]
            }
        );

        this.player = player;

        const stream = Readable.fromWeb(
            body as Parameters<typeof Readable.fromWeb>[0]
        );

        await new Promise<void>((resolve, reject) => {
            let settled = false;

            const finish = (error?: Error) => {
                if (settled) {
                    return;
                }

                settled = true;

                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };

            player.on("error", error => {
                finish(error);
            });

            player.on("close", code => {
                if (code === 0) {
                    finish();
                } else {
                    finish(
                        new Error(
                            "O reprodutor de áudio encerrou com código " +
                            String(code)
                        )
                    );
                }
            });

            stream.on("data", chunk => {
                if (firstChunk) {
                    firstChunk = false;

                    console.log(
                        "[Audio] TTS nativo: primeiro chunk encaminhado ao player em " +
                        String(Date.now() - playbackStartedAt) +
                        " ms."
                    );
                }

                return chunk;
            });

            stream.on("error", error => {
                player.stdin?.destroy(error);
                finish(error);
            });

            if (!player.stdin) {
                finish(
                    new Error(
                        "O reprodutor de áudio não abriu a entrada de áudio."
                    )
                );
                return;
            }

            stream.pipe(player.stdin);
        });

        this.player = null;
    }
}

async function waitForPort(
    host: string,
    port: number,
    timeoutMs: number
): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const connected = await canConnect(host, port);

        if (connected) {
            return;
        }

        await delay(100);
    }

    throw new Error(
        "O servidor nativo de TTS não ficou disponível em " +
        host +
        ":" +
        String(port)
    );
}

function canConnect(
    host: string,
    port: number
): Promise<boolean> {
    return new Promise(resolve => {
        const socket = net.createConnection({
            host,
            port
        });

        const finish = (value: boolean) => {
            socket.destroy();
            resolve(value);
        };

        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.setTimeout(500, () => finish(false));
    });
}

async function delay(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
}

export function getNativeTTSPaths(): {
    home: string;
    repository: string;
    binary: string;
    model: string;
} {
    return {
        home: DEFAULT_HOME,
        repository: path.join(DEFAULT_HOME, "qwen3-tts"),
        binary: BINARY_PATH,
        model: MODEL_DIRECTORY
    };
}

export function getNativeTTSRepositoryUrl(): string {
    return REPOSITORY_URL;
}
