// Retraining on demand (REQ028): the "Update forecasts & trends" button queues one run for
// the ML worker; a second is refused while one is queued or training (by the database
// itself); runs and their accuracy are reported; non-admins are blocked; the startup line.
// The training itself, the automatic triggers and failure handling are tested with the
// worker in ml/worker/tests/test_integration.py.
const request = require("supertest");
const app = require("../server");
const { mlStatusLine } = require("../lib/mlStatus");
const { pool, resetDb, createUser } = require("./helpers");

const API = "/api/admin/ml/training";
const raw = async (sql, params = []) => (await pool.query(sql, params))[0];
const setStatus = (fields) => pool.query("UPDATE ml_status SET ? WHERE id = 1", [fields]);
const workerAlive = () => setStatus({ heartbeat_at: new Date() });

beforeEach(async () => {
  await resetDb();
  await pool.query("DELETE FROM ml_model_versions");
  await setStatus({ state: "up_to_date", heartbeat_at: null, last_train_at: null, last_train_status: null, last_train_message: null,
    auto_retrain_hour: 2, auto_retrain_orders: 50, auto_retrain_stock_changes: 100, sold_orders_at_last_train: 0, event_id_at_last_train: 0 });
});
afterAll(() => pool.end());

describe("Update forecasts & trends", () => {
  test("queues exactly one run, recorded in the admin audit log", async () => {
    await workerAlive();
    const admin = await createUser({ role: "admin" });
    const res = await request(app).post(API).set("Authorization", admin.auth);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ worker_online: true,
      run: { trigger_type: "manual", requested_by: admin.username, status: "queued", outcome: null } });
    expect(await raw("SELECT trigger_type, status, requested_by FROM ml_training_runs"))
      .toEqual([{ trigger_type: "manual", status: "queued", requested_by: admin.id }]);
    expect(await raw("SELECT admin_id, action, target_user_id, target_label, new_value FROM admin_audit_log"))
      .toEqual([{ admin_id: admin.id, action: "ml_retrain", target_user_id: null, target_label: "Stock forecasts",
                  new_value: { run_id: res.body.run.run_id } }]);
  });

  test("a second run is refused while one is queued or training, even from another admin at the same moment", async () => {
    await workerAlive();
    const a = await createUser({ role: "admin" });
    const b = await createUser({ role: "admin" });
    const results = await Promise.all([a, b, a].map((who) => request(app).post(API).set("Authorization", who.auth)));
    expect(results.map((r) => r.status).sort()).toEqual([202, 409, 409]);
    expect((await raw("SELECT COUNT(*) AS n FROM ml_training_runs"))[0].n).toBe(1);

    await pool.query("UPDATE ml_training_runs SET status = 'training', started_at = NOW(3)");
    const again = await request(app).post(API).set("Authorization", b.auth);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "RETRAIN_IN_PROGRESS", run: { status: "training" } });
    expect(again.body.error).toMatch(/^A retrain is already running, started by (admin\d+)\. Wait for it to finish\.$/);

    // The database itself refuses a second active run (e.g. the worker's automatic trigger).
    await expect(pool.query("INSERT INTO ml_training_runs (trigger_type, status) VALUES ('nightly', 'training')"))
      .rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    // Once it's done, the button works again.
    await pool.query("UPDATE ml_training_runs SET status = 'done', outcome = 'promoted', finished_at = NOW(3)");
    expect((await request(app).post(API).set("Authorization", b.auth)).status).toBe(202);
  });

  test("a run stuck because the worker died long ago doesn't block the button forever", async () => {
    const admin = await createUser({ role: "admin" });
    await setStatus({ heartbeat_at: new Date(Date.now() - 30 * 60 * 1000) });   // silent for 30 minutes
    await pool.query("INSERT INTO ml_training_runs (trigger_type, status, started_at) VALUES ('nightly', 'training', NOW(3))");
    const res = await request(app).post(API).set("Authorization", admin.auth);
    expect(res.status).toBe(202);
    expect(res.body.worker_online).toBe(false);
    const [old] = await raw("SELECT status, outcome, message FROM ml_training_runs ORDER BY run_id LIMIT 1");
    expect(old).toMatchObject({ status: "failed", outcome: "failed" });
    expect(old.message).toContain("stopped before finishing");
  });

  test("progress, history, accuracy and the automatic triggers are reported", async () => {
    await workerAlive();
    const admin = await createUser({ role: "admin" });
    await pool.query(`INSERT INTO ml_model_versions (version, file_path, trained_with, data_source, train_rows, val_rows, val_mae, baseline_val_mae, status)
                      VALUES ('v-old', 'a.json', 'tf', 'mysql', 3000, 1500, 0.30, 0.31, 'retired'),
                             ('v-new', 'b.json', 'tensorflow 2.21.0', 'mysql', 3649, 1798, 0.249, 0.253, 'active')`);
    await pool.query(`INSERT INTO ml_training_runs (trigger_type, trigger_detail, status, outcome, model_version, sales_records, orders_used,
                        products_used, train_rows, val_rows, data_from, data_to, val_mae, baseline_val_mae, naive_val_mae, message,
                        started_at, finished_at)
                      VALUES ('nightly', 'nightly retraining (after 02:00)', 'done', 'promoted', 'v-new', 412, 168, 67, 3649, 1798,
                        '2026-01-02', '2026-10-13', 0.249, 0.253, 0.401, 'Model v-new promoted', NOW(3), NOW(3)),
                             ('new_data', '50 new paid orders since the last training', 'failed', 'failed', NULL, NULL, NULL, NULL, NULL, NULL,
                        NULL, NULL, NULL, NULL, NULL, 'Retraining failed, kept the active model: RuntimeError: boom', NOW(3), NOW(3))`);
    await setStatus({ last_train_at: new Date(), last_train_status: "failed", last_train_message: "Retraining failed, kept the active model: RuntimeError: boom",
                      auto_retrain_orders: 5, auto_retrain_stock_changes: 3, sold_orders_at_last_train: 1, event_id_at_last_train: 0 });
    for (let i = 0; i < 3; i++) await pool.query("INSERT INTO orders (user_id, status, total_amount) VALUES (?, 'paid', 100)", [admin.id]);
    await pool.query("INSERT INTO orders (user_id, status, total_amount) VALUES (?, 'pending_payment', 100)", [admin.id]);   // not a sale

    const body = (await request(app).get(API).set("Authorization", admin.auth)).body;
    expect(body.current).toBeNull();
    expect(body.runs.map((r) => [r.trigger_type, r.status, r.outcome])).toEqual([["new_data", "failed", "failed"], ["nightly", "done", "promoted"]]);
    // A failed run leaves the model in use, and says why.
    expect(body.model).toMatchObject({ version: "v-new", val_mae: 0.249, train_rows: 3649 });
    expect(body.last_result).toEqual({ status: "failed", message: "Retraining failed, kept the active model: RuntimeError: boom" });
    expect(body.last_completed).toMatchObject({ model_version: "v-new", sales_records: 412, orders_used: 167 + 1, products_used: 67,
      val_mae: 0.249, baseline_val_mae: 0.253, naive_val_mae: 0.401 });
    expect(body.auto).toEqual({ nightly_hour: 2, new_orders: { threshold: 5, since_last: 2 }, stock_changes: { threshold: 3, since_last: 0 } });
    expect(body.worker_online).toBe(true);
  });
});

