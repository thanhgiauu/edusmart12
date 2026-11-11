
"use strict";

// ==========================================
// EDUSMART 12 - HỌC SINH NHẬN BÀI KIỂM TRA
// ==========================================

const params = new URLSearchParams(location.search);
const subject = params.get("mon") || "";

const subjectTitle = document.getElementById("subjectTitle");
const statusBox = document.getElementById("status");
const examList = document.getElementById("examList");

subjectTitle.textContent = subject || "Môn học";

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

function showError(message) {
    statusBox.textContent = message;
    statusBox.classList.add("error");
}

// KIỂM TRA TÀI KHOẢN HỌC SINH
async function checkStudent() {
    const response = await fetch("/api/auth/me", {
        credentials: "same-origin",
        cache: "no-store"
    });

    if (!response.ok) {
        statusBox.innerHTML =
            'Bạn cần đăng nhập học sinh. ' +
            '<a href="/hoc-sinh/dang-nhap.html">Đăng nhập tại đây</a>';

        return null;
    }

    const data = await response.json();

    if (data.user?.role !== "student") {
        showError("Bạn cần sử dụng tài khoản học sinh.");
        return null;
    }

    return data.user;
}

// TẢI BÀI KIỂM TRA TỪ MÁY CHỦ
async function loadStudentExams() {
    if (!subject) {
        showError("Không xác định được môn học.");
        examList.textContent = "";
        return;
    }

    examList.textContent = "Đang tải bài tập...";

    try {
        const user = await checkStudent();

        if (!user) {
            examList.textContent = "";
            return;
        }

        const response = await fetch("/api/student/exams", {
            credentials: "same-origin",
            cache: "no-store",
            headers: {
                "Accept": "application/json"
            }
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.error || "Không tải được bài kiểm tra."
            );
        }

        const exams = (data.exams || []).filter(exam => {
            return String(exam.subject || "")
                .trim()
                .toLocaleLowerCase("vi") ===
                subject.trim().toLocaleLowerCase("vi");
        });

        statusBox.classList.remove("error");

        statusBox.textContent =
            "Đã đăng nhập: " +
            (user.fullName || user.username) +
            " | Lớp: " +
            (user.className || "Chưa cập nhật") +
            " | Tìm thấy " +
            exams.length +
            " bài kiểm tra môn " + subject + ".";

        if (exams.length === 0) {
            examList.innerHTML = `
                <div class="status">
                    Chưa có bài kiểm tra môn ${escapeHTML(subject)}
                    được giao cho lớp của bạn.
                    <br><br>
                    Vui lòng kiểm tra lớp trong tài khoản học sinh
                    hoặc chờ giáo viên đăng bài.
                </div>
            `;
            return;
        }

        examList.innerHTML = "";

        exams.forEach(exam => {
            const id = Number(exam.id);

            const item = document.createElement("article");
            item.className = "exam-item";

            const dates = [
                exam.starts_at
                    ? "Ngày mở: " +
                      new Date(exam.starts_at).toLocaleString("vi-VN")
                    : "",

                exam.ends_at
                    ? "Hạn nộp: " +
                      new Date(exam.ends_at).toLocaleString("vi-VN")
                    : ""
            ].filter(Boolean);

            const submitted = Boolean(exam.submitted_at);

            item.innerHTML = `
                <h3>${escapeHTML(exam.title)}</h3>

                <div class="meta">
                    Môn học: ${escapeHTML(exam.subject)}<br>
                    Lớp: ${escapeHTML(exam.class_name)}<br>
                    Thời gian: ${Number(exam.duration_minutes) || 45} phút<br>
                    Số câu hỏi: ${Number(exam.question_count) || 0}<br>
                    ${dates.map(escapeHTML).join("<br>")}
                </div>

                <p>
                    ${submitted
                        ? '<span style="color:green;font-weight:bold">Đã nộp bài</span>'
                        : '<span style="color:#2563eb;font-weight:bold">Chưa nộp bài</span>'
                    }
                </p>

                ${exam.file_name ? `
                    <a class="btnx"
                       href="/api/exams/${id}/file">
                       📥 Tải file đề kiểm tra
                    </a>
                ` : ""}

                ${!submitted && Number(exam.question_count) > 0 ? `
                    <a class="btnx secondary"
                       href="/hoc-sinh/dashboard.html">
                       Vào khu vực làm bài
                    </a>
                ` : ""}
            `;

            examList.appendChild(item);
        });

    } catch (error) {
        showError(error.message);
        examList.textContent = "";
    }
}

// KHỞI ĐỘNG TRANG HỌC SINH
loadStudentExams();

// TỰ ĐỘNG CẬP NHẬT DANH SÁCH MỖI 15 GIÂY
setInterval(() => {
    loadStudentExams();
}, 15000);
