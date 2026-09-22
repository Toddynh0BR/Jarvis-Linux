import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SystemInfo } from "../setup/diagnostics.js";
import type { CompatibilityResult } from "../setup/compatibility";

export const DATA_DIR = path.join(process.cwd(), "data");
export const DATABASE_PATH = path.join(DATA_DIR, "jarvis.db");
export const COMPATIBILITY_CHECK_VERSION = 1;

export interface CompatibilityRecord {
    id: number;
    supported: boolean;
    reasons: string[];
    warnings: string[];
    checkedAt: string;
    checkVersion: number;
}

export function ensureDataDirectory(): void {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

export function initializeDatabase(): Database.Database {
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
            pretty_distribution_name TEXT NOT NULL DEFAULT 'Unknown Linux',
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
            check_version INTEGER NOT NULL DEFAULT 1,
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

    const systemColumns = db
        .prepare("PRAGMA table_info(system_info)")
        .all() as Array<{ name: string }>;

    if (!systemColumns.some(column => column.name === "pretty_distribution_name")) {
        db.exec(
            "ALTER TABLE system_info ADD COLUMN pretty_distribution_name TEXT NOT NULL DEFAULT 'Unknown Linux'"
        );
    }

    const compatibilityColumns = db
        .prepare("PRAGMA table_info(compatibility)")
        .all() as Array<{ name: string }>;

    if (!compatibilityColumns.some(column => column.name === "check_version")) {
        db.exec(
            "ALTER TABLE compatibility ADD COLUMN check_version INTEGER NOT NULL DEFAULT 1"
        );
    }

    return db;
}

export function getLatestCompatibility(
    db: Database.Database
): CompatibilityRecord | null {
    const row = db
        .prepare(`
            SELECT id, supported, reasons, warnings, check_version, checked_at
            FROM compatibility
            ORDER BY id DESC
            LIMIT 1
        `)
        .get() as
        | {
              id: number;
              supported: number;
              reasons: string;
              warnings: string;
              check_version: number;
              checked_at: string;
          }
        | undefined;

    if (!row) return null;

    return {
        id: row.id,
        supported: row.supported === 1,
        reasons: JSON.parse(row.reasons),
        warnings: JSON.parse(row.warnings),
        checkedAt: row.checked_at,
        checkVersion: row.check_version
    };
}

export function saveCompatibility(
    db: Database.Database,
    result: CompatibilityResult
): void {
    db.prepare(`
        INSERT INTO compatibility (
            supported, reasons, warnings, check_version, checked_at
        )
        VALUES (?, ?, ?, ?, ?)
    `).run(
        result.supported ? 1 : 0,
        JSON.stringify(result.reasons),
        JSON.stringify(result.warnings),
        COMPATIBILITY_CHECK_VERSION,
        new Date().toISOString()
    );
}

export function saveSystemInfo(
    db: Database.Database,
    system: SystemInfo
): void {
    db.prepare(`
        INSERT INTO system_info (
            username, hostname, home_directory,
            os, distribution, distribution_version, pretty_distribution_name,
            kernel, architecture, desktop_environment, window_manager,
            init_system, shell_current, shell_default,
            cpu_model, cpu_cores, cpu_threads,
            ram_total_bytes, ram_available_bytes, gpu,
            root_filesystem, root_total_bytes, root_free_bytes,
            package_manager, created_at
        )
        VALUES (
            @username, @hostname, @homeDirectory,
            @os, @distribution, @distributionVersion, @prettyDistributionName,
            @kernel, @architecture, @desktopEnvironment, @windowManager,
            @initSystem, @shellCurrent, @shellDefault,
            @cpuModel, @cpuCores, @cpuThreads,
            @ramTotalBytes, @ramAvailableBytes, @gpu,
            @rootFilesystem, @rootTotalBytes, @rootFreeBytes,
            @packageManager, @createdAt
        )
    `).run({
        ...system,
        createdAt: new Date().toISOString()
    });

    const upsert = db.prepare(`
        INSERT INTO software (
            name, installed, path, version, updated_at
        )
        VALUES (@name, @installed, @path, @version, @updatedAt)
        ON CONFLICT(name)
        DO UPDATE SET
            installed = excluded.installed,
            path = excluded.path,
            version = excluded.version,
            updated_at = excluded.updated_at
    `);

    const updatedAt = new Date().toISOString();

    db.transaction(() => {
        for (const [name, info] of Object.entries(system.tools)) {
            upsert.run({
                name,
                installed: info.installed ? 1 : 0,
                path: info.path,
                version: info.version,
                updatedAt
            });
        }
    })();
}

export function getLatestSystemInfo(
    db: Database.Database
): SystemInfo | null {
    const row = db
        .prepare(`
            SELECT *
            FROM system_info
            ORDER BY id DESC
            LIMIT 1
        `)
        .get() as any;

    if (!row) return null;

    const softwareRows = db
        .prepare(`
            SELECT name, installed, path, version
            FROM software
            ORDER BY name
        `)
        .all() as Array<{
            name: string;
            installed: number;
            path: string | null;
            version: string | null;
        }>;

    const tools: SystemInfo["tools"] = {};

    for (const software of softwareRows) {
        tools[software.name] = {
            installed: software.installed === 1,
            path: software.path,
            version: software.version
        };
    }

    return {
        username: row.username,
        hostname: row.hostname,
        homeDirectory: row.home_directory,
        os: row.os,
        distribution: row.distribution,
        distributionVersion: row.distribution_version,
        prettyDistributionName:
            row.pretty_distribution_name ?? row.distribution,
        kernel: row.kernel,
        architecture: row.architecture,
        desktopEnvironment: row.desktop_environment ?? "unknown",
        windowManager: row.window_manager ?? "unknown",
        initSystem: row.init_system ?? "unknown",
        shellCurrent: row.shell_current ?? "unknown",
        shellDefault: row.shell_default ?? "unknown",
        cpuModel: row.cpu_model ?? "Unknown CPU",
        cpuCores: row.cpu_cores ?? 0,
        cpuThreads: row.cpu_threads ?? 0,
        ramTotalBytes: row.ram_total_bytes ?? 0,
        ramAvailableBytes: row.ram_available_bytes ?? 0,
        gpu: row.gpu ?? "GPU não detectada",
        rootFilesystem: row.root_filesystem ?? "unknown",
        rootTotalBytes: row.root_total_bytes ?? 0,
        rootFreeBytes: row.root_free_bytes ?? 0,
        packageManager: row.package_manager ?? "unknown",
        tools
    };
}

export function saveOllamaInfo(
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
            id, installed, version, service_running,
            api_available, model_installed, model_name, updated_at
        )
        VALUES (
            1, @installed, @version, @serviceRunning,
            @apiAvailable, @modelInstalled, @modelName, @updatedAt
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