describe("admins only", () => {
  test("customers get 403, guests 401, and nothing is queued", async () => {
    const customer = await createUser();
    expect((await request(app).post(API).set("Authorization", customer.auth)).status).toBe(403);
    expect((await request(app).get(API).set("Authorization", customer.auth)).status).toBe(403);
    expect((await request(app).post(API)).status).toBe(401);
    expect(await raw("SELECT * FROM ml_training_runs")).toEqual([]);
  });
});

describe("startup status line", () => {
  test("worker running, not running, and an unreadable database", async () => {
    await pool.query(`INSERT INTO ml_model_versions (version, file_path, trained_with, data_source, status)
                      VALUES ('v20261014-211029-815', 'b.json', 'tf', 'mysql', 'active')`);
    await setStatus({ heartbeat_at: new Date(), last_train_at: "2026-10-14 21:10:34", last_train_status: "promoted" });
    expect(await mlStatusLine(pool)).toBe("ML:         enabled (worker running; last trained 2026-10-14 21:10 (promoted); model v20261014-211029-815)");
    await setStatus({ heartbeat_at: "2026-10-14 23:47:59" });
    expect(await mlStatusLine(pool)).toMatch(/^ML: {9}worker not running \(last seen 2026-10-14 23:47; last trained 2026-10-14 21:10 \(promoted\); model v20261014-211029-815\)\. Start it:/);
    const broken = { query: () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })) };
    expect(await mlStatusLine(broken)).toBe("ML:         unknown (could not read ml_status: ECONNREFUSED)");
  });
});
