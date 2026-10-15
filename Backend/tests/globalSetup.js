// Builds a fresh bongalink_test database from the schema dump + migrations.
const path = require("path");
const mysql = require("mysql2/promise");
const { runSqlFile } = require("./sqlLoader");

module.exports = async () => {
  require("./setupEnv");
  const db = path.join(__dirname, "..", "database");
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true
  });
  try {
    await connection.query("DROP DATABASE IF EXISTS bongalink_test");
    await connection.query("CREATE DATABASE bongalink_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    await connection.query("USE bongalink_test");
    await runSqlFile(connection, path.join(db, "bongalink_schema.sql"));
    await runSqlFile(connection, path.join(db, "migrations", "003_ml_sync.sql"));
    await runSqlFile(connection, path.join(db, "migrations", "004_api_integrations.sql"));
    await runSqlFile(connection, path.join(db, "migrations", "005_product_history.sql"));
    await runSqlFile(connection, path.join(db, "migrations", "006_chatbot.sql"));
  } finally {
    await connection.end();
  }
};
