
import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import { GoogleGenAI } from "@google/genai";
import pg from "pg";
import bcrypt from "bcryptjs";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set("trust proxy", 1);
app.use(express.json({ limit: "30kb" }));

// Kiểm tra cấu hình
if (!process.env.DATABASE_URL) {
  console.error("THIẾU DATABASE_URL trong file .env");
  process.exit(1);
}

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error("SESSION_SECRET phải có ít nhất 32 ký tự.");
  process.exit(1);
}

// Kết nối PostgreSQL
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on("error", (err) => {
  console.error("PostgreSQL:", err.message);
});

// Gemini AI - giữ chức năng cũ
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        timeout: 30000,
        retryOptions: {
          attempts: 2,
          initialDelay: 0.5,
          maxDelay: 2,
          jitter: 0.2
        }
      }
    })
  : null;

// Session lưu trong PostgreSQL
const PgSession = connectPgSimple(session);

app.use(session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  name: "edusmart.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

// Giới hạn số lần đăng nhập
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

// Giới hạn chat AI
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

// Tạo bảng tài khoản
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY,
      full_name VARCHAR(120) NOT NULL,
      username VARCHAR(30) NOT NULL UNIQUE,
      email VARCHAR(254),
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL
        CHECK (role IN ('student','teacher','admin')),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_unique
    ON app_users (LOWER(email))
    WHERE email IS NOT NULL AND email <> ''
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_setup_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      completed BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);

  await pool.query(`
    INSERT INTO admin_setup_lock (id, completed)
    VALUES (1, FALSE)
    ON CONFLICT (id) DO NOTHING
  `);
}

function clean(value, max = 120) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function validUsername(value) {
  return /^[a-zA-Z0-9_.-]{3,30}$/.test(value);
}

function validPassword(value) {
  return typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 72;
}

function safeUser(user) {
  return {
    id: user.id,
    fullName: user.full_name,
    username: user.username,
    email: user.email,
    role: user.role,
    isActive: user.is_active
  };
}

// Kiểm tra quyền
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      success: false,
      error: "Vui lòng đăng nhập."
    });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user ||
        !roles.includes(req.session.user.role)) {
      return res.status(403).json({
        success: false,
        error: "Bạn không có quyền truy cập."
      });
    }
    next();
  };
}

// HỌC SINH: ĐĂNG KÝ
app.post("/api/auth/student/register", authLimiter, async (req, res) => {
  try {
    const fullName = clean(req.body?.fullName);
    const username = clean(req.body?.username, 30).toLowerCase();
    const email = clean(req.body?.email, 254).toLowerCase() || null;
    const password = req.body?.password;

    if (!fullName || !validUsername(username) || !validPassword(password)) {
      return res.status(400).json({
        success: false,
        error: "Thông tin không hợp lệ. Mật khẩu cần ít nhất 8 ký tự."
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(`
      INSERT INTO app_users
      (full_name, username, email, password_hash, role)
      VALUES ($1, $2, $3, $4, 'student')
      RETURNING *
    `, [fullName, username, email, hash]);

    req.session.user = safeUser(result.rows[0]);

    res.status(201).json({
      success: true,
      message: "Đăng ký học sinh thành công.",
      user: req.session.user
    });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        error: "Tên đăng nhập hoặc email đã tồn tại."
      });
    }

    console.error(error.message);
    res.status(500).json({
      success: false,
      error: "Không thể đăng ký tài khoản."
    });
  }
});

// HÀM ĐĂNG NHẬP DÙNG CHUNG
async function loginUser(role, req, res) {
  try {
    const username = clean(req.body?.username, 30).toLowerCase();
    const password = req.body?.password;

    if (!username || typeof password !== "string") {
      return res.status(400).json({
        success: false,
        error: "Vui lòng nhập tài khoản và mật khẩu."
      });
    }

    const result = await pool.query(`
      SELECT * FROM app_users
      WHERE username = $1 AND role = $2
      LIMIT 1
    `, [username, role]);

    const user = result.rows[0];

    if (!user || !user.is_active ||
        !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        success: false,
        error: "Tài khoản hoặc mật khẩu không đúng."
      });
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate(err => {
        if (err) reject(err);
        else resolve();
      });
    });

    req.session.user = safeUser(user);

    res.json({
      success: true,
      message: "Đăng nhập thành công.",
      user: req.session.user
    });

  } catch (error) {
    console.error(error.message);
    res.status(500).json({
      success: false,
      error: "Lỗi đăng nhập."
    });
  }
}

