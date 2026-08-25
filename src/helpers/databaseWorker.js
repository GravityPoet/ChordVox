const { parentPort } = require("worker_threads");
const Database = require("better-sqlite3");

let db = null;

function send(message) {
  parentPort?.postMessage(message);
}

function serializeError(error) {
  return {
    message: error?.message || String(error || "Unknown database worker error"),
    code: error?.code || null,
  };
}

function normalizeLimit(value, fallback = 50) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(200, Math.floor(numeric)));
}

function buildWhere(options = {}) {
  const clauses = [];
  const params = [];

  if (options.favoriteOnly === true) {
    clauses.push("favorite = 1");
  }
  if (options.since) {
    clauses.push("datetime(COALESCE(timestamp, created_at)) >= datetime(?)");
    params.push(String(options.since));
  }

  const cursor = options.cursor;
  if (cursor && Number.isSafeInteger(Number(cursor.id)) && cursor.timestamp) {
    clauses.push(
      "(datetime(COALESCE(timestamp, created_at)) < datetime(?) OR (datetime(COALESCE(timestamp, created_at)) = datetime(?) AND id < ?))"
    );
    params.push(String(cursor.timestamp), String(cursor.timestamp), Number(cursor.id));
  }

  return {
    whereClause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function queryRows(options = {}) {
  if (!db) throw new Error("Database worker is not initialized");

  const limit = normalizeLimit(options.limit);
  const { whereClause, params } = buildWhere(options);
  const orderClause = "ORDER BY datetime(COALESCE(timestamp, created_at)) DESC, id DESC";
  const offset = options.cursor ? 0 : Math.max(0, Math.floor(Number(options.offset) || 0));
  const rows = db
    .prepare(`SELECT * FROM transcriptions ${whereClause} ${orderClause} LIMIT ? OFFSET ?`)
    .all(...params, limit + 1, offset);
  const totalWhere = buildWhere({
    favoriteOnly: options.favoriteOnly,
    since: options.since,
  });
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS count FROM transcriptions ${totalWhere.whereClause}`)
    .get(...totalWhere.params);

  return {
    rows: rows.slice(0, limit),
    hasMore: rows.length > limit,
    totalCount: Math.max(0, Number(totalRow?.count) || 0),
  };
}

parentPort?.on("message", (message = {}) => {
  const id = message.id;
  try {
    if (message.type === "init") {
      if (db) db.close();
      db = new Database(String(message.dbPath || ""), {
        readonly: true,
        fileMustExist: true,
      });
      db.pragma("busy_timeout = 5000");
      send({ id, ok: true, result: { ready: true } });
      return;
    }

    if (message.type === "query") {
      send({ id, ok: true, result: queryRows(message.options || {}) });
      return;
    }

    if (message.type === "close") {
      if (db) db.close();
      db = null;
      send({ id, ok: true, result: { closed: true } });
      return;
    }

    throw new Error(`Unknown database worker command: ${message.type}`);
  } catch (error) {
    send({ id, ok: false, error: serializeError(error) });
  }
});
