// ============================================================
// Menu hamburger mobile - comportement partagé par toutes les pages
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('navToggle');
    const nav = document.getElementById('mainNav');

    if (!toggle || !nav) return;

    toggle.addEventListener('click', () => {
        nav.classList.toggle('nav-open');
    });

    // Fermer le menu automatiquement après un clic sur un lien
    nav.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => nav.classList.remove('nav-open'));
    });

    // Fermer le menu si on clique en dehors
    document.addEventListener('click', (e) => {
        if (!nav.contains(e.target) && !toggle.contains(e.target)) {
            nav.classList.remove('nav-open');
        }
    });
});
