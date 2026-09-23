import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { delay } from "./setup.js";

const execFileAsync = promisify(execFile);

export interface CommandResult {
    stdout: string;
    stderr: string;
    code: number;
}

export interface ToolInfo {
    installed: boolean;
    path: string | null;
    version: string | null;
}

export interface SystemInfo {
    username: string;
    hostname: string;
    homeDirectory: string;
    os: string;
    distribution: string;
    distributionVersion: string;
    prettyDistributionName: string;
    kernel: string;
    architecture: string;
    desktopEnvironment: string;
    windowManager: string;
    initSystem: string;
    shellCurrent: string;
    shellDefault: string;
    cpuModel: string;
    cpuCores: number;
    cpuThreads: number;
    ramTotalBytes: number;
    ramAvailableBytes: number;
    gpu: string;
    rootFilesystem: string;
    rootTotalBytes: number;
    rootFreeBytes: number;
    packageManager: string;
    tools: Record<string, ToolInfo>;
}

export async function runCommand(
    command: string,
    args: string[] = [],
    timeout = 15_000
): Promise<CommandResult> {
    try {
        const result = await execFileAsync(command, args, {
            timeout,
            maxBuffer: 5 * 1024 * 1024
        });

        return {
            stdout: result.stdout?.toString() ?? "",
            stderr: result.stderr?.toString() ?? "",
            code: 0
        };
    } catch (error: any) {
        return {
            stdout: error.stdout?.toString() ?? "",
            stderr: error.stderr?.toString() ?? "",
            code: typeof error.code === "number" ? error.code : 1
        };
    }
};//executar comandos

export async function commandExists(command: string): Promise<boolean> {
    const result = await runCommand("which", [command]);
    return result.code === 0 && result.stdout.trim().length > 0;
};//Veirifcar se comando existe

export async function getCommandPath(command: string): Promise<string | null> {
    const result = await runCommand("which", [command]);
    return result.code === 0 ? result.stdout.trim() || null : null;
};//buscar caminho do comando

export async function getCommandVersion(
    command: string,
    args: string[] = ["--version"]
): Promise<string | null> {
    const result = await runCommand(command, args);

    const line = (result.stdout + "\n" + result.stderr)
        .split("\n")
        .map(value => value.trim())
        .find(Boolean);

    return line ?? null;
};//buscar versão de comando

export function bytesToGB(bytes: number): number {
    return bytes / 1024 ** 3;
};

export function formatGB(bytes: number): string {
    const gb = bytes / 1024 ** 3;//formata de bytes para gb
    return gb.toFixed(1) + " GB";
};//transformar bytes em gb para melhor entendimento do user

function parseOsRelease(): Pick<
    SystemInfo,
    "distribution" | "distributionVersion" | "prettyDistributionName"
