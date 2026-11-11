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
import multer from "multer";
import fs from "fs";
import crypto from "crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

if (!process.env.DATABASE_URL) {
  console.error("THIẾU DATABASE_URL trong file .env");
  process.exit(1);
}

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error("SESSION_SECRET phải có ít nhất 32 ký tự.");
  process.exit(1);
}

// POSTGRESQL
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on("error", err => {
  console.error("PostgreSQL:", err.message);
});

// GEMINI AI
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

// SESSION
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

// GIỚI HẠN ĐĂNG NHẬP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

// GIỚI HẠN GEMINI
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

// TẠO DATABASE
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

  await pool.query(`
    ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS class_name VARCHAR(80)
  `);

  // BẢNG BÀI KIỂM TRA
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exams (
      id BIGSERIAL PRIMARY KEY,
      teacher_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      title VARCHAR(200) NOT NULL,
      subject VARCHAR(100) NOT NULL,
      class_name VARCHAR(80) NOT NULL DEFAULT 'Tất cả lớp',
      duration_minutes INTEGER NOT NULL DEFAULT 45
        CHECK (duration_minutes BETWEEN 1 AND 300),
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      file_name VARCHAR(255),
      file_path TEXT,
      file_mime VARCHAR(120),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // BẢNG CÂU HỎI
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exam_questions (
      id BIGSERIAL PRIMARY KEY,
      exam_id BIGINT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      question_order INTEGER NOT NULL,
      question_type VARCHAR(30) NOT NULL
        CHECK (question_type IN ('multiple_choice','true_false','essay')),
      content TEXT NOT NULL,
      options JSONB NOT NULL DEFAULT '[]'::jsonb,
      correct_answer JSONB,
      points NUMERIC(7,2) NOT NULL DEFAULT 1
        CHECK (points >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(exam_id, question_order)
    )
  `);

  // BẢNG BÀI LÀM
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exam_submissions (
      id BIGSERIAL PRIMARY KEY,
      exam_id BIGINT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      student_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      submitted_at TIMESTAMPTZ,
      answers JSONB NOT NULL DEFAULT '{}'::jsonb,
      objective_score NUMERIC(8,2) NOT NULL DEFAULT 0,
      total_score NUMERIC(8,2),
      status VARCHAR(30) NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress','submitted','pending_review')),
      UNIQUE(exam_id, student_id)
    )
  `);

  // BẢNG THÔNG BÁO
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_notices (
      id BIGSERIAL PRIMARY KEY,
      teacher_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      class_name VARCHAR(80) NOT NULL DEFAULT 'Tất cả lớp',
      title VARCHAR(200) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS exams_class_dates_idx
    ON exams(class_name, starts_at, ends_at)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS submissions_student_idx
    ON exam_submissions(student_id, submitted_at DESC)
  `);
}
// =====================================================
// SỬA CẤU TRÚC DATABASE CŨ - BÀI KIỂM TRA
// =====================================================
async function repairExamDatabase() {
  // Bổ sung cột cho bảng bài kiểm tra
  await pool.query(`
    ALTER TABLE exams
      ADD COLUMN IF NOT EXISTS class_name VARCHAR(80) NOT NULL DEFAULT 'Tất cả lớp',
      ADD COLUMN IF NOT EXISTS duration_minutes INTEGER NOT NULL DEFAULT 45,
      ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS file_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS file_path TEXT,
      ADD COLUMN IF NOT EXISTS file_mime VARCHAR(120),
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);

  // Bổ sung cột câu hỏi
  await pool.query(`
    ALTER TABLE exam_questions
      ADD COLUMN IF NOT EXISTS question_order INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS question_type VARCHAR(30) NOT NULL DEFAULT 'multiple_choice',
      ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS correct_answer JSONB,
      ADD COLUMN IF NOT EXISTS points NUMERIC(7,2) NOT NULL DEFAULT 1
  `);

  // Bổ sung cột bài làm
  await pool.query(`
    ALTER TABLE exam_submissions
      ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS answers JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS objective_score NUMERIC(8,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_score NUMERIC(8,2),
      ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'in_progress'
  `);

  // Đảm bảo tài khoản học sinh có lớp
  await pool.query(`
    ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS class_name VARCHAR(80)
  `);

  // Tạo chỉ mục
  await pool.query(`
    CREATE INDEX IF NOT EXISTS exams_class_dates_idx
    ON exams(class_name, starts_at, ends_at)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS submissions_student_idx
    ON exam_submissions(student_id, submitted_at DESC)
  `);

  console.log("Da kiem tra va bo sung database bai kiem tra.");
}
// HÀM LÀM SẠCH DỮ LIỆU
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

