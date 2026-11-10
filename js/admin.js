
document.addEventListener("DOMContentLoaded", function () {

    // KIEM TRA QUYEN DANG NHAP
    if (sessionStorage.getItem("eduAdminLoggedIn") !== "true") {
        window.location.href = "login.html";
        return;
    }

    const adminName = document.getElementById("adminName");

    if (adminName) {
        adminName.textContent =
            sessionStorage.getItem("eduAdminName") || "Giáo viên";
    }

    // HAM DOC DU LIEU
    function readData(key) {
        try {
            return JSON.parse(localStorage.getItem(key) || "[]");
        } catch {
            return [];
        }
    }

    // HAM TAO THE AN TOAN
    function createCell(text) {
        const td = document.createElement("td");
        td.textContent = text;
        return td;
    }

    function createButton(text, callback) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-light";
        button.textContent = text;
        button.addEventListener("click", callback);
        return button;
    }

    // CAP NHAT THONG KE
    function updateStats() {

        const resources = readData("edu_resources");
        const feedback = readData("edu_feedback");
        const notices = readData("edu_notices");

        document.getElementById("resourceCount").textContent =
            12 + resources.length;

        document.getElementById("feedbackCount").textContent =
            feedback.length;

        document.getElementById("noticeCount").textContent =
            notices.length;
    }

    // QUAN LY THONG BAO
    const noticeForm = document.getElementById("noticeForm");

    function displayNotices() {

        const list = document.getElementById("noticeList");
        const notices = readData("edu_notices");

        list.replaceChildren();

        notices.forEach(function (notice, index) {

            const card = document.createElement("div");
            card.className = "card";
            card.style.marginTop = "12px";

            const title = document.createElement("h3");
            title.textContent = notice.title;

            const content = document.createElement("p");
            content.textContent = notice.content;

            const date = document.createElement("small");
            date.className = "small";
            date.textContent = notice.date;

            const remove = createButton("Xóa", function () {

                if (!confirm("Bạn có muốn xóa thông báo này?")) {
                    return;
                }

                const current = readData("edu_notices");

                current.splice(index, 1);

                localStorage.setItem(
                    "edu_notices",
                    JSON.stringify(current)
                );

                displayNotices();
                updateStats();

            });

            card.append(title, content, date, remove);
            list.appendChild(card);

        });

        if (notices.length === 0) {
            list.textContent = "Chưa có thông báo nào.";
        }
    }

    if (noticeForm) {

        noticeForm.addEventListener("submit", function (event) {

            event.preventDefault();

            const title = document.getElementById("noticeTitle").value.trim();

            const content = document.getElementById("noticeContent").value.trim();

            if (!title || !content) return;

            const notices = readData("edu_notices");

            notices.unshift({
                title: title,
                content: content,
                date: new Date().toLocaleString("vi-VN")
            });

            localStorage.setItem(
                "edu_notices",
                JSON.stringify(notices)
            );

            noticeForm.reset();

            displayNotices();
            updateStats();

            alert("Đăng thông báo thành công!");

        });

    }

    // QUAN LY HOC LIEU
    const resourceForm = document.getElementById("resourceForm");

    const subjectNames = {
        toan: "Toán học",
        ly: "Vật lí",
        hoa: "Hóa học",
        sinh: "Sinh học",
        van: "Ngữ văn",
        tin: "Tin học",
        anh: "Tiếng Anh",
        dia: "Địa lí"
    };

    function displayResources() {

        const list = document.getElementById("resourceList");

        const resources = readData("edu_resources");

        list.replaceChildren();

        resources.forEach(function (resource, index) {

            const tr = document.createElement("tr");

            tr.appendChild(createCell(resource.title));

            tr.appendChild(
                createCell(subjectNames[resource.subject] || resource.subject)
            );

            const actionCell = document.createElement("td");

            actionCell.appendChild(
                createButton("Xóa", function () {

                    if (!confirm("Bạn muốn xóa học liệu này?")) {
                        return;
                    }

                    const current = readData("edu_resources");

                    current.splice(index, 1);

                    localStorage.setItem(
                        "edu_resources",
                        JSON.stringify(current)
                    );

                    displayResources();
                    updateStats();

                })
            );

            tr.appendChild(actionCell);

            list.appendChild(tr);

        });

        if (resources.length === 0) {
            const tr = document.createElement("tr");
            const td = createCell("Chưa có học liệu được thêm.");
            td.colSpan = 3;
            tr.appendChild(td);
            list.appendChild(tr);
        }
    }

    if (resourceForm) {

        resourceForm.addEventListener("submit", function (event) {

            event.preventDefault();

            const title = document.getElementById("resourceTitle").value.trim();

            const subject = document.getElementById("resourceSubject").value;

            const description = document.getElementById("resourceDescription").value.trim();

            const link = document.getElementById("resourceLink").value.trim();

            if (!title || !description) return;

            if (link) {
                try {
                    const url = new URL(link);

                    if (url.protocol !== "https:" && url.protocol !== "http:") {
                        alert("Đường dẫn không hợp lệ.");
                        return;
                    }

                } catch {
                    alert("Vui lòng nhập đường dẫn hợp lệ.");
                    return;
                }
            }

            const resources = readData("edu_resources");

            resources.push({
                title: title,
                subject: subject,
                description: description,
                link: link,
                date: new Date().toLocaleString("vi-VN")
            });

            localStorage.setItem(
                "edu_resources",
                JSON.stringify(resources)
            );

            resourceForm.reset();

            displayResources();
            updateStats();

            alert("Thêm học liệu thành công!");

        });

    }

    // HIEN THI GOP Y
    function displayFeedback() {

        const list = document.getElementById("feedbackList");

        const feedback = readData("edu_feedback");

        list.replaceChildren();

        feedback.forEach(function (item) {

            const tr = document.createElement("tr");

            tr.appendChild(createCell(item.name));
            tr.appendChild(createCell(item.email));
            tr.appendChild(createCell(item.subject));
            tr.appendChild(createCell(item.message));
            tr.appendChild(createCell(item.date));

            list.appendChild(tr);

        });

        if (feedback.length === 0) {
            const tr = document.createElement("tr");
            const td = createCell("Chưa có góp ý.");
            td.colSpan = 5;
            tr.appendChild(td);
            list.appendChild(tr);
        }
    }

    // LICH SU LUYEN TAP
    function displayQuizHistory() {

        const list = document.getElementById("quizHistory");

        const history = readData("edu_quiz_history");

        list.replaceChildren();

        history.forEach(function (item) {

            const tr = document.createElement("tr");

            tr.appendChild(createCell(item.score * 2 + "/10"));
            tr.appendChild(createCell(item.total + " câu"));
            tr.appendChild(createCell(item.date));

            list.appendChild(tr);

        });

        if (history.length === 0) {
            const tr = document.createElement("tr");
            const td = createCell("Chưa có lịch sử luyện tập.");
            td.colSpan = 3;
            tr.appendChild(td);
            list.appendChild(tr);
        }
    }

    // DANG XUAT
    const logoutButton = document.getElementById("logoutButton");

    if (logoutButton) {

        logoutButton.addEventListener("click", function () {

            sessionStorage.removeItem("eduAdminLoggedIn");
            sessionStorage.removeItem("eduAdminName");

            window.location.href = "login.html";

        });

    }

    // KHOI DONG DASHBOARD
    displayNotices();
    displayResources();
    displayFeedback();
    displayQuizHistory();
    updateStats();

});
