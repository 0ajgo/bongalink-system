// Scope: the system covers ordering parts, customer inquiries, delivery and inventory.
// Repairs are not offered through it, so neither the chatbot, the starter FAQs nor the
// pages may offer, quote or book them.
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { runSqlFile } = require("./sqlLoader");
const { systemInstruction } = require("../services/chatbot");
const { DECLARATIONS } = require("../services/chatTools");
const { pool, resetDb } = require("./helpers");

const MIGRATIONS = path.join(__dirname, "..", "database", "migrations");
const FRONTEND = path.join(__dirname, "..", "..", "Frontend");

// Wording that would present repairs as something the shop offers here.
const OFFERS_REPAIRS = [
  /\brepairs? (computers|laptops|printers)/i, /parts and repairs?\b/i, /\brepair (quote|prices?|services?|booking)/i,
  /\bwe (can )?(repair|fix)\b/i, /\bbongalink repairs\b/i, /\brepairs to go with\b/i, /\btechnician\b/i, /\btroubleshooting\b/i,
];
const offers = (text) => OFFERS_REPAIRS.filter((re) => re.test(text)).map(String);

afterAll(() => pool.end());

describe("chatbot instructions", () => {
  const prompt = systemInstruction({ faqs: [], loggedIn: false, product: null });

  test("parts only; repairs are referred to the shop, never offered, quoted or booked", () => {
    expect(prompt).toContain("Bongalink's online system sells computer, laptop and printer parts only.");
    expect(prompt).toContain("Repairs are not handled through the online system.");
    expect(prompt).toContain("say that repairs aren't handled through the online system and give the shop's contact details (call or text 09170000000");
    expect(prompt).toContain("Never offer, quote, estimate, schedule or book a repair");
    expect(prompt).toContain("This rule overrides any FAQ.");
    expect(offers(prompt)).toEqual([]);
    expect(prompt).not.toMatch(/(,|\band) repairs\b/i);   // repairs never listed as a topic or service
  });

  test("the rule wins even if an FAQ says otherwise", () => {
    const withFaq = systemInstruction({ loggedIn: false, product: null,
      faqs: [{ category: "General", question: "Do you fix printers?", answer: "Yes, we fix printers.", is_placeholder: 0 }] });
    expect(withFaq.indexOf("This rule overrides any FAQ.")).toBeLessThan(withFaq.indexOf("Do you fix printers?"));
  });

  test("the tool descriptions don't mention repair work", () => {
    expect(JSON.stringify(DECLARATIONS)).not.toMatch(/repair/i);
  });
});

describe("starter FAQs", () => {
  beforeEach(() => resetDb());

  async function runMigrationFile(name) {
    const conn = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, multipleStatements: true });
    try {
      if (name === "006_chatbot.sql") {
        // Only the seed INSERT: the tables already exist in the test database.
        const sql = fs.readFileSync(path.join(MIGRATIONS, name), "utf8");
        await conn.query(sql.slice(sql.indexOf("INSERT INTO faqs")));
      } else {
        await runSqlFile(conn, path.join(MIGRATIONS, name));
      }
    } finally {
      await conn.end();
    }
  }
  const allFaqs = async () => (await pool.query("SELECT question, answer, category, is_placeholder FROM faqs ORDER BY faq_id"))[0];

  test("006 seeds: no FAQ offers repairs; one says they aren't handled online and points to the shop", async () => {
    await runMigrationFile("006_chatbot.sql");
    const faqs = await allFaqs();
    expect(faqs).toHaveLength(10);
    for (const f of faqs) expect(offers(`${f.question} ${f.answer}`)).toEqual([]);
    expect(faqs.map((f) => f.category)).not.toContain("Repairs");
    expect(faqs).toContainEqual(expect.objectContaining({
      question: "Can I book a repair through the website or this chat?", category: "General", is_placeholder: 0,
      answer: expect.stringMatching(/^No\. The online store is for ordering computer, laptop and printer parts only; repairs are not handled/) }));
  });

  test("007 corrects a database seeded with the old text, but leaves admin-edited FAQs alone", async () => {
    await pool.query(`INSERT INTO faqs (question, answer, category, is_placeholder) VALUES
      ('Do you repair computers, laptops and printers?', 'Yes. Bongalink repairs desktop computers, laptops and printers, including printhead cleaning.', 'Repairs', 1),
      ('Can I return or exchange a part?', 'Message the shop within 7 days. Returns are checked by our technician before a replacement or refund is given.', 'Returns', 1),
      ('Do you repair computers, laptops and printers?', 'Edited by the admin: no repairs here.', 'General', 0)`);
    await runMigrationFile("007_faq_no_repairs.sql");
    const [repairs, returns, edited] = await allFaqs();
    expect(repairs).toMatchObject({ question: "Can I book a repair through the website or this chat?", category: "General", is_placeholder: 0 });
    expect(returns.answer).toBe("Message the shop within 7 days. Returns are checked by the shop before a replacement or refund is given.");
    expect(edited).toMatchObject({ question: "Do you repair computers, laptops and printers?", answer: "Edited by the admin: no repairs here." });
  });
});

describe("pages", () => {
  test("no page or script mentions repairs (headline, meta description, titles, footers)", () => {
    const files = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "vendor") walk(full); } else if (/\.(html|js|css)$/.test(e.name)) files.push(full);
    });
    walk(FRONTEND);
    expect(files.length).toBeGreaterThan(20);
    const hits = files.filter((f) => /repair/i.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(FRONTEND, f));
    expect(hits).toEqual([]);
  });
});
