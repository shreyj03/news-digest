import express from "express";
import cors from "cors";
import { pool } from "./db.js";

const app = express();
const port = process.env.PORT ?? 3001;

app.use(cors());

app.get("/api/topics", async (_req, res) => {
  const result = await pool.query(
    "SELECT id, name, keywords, created_at FROM topics ORDER BY id"
  );
  res.json(result.rows);
});

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