// THÔNG TIN TÀI KHOẢN AN TOÀN
function safeUser(user) {
  return {
    id: user.id,
    fullName: user.full_name,
    username: user.username,
    email: user.email,
    role: user.role,
    isActive: user.is_active,
    className: user.class_name || null
  };
}

// KIỂM TRA ĐĂNG NHẬP
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      success: false,
      error: "Vui lòng đăng nhập."
    });
  }
  next();
}

// KIỂM TRA QUYỀN
function requireRole(...roles) {
  return (req, res, next) => {
    if (
      !req.session.user ||
      !roles.includes(req.session.user.role)
    ) {
      return res.status(403).json({
        success: false,
        error: "Bạn không có quyền truy cập."
      });
    }
    next();
  };
}

// HỌC SINH ĐĂNG KÝ
app.post("/api/auth/student/register", authLimiter, async (req, res) => {
  try {
    const fullName = clean(req.body?.fullName);
    const username = clean(req.body?.username, 30).toLowerCase();
    const email = clean(req.body?.email, 254).toLowerCase() || null;
    const className = clean(req.body?.className, 80) || null;
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
      (full_name, username, email, password_hash, role, class_name)
      VALUES ($1, $2, $3, $4, 'student', $5)
      RETURNING *
    `, [fullName, username, email, hash, className]);

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

    if (!username || typeof password !== "string" || !password) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập tên đăng nhập và mật khẩu."
      });
    }

    const result = await pool.query(`
      SELECT id, full_name, username, email, role,
             is_active, password_hash, class_name
      FROM app_users
      WHERE LOWER(username) = LOWER($1)
        AND role = $2
      LIMIT 1
    `, [username, role]);

    const user = result.rows[0];

    const passwordMatch = user
      ? await bcrypt.compare(password, user.password_hash)
      : false;

    console.log("LOGIN CHECK:", {
      role,
      found: !!user,
      active: user?.is_active,
      passwordMatch
    });

    if (!user || user.is_active !== true || !passwordMatch) {
      return res.status(401).json({
        success: false,
        message: "Tài khoản hoặc mật khẩu không đúng."
      });
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate(err => {
        if (err) reject(err);
        else resolve();
      });
    });

    req.session.user = safeUser(user);

    return res.json({
      success: true,
      message: "Đăng nhập thành công.",
      user: req.session.user
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error.message);

    return res.status(500).json({
      success: false,
      message: "Lỗi máy chủ khi đăng nhập."
    });
  }
}

// HỌC SINH ĐĂNG NHẬP
app.post("/api/auth/student/login", authLimiter, (req, res) => {
  loginUser("student", req, res);
});

// GIÁO VIÊN ĐĂNG NHẬP
app.post("/api/auth/teacher/login", authLimiter, (req, res) => {
  loginUser("teacher", req, res);
});

// ADMIN ĐĂNG NHẬP
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

    await client.query(`
      INSERT INTO app_users
      (full_name, username, password_hash, role)
      VALUES ($1, $2, $3, 'admin')
    `, [name, user, hash]);

    await client.query(`
      UPDATE admin_setup_lock
      SET completed = TRUE
      WHERE id = 1
    `);

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Đã tạo Admin đầu tiên."
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

// ============================================================
// EDU SMART 12 - QUẢN LÝ BÀI KIỂM TRA, BÀI LÀM VÀ THÔNG BÁO
// ============================================================

// THƯ MỤC LƯU FILE ĐỀ
const uploadDir = path.join(__dirname, "uploads", "exams");

fs.mkdirSync(uploadDir, { recursive: true });

// CÁC LOẠI FILE ĐƯỢC PHÉP TẢI
const allowedMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

// CẤU HÌNH LƯU FILE
const examStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
      .toLowerCase()
      .slice(0, 10);

    cb(
      null,
      `${Date.now()}-${crypto.randomBytes(12).toString("hex")}${ext}`
    );
  }
});

// UPLOAD FILE TỐI ĐA 20MB
const examUpload = multer({
  storage: examStorage,

  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 1
  },

  fileFilter: (req, file, cb) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return cb(new Error(
        "Chỉ nhận file PDF, Word, JPG, PNG hoặc WEBP."
      ));
    }

    cb(null, true);
  }
});

// KIỂM TRA VÀ XỬ LÝ CÂU HỎI
function parseQuestions(input) {
  let questions = input;

  if (typeof questions === "string") {
    try {
      questions = JSON.parse(questions);
    } catch {
      throw new Error("Danh sách câu hỏi không đúng định dạng JSON.");
    }
  }

  if (!Array.isArray(questions) || questions.length > 100) {
    throw new Error("Bài kiểm tra cần có từ 1 đến 100 câu hỏi.");
  }

  return questions.map((q, index) => {
    const type = clean(q?.type, 30);
    const content = clean(q?.content, 5000);
    const points = Number(q?.points ?? 1);

    if (
      !content ||
      !Number.isFinite(points) ||
      points < 0 ||
      points > 100
    ) {
      throw new Error(
        `Câu ${index + 1}: nội dung hoặc điểm số không hợp lệ.`
      );
    }

    if (!["multiple_choice", "true_false", "essay"].includes(type)) {
      throw new Error(
        `Câu ${index + 1}: loại câu hỏi không hợp lệ.`
      );
    }

    let options = [];
    let correctAnswer = null;

    if (type === "multiple_choice") {
      options = Array.isArray(q.options)
        ? q.options
            .map(x => clean(x, 1000))
            .filter(Boolean)
            .slice(0, 6)
        : [];

      if (options.length < 2) {
        throw new Error(
          `Câu ${index + 1}: trắc nghiệm cần ít nhất 2 đáp án.`
        );
      }

      correctAnswer = clean(
        String(q.correctAnswer ?? ""),
        20
      );

      if (
        !["A", "B", "C", "D", "E", "F"]
          .slice(0, options.length)
          .includes(correctAnswer)
      ) {
        throw new Error(
          `Câu ${index + 1}: đáp án đúng phải là A, B, C...`
        );
      }
    }

    if (type === "true_false") {
      const raw = q.correctAnswer;

      if (![true, false, "true", "false"].includes(raw)) {
        throw new Error(
          `Câu ${index + 1}: đáp án đúng/sai không hợp lệ.`
        );
      }

      correctAnswer = raw === true || raw === "true";
      options = ["Đúng", "Sai"];
    }

    return {
      type,
      content,
      options,
      correctAnswer,
      points
    };
  });
}

// KIỂM TRA THỜI GIAN MỞ BÀI
function examIsOpen(exam) {
  const now = Date.now();

  if (
    exam.starts_at &&
    now < new Date(exam.starts_at).getTime()
  ) {
    return false;
  }

  if (
    exam.ends_at &&
    now > new Date(exam.ends_at).getTime()
  ) {
    return false;
  }

  return true;
}

// KIỂM TRA LỚP ĐƯỢC PHÉP LÀM BÀI
async function studentCanAccessExam(student, exam) {
  return (
    exam.class_name === "Tất cả lớp" ||
    (
      student.className &&
      student.className === exam.class_name
    )
  );
}
// HỌC SINH CẬP NHẬT LỚP
app.patch("/api/student/class", requireRole("student"), async (req, res) => {
  const className = clean(req.body?.className, 80);

  if (!className) {
    return res.status(400).json({
      success: false,
      error: "Vui lòng nhập tên lớp."
    });
  }

  try {
    const result = await pool.query(
      "UPDATE app_users SET class_name = $1 WHERE id = $2 RETURNING *",
      [className, req.session.user.id]
    );

    req.session.user = safeUser(result.rows[0]);

    res.json({
      success: true,
      user: req.session.user
    });

  } catch (error) {
    console.error("Cập nhật lớp:", error.message);

    res.status(500).json({
      success: false,
      error: "Không cập nhật được lớp."
    });
  }
});

// GIÁO VIÊN: TẠO BÀI KIỂM TRA
app.post(
  "/api/teacher/exams",
  requireRole("teacher"),

  (req, res, next) => examUpload.single("file")(
    req,
    res,
    err => {
      if (err) {
        return res.status(400).json({
          success: false,
          error: err.message
        });
      }
      next();
    }
  ),

  async (req, res) => {
    const client = await pool.connect();
    const savedFile = req.file?.path || null;

    try {
      const title = clean(req.body?.title, 200);
      const subject = clean(req.body?.subject, 100);
      const className = clean(req.body?.className, 80) || "Tất cả lớp";

      const duration = Number(req.body?.durationMinutes || 45);

      const startsAt = req.body?.startsAt
        ? new Date(req.body.startsAt)
        : null;

      const endsAt = req.body?.endsAt
        ? new Date(req.body.endsAt)
        : null;

      const questions = parseQuestions(
        req.body?.questions || "[]"
      );

      if (!title || !subject) {
        throw new Error("Vui lòng nhập tên bài kiểm tra và môn học.");
      }

      if (!Number.isInteger(duration) || duration < 1 || duration > 300) {
        throw new Error("Thời gian làm bài phải từ 1 đến 300 phút.");
      }

      if (!questions.length && !req.file) {
        throw new Error("Hãy tạo câu hỏi hoặc tải file đề kiểm tra lên.");
      }

      if (startsAt && Number.isNaN(startsAt.getTime())) {
        throw new Error("Ngày mở bài không hợp lệ.");
      }

      if (endsAt && Number.isNaN(endsAt.getTime())) {
        throw new Error("Hạn nộp bài không hợp lệ.");
      }

      if (startsAt && endsAt && endsAt <= startsAt) {
        throw new Error("Hạn nộp phải sau ngày mở bài.");
      }

      await client.query("BEGIN");

      const examResult = await client.query(`
        INSERT INTO exams
          (
            teacher_id,
            title,
            subject,
            class_name,
            duration_minutes,
            starts_at,
            ends_at,
            file_name,
            file_path,
            file_mime
          )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *
      `, [
        req.session.user.id,
        title,
        subject,
        className,
        duration,
        startsAt,
        endsAt,
        req.file?.originalname || null,
        req.file?.filename || null,
        req.file?.mimetype || null
      ]);

      const exam = examResult.rows[0];

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];

        await client.query(`
          INSERT INTO exam_questions
            (
              exam_id,
              question_order,
              question_type,
              content,
              options,
              correct_answer,
              points
            )
          VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
        `, [
          exam.id,
          i + 1,
          q.type,
          q.content,
          JSON.stringify(q.options),
          q.correctAnswer === null
            ? null
            : JSON.stringify(q.correctAnswer),
          q.points
        ]);
      }

      await client.query("COMMIT");

      res.status(201).json({
        success: true,
        message: "Đã đăng bài kiểm tra.",

        exam: {
          id: exam.id,
          title: exam.title,
          subject: exam.subject,
          className: exam.class_name,
          durationMinutes: exam.duration_minutes,
          questionCount: questions.length,
          hasFile: Boolean(exam.file_path)
        }
      });

    } catch (error) {
      await client.query("ROLLBACK");

      if (savedFile && fs.existsSync(savedFile)) {
        fs.unlinkSync(savedFile);
      }

      console.error("Tạo bài kiểm tra:", error.message);

      res.status(400).json({
        success: false,
        error: error.message || "Không tạo được bài kiểm tra."
      });

    } finally {
      client.release();
    }
  }
);

// GIÁO VIÊN: DANH SÁCH BÀI KIỂM TRA
app.get("/api/teacher/exams", requireRole("teacher"), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        e.id,
        e.title,
        e.subject,
        e.class_name,
        e.duration_minutes,
        e.starts_at,
        e.ends_at,
        e.file_name,
        e.created_at,
        COUNT(DISTINCT q.id)::int AS question_count,
        COUNT(DISTINCT s.id)::int AS submission_count

      FROM exams e

      LEFT JOIN exam_questions q
        ON q.exam_id = e.id

      LEFT JOIN exam_submissions s
        ON s.exam_id = e.id
        AND s.submitted_at IS NOT NULL

      WHERE e.teacher_id = $1

      GROUP BY e.id
      ORDER BY e.created_at DESC
    `, [req.session.user.id]);

    res.json({
      success: true,
      exams: result.rows
    });

  } catch (error) {
    console.error("Danh sách đề:", error.message);

    res.status(500).json({
      success: false,
      error: "Không tải được danh sách bài kiểm tra."
    });
  }
});

