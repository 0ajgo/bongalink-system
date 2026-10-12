// Runs a .sql file the way the mysql CLI would, including DELIMITER blocks
// (the 003 triggers), over a connection opened with multipleStatements.
const fs = require("fs");

function splitByDelimiter(text) {
  const chunks = [];
  let delimiter = ";";
  let buffer = [];
  const flush = () => {
    const sql = buffer.join("\n").trim();
    if (sql) chunks.push(sql);
    buffer = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const directive = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i);
    if (directive) {
      flush();
      delimiter = directive[1];
      continue;
    }
    if (delimiter !== ";" && line.trim().endsWith(delimiter)) {
      buffer.push(line.trimEnd().slice(0, -delimiter.length));
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

async function runSqlFile(connection, file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  for (const chunk of splitByDelimiter(text)) {
    await connection.query(chunk);
  }
}

module.exports = { runSqlFile };
