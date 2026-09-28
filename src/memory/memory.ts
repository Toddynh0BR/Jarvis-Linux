import * as path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR } from "../database/database";

export interface JarvisMemory {
    id: number;
    category: string;
    key: string;
    value: string;
    importance: number;
    updatedAt: string;
}

function openMemoryDatabase(): Database.Database {
    const db = new Database(path.join(DATA_DIR, "jarvis.db"));

    db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL,
            memory_key TEXT NOT NULL UNIQUE,
            value TEXT NOT NULL,
            importance INTEGER NOT NULL DEFAULT 5,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);

    return db;
}

export function saveMemory(
    category: string,
    key: string,
    value: string,
    importance = 5
): void {
    const cleanValue = value.trim();

    if (!cleanValue) {
        return;
    }

    const db = openMemoryDatabase();

    try {
        const now = new Date().toISOString();

        db.prepare(`
            INSERT INTO memories (
                category, memory_key, value, importance, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(memory_key)
            DO UPDATE SET
                category = excluded.category,
                value = excluded.value,
                importance = excluded.importance,
                updated_at = excluded.updated_at
        `).run(
            category,
            key,
            cleanValue,
            importance,
            now,
            now
        );
    } finally {
        db.close();
    }
}

export function deleteMemory(key: string): boolean {
    const db = openMemoryDatabase();

    try {
        const result = db
            .prepare("DELETE FROM memories WHERE memory_key = ?")
            .run(key);

        return result.changes > 0;
    } finally {
        db.close();
    }
}

export function listMemories(limit = 30): JarvisMemory[] {
    const db = openMemoryDatabase();

    try {
        return db.prepare(`
            SELECT
                id,
                category,
                memory_key AS key,
                value,
                importance,
                updated_at AS updatedAt
            FROM memories
            ORDER BY importance DESC, updated_at DESC
            LIMIT ?
        `).all(Math.max(1, Math.min(limit, 100))) as JarvisMemory[];
    } finally {
        db.close();
    }
}

export function findRelevantMemories(
    message: string,
    limit = 6
): JarvisMemory[] {
    const memories = listMemories(50);
    const terms = normalize(message)
        .split(/\s+/)
        .filter(term => term.length >= 3);

    if (terms.length === 0) {
        return memories.slice(0, limit);
    }

    return memories
        .map(memory => ({
            memory,
            score: scoreMemory(memory, terms)
        }))
        .filter(item => item.score > 0)
        .sort((a, b) =>
            b.score - a.score ||
            b.memory.importance - a.memory.importance
        )
        .slice(0, limit)
        .map(item => item.memory);
}

export function extractExplicitMemories(message: string): JarvisMemory[] {
    const patterns: Array<{
        pattern: RegExp;
        category: string;
        key: string;
        importance: number;
    }> = [
        {
            pattern: /\bmeu nome é\s+(.+?)(?:[.!?]|$)/i,
            category: "profile",
            key: "user.name",
            importance: 10
        },
        {
            pattern: /\beu moro em\s+(.+?)(?:[.!?]|$)/i,
            category: "profile",
            key: "user.location",
            importance: 8
        },
        {
            pattern: /\beu trabalho com\s+(.+?)(?:[.!?]|$)/i,
            category: "profile",
            key: "user.work",
            importance: 8
        },
        {
            pattern: /\beu gosto de\s+(.+?)(?:[.!?]|$)/i,
            category: "preference",
            key: "user.likes",
            importance: 7
        },
        {
            pattern: /\beu prefiro\s+(.+?)(?:[.!?]|$)/i,
            category: "preference",
            key: "user.preferences",
            importance: 7
        },
        {
            pattern: /\bmeu projeto é\s+(.+?)(?:[.!?]|$)/i,
            category: "project",
            key: "user.current_project",
            importance: 8
        }
    ];

    const extracted: JarvisMemory[] = [];

    for (const item of patterns) {
        const match = message.match(item.pattern);

        if (!match?.[1]) {
            continue;
        }

        const value = match[1].trim();

        if (value.length < 2 || value.length > 300) {
            continue;
        }

        extracted.push({
            id: 0,
            category: item.category,
            key: item.key,
            value,
            importance: item.importance,
            updatedAt: new Date().toISOString()
        });
    }

    return extracted;
}

export function saveExtractedMemories(message: string): number {
    const memories = extractExplicitMemories(message);

    for (const memory of memories) {
        saveMemory(
            memory.category,
            memory.key,
            memory.value,
            memory.importance
        );
    }

    return memories.length;
}

function scoreMemory(
    memory: JarvisMemory,
    terms: string[]
): number {
    const haystack = normalize(
        memory.category + " " + memory.key + " " + memory.value
    );

    return terms.reduce(
        (score, term) =>
            score + (haystack.includes(term) ? 1 : 0),
        0
    );
}

function normalize(value: string): string {
    return value
        .toLocaleLowerCase("pt-BR")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}