// GIÁO VIÊN: XEM CHI TIẾT ĐỀ VÀ ĐÁP ÁN
app.get("/api/teacher/exams/:id", requireRole("teacher"), async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({
      success: false,
      error: "ID bài kiểm tra không hợp lệ."
    });
  }

  try {
    const examResult = await pool.query(
      "SELECT * FROM exams WHERE id = $1 AND teacher_id = $2",
      [id, req.session.user.id]
    );

    if (!examResult.rowCount) {
      return res.status(404).json({
        success: false,
        error: "Không tìm thấy bài kiểm tra."
      });
    }

    const questions = await pool.query(`
      SELECT
        id,
        question_order,
        question_type,
        content,
        options,
        correct_answer,
        points
      FROM exam_questions
      WHERE exam_id = $1
      ORDER BY question_order
    `, [id]);

    res.json({
      success: true,
      exam: examResult.rows[0],
      questions: questions.rows
    });

  } catch (error) {
    console.error("Chi tiết đề:", error.message);

    res.status(500).json({
      success: false,
      error: "Không tải được bài kiểm tra."
    });
  }
});

// GIÁO VIÊN: XÓA BÀI KIỂM TRA
app.delete("/api/teacher/exams/:id", requireRole("teacher"), async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({
      success: false,
      error: "ID không hợp lệ."
    });
  }

  try {
    const result = await pool.query(`
      DELETE FROM exams
      WHERE id = $1 AND teacher_id = $2
      RETURNING file_path
    `, [id, req.session.user.id]);

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        error: "Không tìm thấy bài kiểm tra."
      });
    }

    const filePath = result.rows[0].file_path
      ? path.join(uploadDir, path.basename(result.rows[0].file_path))
      : null;

    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({
      success: true,
      message: "Đã xóa bài kiểm tra."
    });

  } catch (error) {
    console.error("Xóa đề:", error.message);

    res.status(500).json({
      success: false,
      error: "Không xóa được bài kiểm tra."
    });
  }
});

