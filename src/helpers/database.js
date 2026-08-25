const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Worker } = require("worker_threads");
const { app } = require("electron");
const {
  decryptTranscriptionRow,
  decryptTranscriptionText,
  encryptTranscriptionText,
  isEncryptedText,
} = require("./transcriptionCrypto");
const {
  MAX_HISTORY_CURSOR_LENGTH,
  decodeHistoryCursor,
  encodeHistoryCursor,
} = require("./historyCursor");

const ENCRYPTION_MIGRATION_BATCH_SIZE = 100;
const STATS_BACKFILL_BATCH_SIZE = 50;
const HISTORY_WORKER_TIMEOUT_MS = 10_000;

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

class DatabaseReadWorkerBridge {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.worker = null;
    this.startPromise = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  resolveWorkerPath() {
    const candidates = [
      path.join(__dirname, "databaseWorker.js"),
      path.join(__dirname, "..", "helpers", "databaseWorker.js"),
    ];
    for (const candidate of candidates) {
      const unpacked = candidate.replace(
        `${path.sep}app.asar${path.sep}`,
        `${path.sep}app.asar.unpacked${path.sep}`
      );
      if (fs.existsSync(unpacked)) return unpacked;
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  async start() {
    if (this.closed) throw new Error("Database read worker is closed");
    if (this.worker) return this.worker;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      const workerPath = this.resolveWorkerPath();
      if (!workerPath) throw new Error("Database read worker bundle not found");

      const worker = new Worker(workerPath, {
        env: { ...process.env },
      });
      this.worker = worker;
      worker.unref?.();
      worker.on("message", (message) => this.handleMessage(message));
      worker.once("error", (error) => this.handleWorkerFailure(error));
      worker.once("exit", (code) => {
        if (code !== 0) {
          this.handleWorkerFailure(new Error(`Database read worker exited with code ${code}`));
        }
      });

      await this.request("init", { dbPath: this.dbPath });
      return worker;
    })().finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  handleMessage(message = {}) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    const error = new Error(message.error?.message || "Database read worker request failed");
    if (message.error?.code) error.code = message.error.code;
    pending.reject(error);
  }

  handleWorkerFailure(error) {
    const worker = this.worker;
    this.worker = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (worker) {
      worker.removeAllListeners();
      worker.terminate().catch(() => {});
    }
  }