// HỌC SINH: ĐĂNG NHẬP
app.post("/api/auth/student/login", authLimiter, (req, res) => {
  loginUser("student", req, res);
});

// GIÁO VIÊN: ĐĂNG NHẬP RIÊNG
app.post("/api/auth/teacher/login", authLimiter, (req, res) => {
  loginUser("teacher", req, res);
});

// ADMIN: ĐĂNG NHẬP RIÊNG
app.post("/api/auth/admin/login", authLimiter, (req, res) => {
  loginUser("admin", req, res);
});

// KIỂM TRA TÀI KHOẢN ĐANG ĐĂNG NHẬP
app.get("/api/auth/me", requireLogin, (req, res) => {
  res.json({
    success: true,
    user: req.session.user
  });
});

// ĐĂNG XUẤT
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("edusmart.sid");
    res.json({
      success: true,
      message: "Đã đăng xuất."
    });
  });
});

// TẠO ADMIN ĐẦU TIÊN - CHỈ MỘT LẦN
app.post("/api/auth/setup-first-admin", authLimiter, async (req, res) => {
  const client = await pool.connect();

  try {
    if (!process.env.ADMIN_SETUP_KEY) {
      return res.status(503).json({
        success: false,
        error: "Chưa cấu hình ADMIN_SETUP_KEY."
      });
    }

    await client.query("BEGIN");

    const lock = await client.query(`
      SELECT * FROM admin_setup_lock
      WHERE id = 1 FOR UPDATE
    `);

    if (lock.rows[0].completed) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        error: "Admin đầu tiên đã được tạo."
      });
    }

    const { setupKey, fullName, username, password } = req.body || {};

    if (setupKey !== process.env.ADMIN_SETUP_KEY) {
      await client.query("ROLLBACK");
      return res.status(401).json({
        success: false,
        error: "Mã thiết lập không đúng."
      });
    }

    const name = clean(fullName);
    const user = clean(username, 30).toLowerCase();

    if (!name || !validUsername(user) || !validPassword(password)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: "Thông tin không hợp lệ."
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const created = await client.query(`
      INSERT INTO app_users
      (full_name, username, password_hash, role)
      VALUES ($1, $2, $3, 'admin')
      RETURNING id
    `, [name, user, hash]);

    await client.query(`
      UPDATE admin_setup_lock
      SET completed = TRUE
      WHERE id = 1
    `);

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Đã tạo Admin đầu tiên. Hãy xóa ADMIN_SETUP_KEY khỏi môi trường."
    });

  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        error: "Tên đăng nhập đã tồn tại."
      });
    }

    console.error(error.message);
    res.status(500).json({
      success: false,
      error: "Không thể tạo Admin."
    });

  } finally {
    client.release();
  }
});

// ADMIN TẠO TÀI KHOẢN GIÁO VIÊN
app.post("/api/admin/teachers", requireRole("admin"), async (req, res) => {
  try {
    const fullName = clean(req.body?.fullName);
    const username = clean(req.body?.username, 30).toLowerCase();
    const email = clean(req.body?.email, 254).toLowerCase() || null;
    const password = req.body?.password;

    if (!fullName || !validUsername(username) || !validPassword(password)) {
      return res.status(400).json({
        success: false,
        error: "Thông tin tài khoản chưa hợp lệ."
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(`
      INSERT INTO app_users
      (full_name, username, email, password_hash, role)
      VALUES ($1, $2, $3, $4, 'teacher')
      RETURNING id, full_name, username, email, role, is_active
    `, [fullName, username, email, hash]);

    res.status(201).json({
      success: true,
      message: "Đã tạo tài khoản giáo viên.",
      user: safeUser(result.rows[0])
    });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        error: "Tên đăng nhập hoặc email đã tồn tại."
      });
    }

    console.error(error.message);
    res.status(500).json({
      success: false,
      error: "Không thể tạo tài khoản giáo viên."
    });
  }
});

