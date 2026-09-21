import ollama from "ollama";
import Database from "better-sqlite3";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const execFileAsync = promisify(execFile);

// ============================================================
// CONFIGURAÇÃO
// ============================================================

const APP_NAME = "Jarvis";

const DATA_DIR = path.join(process.cwd(), "data");
const DATABASE_PATH = path.join(DATA_DIR, "jarvis.db");

const MIN_RAM_GB = 8;
const MIN_FREE_STORAGE_GB = 10;

const OLLAMA_MODEL = "qwen3:4b";
const OLLAMA_API_URL = "http://127.0.0.1:11434";

// ============================================================
// TIPOS
// ============================================================

interface CommandResult {
    stdout: string;
    stderr: string;
    code: number;
}

interface SystemInfo {
    username: string;
    hostname: string;
    homeDirectory: string;

    os: string;
    distribution: string;
    distributionVersion: string;

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

    tools: Record<string, {
        installed: boolean;
        path: string | null;
        version: string | null;
    }>;
}

interface CompatibilityResult {
    supported: boolean;
    reasons: string[];
    warnings: string[];
}

// ============================================================
// UTILIDADES
// ============================================================

function ensureDataDirectory(): void {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

async function runCommand(
    command: string,
    args: string[] = []
): Promise<CommandResult> {

    try {
        const result = await execFileAsync(command, args, {
            timeout: 15_000,
            maxBuffer: 1024 * 1024 * 5
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
}

async function commandExists(command: string): Promise<boolean> {
    const result = await runCommand("which", [command]);
    return result.code === 0 && result.stdout.trim().length > 0;
}

async function getCommandPath(command: string): Promise<string | null> {
    const result = await runCommand("which", [command]);

    if (result.code !== 0) {
        return null;
    }

    return result.stdout.trim() || null;
}

async function getCommandVersion(
    command: string,
    args: string[] = ["--version"]
): Promise<string | null> {

    const result = await runCommand(command, args);

    const output = `${result.stdout}\n${result.stderr}`
        .trim()
        .split("\n")
        .find(line => line.trim().length > 0);

    return output?.trim() ?? null;
}

function bytesToGB(bytes: number): number {
    return bytes / 1024 / 1024 / 1024;
}

function formatGB(bytes: number): string {
    return `${bytesToFixed(bytesToGB(bytes))} GB`;
}

function bytesToFixed(value: number): string {
    return value.toFixed(1);
}

// ============================================================
// DISTRIBUIÇÃO LINUX
// ============================================================

function readOsRelease(): {
    id: string;
    versionId: string;
    prettyName: string;
} {

    try {

        const content = fs.readFileSync("/etc/os-release", "utf8");

        const values: Record<string, string> = {};

        for (const line of content.split("\n")) {

            const match = line.match(/^([A-Z_]+)=(.*)$/);

            if (!match) {
                continue;
            }

            const key = match[1];

            let value = match[2];

            value = value.replace(/^"/, "").replace(/"$/, "");

            values[key] = value;
        }

        return {
            id: values.ID ?? "unknown",
            versionId: values.VERSION_ID ?? "unknown",
            prettyName: values.PRETTY_NAME ?? "Unknown Linux"
        };

    } catch {

        return {
            id: "unknown",
            versionId: "unknown",
            prettyName: "Unknown Linux"
        };
    }
}

// ============================================================
// SHELL
// ============================================================

function getCurrentShell(): string {

    const shellPath =
        process.env.SHELL ??
        "";

    if (!shellPath) {
        return "unknown";
    }

    return path.basename(shellPath);
}

function getDefaultShell(): string {

    try {

        const username = os.userInfo().username;

        const passwd = fs.readFileSync("/etc/passwd", "utf8");

        const line = passwd
            .split("\n")
            .find(line => line.startsWith(`${username}:`));

        if (!line) {
            return "unknown";
        }

        const parts = line.split(":");

        const shellPath = parts[6];

        if (!shellPath) {
            return "unknown";
        }

        return path.basename(shellPath);

    } catch {

        return "unknown";
    }
}

// ============================================================
// CPU
// ============================================================

function getCPUInfo(): {
    model: string;
    cores: number;
    threads: number;
} {

    const cpus = os.cpus();

    const model =
        cpus[0]?.model?.trim() ??
        "Unknown CPU";

    return {
        model,
        cores: cpus.length > 0
            ? new Set(cpus.map(cpu => cpu.model)).size === 1
                ? estimatePhysicalCores(cpus.length)
                : cpus.length
            : 0,

        threads: cpus.length
    };
}

function estimatePhysicalCores(threads: number): number {

    // Não usamos isso como dado crítico.
    // Posteriormente substituiremos pela leitura de /sys ou lscpu.
    return Math.max(1, Math.floor(threads / 2));
}

// ============================================================
// GPU
// ============================================================

async function getGPUInfo(): Promise<string> {

    if (await commandExists("lspci")) {

        const result = await runCommand("lspci");

        const lines = result.stdout
            .split("\n")
            .filter(line =>
                /VGA compatible controller|3D controller|Display controller/i
                    .test(line)
            );

        if (lines.length > 0) {
            return lines.join(" | ").trim();
        }
    }

    return "GPU não detectada";
}

// ============================================================
// FILESYSTEM
// ============================================================

async function getFilesystemInfo(): Promise<{
    filesystem: string;
    totalBytes: number;
    freeBytes: number;
}> {

    const result = await runCommand("df", ["-B1", "/"]);

    const lines = result.stdout
        .trim()
        .split("\n");

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

// ============================================================
// DESKTOP
// ============================================================

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
        "unknown"
    );
}

// ============================================================
// INIT SYSTEM
// ============================================================

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

// ============================================================
// PACKAGE MANAGER
// ============================================================

async function detectPackageManager(): Promise<string> {

    const managers = [
        "pacman",
        "paru",
        "yay",
        "apt",
        "dnf",
        "zypper",
        "apk"
    ];

    for (const manager of managers) {

        if (await commandExists(manager)) {
            return manager;
        }
    }

    return "unknown";
}

// ============================================================
// FERRAMENTAS
// ============================================================

async function detectTools(): Promise<SystemInfo["tools"]> {

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
        "systemctl"
    ];

    const tools: SystemInfo["tools"] = {};

    for (const command of commands) {

        const installed = await commandExists(command);

        tools[command] = {
            installed,
            path: installed
                ? await getCommandPath(command)
                : null,

            version: installed
                ? await getCommandVersion(command)
                : null
        };
    }

    return tools;
}

// ============================================================
// DIAGNÓSTICO COMPLETO
// ============================================================

async function runDiagnostics(): Promise<SystemInfo> {

    console.log("\nColetando informações do sistema...\n");

    const osRelease = readOsRelease();

    const cpu = getCPUInfo();

    const filesystem = await getFilesystemInfo();

    const gpu = await getGPUInfo();

    const initSystem = await getInitSystem();

    const packageManager = await detectPackageManager();

    const tools = await detectTools();

    return {

        username: os.userInfo().username,

        hostname: os.hostname(),

        homeDirectory: os.homedir(),

        os: "Linux",

        distribution: osRelease.id,

        distributionVersion: osRelease.versionId,

        kernel: os.release(),

        architecture: os.arch(),

        desktopEnvironment: getDesktopEnvironment(),

        windowManager: getWindowManager(),

        initSystem,

        shellCurrent: getCurrentShell(),

        shellDefault: getDefaultShell(),

        cpuModel: cpu.model,

        cpuCores: cpu.cores,

        cpuThreads: cpu.threads,

        ramTotalBytes: os.totalmem(),

        ramAvailableBytes: os.freemem(),

        gpu,

        rootFilesystem: filesystem.filesystem,

        rootTotalBytes: filesystem.totalBytes,

        rootFreeBytes: filesystem.freeBytes,

        packageManager,

        tools
    };
}

// ============================================================
// COMPATIBILIDADE
// ============================================================

function checkCompatibility(
    system: SystemInfo
): CompatibilityResult {

    const reasons: string[] = [];
    const warnings: string[] = [];

    const ramGB = bytesToGB(system.ramTotalBytes);

    const freeStorageGB =
        bytesToGB(system.rootFreeBytes);

    // --------------------------------------------------------
    // Sistema operacional
    // --------------------------------------------------------

    if (system.os !== "Linux") {

        reasons.push(
            "Esta versão do Jarvis suporta somente Linux."
        );
    }

    // --------------------------------------------------------
    // Arquitetura
    // --------------------------------------------------------

    if (
        system.architecture !== "x64" &&
        system.architecture !== "arm64"
    ) {

        reasons.push(
            `Arquitetura não suportada: ${system.architecture}`
        );
    }

    // --------------------------------------------------------
    // RAM
    // --------------------------------------------------------

    if (ramGB < MIN_RAM_GB) {

        reasons.push(
            `RAM insuficiente. Mínimo recomendado: ${MIN_RAM_GB} GB.`
        );
    }

    // --------------------------------------------------------
    // Armazenamento
    // --------------------------------------------------------

    if (freeStorageGB < MIN_FREE_STORAGE_GB) {

        reasons.push(
            `Espaço livre insuficiente. Necessário pelo menos ${MIN_FREE_STORAGE_GB} GB.`
        );
    }

    // --------------------------------------------------------
    // CachyOS / Arch
    // --------------------------------------------------------

    const supportedDistributions = [
        "cachyos",
        "arch"
    ];

    if (!supportedDistributions.includes(
        system.distribution.toLowerCase()
    )) {

        warnings.push(
            `Distribuição ${system.distribution} não é oficialmente suportada nesta versão.`
        );
    }

    // --------------------------------------------------------
    // systemd
    // --------------------------------------------------------

    if (system.initSystem !== "systemd") {

        warnings.push(
            "systemd não foi detectado. O gerenciamento automático do Ollama pode não funcionar."
        );
    }

    // --------------------------------------------------------
    // GPU
    // --------------------------------------------------------

    if (
        system.gpu.toLowerCase().includes("amd") ||
        system.gpu.toLowerCase().includes("radeon")
    ) {

        warnings.push(
            "GPU AMD detectada. O suporte de aceleração dependerá do driver/ROCm disponível."
        );
    }

    // --------------------------------------------------------
    // Resultado
    // --------------------------------------------------------

    return {
        supported: reasons.length === 0,
        reasons,
        warnings
    };
}

// ============================================================
// DATABASE
// ============================================================

function initializeDatabase(): Database.Database {

    ensureDataDirectory();

    const db = new Database(DATABASE_PATH);

    db.pragma("journal_mode = WAL");

    db.exec(`
        CREATE TABLE IF NOT EXISTS system_info (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            username TEXT NOT NULL,
            hostname TEXT NOT NULL,
            home_directory TEXT NOT NULL,

            os TEXT NOT NULL,
            distribution TEXT NOT NULL,
            distribution_version TEXT NOT NULL,

            kernel TEXT NOT NULL,
            architecture TEXT NOT NULL,

            desktop_environment TEXT,
            window_manager TEXT,
            init_system TEXT,

            shell_current TEXT,
            shell_default TEXT,

            cpu_model TEXT,
            cpu_cores INTEGER,
            cpu_threads INTEGER,

            ram_total_bytes INTEGER,
            ram_available_bytes INTEGER,

            gpu TEXT,

            root_filesystem TEXT,
            root_total_bytes INTEGER,
            root_free_bytes INTEGER,

            package_manager TEXT,

            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS software (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            name TEXT NOT NULL UNIQUE,

            installed INTEGER NOT NULL,

            path TEXT,

            version TEXT,

            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS compatibility (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            supported INTEGER NOT NULL,

            reasons TEXT NOT NULL,

            warnings TEXT NOT NULL,

            checked_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ollama (
            id INTEGER PRIMARY KEY CHECK (id = 1),

            installed INTEGER NOT NULL,

            version TEXT,

            service_running INTEGER NOT NULL,

            api_available INTEGER NOT NULL,

            model_installed INTEGER NOT NULL,

            model_name TEXT,

            updated_at TEXT NOT NULL
        );
    `);

    return db;
}

// ============================================================
// SALVAR DIAGNÓSTICO
// ============================================================

function saveSystemInfo(
    db: Database.Database,
    system: SystemInfo
): void {

    const insert = db.prepare(`
        INSERT INTO system_info (
            username,
            hostname,
            home_directory,
            os,
            distribution,
            distribution_version,
            kernel,
            architecture,
            desktop_environment,
            window_manager,
            init_system,
            shell_current,
            shell_default,
            cpu_model,
            cpu_cores,
            cpu_threads,
            ram_total_bytes,
            ram_available_bytes,
            gpu,
            root_filesystem,
            root_total_bytes,
            root_free_bytes,
            package_manager,
            created_at
        )
        VALUES (
            @username,
            @hostname,
            @homeDirectory,
            @os,
            @distribution,
            @distributionVersion,
            @kernel,
            @architecture,
            @desktopEnvironment,
            @windowManager,
            @initSystem,
            @shellCurrent,
            @shellDefault,
            @cpuModel,
            @cpuCores,
            @cpuThreads,
            @ramTotalBytes,
            @ramAvailableBytes,
            @gpu,
            @rootFilesystem,
            @rootTotalBytes,
            @rootFreeBytes,
            @packageManager,
            @createdAt
        )
    `);

    insert.run({
        ...system,
        createdAt: new Date().toISOString()
    });

    const insertSoftware = db.prepare(`
        INSERT INTO software (
            name,
            installed,
            path,
            version,
            updated_at
        )
        VALUES (
            @name,
            @installed,
            @path,
            @version,
            @updatedAt
        )
        ON CONFLICT(name)
        DO UPDATE SET
            installed = excluded.installed,
            path = excluded.path,
            version = excluded.version,
            updated_at = excluded.updated_at
    `);

    const transaction = db.transaction(() => {

        for (const [name, info] of Object.entries(system.tools)) {

            insertSoftware.run({
                name,
                installed: info.installed ? 1 : 0,
                path: info.path,
                version: info.version,
                updatedAt: new Date().toISOString()
            });
        }
    });

    transaction();
}

function saveCompatibility(
    db: Database.Database,
    result: CompatibilityResult
): void {

    db.prepare(`
        INSERT INTO compatibility (
            supported,
            reasons,
            warnings,
            checked_at
        )
        VALUES (?, ?, ?, ?)
    `).run(
        result.supported ? 1 : 0,
        JSON.stringify(result.reasons),
        JSON.stringify(result.warnings),
        new Date().toISOString()
    );
}

// ============================================================
// OUTPUT
// ============================================================

function printSystemInfo(system: SystemInfo): void {

    console.log(`
╔══════════════════════════════════════════════╗
║              JARVIS SYSTEM CHECK             ║
╚══════════════════════════════════════════════╝
`);

    console.log("Sistema");
    console.log("──────────────────────────────────────────────");

    console.log(`OS:              ${system.os}`);
    console.log(`Distribuição:    ${system.distribution}`);
    console.log(`Versão:          ${system.distributionVersion}`);
    console.log(`Kernel:          ${system.kernel}`);
    console.log(`Arquitetura:     ${system.architecture}`);
    console.log(`Desktop:         ${system.desktopEnvironment}`);
    console.log(`Window Manager:  ${system.windowManager}`);
    console.log(`Init:             ${system.initSystem}`);

    console.log("\nHardware");
    console.log("──────────────────────────────────────────────");

    console.log(`CPU:             ${system.cpuModel}`);
    console.log(`Cores:           ${system.cpuCores}`);
    console.log(`Threads:         ${system.cpuThreads}`);
    console.log(`RAM total:       ${formatGB(system.ramTotalBytes)}`);
    console.log(`RAM disponível:  ${formatGB(system.ramAvailableBytes)}`);
    console.log(`GPU:             ${system.gpu}`);

    console.log("\nArmazenamento");
    console.log("──────────────────────────────────────────────");

    console.log(`Filesystem:      ${system.rootFilesystem}`);
    console.log(`Espaço total:    ${formatGB(system.rootTotalBytes)}`);
    console.log(`Espaço livre:    ${formatGB(system.rootFreeBytes)}`);

    console.log("\nShell");
    console.log("──────────────────────────────────────────────");

    console.log(`Atual:           ${system.shellCurrent}`);
    console.log(`Padrão:          ${system.shellDefault}`);

    console.log("\nAmbiente");
    console.log("──────────────────────────────────────────────");

    console.log(`Usuário:         ${system.username}`);
    console.log(`Home:            ${system.homeDirectory}`);
    console.log(`Hostname:        ${system.hostname}`);
    console.log(`Package Manager: ${system.packageManager}`);

    console.log("\nFerramentas");
    console.log("──────────────────────────────────────────────");

    for (const [name, info] of Object.entries(system.tools)) {

        const symbol = info.installed
            ? "✓"
            : "✗";

        console.log(
            `${symbol} ${name.padEnd(12)} ${info.version ?? ""}`
        );
    }
}

function printCompatibility(
    result: CompatibilityResult
): void {

    console.log("\nCompatibilidade");
    console.log("──────────────────────────────────────────────");

    if (result.supported) {

        console.log("✓ Sistema compatível com o Jarvis.");

    } else {

        console.log("✗ Sistema incompatível.");

        for (const reason of result.reasons) {

            console.log(`  • ${reason}`);
        }
    }

    if (result.warnings.length > 0) {

        console.log("\nAvisos:");

        for (const warning of result.warnings) {

            console.log(`  • ${warning}`);
        }
    }
}

// ============================================================
// OLLAMA
// ============================================================

async function isOllamaInstalled(): Promise<boolean> {

    return commandExists("ollama");
}

async function getOllamaVersion(): Promise<string | null> {

    if (!(await isOllamaInstalled())) {
        return null;
    }

    return getCommandVersion("ollama", ["--version"]);
}

async function isOllamaServiceRunning(): Promise<boolean> {

    if (!(await commandExists("systemctl"))) {
        return false;
    }

    const result = await runCommand(
        "systemctl",
        ["is-active", "--quiet", "ollama"]
    );

    return result.code === 0;
}

async function isOllamaAPIAvailable(): Promise<boolean> {

    try {

        const response = await fetch(
            `${OLLAMA_API_URL}/api/tags`,
            {
                signal: AbortSignal.timeout(3000)
            }
        );

        return response.ok;

    } catch {

        return false;
    }
}

async function isModelInstalled(
    modelName: string
): Promise<boolean> {

    if (!(await isOllamaInstalled())) {
        return false;
    }

    const result = await runCommand(
        "ollama",
        ["list"]
    );

    if (result.code !== 0) {
        return false;
    }

    return result.stdout
        .split("\n")
        .some(line =>
            line.startsWith(modelName + " ") ||
            line.startsWith(modelName + "\t")
        );
}

// ============================================================
// OLLAMA DATABASE
// ============================================================

function saveOllamaInfo(
    db: Database.Database,
    info: {
        installed: boolean;
        version: string | null;
        serviceRunning: boolean;
        apiAvailable: boolean;
        modelInstalled: boolean;
        modelName: string;
    }
): void {

    db.prepare(`
        INSERT INTO ollama (
            id,
            installed,
            version,
            service_running,
            api_available,
            model_installed,
            model_name,
            updated_at
        )
        VALUES (
            1,
            @installed,
            @version,
            @serviceRunning,
            @apiAvailable,
            @modelInstalled,
            @modelName,
            @updatedAt
        )
        ON CONFLICT(id)
        DO UPDATE SET
            installed = excluded.installed,
            version = excluded.version,
            service_running = excluded.service_running,
            api_available = excluded.api_available,
            model_installed = excluded.model_installed,
            model_name = excluded.model_name,
            updated_at = excluded.updated_at
    `).run({
        installed: info.installed ? 1 : 0,
        version: info.version,
        serviceRunning: info.serviceRunning ? 1 : 0,
        apiAvailable: info.apiAvailable ? 1 : 0,
        modelInstalled: info.modelInstalled ? 1 : 0,
        modelName: info.modelName,
        updatedAt: new Date().toISOString()
    });
}

// ============================================================
// CONFIRMAÇÃO
// ============================================================

async function askConfirmation(
    question: string
): Promise<boolean> {

    const rl = readline.createInterface({
        input,
        output
    });

    try {

        const answer = await rl.question(
            `${question} [s/N] `
        );

        return (
            answer.trim().toLowerCase() === "s" ||
            answer.trim().toLowerCase() === "sim"
        );

    } finally {

        rl.close();
    }
}

// ============================================================
// INSTALAÇÃO DO OLLAMA
// ============================================================

async function installOllama(): Promise<boolean> {

    console.log("\nO Ollama não está instalado.");

    console.log(`
O instalador oficial do Ollama será executado.

A instalação pode:
- solicitar sua senha através do sudo;
- instalar o binário do Ollama;
- criar um usuário de sistema;
- criar/configurar um serviço systemd.

O Jarvis NÃO verá nem armazenará sua senha.
`);

    const confirmed = await askConfirmation(
        "Deseja instalar o Ollama agora?"
    );

    if (!confirmed) {

        console.log(
            "\nInstalação cancelada pelo usuário."
        );

        return false;
    }

    console.log("\nIniciando instalação...\n");

    /*
     * IMPORTANTE:
     *
     * Não usamos:
     *
     *   sudo bash -c "..."
     *
     * nem capturamos senha.
     *
     * O próprio instalador oficial do Ollama utiliza sudo
     * quando necessário.
     */

    return new Promise(resolve => {

        const child = spawn(
            "sh",
            ["-c", "curl -fsSL https://ollama.com/install.sh | sh"],
            {
                stdio: "inherit",
                shell: false
            }
        );

        child.on("error", error => {

            console.error(
                "\nErro ao iniciar instalador:",
                error.message
            );

            resolve(false);
        });

        child.on("close", code => {

            if (code === 0) {

                console.log(
                    "\n✓ Instalação do Ollama concluída."
                );

                resolve(true);

            } else {

                console.error(
                    `\n✗ Instalador terminou com código ${code}.`
                );

                resolve(false);
            }
        });
    });
}

// ============================================================
// GARANTIR SERVIÇO
// ============================================================

async function ensureOllamaService(): Promise<boolean> {

    if (await isOllamaAPIAvailable()) {
        return true;
    }

    if (!(await commandExists("systemctl"))) {

        console.log(
            "systemctl não encontrado. Tentando iniciar Ollama diretamente..."
        );

        return startOllamaDirectly();
    }

    const running = await isOllamaServiceRunning();

    if (running) {

        // Pode estar iniciando.
        await sleep(1500);

        return isOllamaAPIAvailable();
    }

    console.log("Iniciando serviço Ollama...");

    const result = await runCommand(
        "sudo",
        ["systemctl", "start", "ollama"]
    );

    if (result.code !== 0) {

        console.error(
            "Não foi possível iniciar o serviço Ollama."
        );

        console.error(result.stderr);

        return false;
    }

    await sleep(2000);

    return isOllamaAPIAvailable();
}

async function startOllamaDirectly(): Promise<boolean> {

    console.log("Iniciando Ollama...");

    const child = spawn(
        "ollama",
        ["serve"],
        {
            detached: true,
            stdio: "ignore"
        }
    );

    child.unref();

    for (let i = 0; i < 10; i++) {

        await sleep(1000);

        if (await isOllamaAPIAvailable()) {
            return true;
        }
    }

    return false;
}

// ============================================================
// DOWNLOAD DO MODELO
// ============================================================

async function installModel(): Promise<boolean> {

    const installed =
        await isModelInstalled(OLLAMA_MODEL);

    if (installed) {

        console.log(
            `✓ Modelo ${OLLAMA_MODEL} já está instalado.`
        );

        return true;
    }

    console.log(`
O modelo ${OLLAMA_MODEL} ainda não está instalado.

O download ocupará espaço adicional no disco.
`);

    const confirmed = await askConfirmation(
        `Baixar ${OLLAMA_MODEL} agora?`
    );

    if (!confirmed) {

        console.log(
            "\nDownload do modelo cancelado."
        );

        return false;
    }

    console.log(
        `\nBaixando ${OLLAMA_MODEL}...\n`
    );

    const result = await runCommand(
        "ollama",
        ["pull", OLLAMA_MODEL]
    );

    if (result.code !== 0) {

        console.error(
            "\nErro ao baixar modelo:"
        );

        console.error(result.stderr);

        return false;
    }

    console.log(
        `\n✓ ${OLLAMA_MODEL} instalado.`
    );

    return true;
}

// ============================================================
// TESTE DA IA
// ============================================================

async function testAI(): Promise<boolean> {

    console.log("\nTestando comunicação com o Qwen3...\n");

    try {

        const response = await ollama.chat({

            model: OLLAMA_MODEL,

            messages: [
                {
                    role: "user",
                    content:
                        "Responda somente: JARVIS ONLINE."
                }
            ]
        });

        console.log(
            `Jarvis: ${response.message.content}`
        );

        return true;

    } catch (error: any) {

        console.error(
            "Erro ao conversar com o modelo:"
        );

        console.error(error.message);

        return false;
    }
}

// ============================================================
// UTILIDADE
// ============================================================

function sleep(ms: number): Promise<void> {

    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );
}

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {

    console.clear();

    console.log(`
╔══════════════════════════════════════════════╗
║                  J A R V I S                 ║
║             Local AI Assistant               ║
╚══════════════════════════════════════════════╝
`);

    // --------------------------------------------------------
    // Linux
    // --------------------------------------------------------

    if (process.platform !== "linux") {

        console.error(
            "Esta versão do Jarvis foi desenvolvida para Linux."
        );

        process.exit(1);
    }

    // --------------------------------------------------------
    // Database
    // --------------------------------------------------------

    console.log("Inicializando banco de dados...");

    const db = initializeDatabase();

    console.log(
        `Banco: ${DATABASE_PATH}\n`
    );

    // --------------------------------------------------------
    // Diagnostics
    // --------------------------------------------------------

    const system = await runDiagnostics();

    printSystemInfo(system);

    saveSystemInfo(db, system);

    console.log(
        "\n✓ Informações do sistema salvas."
    );

    // --------------------------------------------------------
    // Compatibility
    // --------------------------------------------------------

    const compatibility =
        checkCompatibility(system);

    printCompatibility(compatibility);

    saveCompatibility(
        db,
        compatibility
    );

    if (!compatibility.supported) {

        console.log(`
O Jarvis não pode continuar neste computador.

Corrija os requisitos acima e execute novamente.
`);

        db.close();

        process.exit(1);
    }

    // --------------------------------------------------------
    // Ollama
    // --------------------------------------------------------

    console.log("\nOllama");
    console.log("──────────────────────────────────────────────");

    let ollamaInstalled =
        await isOllamaInstalled();

    let ollamaVersion =
        await getOllamaVersion();

    console.log(
        `Instalado: ${ollamaInstalled ? "✓" : "✗"}`
    );

    if (ollamaInstalled) {

        console.log(
            `Versão: ${ollamaVersion ?? "desconhecida"}`
        );
    }

    // --------------------------------------------------------
    // Install if necessary
    // --------------------------------------------------------

    if (!ollamaInstalled) {

        const installed =
            await installOllama();

        if (!installed) {

            console.log(`
O Jarvis continuará sem o Ollama.

Execute novamente quando quiser tentar a instalação.
`);

            db.close();

            process.exit(0);
        }

        // Recheck
        ollamaInstalled =
            await isOllamaInstalled();

        ollamaVersion =
            await getOllamaVersion();

        if (!ollamaInstalled) {

            console.error(`
O instalador terminou, mas o comando "ollama"
não foi encontrado no PATH.
`);

            db.close();

            process.exit(1);
        }
    }

    // --------------------------------------------------------
    // Service / API
    // --------------------------------------------------------

    console.log("\nVerificando serviço Ollama...");

    const apiReady =
        await ensureOllamaService();

    if (!apiReady) {

        console.error(`
O Ollama está instalado, mas a API local não está disponível.

Endpoint esperado:
${OLLAMA_API_URL}
`);

        db.close();

        process.exit(1);
    }

    console.log(
        "✓ API Ollama disponível."
    );

    // --------------------------------------------------------
    // Model
    // --------------------------------------------------------

    const modelInstalled =
        await installModel();

    // --------------------------------------------------------
    // Save Ollama state
    // --------------------------------------------------------

    const serviceRunning =
        await isOllamaServiceRunning();

    const apiAvailable =
        await isOllamaAPIAvailable();

    saveOllamaInfo(
        db,
        {
            installed: ollamaInstalled,
            version: ollamaVersion,
            serviceRunning,
            apiAvailable,
            modelInstalled,
            modelName: OLLAMA_MODEL
        }
    );

    // --------------------------------------------------------
    // Test AI
    // --------------------------------------------------------

    if (modelInstalled && apiAvailable) {

        const aiReady =
            await testAI();

        if (!aiReady) {

            console.error(
                "\n✗ A IA não respondeu corretamente."
            );

            db.close();

            process.exit(1);
        }
    }

    // --------------------------------------------------------
    // Final
    // --------------------------------------------------------

    console.log(`
╔══════════════════════════════════════════════╗
║              JARVIS ESTÁ PRONTO              ║
╚══════════════════════════════════════════════╝

Sistema:
  ${system.distribution} ${system.distributionVersion}

CPU:
  ${system.cpuModel}

RAM:
  ${formatGB(system.ramTotalBytes)}

GPU:
  ${system.gpu}

Shell:
  ${system.shellDefault}

Ollama:
  ${ollamaVersion ?? "instalado"}

Modelo:
  ${modelInstalled ? OLLAMA_MODEL : "não instalado"}

Banco:
  ${DATABASE_PATH}

Próximo passo:
  Construir o Agent + sistema de Tools.
`);

    db.close();
}

// ============================================================
// ERROR HANDLER
// ============================================================

main().catch(error => {

    console.error(
        "\nErro fatal no Jarvis:"
    );

    console.error(error);

    process.exit(1);
});