// TẢI FILE ĐỀ KIỂM TRA
app.get("/api/exams/:id/file", requireLogin, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).send("ID không hợp lệ.");
  }

  try {
    const result = await pool.query(
      "SELECT * FROM exams WHERE id = $1",
      [id]
    );

    const exam = result.rows[0];

    if (!exam || !exam.file_path) {
      return res.status(404).send("Không có file đề.");
    }

    const user = req.session.user;

    if (
      user.role === "teacher" &&
      Number(exam.teacher_id) !== Number(user.id)
    ) {
      return res.status(403).send("Không có quyền tải file.");
    }

    if (
      user.role === "student" &&
      !(await studentCanAccessExam(user, exam))
    ) {
      return res.status(403).send(
        "Bài kiểm tra không dành cho lớp của bạn."
      );
    }

    const fullPath = path.join(
      uploadDir,
      path.basename(exam.file_path)
    );

    if (!fs.existsSync(fullPath)) {
      return res.status(404).send("File không còn tồn tại.");
    }

    res.download(
      fullPath,
      exam.file_name || "de-kiem-tra"
    );

  } catch (error) {
    console.error("Tải file đề:", error.message);
    res.status(500).send("Không tải được file.");
  }
});

// HỌC SINH: DANH SÁCH BÀI KIỂM TRA ĐƯỢC GIAO
// HỌC SINH: DANH SÁCH BÀI KIỂM TRA ĐƯỢC GIAO
// =====================================================

