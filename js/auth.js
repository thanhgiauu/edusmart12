
document.addEventListener("DOMContentLoaded", () => {
    const form = document.querySelector("[data-auth-form]");

    if (!form) return;

    const message = document.querySelector("#authMessage");
    const submitButton = form.querySelector("button[type='submit']");

    function showMessage(text, type) {
        message.textContent = text;
        message.className = "auth-message show " + type;
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();

        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());

        const endpoint = form.dataset.endpoint;

        if (!endpoint) {
            showMessage("Không tìm thấy địa chỉ API.", "error");
            return;
        }

        if (data.password && data.password.length < 8) {
            showMessage("Mật khẩu cần ít nhất 8 ký tự.", "error");
            return;
        }

        submitButton.disabled = true;
        submitButton.textContent = "Đang xử lý...";

        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                credentials: "same-origin",
                body: JSON.stringify(data)
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(
                    result.error || "Có lỗi xảy ra. Vui lòng thử lại."
                );
            }

            showMessage(
                result.message || "Thao tác thành công!",
                "success"
            );

            form.reset();

            if (form.dataset.redirect) {
                setTimeout(() => {
                    window.location.href = form.dataset.redirect;
                }, 1000);
            }

        } catch (error) {
            showMessage(error.message, "error");
        } finally {
            submitButton.disabled = false;
            submitButton.textContent =
                form.dataset.buttonText || "Xác nhận";
        }
    });
});

async function updateAuthUI() {
    const guestActions = document.getElementById("guestActions");
    const userActions = document.getElementById("userActions");
    const userWelcome = document.getElementById("userWelcome");
    const dashboardLink = document.getElementById("dashboardLink");
    const logoutBtn = document.getElementById("logoutBtn");

    if (!guestActions || !userActions) return;

    try {
        const response = await fetch("/api/auth/me", {
            method: "GET",
            credentials: "same-origin"
        });

        const data = await response.json();

        if (!response.ok || !data.success || !data.user) {
            guestActions.hidden = false;
            userActions.hidden = true;
            return;
        }

        const user = data.user;

        guestActions.hidden = true;
        userActions.hidden = false;

        userWelcome.textContent =
            "Xin chào, " + (user.fullName || user.username || "bạn");

        if (user.role === "student") {
            dashboardLink.href = "/hoc-sinh/tai-khoan.html";
        } else if (user.role === "teacher") {
            dashboardLink.href = "/giao-vien/dashboard.html";
        } else if (user.role === "admin") {
            dashboardLink.href = "/admin/dashboard.html";
        }

    } catch (error) {
        console.error("Không kiểm tra được đăng nhập:", error);
        guestActions.hidden = false;
        userActions.hidden = true;
    }
}

document.addEventListener("DOMContentLoaded", updateAuthUI);

if (document.getElementById("logoutBtn")) {
    document.getElementById("logoutBtn").addEventListener("click", async () => {
        try {
            const response = await fetch("/api/auth/logout", {
                method: "POST",
                credentials: "same-origin"
            });

            if (response.ok) {
                window.location.href = "/index.html";
            } else {
                alert("Không thể đăng xuất. Hãy thử lại.");
            }
        } catch (error) {
            alert("Không kết nối được máy chủ.");
        }
    });
}
