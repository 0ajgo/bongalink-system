const mysql = require("mysql2/promise");

module.exports = async () => {
  require("./setupEnv");
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  });
  await connection.query("DROP DATABASE IF EXISTS bongalink_test");
  await connection.end();
};