app.get(
  "/api/student/exams",
// HỌC SINH: TẢI DANH SÁCH BÀI KIỂM TRA ĐƯỢC GIAO
// =====================================================
app.get(
  "/api/student/exams",
  requireRole("student"),
  async (req, res) => {
    try {
      const studentId = req.session.user.id;

      // Lấy lớp mới nhất từ database
      const studentResult = await pool.query(
        `SELECT class_name FROM app_users WHERE id = $1`,
        [studentId]
      );

      const className = studentResult.rows[0]?.class_name || "";

      const result = await pool.query(`
        SELECT
          e.id,
          e.title,
          e.subject,
          e.class_name,
          e.duration_minutes,
          e.starts_at,
          e.ends_at,
          e.file_name,
          e.created_at,

          (
            SELECT COUNT(*)
            FROM exam_questions q
            WHERE q.exam_id = e.id
          )::int AS question_count,

          s.id AS submission_id,
          s.submitted_at,
          s.status,
          s.total_score

        FROM exams e

        LEFT JOIN exam_submissions s
          ON s.exam_id = e.id
          AND s.student_id = $1

        WHERE
          e.class_name = 'Tất cả lớp'
          OR TRIM(e.class_name) = TRIM($2)

        ORDER BY e.created_at DESC, e.id DESC
      `, [studentId, className]);

      res.json({
        success: true,
        exams: result.rows
      });

    } catch (error) {
      console.error(
        "STUDENT EXAMS ERROR:",
        error.message
      );

      res.status(500).json({
        success: false,
        error: "Không tải được danh sách bài kiểm tra.",
        detail: process.env.NODE_ENV === "development"
          ? error.message
          : undefined
      });
    }
  }
);
// HỌC SINH: BẮT ĐẦU LÀM BÀI
app.post("/api/student/exams/:id/start", requireRole("student"), async (req, res) => {
  const examId = Number(req.params.id);

  if (!Number.isSafeInteger(examId) || examId < 1) {
    return res.status(400).json({
      success: false,
      error: "ID bài kiểm tra không hợp lệ."
    });
  }

  try {
    const examResult = await pool.query(
      "SELECT * FROM exams WHERE id = $1",
      [examId]
    );

    const exam = examResult.rows[0];

    if (!exam) {
      return res.status(404).json({
        success: false,
        error: "Không tìm thấy bài kiểm tra."
      });
    }

    if (!(await studentCanAccessExam(req.session.user, exam))) {
      return res.status(403).json({
        success: false,
        error: "Bài kiểm tra không dành cho lớp của bạn."
      });
    }

    if (!examIsOpen(exam)) {
      return res.status(403).json({
        success: false,
        error: "Bài kiểm tra chưa mở hoặc đã hết hạn."
      });
    }

    const existing = await pool.query(`
      SELECT *
      FROM exam_submissions
      WHERE exam_id = $1 AND student_id = $2
    `, [examId, req.session.user.id]);

    if (existing.rows[0]?.submitted_at) {
      return res.status(409).json({
        success: false,
        error: "Bạn đã nộp bài kiểm tra này rồi."
      });
    }

    let submission = existing.rows[0];

    if (!submission) {
      const created = await pool.query(`
        INSERT INTO exam_submissions (exam_id, student_id)
        VALUES ($1,$2)
        ON CONFLICT (exam_id, student_id)
        DO UPDATE SET exam_id = EXCLUDED.exam_id
        RETURNING *
      `, [examId, req.session.user.id]);

      submission = created.rows[0];
    }

    const questions = await pool.query(`
      SELECT
        id,
        question_order,
        question_type,
        content,
        options,
        points
      FROM exam_questions
      WHERE exam_id = $1
      ORDER BY question_order
    `, [examId]);

    res.json({
      success: true,
      submissionId: submission.id,
      startedAt: submission.started_at,
      durationMinutes: exam.duration_minutes,

      exam: {
        id: exam.id,
        title: exam.title,
        subject: exam.subject,
        fileAvailable: Boolean(exam.file_path)
      },

      questions: questions.rows
    });

  } catch (error) {
    console.error("Bắt đầu bài:", error.message);

    res.status(500).json({
      success: false,
      error: "Không thể bắt đầu bài kiểm tra."
    });
  }
});

// HỌC SINH: NỘP BÀI VÀ TỰ CHẤM
app.post("/api/student/exams/:id/submit", requireRole("student"), async (req, res) => {
  const examId = Number(req.params.id);
  const answers = req.body?.answers;

  if (
    !Number.isSafeInteger(examId) ||
    examId < 1 ||
    !answers ||
    typeof answers !== "object" ||
    Array.isArray(answers)
  ) {
    return res.status(400).json({
      success: false,
      error: "Dữ liệu nộp bài không hợp lệ."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const examResult = await client.query(
      "SELECT * FROM exams WHERE id = $1",
      [examId]
    );

    const exam = examResult.rows[0];

    if (
      !exam ||
      !(await studentCanAccessExam(req.session.user, exam))
    ) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        error: "Không tìm thấy bài kiểm tra."
      });
    }

    const submissionResult = await client.query(`
      SELECT *
      FROM exam_submissions
      WHERE exam_id = $1 AND student_id = $2
      FOR UPDATE
    `, [examId, req.session.user.id]);

    const submission = submissionResult.rows[0];

    if (!submission) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        error: "Bạn cần bắt đầu bài kiểm tra trước."
      });
    }

    if (submission.submitted_at) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        error: "Bài kiểm tra đã được nộp."
      });
    }

    const deadline =
      new Date(submission.started_at).getTime() +
      exam.duration_minutes * 60 * 1000;

    if (Date.now() > deadline + 30 * 1000) {
      await client.query("ROLLBACK");

      return res.status(403).json({
        success: false,
        error: "Đã hết thời gian làm bài."
      });
    }

    const questionsResult = await client.query(`
      SELECT id, question_type, correct_answer, points
      FROM exam_questions
      WHERE exam_id = $1
    `, [examId]);

    let objectiveScore = 0;
    let hasEssay = false;
    const cleanAnswers = {};

    for (const q of questionsResult.rows) {
      const answer = answers[String(q.id)];

      if (answer !== undefined) {
        cleanAnswers[String(q.id)] =
          typeof answer === "string"
            ? answer.slice(0, 5000)
            : typeof answer === "boolean"
              ? answer
              : null;
      }

      if (q.question_type === "essay") {
        hasEssay = true;
        continue;
      }

      const correct = q.correct_answer;

      const normalized = q.question_type === "true_false"
        ? (answer === true || answer === "true")
        : String(answer ?? "").trim().toUpperCase();

      const expected = q.question_type === "true_false"
        ? (correct === true || correct === "true")
        : String(correct ?? "")
            .replace(/^"|"$/g, "")
            .trim()
            .toUpperCase();

      if (answer !== undefined && normalized === expected) {
        objectiveScore += Number(q.points);
      }
    }

    const status = hasEssay
      ? "pending_review"
      : "submitted";

    const updated = await client.query(`
      UPDATE exam_submissions

      SET answers = $1::jsonb,
          objective_score = $2,
          total_score = $3,
          submitted_at = NOW(),
          status = $4

      WHERE id = $5

      RETURNING
        id,
        objective_score,
        total_score,
        submitted_at,
        status
    `, [
      JSON.stringify(cleanAnswers),
      objectiveScore,
      hasEssay ? null : objectiveScore,
      status,
      submission.id
    ]);

    await client.query("COMMIT");

    res.json({
      success: true,

      message: hasEssay
        ? "Đã nộp bài. Câu tự luận đang chờ giáo viên chấm."
        : "Đã nộp bài và chấm điểm tự động.",

      result: updated.rows[0]
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Nộp bài:", error.message);

    res.status(500).json({
      success: false,
      error: "Không thể nộp bài."
    });

  } finally {
    client.release();
  }
});

