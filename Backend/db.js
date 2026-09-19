/* =====================================================================
   db.js — MySQL connection pool
   Reads connection details ONLY from environment variables (.env).
   This is the file that makes "dev locally now, host later" painless:
   the pool config below never hardcodes a host/user/password — so
   when you move to Hostinger/AWS you only edit .env, not this file.
   ===================================================================== */

require("dotenv").config();
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool;
