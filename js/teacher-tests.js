
"use strict";

// ==========================================
// EDUSMART 12 - GIÁO VIÊN ĐĂNG BÀI KIỂM TRA
// ==========================================

const accountStatus = document.getElementById("accountStatus");
const messageBox = document.getElementById("message");
const form = document.getElementById("uploadForm");
const submitButton = document.getElementById("submitButton");
const examList = document.getElementById("examList");

function showMessage(text, error = false) {
    if (!messageBox) return;
    messageBox.hidden = false;
    messageBox.textContent = text;
    messageBox.className = error ? "message error" : "message";
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

// KIỂM TRA TÀI KHOẢN GIÁO VIÊN
async function checkTeacher() {
    try {
        const response = await fetch("/api/auth/me", {
            credentials: "same-origin",
            cache: "no-store"
        });

        if (!response.ok) {
            location.href = "/giao-vien/dang-nhap.html";
            return false;
        }

        const data = await response.json();

        if (data.user?.role !== "teacher") {
            accountStatus.textContent =
                "Tài khoản hiện tại không có quyền giáo viên.";

            form.hidden = true;
            return false;
        }

        accountStatus.textContent =
            "Đã đăng nhập giáo viên: " +
            (data.user.fullName || data.user.username);

        return true;

    } catch (error) {
        accountStatus.textContent =
            "Không kết nối được máy chủ.";
        return false;
    }
}

// TẢI DANH SÁCH BÀI KIỂM TRA
async function loadTeacherExams() {
    examList.textContent = "Đang tải danh sách bài tập...";

    try {
        const response = await fetch("/api/teacher/exams", {
            credentials: "same-origin",
            cache: "no-store"
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Không tải được danh sách.");
        }

        if (!data.exams || data.exams.length === 0) {
            examList.textContent = "Bạn chưa đăng bài kiểm tra nào.";
            return;
        }

        examList.innerHTML = "";

        data.exams.forEach(exam => {
            const id = Number(exam.id);

            const card = document.createElement("article");
            card.className = "exam";

            card.innerHTML = `
                <h3>${escapeHTML(exam.title)}</h3>

                <p class="muted">
                    Môn học: ${escapeHTML(exam.subject)}<br>
                    Lớp: ${escapeHTML(exam.class_name)}<br>
                    Thời gian: ${Number(exam.duration_minutes)} phút<br>
                    Số câu hỏi: ${Number(exam.question_count)}<br>
                    Số học sinh đã nộp: ${Number(exam.submission_count)}<br>
                    File: ${escapeHTML(exam.file_name || "Không có")}
                </p>

                ${exam.file_name ? `
                    <a class="btn secondary"
                       href="/api/exams/${id}/file">
                       Tải file
                    </a>
                ` : ""}

                <button type="button"
                        data-delete="${id}"
                        style="background:#dc2626">
                    Xóa bài
                </button>
            `;

            card.querySelector("[data-delete]")
                .addEventListener("click", () => deleteExam(id));

            examList.appendChild(card);
        });

    } catch (error) {
        examList.textContent = error.message;
    }
}

// XÓA BÀI KIỂM TRA
async function deleteExam(id) {
    if (!confirm("Bạn có chắc chắn muốn xóa bài kiểm tra này?")) {
        return;
    }

    try {
        const response = await fetch(
            "/api/teacher/exams/" + id,
            {
                method: "DELETE",
                credentials: "same-origin"
            }
        );

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Không xóa được bài.");
        }

        showMessage("Đã xóa bài kiểm tra thành công.");

        await loadTeacherExams();

    } catch (error) {
        showMessage(error.message, true);
    }
}

// GIÁO VIÊN ĐĂNG BÀI
form.addEventListener("submit", async event => {
    event.preventDefault();

    const fileInput = document.getElementById("file");
    const file = fileInput.files[0];

    if (!file) {
        showMessage("Vui lòng chọn file bài tập.", true);
        return;
    }

    if (file.size > 20 * 1024 * 1024) {
        showMessage("File không được vượt quá 20 MB.", true);
        return;
    }

    const formData = new FormData();

    formData.append(
        "title",
        document.getElementById("title").value.trim()
    );

    formData.append(
        "subject",
        document.getElementById("subject").value
    );

    formData.append(
        "className",
        document.getElementById("className").value.trim()
        || "Tất cả lớp"
    );

    formData.append(
        "durationMinutes",
        document.getElementById("durationMinutes").value
    );

    formData.append("questions", "[]");
    formData.append("file", file);

    submitButton.disabled = true;
    submitButton.textContent = "Đang đăng bài...";

    try {
        const response = await fetch("/api/teacher/exams", {
            method: "POST",
            credentials: "same-origin",
            body: formData
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Đăng bài thất bại.");
        }

        showMessage(
            "Đăng bài thành công! Học sinh đúng lớp có thể xem bài."
        );

        form.reset();

        document.getElementById("className").value = "Tất cả lớp";
        document.getElementById("durationMinutes").value = 45;

        await loadTeacherExams();

    } catch (error) {
        showMessage(error.message, true);

    } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Đăng bài cho học sinh";
    }
});

// LÀM MỚI DANH SÁCH
document.getElementById("refreshButton")
    .addEventListener("click", loadTeacherExams);

// KHỞI ĐỘNG
async function initTeacherTests() {
    const allowed = await checkTeacher();

    if (allowed) {
        await loadTeacherExams();
    }
}

initTeacherTests();