> {
    try {
        const content = fs.readFileSync("/etc/os-release", "utf8");
        const values: Record<string, string> = {};

        for (const line of content.split("\n")) {
            const match = line.match(/^([A-Z_]+)=(.*)$/);
            if (!match) continue;

            values[match[1]] = match[2]
                .trim()
                .replace(/^"/, "")
                .replace(/"$/, "");
        }

        return {
            distribution: values.ID ?? "unknown",
            distributionVersion:
                values.VERSION_ID ??
                values.VERSION ??
                values.BUILD_ID ??
                "unknown",
            prettyDistributionName:
                values.PRETTY_NAME ??
                values.NAME ??
                "Unknown Linux"
        };
    } catch {
        return {
            distribution: "unknown",
            distributionVersion: "unknown",
            prettyDistributionName: "Unknown Linux"
        };
    }
}

function getCurrentShell(): string {
    const shell = process.env.SHELL;
    return shell ? path.basename(shell) : "unknown";
}

function getDefaultShell(): string {
    try {
        const username = os.userInfo().username;
        const passwd = fs.readFileSync("/etc/passwd", "utf8");
        const line = passwd
            .split("\n")
            .find(value => value.startsWith(username + ":"));

        const shell = line?.split(":")[6];
        return shell ? path.basename(shell) : "unknown";
    } catch {
        return "unknown";
    }
}

async function getCPUInfo(): Promise<{
    model: string;
    cores: number;
    threads: number;
}> {
    const fallback = os.cpus();
    const fallbackModel = fallback[0]?.model?.trim() ?? "Unknown CPU";

    if (await commandExists("lscpu")) {
        const modelResult = await runCommand("lscpu");
        const topologyResult = await runCommand("lscpu", [
            "-p=CPU,CORE,SOCKET"
        ]);

        if (modelResult.code === 0) {
            const values = new Map<string, string>();

            for (const line of modelResult.stdout.split("\n")) {
                const index = line.indexOf(":");
                if (index === -1) continue;

                values.set(
                    line.slice(0, index).trim(),
                    line.slice(index + 1).trim()
                );
            }

            const model = values.get("Model name") ?? fallbackModel;

            if (topologyResult.code === 0) {
                const rows = topologyResult.stdout
                    .split("\n")
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith("#"));

                const logicalThreads = rows.length;
                const physicalCores = new Set(
                    rows.map(line => {
                        const [cpu, core, socket] = line.split(",");
                        return (
                            (socket ?? "0") +
                            ":" +
                            (core ?? cpu ?? line)
                        );
                    })
                ).size;

                if (logicalThreads > 0 && physicalCores > 0) {
                    return {
                        model,
                        cores: physicalCores,
                        threads: logicalThreads
                    };
                }
            }

            const threads = Number(values.get("CPU(s)"));
            const coresPerSocket = Number(values.get("Core(s) per socket"));
            const sockets = Number(values.get("Socket(s)"));

            if (
                Number.isFinite(threads) &&
                Number.isFinite(coresPerSocket) &&
                Number.isFinite(sockets)
            ) {
                return {
                    model,
                    cores: coresPerSocket * sockets,
                    threads
                };
            }
        }
    }

    return {
        model: fallbackModel,
        cores: fallback.length,
        threads: fallback.length
    };
}

async function getGPUInfo(): Promise<string> {
    if (!(await commandExists("lspci"))) {
        return "GPU não detectada";
    }

    const result = await runCommand("lspci");
    const lines = result.stdout
        .split("\n")
        .filter(line =>
            /VGA compatible controller|3D controller|Display controller/i.test(
                line
            )
        );

    return lines.join(" | ").trim() || "GPU não detectada";
}

async function getFilesystemInfo(): Promise<{
    filesystem: string;
    totalBytes: number;
    freeBytes: number;
}> {
    const result = await runCommand("df", ["-B1", "/"]);

    if (result.code !== 0) {
        return {
            filesystem: "unknown",
            totalBytes: 0,
            freeBytes: 0
        };
    }

    const lines = result.stdout.trim().split("\n");

    if (lines.length < 2) {
        return {
            filesystem: "unknown",
            totalBytes: 0,
            freeBytes: 0
        };
    }

    const parts = lines[1].split(/\s+/);

    return {
        filesystem: parts[0] ?? "unknown",
        totalBytes: Number(parts[1]) || 0,
        freeBytes: Number(parts[3]) || 0
    };
}

function getDesktopEnvironment(): string {
    return (
        process.env.XDG_CURRENT_DESKTOP ??
        process.env.DESKTOP_SESSION ??
        "unknown"
    );
}

function getWindowManager(): string {
    return (
        process.env.XDG_SESSION_DESKTOP ??
        process.env.XDG_CURRENT_DESKTOP ??
        "unknown"
    );
}

async function getInitSystem(): Promise<string> {
    if (await commandExists("systemctl")) {
        const result = await runCommand("systemctl", [
            "is-system-running"
        ]);

        if (
            result.code === 0 ||
            result.stdout.includes("running") ||
            result.stdout.includes("degraded")
        ) {
            return "systemd";
        }
    }

    return "unknown";
}

async function detectPackageManager(): Promise<string> {
    for (const manager of [
        "pacman",
        "paru",
        "yay",
        "apt",
        "dnf",
        "zypper",
        "apk"
    ]) {
        if (await commandExists(manager)) return manager;
    }

    return "unknown";
}

async function detectTools(): Promise<Record<string, ToolInfo>> {
    const commands = [
        "node",
        "npm",
        "git",
        "curl",
        "wget",
        "zstd",
        "bash",
        "fish",
        "zsh",
        "java",
        "javac",
        "gradle",
        "docker",
        "steam",
        "code",
        "ollama",
        "lspci",
        "lscpu",
        "systemctl",
        "xdg-open",
        "python3",
        "pw-play",
        "paplay",
        "aplay",
        "ffplay"
    ];

    const tools: Record<string, ToolInfo> = {};

    // Alguns comandos são aplicações gráficas. Consultar --version pode
    // iniciar o aplicativo, portanto a detecção deles não executa o binário.
    const noVersionProbe = new Set(["steam"]);

    for (const command of commands) {
        const installed = await commandExists(command);

        tools[command] = {
            installed,
            path: installed ? await getCommandPath(command) : null,
            version:
                installed && !noVersionProbe.has(command)
                    ? await getCommandVersion(command)
                    : null
        };
    }

    return tools;
}

export async function runDiagnostics(): Promise<SystemInfo> {
    if (process.platform !== "linux") {
        throw new Error("Esta versão do Jarvis suporta somente Linux.");
    }

    console.log("\nColetando informações do sistema...\n");

    const osRelease = parseOsRelease();
    const cpu = await getCPUInfo();
    const filesystem = await getFilesystemInfo();

    return {
        username: os.userInfo().username,
        hostname: os.hostname(),
        homeDirectory: os.homedir(),
        os: "Linux",
        ...osRelease,
        kernel: os.release(),
        architecture: os.arch(),
        desktopEnvironment: getDesktopEnvironment(),
        windowManager: getWindowManager(),
        initSystem: await getInitSystem(),
        shellCurrent: getCurrentShell(),
        shellDefault: getDefaultShell(),
        cpuModel: cpu.model,
        cpuCores: cpu.cores,
        cpuThreads: cpu.threads,
        ramTotalBytes: os.totalmem(),
        ramAvailableBytes: os.freemem(),
        gpu: await getGPUInfo(),
        rootFilesystem: filesystem.filesystem,
        rootTotalBytes: filesystem.totalBytes,
        rootFreeBytes: filesystem.freeBytes,
        packageManager: await detectPackageManager(),
        tools: await detectTools()
    };
}

export async function printSystemInfo(system: SystemInfo): Promise<void> {
    console.log(
        "\n╔══════════════════════════════════════════════╗\n" +
        "║              JARVIS SYSTEM CHECK             ║\n" +
        "╚══════════════════════════════════════════════╝\n"
    );

    await delay(1000)

    console.log("Sistema");
    console.log("──────────────────────────────────────────────");
    await delay(200)
     console.log("OS:              " + system.os);
    await delay(200)
     console.log("Distribuição:    " + system.prettyDistributionName);
    await delay(200)
     console.log("Versão:          " + system.distributionVersion);
    await delay(200)
     console.log("Kernel:          " + system.kernel);
    await delay(200)
     console.log("Arquitetura:     " + system.architecture);
    await delay(200)
     console.log("Desktop:         " + system.desktopEnvironment);
    await delay(200)
     console.log("Window Manager:  " + system.windowManager);
    await delay(200)
     console.log("Init:             " + system.initSystem);

    await delay(1000)


     console.log("\nHardware");
     console.log("──────────────────────────────────────────────");
    await delay(200) 
     console.log("CPU:             " + system.cpuModel);
    await delay(200) 
     console.log("Cores:           " + system.cpuCores);
    await delay(200) 
     console.log("Threads:         " + system.cpuThreads);
    await delay(200) 
     console.log("RAM total:       " + formatGB(system.ramTotalBytes));
    await delay(200) 
     console.log("RAM disponível:  " + formatGB(system.ramAvailableBytes));
    await delay(200) 
     console.log("GPU:             " + system.gpu);

    await delay(1000)

    console.log("\nArmazenamento");
    console.log("──────────────────────────────────────────────");
    await delay(200)
     console.log("Filesystem:      " + system.rootFilesystem);
    await delay(200)
     console.log("Espaço total:    " + formatGB(system.rootTotalBytes));
    await delay(200)
     console.log("Espaço livre:    " + formatGB(system.rootFreeBytes));

    await delay(1000)

    console.log("\nShell");
    console.log("──────────────────────────────────────────────");
    await delay(200) 
     console.log("Atual:           " + system.shellCurrent);
    await delay(200) 
     console.log("Padrão:          " + system.shellDefault);
    
    await delay(1000)
    
    console.log("\nAmbiente");
    console.log("──────────────────────────────────────────────");
    await delay(200) 
     console.log("Usuário:         " + system.username);
    await delay(200) 
     console.log("Home:            " + system.homeDirectory);
    await delay(200) 
     console.log("Hostname:        " + system.hostname);
    await delay(200) 
     console.log("Package Manager: " + system.packageManager);

    console.log("\nFerramentas");
    console.log("──────────────────────────────────────────────");

    for (const [name, info] of Object.entries(system.tools)) {
        await delay(200) 
         console.log(
            (info.installed ? "✓" : "✗") +
            " " +
            name.padEnd(12) +
            " " +
            (info.version ?? "")
        );
    }
}

async function runDiagnoseCommand(): Promise<void> {
    const {
        initializeDatabase,
        saveSystemInfo,
        DATABASE_PATH
    } = await import("../database/database.js");

    const db = initializeDatabase();

    try {
        const system = await runDiagnostics();
        await printSystemInfo(system);
        await saveSystemInfo(db, system);

        console.log("\n✓ Diagnóstico salvo em " + DATABASE_PATH);
    } finally {
        db.close();
    }
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(__filename)
) {
    runDiagnoseCommand().catch(error => {
        console.error("\nErro no diagnóstico:", error.message);
        process.exit(1);
    });
}
