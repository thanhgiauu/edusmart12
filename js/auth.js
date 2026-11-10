
document.addEventListener("DOMContentLoaded", function () {

    const loginForm = document.getElementById("loginForm");

    if (!loginForm) return;

    loginForm.addEventListener("submit", function (event) {

        event.preventDefault();

        const username = document.getElementById("username").value.trim();

        const password = document.getElementById("password").value;

        const message = document.getElementById("loginMessage");

        // TAI KHOAN DEMO
        // Chi dung de thu nghiem tren may tinh ca nhan.
        const demoUsername = "teacher";
        const demoPassword = "EduSmart12@2026";

        if (
            username === demoUsername &&
            password === demoPassword
        ) {

            sessionStorage.setItem("eduAdminLoggedIn", "true");

            sessionStorage.setItem("eduAdminName", "Giáo viên");

            window.location.href = "dashboard.html";

        } else {

            message.textContent =
                "Tài khoản hoặc mật khẩu không chính xác!";

        }

    });

});
