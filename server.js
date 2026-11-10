
import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cấu hình proxy cho Render, sửa lỗi express-rate-limit
app.set("trust proxy", 1);

// Khởi tạo Gemini
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

// Middleware
app.use(express.json({ limit: "30kb" }));

// Giới hạn số lần gửi câu hỏi
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

// Không cho truy cập trực tiếp các file cấu hình máy chủ
app.use((req, res, next) => {
  const blockedFiles = [
    "/server.js",
    "/package.json",
    "/package-lock.json",
    "/.gitignore"
  ];

  if (blockedFiles.includes(req.path)) {
    return res.status(404).send("Không tìm thấy trang.");
  }

  next();
});

// Phục vụ giao diện website
app.use(express.static(__dirname, {
  dotfiles: "ignore",
  index: "index.html"
}));

// Kiểm tra trạng thái máy chủ
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "EduSmart 12 AI đang hoạt động.",
    provider: "Google Gemini",
    model: MODEL,
    aiConfigured: Boolean(ai)
  });
});

// Chat với Gemini
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

    // Gemini yêu cầu nội dung bắt đầu bằng vai trò user
    while (contents.length && contents[0].role === "model") {
      contents.shift();
    }

    if (
      !contents.length ||
      contents[contents.length - 1].role !== "user"
    ) {
      return res.status(400).json({
        success: false,
        error: "Câu hỏi không hợp lệ."
      });
    }

    console.log("Đang gửi câu hỏi đến Gemini...");

    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction:
          "Bạn là EduSmart AI, trợ lý học tập lớp 12. " +
          "Trả lời bằng tiếng Việt, dễ hiểu, có từng bước và ví dụ. " +
          "Hỗ trợ Toán, Văn, Anh, Tin học và các môn khác. " +
          "Không bịa thông tin khi không chắc chắn.",
        maxOutputTokens: 1000,
        temperature: 0.5
      }
    });

    const reply = response.text?.trim();

    if (!reply) {
      return res.status(502).json({
        success: false,
        error: "Gemini chưa tạo được câu trả lời. Hãy thử lại."
      });
    }

    console.log("Gemini đã trả lời thành công.");

    return res.json({
      success: true,
      reply
    });

  } catch (error) {
    const status = Number(error.status || error.code || 500);

    console.error("Gemini lỗi:", status, error.message);

    let message = "Không kết nối được Gemini. Hãy thử lại.";

    if (status === 503 || status === 502) {
      message = "Gemini đang quá tải. Hãy đợi một chút rồi thử lại.";
    } else if (status === 429) {
      message = "Đã đạt giới hạn sử dụng Gemini. Hãy thử lại sau.";
    } else if (status === 401 || status === 403) {
      message = "API Key không hợp lệ hoặc không có quyền.";
    } else if (status === 404) {
      message = "Không tìm thấy model Gemini. Hãy kiểm tra cấu hình.";
    } else if (error.name === "AbortError") {
      message = "Gemini phản hồi quá lâu. Bạn hãy thử lại sau.";
    }

    const responseStatus = [400, 401, 403, 404, 429, 502, 503]
      .includes(status) ? status : 500;

    return res.status(responseStatus).json({
      success: false,
      error: message
    });
  }
});

// Trang không tồn tại
app.use((req, res) => {
  res.status(404).send("Không tìm thấy trang.");
});

// Khởi chạy máy chủ
app.listen(PORT, () => {
  console.log("================================");
  console.log("EDUSMART 12 - GEMINI AI");
  console.log("Website: http://localhost:" + PORT);
  console.log("Model: " + MODEL);
  console.log("API Key: " + (ai ? "Đã cấu hình" : "Chưa cấu hình"));
  console.log("================================");
});
