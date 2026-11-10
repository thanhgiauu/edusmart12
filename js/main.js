
/* ==========================================
   EDUSMART 12 - MAIN JAVASCRIPT
   PHIEN BAN HOAN CHINH
========================================== */

document.addEventListener("DOMContentLoaded", function () {

    "use strict";

    // ======================================
    // 1. CAC HAM DUNG CHUNG
    // ======================================

    function readData(key) {
        try {
            return JSON.parse(localStorage.getItem(key) || "[]");
        } catch (error) {
            console.error("Loi doc du lieu:", key, error);
            return [];
        }
    }

    function saveData(key, data) {
        try {
            localStorage.setItem(key, JSON.stringify(data));
            return true;
        } catch (error) {
            console.error("Khong the luu du lieu:", error);
            alert("Khong the luu du lieu. Hay kiem tra bo nho trinh duyet.");
            return false;
        }
    }

    function createElement(tag, className, content) {
        const element = document.createElement(tag);

        if (className) {
            element.className = className;
        }

        if (content !== undefined) {
            element.textContent = content;
        }

        return element;
    }

    // ======================================
    // 2. MENU DIEU HUONG
    // ======================================

    const menuButton = document.querySelector("[data-menu-toggle]");
    const navigation = document.querySelector("[data-nav]");

    if (menuButton && navigation) {

        menuButton.addEventListener("click", function () {
            navigation.classList.toggle("open");
        });

        navigation.querySelectorAll("a").forEach(function (link) {
            link.addEventListener("click", function () {
                navigation.classList.remove("open");
            });
        });
    }

    // ======================================
    // 3. NAM HIEN TAI
    // ======================================

    document.querySelectorAll("[data-year]").forEach(function (item) {
        item.textContent = new Date().getFullYear();
    });

    // ======================================
    // 4. TEN MON HOC VA ICON
    // ======================================

    const subjectNames = {
        toan: "Toán học",
        ly: "Vật lí",
        hoa: "Hóa học",
        sinh: "Sinh học",
        van: "Ngữ văn",
        tin: "Tin học",
        anh: "Tiếng Anh",
        dia: "Địa lí",
        all: "Kỹ năng"
    };

    const subjectIcons = {
        toan: "📐",
        ly: "⚡",
        hoa: "🧪",
        sinh: "🧬",
        van: "📚",
        tin: "💻",
        anh: "🇬🇧",
        dia: "🌏",
        all: "🧠"
    };

    // ======================================
    // 5. DONG BO HOC LIEU TU ADMIN
    // ======================================

    function loadTeacherResources() {

        const grid = document.getElementById("resourceGrid");

        if (!grid) return;

        const resources = readData("edu_resources");

        // Xoa cac hoc lieu cu do giao vien them
        grid.querySelectorAll("[data-teacher-resource]").forEach(function (item) {
            item.remove();
        });

        // Tao hoc lieu moi
        resources.forEach(function (resource) {

            const subject = resource.subject || "all";

            const card = createElement("div", "card");

            card.dataset.resourceCard = "";
            card.dataset.teacherResource = "true";
            card.dataset.subject = subject;

            const icon = createElement(
                "div",
                "card-icon",
                subjectIcons[subject] || "📖"
            );

            const tag = createElement(
                "span",
                "tag",
                subjectNames[subject] || "Học tập"
            );

            const title = createElement(
                "h3",
                "",
                resource.title || "Học liệu mới"
            );

            const description = createElement(
                "p",
                "",
                resource.description || "Chưa có mô tả."
            );

            const date = createElement(
                "small",
                "small",
                "Giáo viên đăng: " + (resource.date || "")
            );

            card.append(icon, tag, title, description, date);

            // Nut xem tai lieu
            if (resource.link) {

                try {

                    const url = new URL(resource.link);

                    if (
                        url.protocol === "https:" ||
                        url.protocol === "http:"
                    ) {

                        const link = createElement(
                            "a",
                            "btn btn-primary",
                            "Xem tài liệu"
                        );

                        link.href = url.href;
                        link.target = "_blank";
                        link.rel = "noopener noreferrer";

                        card.appendChild(link);
                    }

                } catch (error) {
                    console.warn("Duong dan hoc lieu khong hop le.");
                }
            }

            grid.appendChild(card);
        });

        filterResources();
    }

    // ======================================
    // 6. TIM KIEM VA LOC HOC LIEU
    // ======================================

    const searchInput = document.querySelector("[data-resource-search]");
    const subjectFilter = document.querySelector("[data-resource-filter]");

    function filterResources() {

        const cards = document.querySelectorAll("[data-resource-card]");

        const keyword = searchInput
            ? searchInput.value.toLowerCase().trim()
            : "";

        const selectedSubject = subjectFilter
            ? subjectFilter.value
            : "all";

        cards.forEach(function (card) {

            const content = card.textContent.toLowerCase();

            const subject = card.dataset.subject || "all";

            const matchKeyword = content.includes(keyword);

            const matchSubject =
                selectedSubject === "all" ||
                subject === selectedSubject;

            card.style.display =
                matchKeyword && matchSubject ? "" : "none";

        });
    }

    if (searchInput) {
        searchInput.addEventListener("input", filterResources);
    }

    if (subjectFilter) {
        subjectFilter.addEventListener("change", filterResources);
    }

    loadTeacherResources();

    // ======================================
    // 7. DONG BO THONG BAO GIAO VIEN
    // ======================================

    function displayHomeNotices() {

        let noticeContainer = document.getElementById("homeNotices");

        const notices = readData("edu_notices");

        // Neu chua co khu vuc thong bao tren trang chu
        if (!noticeContainer && document.querySelector("main")) {

            const isHomePage =
                location.pathname.endsWith("/") ||
                location.pathname.endsWith("/index.html");

            if (isHomePage && notices.length > 0) {

                const section = createElement("section", "section alt");

                const container = createElement("div", "container");

                const heading = createElement(
                    "h2",
                    "",
                    "📢 Thông báo mới từ giáo viên"
                );

                noticeContainer = createElement("div", "");

                noticeContainer.id = "homeNotices";

                container.append(heading, noticeContainer);

                section.appendChild(container);

                const footer = document.querySelector("footer");

                if (footer) {
                    footer.parentNode.insertBefore(section, footer);
                } else {
                    document.querySelector("main").appendChild(section);
                }
            }
        }

        if (!noticeContainer) return;

        noticeContainer.replaceChildren();

        if (notices.length === 0) {
            noticeContainer.textContent = "Hiện chưa có thông báo mới.";
            return;
        }

        notices.forEach(function (notice) {

            const card = createElement("div", "card");

            card.style.marginBottom = "15px";

            const title = createElement(
                "h3",
                "",
                notice.title || "Thông báo"
            );

            const content = createElement(
                "p",
                "",
                notice.content || ""
            );

            const date = createElement(
                "small",
                "small",
                "📅 " + (notice.date || "")
            );

            card.append(title, content, date);

            noticeContainer.appendChild(card);
        });
    }

    displayHomeNotices();

    // ======================================
    // 8. LUU GOP Y CUA HOC SINH
    // ======================================

    const feedbackForm = document.getElementById("feedbackForm");

    if (feedbackForm) {

        feedbackForm.addEventListener("submit", function (event) {

            event.preventDefault();

            const formData = new FormData(feedbackForm);

            const feedback = {
                name: String(formData.get("name") || "").trim(),
                email: String(formData.get("email") || "").trim(),
                subject: String(formData.get("subject") || "").trim(),
                message: String(formData.get("message") || "").trim(),
                date: new Date().toLocaleString("vi-VN")
            };

            if (
                !feedback.name ||
                !feedback.email ||
                !feedback.subject ||
                !feedback.message
            ) {
                alert("Vui lòng nhập đầy đủ thông tin.");
                return;
            }

            const feedbackList = readData("edu_feedback");

            feedbackList.push(feedback);

            if (saveData("edu_feedback", feedbackList)) {

                feedbackForm.reset();

                const message = document.getElementById("feedbackMessage");

                if (message) {
                    message.textContent =
                        "Cảm ơn bạn! Góp ý đã được lưu thành công.";
                } else {
                    alert("Gửi góp ý thành công!");
                }
            }
        });
    }

    // ======================================
    // 9. HE THONG TRAC NGHIEM
    // ======================================

    const quiz = document.getElementById("practiceQuiz");

    if (quiz) {

        quiz.addEventListener("submit", function (event) {

            event.preventDefault();

            const answers = {
                q1: "b",
                q2: "a",
                q3: "c",
                q4: "b",
                q5: "a"
            };

            let score = 0;
            let unanswered = [];

            Object.entries(answers).forEach(function (entry) {

                const question = entry[0];
                const correctAnswer = entry[1];

                const selected = quiz.querySelector(
                    'input[name="' + question + '"]:checked'
                );

                if (!selected) {
                    unanswered.push(question);
                    return;
                }

                if (selected.value === correctAnswer) {
                    score++;
                }
            });

            if (unanswered.length > 0) {
                alert("Bạn còn " + unanswered.length + " câu chưa trả lời.");
                return;
            }

            const result = document.getElementById("quizResult");

            if (result) {

                result.style.display = "block";

                result.replaceChildren();

                const heading = createElement(
                    "h3",
                    "",
                    "Kết quả: " + score + "/5 câu đúng"
                );

                const points = createElement(
                    "p",
                    "",
                    "Điểm số: " + (score * 2) + "/10"
                );

                const message = createElement(
                    "p",
                    "",
                    score === 5
                        ? "Xuất sắc! Bạn đã hoàn thành tất cả câu hỏi."
                        : "Hãy ôn lại những kiến thức chưa chính xác nhé!"
                );

                result.append(heading, points, message);
            }

            const history = readData("edu_quiz_history");

            history.push({
                score: score,
                total: 5,
                date: new Date().toLocaleString("vi-VN")
            });

            saveData("edu_quiz_history", history);

        });
    }

    // ======================================
    // 10. TRO LY GOI Y HOC TAP
    // ======================================

    const aiForm = document.getElementById("aiForm");

    if (aiForm) {

        aiForm.addEventListener("submit", function (event) {

            event.preventDefault();

            const topic = aiForm.elements["topic"].value.trim();

            const level = aiForm.elements["level"].value;

            const output = document.getElementById("aiOutput");

            if (!topic || !output) return;

            output.replaceChildren();

            const heading = createElement(
                "h3",
                "",
                "📚 KẾ HOẠCH HỌC TẬP: " + topic
            );

            const levelText = createElement(
                "p",
                "",
                "Mức độ hiện tại: " + level
            );

            const steps = [
                "Bước 1: Xác định những kiến thức trọng tâm của chủ đề.",
                "Bước 2: Đọc sách giáo khoa và ghi lại các nội dung quan trọng.",
                "Bước 3: Chia kiến thức thành từng phần nhỏ để ôn tập.",
                "Bước 4: Làm bài tập từ cơ bản đến nâng cao.",
                "Bước 5: Kiểm tra lại kiến thức và ghi chú phần chưa hiểu."
            ];

            output.append(heading, levelText);

            steps.forEach(function (step) {
                const paragraph = createElement("p", "", step);
                output.appendChild(paragraph);
            });

            const note = createElement(
                "small",
                "small",
                "Đây là kế hoạch gợi ý tự động, chưa kết nối AI trực tuyến."
            );

            output.appendChild(note);

        });
    }

    // ======================================
    // 11. THONG BAO KHI KHONG TIM THAY HOC LIEU
    // ======================================

    if (searchInput && subjectFilter) {

        function showEmptySearch() {

            const cards = document.querySelectorAll("[data-resource-card]");

            const visibleCards = Array.from(cards).filter(function (card) {
                return card.style.display !== "none";
            });

            let emptyMessage = document.getElementById("resourceEmpty");

            if (!emptyMessage) {
                emptyMessage = createElement("p", "");
                emptyMessage.id = "resourceEmpty";
                emptyMessage.style.gridColumn = "1 / -1";
                emptyMessage.style.textAlign = "center";
                emptyMessage.style.padding = "25px";
                document.getElementById("resourceGrid").appendChild(emptyMessage);
            }

            emptyMessage.textContent =
                visibleCards.length === 0
                    ? "Không tìm thấy học liệu phù hợp."
                    : "";

        }

        searchInput.addEventListener("input", showEmptySearch);

        subjectFilter.addEventListener("change", showEmptySearch);
    }

    console.log("EduSmart 12: Main.js da khoi dong thanh cong!");

});