// HỌC SINH: XEM KẾT QUẢ CÁC BÀI ĐÃ NỘP
// =====================================================
// HỌC SINH: XEM KẾT QUẢ BÀI KIỂM TRA
// =====================================================
app.get(
  "/api/student/results",
  requireRole("student"),
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          e.id AS exam_id,
          e.title,
          e.subject,
          e.duration_minutes,

          s.id AS submission_id,
          s.started_at,
          s.submitted_at,
          s.objective_score,
          s.total_score,
          s.status

        FROM exam_submissions s

        INNER JOIN exams e
          ON e.id = s.exam_id

        WHERE
          s.student_id = $1
          AND s.submitted_at IS NOT NULL

        ORDER BY s.submitted_at DESC
      `, [req.session.user.id]);

      res.json({
        success: true,
        results: result.rows
      });

    } catch (error) {
      console.error(
        "STUDENT RESULTS ERROR:",
        error.message
      );

      res.status(500).json({
        success: false,
        error: "Không tải được kết quả học tập.",
        detail: process.env.NODE_ENV === "development"
          ? error.message
          : undefined
      });
    }
  }
);

// GIÁO VIÊN: XEM DANH SÁCH BÀI NỘP
app.get("/api/teacher/exams/:id/submissions", requireRole("teacher"), async (req, res) => {
  const examId = Number(req.params.id);

  if (!Number.isSafeInteger(examId) || examId < 1) {
    return res.status(400).json({
      success: false,
      error: "ID không hợp lệ."
    });
  }

  try {
    const owned = await pool.query(
      "SELECT id FROM exams WHERE id = $1 AND teacher_id = $2",
      [examId, req.session.user.id]
    );

    if (!owned.rowCount) {
      return res.status(404).json({
        success: false,
        error: "Không tìm thấy bài kiểm tra."
      });
    }

    const result = await pool.query(`
      SELECT
        s.id,
        s.student_id,
        u.full_name,
        u.username,
        u.class_name,
        s.started_at,
        s.submitted_at,
        s.objective_score,
        s.total_score,
        s.status,
        s.answers

      FROM exam_submissions s

      JOIN app_users u
        ON u.id = s.student_id

      WHERE s.exam_id = $1

      ORDER BY s.submitted_at DESC NULLS LAST, u.full_name
    `, [examId]);

    res.json({
      success: true,
      submissions: result.rows
    });

  } catch (error) {
    console.error("Danh sách bài nộp:", error.message);

    res.status(500).json({
      success: false,
      error: "Không tải được danh sách bài nộp."
    });
  }
});

// GIÁO VIÊN: CHẤM ĐIỂM TỰ LUẬN
app.patch("/api/teacher/submissions/:id/grade", requireRole("teacher"), async (req, res) => {
  const submissionId = Number(req.params.id);
  const essayScore = Number(req.body?.essayScore);

  if (
    !Number.isSafeInteger(submissionId) ||
    submissionId < 1 ||
    !Number.isFinite(essayScore) ||
    essayScore < 0
  ) {
    return res.status(400).json({
      success: false,
      error: "Điểm tự luận không hợp lệ."
    });
  }

  try {
    const result = await pool.query(`
      SELECT
        s.id,
        s.exam_id,
        s.objective_score,
        e.teacher_id,
        COALESCE(
          SUM(q.points) FILTER (WHERE q.question_type = 'essay'),
          0
        ) AS essay_max

      FROM exam_submissions s

      JOIN exams e
        ON e.id = s.exam_id

      LEFT JOIN exam_questions q
        ON q.exam_id = e.id

      WHERE s.id = $1

      GROUP BY s.id, e.teacher_id
    `, [submissionId]);

    const row = result.rows[0];

    if (
      !row ||
      Number(row.teacher_id) !== Number(req.session.user.id)
    ) {
      return res.status(404).json({
        success: false,
        error: "Không tìm thấy bài nộp."
      });
    }

    if (essayScore > Number(row.essay_max)) {
      return res.status(400).json({
        success: false,
        error: `Điểm tự luận tối đa là ${row.essay_max}.`
      });
    }

    const total = Number(row.objective_score) + essayScore;

    const updated = await pool.query(`
      UPDATE exam_submissions

      SET total_score = $1,
          status = 'submitted'

      WHERE id = $2

      RETURNING id, objective_score, total_score, status
    `, [total, submissionId]);

    res.json({
      success: true,
      message: "Đã lưu điểm.",
      result: updated.rows[0]
    });

  } catch (error) {
    console.error("Chấm tự luận:", error.message);

    res.status(500).json({
      success: false,
      error: "Không chấm được bài."
    });
  }
});

// GIÁO VIÊN: ĐĂNG THÔNG BÁO
app.post("/api/teacher/notices", requireRole("teacher"), async (req, res) => {
  const title = clean(req.body?.title, 200);
  const content = clean(req.body?.content, 10000);
  const className = clean(req.body?.className, 80) || "Tất cả lớp";

  if (!title || !content) {
    return res.status(400).json({
      success: false,
      error: "Vui lòng nhập tiêu đề và nội dung thông báo."
    });
  }

  try {
    const result = await pool.query(`
      INSERT INTO student_notices
        (teacher_id, class_name, title, content)
      VALUES ($1,$2,$3,$4)
      RETURNING *
    `, [
      req.session.user.id,
      className,
      title,
      content
    ]);

    res.status(201).json({
      success: true,
      notice: result.rows[0]
    });

  } catch (error) {
    console.error("Đăng thông báo:", error.message);

    res.status(500).json({
      success: false,
      error: "Không đăng được thông báo."
    });
  }
});

// HỌC SINH: XEM THÔNG BÁO
app.get("/api/student/notices", requireRole("student"), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        n.id,
        n.title,
        n.content,
        n.class_name,
        n.created_at,
        u.full_name AS teacher_name

      FROM student_notices n

      JOIN app_users u
        ON u.id = n.teacher_id

      WHERE n.class_name = 'Tất cả lớp'
         OR n.class_name = $1

      ORDER BY n.created_at DESC
    `, [req.session.user.className || ""]);

    res.json({
      success: true,
      notices: result.rows
    });

  } catch (error) {
    console.error("Thông báo học sinh:", error.message);

    res.status(500).json({
      success: false,
      error: "Không tải được thông báo."
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
        parts: [{
          text: m.content.trim().slice(0, 3000)
        }]
      }));

    while (
      contents.length &&
      contents[0].role === "model"
    ) {
      contents.shift();
    }

    if (
      !contents.length ||
      contents.at(-1).role !== "user"
    ) {
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

    res.json({
      success: true,
      reply
    });

  } catch (error) {
    console.error("Gemini:", error.message);

    res.status(500).json({
      success: false,
      error: "Không kết nối được Gemini. Hãy thử lại."
    });
  }
});

