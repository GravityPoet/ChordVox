const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { app } = require("electron");

class DatabaseManager {
  constructor() {
    this.db = null;
    this.initDatabase();
  }

  initDatabase() {
    try {
      const dbFileName =
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db";

      const dbPath = path.join(app.getPath("userData"), dbFileName);

      this.db = new Database(dbPath);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS transcriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.ensureTranscriptionColumns();

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS custom_dictionary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          word TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      return true;
    } catch (error) {
      console.error("Database initialization failed:", error.message);
      throw error;
    }
  }

  ensureTranscriptionColumns() {
    const columns = this.db.prepare("PRAGMA table_info(transcriptions)").all();
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has("unit_count")) {
      this.db.exec("ALTER TABLE transcriptions ADD COLUMN unit_count INTEGER DEFAULT 0");
    }
    if (!columnNames.has("recording_duration_ms")) {
      this.db.exec(
        "ALTER TABLE transcriptions ADD COLUMN recording_duration_ms INTEGER DEFAULT NULL"
      );
    }
  }

  saveTranscription(text, metadata = {}) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const normalizedText = typeof text === "string" ? text : "";
      const unitCount = Number.isFinite(Number(metadata.unitCount))
        ? Math.max(0, Math.round(Number(metadata.unitCount)))
        : this.countTextUnits(normalizedText);
      const recordingDurationMs = Number.isFinite(Number(metadata.recordingDurationMs))
        ? Math.max(0, Math.round(Number(metadata.recordingDurationMs)))
        : null;

      const stmt = this.db.prepare(
        "INSERT INTO transcriptions (text, unit_count, recording_duration_ms) VALUES (?, ?, ?)"
      );
      const result = stmt.run(normalizedText, unitCount, recordingDurationMs);

      const fetchStmt = this.db.prepare("SELECT * FROM transcriptions WHERE id = ?");
      const transcription = fetchStmt.get(result.lastInsertRowid);

      return { id: result.lastInsertRowid, success: true, transcription };
    } catch (error) {
      console.error("Error saving transcription:", error.message);
      throw error;
    }
  }

  getTranscriptions(limit = 50) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("SELECT * FROM transcriptions ORDER BY timestamp DESC LIMIT ?");
      const transcriptions = stmt.all(limit);
      return transcriptions;
    } catch (error) {
      console.error("Error getting transcriptions:", error.message);
      throw error;
    }
  }

  countTextUnits(text) {
    const normalized = typeof text === "string" ? text.trim() : "";
    if (!normalized) return 0;

    const matches = normalized.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+/gu
    );
    return matches ? matches.length : 0;
  }

  parseDbTimestamp(value) {
    if (!value) return null;
    const normalized = String(value).includes("T")
      ? String(value)
      : `${String(value).replace(" ", "T")}Z`;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  getTranscriptionStats() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }

      const rows = this.db
        .prepare("SELECT text, created_at, timestamp FROM transcriptions ORDER BY created_at DESC")
        .all();

      const now = new Date();
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);

      let todayUnits = 0;
      let totalUnits = 0;
      let todayEntries = 0;
      let totalEntries = 0;
      let totalRecordingDurationMs = 0;
      let lastUpdatedAt = null;

      for (const row of rows) {
        const computedUnits = this.countTextUnits(row.text);
        const storedUnits = Number(row.unit_count);
        const units =
          Number.isFinite(storedUnits) && (storedUnits > 0 || computedUnits === 0)
            ? Math.max(0, Math.round(storedUnits))
            : computedUnits;
        totalUnits += units;
        totalEntries += 1;

        if (Number.isFinite(Number(row.recording_duration_ms))) {
          totalRecordingDurationMs += Math.max(0, Math.round(Number(row.recording_duration_ms)));
        }

        const createdAt = this.parseDbTimestamp(row.created_at || row.timestamp);
        if (!lastUpdatedAt && createdAt) {
          lastUpdatedAt = createdAt.toISOString();
        }

        if (createdAt && createdAt >= startOfToday) {
          todayUnits += units;
          todayEntries += 1;
        }
      }

      const typingBaselineUnitsPerMinute = 80;
      const averageDictationUnitsPerMinute =
        totalRecordingDurationMs > 0 ? (totalUnits * 60000) / totalRecordingDurationMs : 0;
      const estimatedTypingDurationMs =
        totalUnits > 0 ? (totalUnits / typingBaselineUnitsPerMinute) * 60 * 1000 : 0;
      const estimatedTimeSavedMs = Math.max(0, estimatedTypingDurationMs - totalRecordingDurationMs);

      return {
        todayUnits,
        totalUnits,
        todayEntries,
        totalEntries,
        totalRecordingDurationMs,
        estimatedTimeSavedMs,
        averageDictationUnitsPerMinute: Math.max(0, averageDictationUnitsPerMinute),
        lastUpdatedAt,
      };
    } catch (error) {
      console.error("Error getting transcription stats:", error.message);
      throw error;
    }
  }

  clearTranscriptions() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("DELETE FROM transcriptions");
      const result = stmt.run();
      return { cleared: result.changes, success: true };
    } catch (error) {
      console.error("Error clearing transcriptions:", error.message);
      throw error;
    }
  }

  deleteTranscription(id) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("DELETE FROM transcriptions WHERE id = ?");
      const result = stmt.run(id);
      console.log(`🗑️ Deleted transcription ${id}, affected rows: ${result.changes}`);
      return { success: result.changes > 0, id };
    } catch (error) {
      console.error("❌ Error deleting transcription:", error);
      throw error;
    }
  }

  getDictionary() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("SELECT word FROM custom_dictionary ORDER BY id ASC");
      const rows = stmt.all();
      return rows.map((row) => row.word);
    } catch (error) {
      console.error("Error getting dictionary:", error.message);
      throw error;
    }
  }

  setDictionary(words) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const transaction = this.db.transaction((wordList) => {
        this.db.prepare("DELETE FROM custom_dictionary").run();
        const insert = this.db.prepare("INSERT OR IGNORE INTO custom_dictionary (word) VALUES (?)");
        for (const word of wordList) {
          const trimmed = typeof word === "string" ? word.trim() : "";
          if (trimmed) {
            insert.run(trimmed);
          }
        }
      });
      transaction(words);
      return { success: true };
    } catch (error) {
      console.error("Error setting dictionary:", error.message);
      throw error;
    }
  }

  cleanup() {
    console.log("Starting database cleanup...");
    try {
      const dbPath = path.join(
        app.getPath("userData"),
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
      );
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
        console.log("✅ Database file deleted:", dbPath);
      }
    } catch (error) {
      console.error("❌ Error deleting database file:", error);
    }
  }
}

module.exports = DatabaseManager;
