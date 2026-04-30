(() => {
  const socket = io();
  const indicator = document.getElementById("live-indicator");
  const menuToggle = document.getElementById("menu-toggle");
  const sidebarClose = document.getElementById("sidebar-close");
  const sidebarOverlay = document.getElementById("sidebar-overlay");
  let refreshTimer = null;
  let indicatorTimer = null;

  function showIndicator(text) {
    if (!indicator) return;
    indicator.textContent = text;
    indicator.classList.add("show");
    clearTimeout(indicatorTimer);
    indicatorTimer = setTimeout(() => indicator.classList.remove("show"), 1400);
  }

  function scheduleRefresh() {
    if (document.hidden) return;
    if (refreshTimer) return;
    document.body.classList.add("page-updating");
    refreshTimer = setTimeout(() => {
      window.location.reload();
    }, 700);
  }

  socket.on("connect", () => {
    showIndicator("Live sync connected");
  });

  socket.on("app:update", (payload) => {
    const eventName = payload?.event || "Updated";
    showIndicator(`${eventName} - syncing...`);
    scheduleRefresh();
  });

  function closeSidebar() {
    document.body.classList.remove("sidebar-open");
  }

  if (menuToggle) {
    menuToggle.addEventListener("click", () => {
      document.body.classList.toggle("sidebar-open");
    });
  }

  if (sidebarClose) sidebarClose.addEventListener("click", closeSidebar);
  if (sidebarOverlay) sidebarOverlay.addEventListener("click", closeSidebar);

  document.querySelectorAll(".nav-links a").forEach((link) => {
    link.addEventListener("click", closeSidebar);
  });
})();