// ADMIN XEM DANH SÁCH HỌC SINH / GIÁO VIÊN
app.get("/api/admin/users", requireRole("admin"), async (req, res) => {
  try {
    const role = req.query.role;

    if (!["student", "teacher"].includes(role)) {
      return res.status(400).json({
        success: false,
        error: "Vai trò không hợp lệ."
      });
    }

    const result = await pool.query(`
      SELECT id, full_name, username, email, role, is_active, created_at
      FROM app_users
      WHERE role = $1
      ORDER BY created_at DESC
    `, [role]);

    res.json({
      success: true,
      users: result.rows.map(safeUser)
    });

  } catch (error) {
    console.error(error.message);
    res.status(500).json({
      success: false,
      error: "Không thể tải danh sách."
    });
  }
});

// ADMIN KHÓA / MỞ TÀI KHOẢN
app.patch("/api/admin/users/:id/status", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const isActive = req.body?.isActive;

  if (!Number.isSafeInteger(id) || id < 1 || typeof isActive !== "boolean") {
    return res.status(400).json({
      success: false,
      error: "Dữ liệu không hợp lệ."
    });
  }

  try {
    const result = await pool.query(`
      UPDATE app_users
      SET is_active = $1
      WHERE id = $2 AND role IN ('student', 'teacher')
      RETURNING id
    `, [isActive, id]);

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        error: "Không tìm thấy tài khoản."
      });
    }

    res.json({
      success: true,
      message: "Đã cập nhật trạng thái tài khoản."
    });

  } catch (error) {
    console.error(error.message);
    res.status(500).json({
      success: false,
      error: "Không thể cập nhật."
    });
  }
});

// KIỂM TRA WEBSITE VÀ DATABASE
app.get("/api/health", async (req, res) => {
  let databaseConnected = false;

  try {
    await pool.query("SELECT 1");
    databaseConnected = true;
  } catch {}

  res.json({
    success: true,
    message: "EduSmart 12 đang hoạt động.",
    model: MODEL,
    aiConfigured: Boolean(ai),
    databaseConnected
  });
});

// CHAT GEMINI - GIỮ CHỨC NĂNG CŨ
app.post("/api/chat", chatLimiter, async (req, res) => {
  try {
    if (!ai) {
      return res.status(503).json({
        success: false,
        error: "Chưa cấu hình Gemini API Key."
      });
    }

    const messages = req.body?.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Vui lòng nhập câu hỏi."
      });
    }

    const contents = messages
      .slice(-10)
      .filter(m =>
        ["user", "assistant"].includes(m.role) &&
        typeof m.content === "string" &&
        m.content.trim()
      )
      .map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content.trim().slice(0, 3000) }]
      }));

    while (contents.length && contents[0].role === "model") {
      contents.shift();
    }

    if (!contents.length || contents.at(-1).role !== "user") {
      return res.status(400).json({
        success: false,
        error: "Câu hỏi không hợp lệ."
      });
    }

    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction:
          "Bạn là EduSmart AI, trợ lý học tập lớp 12. " +
          "Trả lời bằng tiếng Việt, dễ hiểu, có từng bước và ví dụ. " +
          "Không bịa thông tin khi không chắc chắn.",
        maxOutputTokens: 1000,
        temperature: 0.5
      }
    });

    const reply = response.text?.trim();

    if (!reply) {
      return res.status(502).json({
        success: false,
        error: "Gemini chưa tạo được câu trả lời."
      });
    }

    res.json({ success: true, reply });

  } catch (error) {
    console.error("Gemini:", error.message);

    res.status(500).json({
      success: false,
      error: "Không kết nối được Gemini. Hãy thử lại."
    });
  }
});

// Chặn truy cập file cấu hình
app.use((req, res, next) => {
  const blocked = [
    "/server.js",
    "/package.json",
    "/package-lock.json",
    "/.env",
    "/.gitignore"
  ];

  if (blocked.includes(req.path)) {
    return res.status(404).send("Không tìm thấy trang.");
  }

  next();
});

// Phục vụ giao diện cũ và mới
app.use(express.static(__dirname, {
  dotfiles: "ignore",
  index: "index.html"
}));

app.use((req, res) => {
  res.status(404).send("Không tìm thấy trang.");
});

// Khởi chạy
async function startServer() {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      console.log("==============================");
      console.log("EDUSMART 12");
      console.log("Website: http://localhost:" + PORT);
      console.log("Gemini: " + (ai ? "Đã cấu hình" : "Chưa cấu hình"));
      console.log("PostgreSQL: Đã kết nối");
      console.log("==============================");
    });

  } catch (error) {
    console.error("Lỗi PostgreSQL:", error.message);
    process.exit(1);
  }
}

startServer();