  request(type, options = {}) {
    if (!this.worker) return Promise.reject(new Error("Database read worker is not running"));
    const id = String(this.nextRequestId++);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Database read worker request timed out: ${type}`));
      }, HISTORY_WORKER_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.worker.postMessage({ id, type, ...(type === "init" ? options : { options }) });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async query(options = {}) {
    await this.start();
    return this.request("query", options);
  }

  async close() {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    try {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        worker.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        worker.postMessage({ id: String(this.nextRequestId++), type: "close" });
      });
    } catch {
      // Termination below is the final cleanup path.
    }
    await worker.terminate().catch(() => {});
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Database read worker closed"));
    }
    this.pending.clear();
  }
}

class DatabaseManager {
  constructor() {
    this.db = null;
    this.dbPath = null;
    this.readWorkerBridge = null;
    this.readWorkerDisabled = false;
    this.encryptionMigrationPromise = null;
    this.encryptionMigrationCancelled = false;
    this.statsBackfillPromise = null;
    this.statsBackfillCancelled = false;
    this.statsBackfillPending = false;
    this.initDatabase();
  }

  initDatabase() {
    try {
      const dbFileName =
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db";

      const dbPath = path.join(app.getPath("userData"), dbFileName);

      this.dbPath = dbPath;
      this.ensurePrivateDatabaseFile(dbPath);
      this.db = new Database(dbPath);
      this.hardenDatabasePermissions(dbPath);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS transcriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.ensureTranscriptionColumns();
      this.ensureIndexes();
      const encryptionMigration = this.scheduleEncryptionMigration();
      this.scheduleStatsBackfill(encryptionMigration);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS custom_dictionary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          word TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS onboarding_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_name TEXT NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS onboarding_telemetry_reports (
          event_name TEXT PRIMARY KEY,
          reported_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      return true;
    } catch (error) {
      console.error("Database initialization failed:", error.message);
      throw error;
    }
  }

  async getReadWorker() {
    if (this.readWorkerDisabled || !this.dbPath || !fs.existsSync(this.dbPath)) return null;
    if (!this.readWorkerBridge) {
      this.readWorkerBridge = new DatabaseReadWorkerBridge(this.dbPath);
    }
    try {
      await this.readWorkerBridge.start();
      return this.readWorkerBridge;
    } catch (error) {
      this.readWorkerDisabled = true;
      this.readWorkerBridge?.close().catch(() => {});
      console.warn(
        "Database read worker unavailable; falling back to main process reads:",
        error.message
      );
      return null;
    }
  }

  async queryHistoryRowsInWorker(options = {}) {
    const worker = await this.getReadWorker();
    if (!worker) return null;
    try {
      return await worker.query(options);
    } catch (error) {
      this.readWorkerDisabled = true;
      worker.close().catch(() => {});
      console.warn(
        "Database read worker query failed; falling back to main process:",
        error.message
      );
      return null;
    }
  }

  ensurePrivateDatabaseFile(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    if (!fs.existsSync(dbPath)) {
      fs.closeSync(fs.openSync(dbPath, "a", 0o600));
    }
  }

  hardenDatabasePermissions(dbPath = this.dbPath) {
    if (!dbPath) return;
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {}
  }

  ensureTranscriptionColumns() {
    const columns = this.db.prepare("PRAGMA table_info(transcriptions)").all();
    const columnNames = new Set(columns.map((column) => column.name));
    const isAddingStatsExclusion = !columnNames.has("exclude_from_stats");

    if (!columnNames.has("timestamp")) {
      this.db.exec("ALTER TABLE transcriptions ADD COLUMN timestamp DATETIME");
    }
    if (!columnNames.has("created_at")) {
      this.db.exec("ALTER TABLE transcriptions ADD COLUMN created_at DATETIME");
    }
    if (!columnNames.has("unit_count")) {
      this.db.exec("ALTER TABLE transcriptions ADD COLUMN unit_count INTEGER DEFAULT 0");
    }
    if (!columnNames.has("recording_duration_ms")) {
      this.db.exec(
        "ALTER TABLE transcriptions ADD COLUMN recording_duration_ms INTEGER DEFAULT NULL"
      );
    }
    if (!columnNames.has("favorite")) {
      this.db.exec("ALTER TABLE transcriptions ADD COLUMN favorite INTEGER DEFAULT 0");
    }
    if (isAddingStatsExclusion) {
      this.db.exec(
        "ALTER TABLE transcriptions ADD COLUMN exclude_from_stats INTEGER NOT NULL DEFAULT 0"
      );
    }
    if (!columnNames.has("estimated_typing_duration_ms")) {
      this.db.exec(
        "ALTER TABLE transcriptions ADD COLUMN estimated_typing_duration_ms INTEGER DEFAULT NULL"
      );
    }

    this.db.exec(`
      UPDATE transcriptions
      SET timestamp = COALESCE(timestamp, created_at, datetime('now'))
      WHERE timestamp IS NULL
    `);
    this.db.exec(`
      UPDATE transcriptions
      SET created_at = COALESCE(created_at, timestamp, datetime('now'))
      WHERE created_at IS NULL
    `);

    if (isAddingStatsExclusion) {
      // Older re-polish records were the only path that deliberately persisted
      // both values as zero. Keep genuine legacy dictations (duration NULL)
      // eligible for the unit-count fallback.
      this.db.exec(`
        UPDATE transcriptions
        SET exclude_from_stats = 1
        WHERE unit_count = 0 AND recording_duration_ms = 0
      `);
    }
  }

  ensureIndexes() {
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_transcriptions_created_at ON transcriptions(created_at)"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_transcriptions_favorite_created_at ON transcriptions(favorite, created_at)"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_transcriptions_history_keyset ON transcriptions(datetime(COALESCE(timestamp, created_at)) DESC, id DESC)"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_transcriptions_favorite_history_keyset ON transcriptions(favorite, datetime(COALESCE(timestamp, created_at)) DESC, id DESC)"
    );
  }

  scheduleEncryptionMigration() {
    if (this.encryptionMigrationPromise) {
      return this.encryptionMigrationPromise;
    }

    this.encryptionMigrationCancelled = false;
    this.encryptionMigrationPromise = yieldToEventLoop()
      .then(() => this.encryptExistingTranscriptionsInBackground())
      .catch((error) => {
        console.error("Background transcription encryption migration failed:", error.message);
      })
      .finally(() => {
        this.encryptionMigrationPromise = null;
      });
    return this.encryptionMigrationPromise;
  }

  async getPlaintextBackupPaths() {
    if (!this.dbPath) return [];
    const directory = path.dirname(this.dbPath);
    const prefix = `${path.basename(this.dbPath)}.plaintext-backup-`;
    const entries = await fs.promises.readdir(directory).catch(() => []);
    return entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => path.join(directory, entry));
  }

  async cleanupPlaintextBackups() {
    const backupPaths = await this.getPlaintextBackupPaths();
    const failed = [];
    for (const backupPath of backupPaths) {
      try {
        await fs.promises.rm(backupPath, { force: true });
      } catch (error) {
        failed.push(`${backupPath}: ${error.message}`);
      }
    }
    if (failed.length > 0) {
      console.warn("Could not remove plaintext transcription backups:", failed.join("; "));
    }
    return { removed: backupPaths.length - failed.length, failed };
  }

  async backupDatabaseBeforeEncryption() {
    if (!this.dbPath || !this.db || !fs.existsSync(this.dbPath)) return null;
    const existingBackups = await this.getPlaintextBackupPaths();
    if (existingBackups.length > 0) {
      return existingBackups[0];
    }

    const backupPath = `${this.dbPath}.plaintext-backup-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}`;
    if (typeof this.db.backup === "function") {
      await this.db.backup(backupPath);
    } else {
      await fs.promises.copyFile(this.dbPath, backupPath, fs.constants.COPYFILE_EXCL);
    }
    await fs.promises.chmod(backupPath, 0o600).catch(() => {});
    console.log(
      "Created temporary plaintext transcription DB backup before encryption:",
      backupPath
    );
    return backupPath;
  }

  async encryptExistingTranscriptionsInBackground() {
    if (!this.db || this.encryptionMigrationCancelled) return;
    const selectPlaintext = this.db.prepare(`
      SELECT id, text
      FROM transcriptions
      WHERE text IS NOT NULL AND text != '' AND substr(text, 1, 6) != 'encv1:'
      ORDER BY id ASC
      LIMIT ?
    `);
    const initialRows = selectPlaintext.all(1);
    if (initialRows.length === 0) {
      await this.cleanupPlaintextBackups();
      return;
    }

    await this.backupDatabaseBeforeEncryption();
    const update = this.db.prepare("UPDATE transcriptions SET text = ? WHERE id = ?");
    const encryptBatch = this.db.transaction((pendingRows) => {
      for (const row of pendingRows) {
        if (row?.text && !isEncryptedText(row.text)) {
          update.run(encryptTranscriptionText(row.text), row.id);
        }
      }
    });

    while (this.db && !this.encryptionMigrationCancelled) {
      const rows = selectPlaintext.all(ENCRYPTION_MIGRATION_BATCH_SIZE);
      if (rows.length === 0) {
        await this.cleanupPlaintextBackups();
        return;
      }
      encryptBatch(rows);
      await yieldToEventLoop();
    }
  }

  scheduleStatsBackfill(prerequisite = null) {
    if (this.statsBackfillPromise) {
      return this.statsBackfillPromise;
    }

    this.statsBackfillCancelled = false;
    this.statsBackfillPending = true;
    this.statsBackfillPromise = Promise.resolve(prerequisite)
      .then(() => yieldToEventLoop())
      .then(() => this.backfillLegacyTranscriptionStatsInBackground())
      .catch((error) => {
        console.error("Background transcription statistics backfill failed:", error.message);
      })
      .finally(() => {
        this.statsBackfillPending = false;
        this.statsBackfillPromise = null;
      });
    return this.statsBackfillPromise;
  }

  async backfillLegacyTranscriptionStatsInBackground() {
    if (!this.db || this.statsBackfillCancelled) return;

    const selectPending = this.db.prepare(`
      SELECT
        id,
        text,
        unit_count,
        recording_duration_ms,
        estimated_typing_duration_ms
      FROM transcriptions
      WHERE id > ?
        AND COALESCE(exclude_from_stats, 0) != 1
        AND (
          unit_count IS NULL
          OR unit_count <= 0
          OR estimated_typing_duration_ms IS NULL
          OR estimated_typing_duration_ms <= 0
        )
      ORDER BY id ASC
      LIMIT ?
    `);
    const updateStats = this.db.prepare(`
      UPDATE transcriptions
      SET unit_count = ?, estimated_typing_duration_ms = ?
      WHERE id = ?
    `);
    const updateBatch = this.db.transaction((rows) => {
      for (const row of rows) {
        const text = decryptTranscriptionText(row.text, {
          allowKeychain: false,
          allowCreate: false,
        });
        const storedUnits = Number(row.unit_count);
        const unitCount =
          Number.isFinite(storedUnits) && storedUnits > 0
            ? Math.round(storedUnits)
            : this.countTextUnits(text);
        const storedTypingDurationMs = Number(row.estimated_typing_duration_ms);
        const typingDurationMs =
          Number.isFinite(storedTypingDurationMs) && storedTypingDurationMs > 0
            ? Math.round(storedTypingDurationMs)
            : this.estimateTypingDurationMs(text);
        updateStats.run(unitCount, typingDurationMs, row.id);
      }
    });

    let lastId = 0;
    while (this.db && !this.statsBackfillCancelled) {
      const rows = selectPending.all(lastId, STATS_BACKFILL_BATCH_SIZE);
      if (rows.length === 0) {
        return;
      }
      updateBatch(rows);
      lastId = Number(rows[rows.length - 1].id) || lastId;
      await yieldToEventLoop();
    }
  }

  saveTranscription(text, metadata = {}) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const normalizedText = typeof text === "string" ? text : "";
      const encryptedText = encryptTranscriptionText(normalizedText);
      const unitCount = Number.isFinite(Number(metadata.unitCount))
        ? Math.max(0, Math.round(Number(metadata.unitCount)))
        : this.countTextUnits(normalizedText);
      const recordingDurationMs = Number.isFinite(Number(metadata.recordingDurationMs))
        ? Math.max(0, Math.round(Number(metadata.recordingDurationMs)))
        : null;
      const excludeFromStats = metadata.excludeFromStats === true ? 1 : 0;
      const estimatedTypingDurationMs = Number.isFinite(Number(metadata.estimatedTypingDurationMs))
        ? Math.max(0, Math.round(Number(metadata.estimatedTypingDurationMs)))
        : this.estimateTypingDurationMs(normalizedText);

      const stmt = this.db.prepare(
        `INSERT INTO transcriptions
          (text, unit_count, recording_duration_ms, exclude_from_stats, estimated_typing_duration_ms)
         VALUES (?, ?, ?, ?, ?)`
      );
      const result = stmt.run(
        encryptedText,
        unitCount,
        recordingDurationMs,
        excludeFromStats,
        estimatedTypingDurationMs
      );

      const fetchStmt = this.db.prepare("SELECT * FROM transcriptions WHERE id = ?");
      const transcription = decryptTranscriptionRow(fetchStmt.get(result.lastInsertRowid));

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
      const transcriptions = stmt.all(limit).map((row) => decryptTranscriptionRow(row));
      return transcriptions;
    } catch (error) {
      console.error("Error getting transcriptions:", error.message);
      throw error;
    }
  }

  buildHistoryWhere(options = {}, cursor = null) {
    const clauses = [];
    const params = [];
    if (options.favoriteOnly === true) {
      clauses.push("favorite = 1");
    }
    const sinceDate = options.since ? this.parseDbTimestamp(options.since) : null;
    if (sinceDate) {
      clauses.push("datetime(COALESCE(timestamp, created_at)) >= datetime(?)");
      params.push(sinceDate.toISOString());
    }
    if (cursor) {
      clauses.push(
        "(datetime(COALESCE(timestamp, created_at)) < datetime(?) OR (datetime(COALESCE(timestamp, created_at)) = datetime(?) AND id < ?))"
      );
      params.push(cursor.timestamp, cursor.timestamp, cursor.id);
    }
    return {
      whereClause: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
      params,
    };
  }

  async queryHistoryRowsOnMain(options = {}) {
    const limit = Math.max(1, Math.floor(Number(options.limit) || 50));
    const cursor = options.cursor || null;
    const { whereClause, params } = this.buildHistoryWhere(options, cursor);
    const orderClause = "ORDER BY datetime(COALESCE(timestamp, created_at)) DESC, id DESC";
    const statement = cursor
      ? this.db.prepare(`SELECT * FROM transcriptions ${whereClause} ${orderClause} LIMIT ?`)
      : this.db.prepare(
          `SELECT * FROM transcriptions ${whereClause} ${orderClause} LIMIT ? OFFSET ?`
        );
    const rows = cursor
      ? statement.all(...params, limit + 1)
      : statement.all(...params, limit + 1, Math.max(0, Math.floor(Number(options.offset) || 0)));

    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM transcriptions ${this.buildHistoryWhere(options).whereClause}`
      )
      .get(...this.buildHistoryWhere(options).params);
    return {
      rows,
      hasMore: rows.length > limit,
      totalCount: Math.max(0, Number(totalRow?.count) || 0),
    };
  }

  async queryHistoryRows(options = {}) {
    const workerResult = await this.queryHistoryRowsInWorker(options);
    if (workerResult) return workerResult;
    return this.queryHistoryRowsOnMain(options);
  }

  async queryTranscriptionHistory(options = {}) {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const query = String(options.query || "")
      .trim()
      .toLowerCase();
    const limitCap = Math.max(1, Math.floor(Number(options.limitCap) || 200));
    const limit = Math.max(1, Math.min(limitCap, Math.floor(Number(options.limit) || 50)));
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const rawCursor = String(options.cursor || "")
      .trim()
      .slice(0, MAX_HISTORY_CURSOR_LENGTH);
    const decodedCursor = decodeHistoryCursor(rawCursor);
    const cursor = decodedCursor || null;
    const baseOptions = {
      favoriteOnly: options.favoriteOnly === true,
      since: options.since || null,
      limit,
      offset: query ? 0 : cursor ? 0 : offset,
    };

    if (!query) {
      const result = await this.queryHistoryRows({ ...baseOptions, cursor });
      const visibleRows = result.rows.slice(0, limit);
      const hasMore = result.hasMore === true;
      return {
        items: visibleRows.map((row) => decryptTranscriptionRow(row)),
        hasMore,
        nextCursor: hasMore ? encodeHistoryCursor(visibleRows[visibleRows.length - 1]) : null,
        totalCount: Math.max(0, Number(result.totalCount) || 0),
        truncated: false,
        cancelled: false,
      };
    }

    // Text is encrypted at rest, so search decrypts only bounded keyset pages
    // in the main process. The database worker performs the SQLite scan off
    // the Electron event loop, while the cursor prevents OFFSET degradation.
    const scanBatchSize = Math.max(50, Math.min(200, limit * 4));
    const items = [];
    let scanCursor = cursor;
    let matchedCount = 0;
    let legacyOffset = 0;

    while (true) {
      if (options.shouldCancel?.()) {
        return {
          items: [],
          hasMore: false,
          nextCursor: null,
          totalCount: null,
          truncated: false,
          cancelled: true,
        };
      }

      const result = await this.queryHistoryRows({
        ...baseOptions,
        limit: scanBatchSize,
        offset: legacyOffset,
        cursor: scanCursor,
      });
      const rows = result.rows || [];
      let lastScannedRow = null;
      for (const row of rows) {
        lastScannedRow = row;
        const decrypted = decryptTranscriptionRow(row);
        if (
          !String(decrypted.text || "")
            .toLowerCase()
            .includes(query)
        )
          continue;

        const matchIndex = matchedCount;
        matchedCount += 1;
        if (matchIndex < offset && !cursor) continue;
        items.push(decrypted);
        if (items.length >= limit) {
          const nextCursor = result.hasMore ? encodeHistoryCursor(lastScannedRow) : null;
          return {
            items,
            hasMore: Boolean(nextCursor),
            nextCursor,
            totalCount: null,
            truncated: false,
            cancelled: false,
          };
        }
      }

      if (!result.hasMore || rows.length === 0) break;
      const lastRow = rows[rows.length - 1];
      scanCursor = {
        timestamp: String(lastRow?.timestamp || lastRow?.created_at || ""),
        id: Number(lastRow?.id),
      };
      legacyOffset += rows.length;
      await yieldToEventLoop();
    }

    return {
      items,
      hasMore: false,
      nextCursor: null,
      totalCount: cursor ? null : matchedCount,
      truncated: false,
      cancelled: false,
    };
  }

  async searchTranscriptions(query, limit = 50) {
    try {
      return await this.queryTranscriptionHistory({ query, limit });
    } catch (error) {
      console.error("Error searching transcriptions:", error.message);
      return {
        items: [],
        hasMore: false,
        totalCount: 0,
        truncated: false,
        cancelled: false,
      };
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

  estimateTypingDurationMs(text) {
    const normalized = typeof text === "string" ? text.trim() : "";
    if (!normalized) return 0;

    const units =
      normalized.match(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+/gu
      ) || [];
    let characterUnits = 0;
    let wordUnits = 0;
    for (const unit of units) {
      if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(unit)) {
        characterUnits += 1;
      } else {
        wordUnits += 1;
      }
    }

    // Typing estimates are intentionally language-aware: character-based
    // scripts and space-delimited words use separate, conservative baselines.
    const CHARACTER_UNITS_PER_MINUTE = 50;
    const WORD_UNITS_PER_MINUTE = 40;
    return Math.max(
      0,
      Math.round(
        (characterUnits / CHARACTER_UNITS_PER_MINUTE + wordUnits / WORD_UNITS_PER_MINUTE) * 60_000
      )
    );
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

      const now = new Date();
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);
      const aggregate =
        this.db
          .prepare(
            `
              SELECT
                COUNT(*) AS total_entries,
                COALESCE(SUM(CASE WHEN unit_count > 0 THEN unit_count ELSE 0 END), 0) AS total_units,
                COALESCE(SUM(CASE
                  WHEN datetime(COALESCE(timestamp, created_at)) >= datetime(?)
                    AND unit_count > 0
                  THEN unit_count
                  ELSE 0
                END), 0) AS today_units,
                COALESCE(SUM(CASE
                  WHEN datetime(COALESCE(timestamp, created_at)) >= datetime(?)
                  THEN 1
                  ELSE 0
                END), 0) AS today_entries,
                COALESCE(SUM(CASE
                  WHEN recording_duration_ms > 0 THEN recording_duration_ms
                  ELSE 0
                END), 0) AS total_recording_duration_ms,
                COALESCE(SUM(CASE
                  WHEN recording_duration_ms > 0 AND unit_count > 0 THEN unit_count
                  ELSE 0
                END), 0) AS speed_units,
                COALESCE(SUM(CASE
                  WHEN recording_duration_ms > 0 AND estimated_typing_duration_ms > 0
                  THEN estimated_typing_duration_ms
                  ELSE 0
                END), 0) AS estimated_typing_duration_ms,
                MAX(COALESCE(timestamp, created_at)) AS last_updated_at
              FROM transcriptions
              WHERE COALESCE(exclude_from_stats, 0) != 1
            `
          )
          .get(startOfToday.toISOString(), startOfToday.toISOString()) || {};

      const todayUnits = Math.max(0, Number(aggregate.today_units) || 0);
      const totalUnits = Math.max(0, Number(aggregate.total_units) || 0);
      const todayEntries = Math.max(0, Number(aggregate.today_entries) || 0);
      const totalEntries = Math.max(0, Number(aggregate.total_entries) || 0);
      const totalRecordingDurationMs = Math.max(
        0,
        Math.round(Number(aggregate.total_recording_duration_ms) || 0)
      );
      const speedUnits = Math.max(0, Number(aggregate.speed_units) || 0);
      const estimatedTypingDurationMs = Math.max(
        0,
        Math.round(Number(aggregate.estimated_typing_duration_ms) || 0)
      );
      const lastUpdatedDate = this.parseDbTimestamp(aggregate.last_updated_at);
      const lastUpdatedAt = lastUpdatedDate ? lastUpdatedDate.toISOString() : null;

      const averageDictationUnitsPerMinute =
        totalRecordingDurationMs > 0 ? (speedUnits * 60000) / totalRecordingDurationMs : 0;
      const estimatedTimeSavedMs = Math.max(
        0,
        estimatedTypingDurationMs - totalRecordingDurationMs
      );

      return {
        todayUnits,
        totalUnits,
        todayEntries,
        totalEntries,
        totalRecordingDurationMs,
        estimatedTimeSavedMs,
        averageDictationUnitsPerMinute: Math.max(0, averageDictationUnitsPerMinute),
        lastUpdatedAt,
        statsBackfillPending: this.statsBackfillPending === true,
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

  setTranscriptionFavorite(id, favorite) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const val = favorite ? 1 : 0;
      const stmt = this.db.prepare("UPDATE transcriptions SET favorite = ? WHERE id = ?");
      const result = stmt.run(val, id);
      console.log(
        `⭐ Updated favorite for transcription ${id} to ${val}, affected rows: ${result.changes}`
      );
      return { success: result.changes > 0, id, favorite: val };
    } catch (error) {
      console.error("❌ Error updating transcription favorite:", error);
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

  async cleanup() {
    console.log("Starting database cleanup...");
    try {
      await this.close();
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

  async close() {
    this.encryptionMigrationCancelled = true;
    this.statsBackfillCancelled = true;
    if (this.readWorkerBridge) {
      await this.readWorkerBridge.close().catch(() => {});
      this.readWorkerBridge = null;
    }
    if (this.encryptionMigrationPromise) {
      await this.encryptionMigrationPromise.catch(() => {});
    }
    if (this.statsBackfillPromise) {
      await this.statsBackfillPromise.catch(() => {});
    }
    if (!this.db) {
      return;
    }
    this.db.close();
    this.db = null;
  }

  trackOnboardingEvent(eventName) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      // Funnel events are first-reach timestamps: idempotent per event name so
      // re-entering a step, restarting onboarding, or renderer races never
      // inflate the funnel. first_successful_dictation only counts for installs
      // that actually went through onboarding, keeping upgrade users out of the
      // funnel denominator. Timestamps are stored as explicit ISO-8601 UTC so
      // renderers can parse them unambiguously.
      // first_dictation_attempt shares the gate so the attempt/success pair
      // measures the same population and their ratio reads as a success rate.
      const requiresOnboardingStart =
        eventName === "first_successful_dictation" || eventName === "first_dictation_attempt";
      const stmt = this.db.prepare(`
        INSERT INTO onboarding_events (event_name, timestamp)
        SELECT @eventName, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE NOT EXISTS (
          SELECT 1 FROM onboarding_events WHERE event_name = @eventName
        )
        ${
          requiresOnboardingStart
            ? "AND EXISTS (SELECT 1 FROM onboarding_events WHERE event_name = 'onboarding_started')"
            : ""
        }
      `);
      const info = stmt.run({ eventName });
      return { success: true, recorded: info.changes > 0 };
    } catch (error) {
      console.error("Error tracking onboarding event:", error.message);
      return { success: false, error: error.message };
    }
  }

  getOnboardingEvents() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare("SELECT * FROM onboarding_events ORDER BY timestamp ASC");
      return stmt.all();
    } catch (error) {
      console.error("Error getting onboarding events:", error.message);
      return [];
    }
  }

  getUnreportedOnboardingEvents() {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare(`
        SELECT DISTINCT events.event_name
        FROM onboarding_events AS events
        LEFT JOIN onboarding_telemetry_reports AS reports
          ON reports.event_name = events.event_name
        WHERE reports.event_name IS NULL
        ORDER BY events.timestamp ASC
      `);
      return stmt.all().map((row) => row.event_name);
    } catch (error) {
      console.error("Error getting pending onboarding telemetry:", error.message);
      return [];
    }
  }

  markOnboardingEventReported(eventName) {
    try {
      if (!this.db) {
        throw new Error("Database not initialized");
      }
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO onboarding_telemetry_reports (event_name, reported_at)
        VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      `);
      const info = stmt.run(eventName);
      return { success: true, recorded: info.changes > 0 };
    } catch (error) {
      console.error("Error marking onboarding telemetry as reported:", error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = DatabaseManager;