// CHẶN TRUY CẬP FILE CẤU HÌNH
app.use((req, res, next) => {
  const blocked = [
    "/server.js",
    "/package.json",
    "/package-lock.json",
    "/.env",
    "/.gitignore"
  ];

  if (
    blocked.includes(req.path) ||
    req.path.startsWith("/uploads/")
  ) {
    return res.status(404).send("Không tìm thấy trang.");
  }

  next();
});

// XỬ LÝ LỖI SERVER
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err.message);

  if (res.headersSent) {
    return next(err);
  }

  res.status(400).json({
    success: false,
    error: err.message || "Yêu cầu không hợp lệ."
  });
});

// PHỤC VỤ GIAO DIỆN WEBSITE
app.use(express.static(__dirname, {
  dotfiles: "ignore",
  index: "index.html"
}));

// TRANG KHÔNG TỒN TẠI
app.use((req, res) => {
  res.status(404).send("Không tìm thấy trang.");
});

// KHỞI CHẠY SERVER
async function startServer() {
  try {
    await initDatabase();

    // Kiểm tra và bổ sung cấu trúc database cũ
    await repairExamDatabase();

    app.listen(PORT, () => {
      console.log("==============================");
      console.log("EDUSMART 12");
      console.log("Website: http://localhost:" + PORT);
      console.log("Gemini: " + (ai ? "Da cau hinh" : "Chua cau hinh"));
      console.log("PostgreSQL: Da ket noi");
      console.log("Bai kiem tra: Da kiem tra database");
      console.log("==============================");
    });

  } catch (error) {
    console.error("Loi khoi dong server:", error.message);
    process.exit(1);
  }
}

startServer();
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