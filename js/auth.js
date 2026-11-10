
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
