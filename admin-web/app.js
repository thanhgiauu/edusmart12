const API_URL = "https://edusmart12.onrender.com";

const loginForm = document.getElementById("loginForm");

loginForm.addEventListener("submit", async function(e) {
    e.preventDefault();

    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;

    const message = document.getElementById("loginMessage");

    message.textContent = "Đang kiểm tra tài khoản...";

    try {
        const response = await fetch(
            API_URL + "/api/auth/admin/login",
            {
                method: "POST",
                credentials: "include",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    username,
                    password
                })
            }
        );

        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(
                data.message || data.error || "Đăng nhập thất bại."
            );
        }

        if (data.user?.role !== "admin") {
            throw new Error("Tài khoản không có quyền quản trị.");
        }

        document.getElementById("loginPage").hidden = true;
        document.getElementById("dashboardPage").hidden = false;

        document.getElementById("adminName").textContent =
            data.user.fullName;

    } catch (error) {
        message.textContent = error.message;
    }
});

document.getElementById("logoutButton")
    .addEventListener("click", async function() {

        try {
            await fetch(API_URL + "/api/auth/logout", {
                method: "POST",
                credentials: "include"
            });
        } finally {
            location.reload();
        }
    });
