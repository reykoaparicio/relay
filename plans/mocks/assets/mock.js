// Mock-only helpers. Not part of the product.
// 1) State switcher: <div class="mock-states" data-states="active,empty,interrupted"></div>
//    and sections marked <div data-state-view="active">…</div>. The first state is default.
//    URL hash #state=<name> selects a state (so mocks can be deep-linked from index.html).
// 2) Theme toggle button with id="mock-theme" flips data-theme on <html>.
(function () {
  const bar = document.querySelector('.mock-states');
  if (bar) {
    const states = (bar.dataset.states || '').split(',').map((s) => s.trim()).filter(Boolean);
    const label = document.createElement('span');
    label.textContent = 'Mock state:';
    bar.appendChild(label);
    const buttons = states.map((name) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.addEventListener('click', () => select(name));
      bar.appendChild(b);
      return b;
    });
    const theme = document.createElement('button');
    theme.type = 'button';
    theme.textContent = 'toggle theme';
    theme.addEventListener('click', () => {
      const root = document.documentElement;
      root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    });
    bar.appendChild(theme);

    function select(name) {
      document.querySelectorAll('[data-state-view]').forEach((el) => {
        const names = el.dataset.stateView.split(',').map((s) => s.trim());
        el.classList.toggle('active', names.includes(name));
      });
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === name)));
      history.replaceState(null, '', '#state=' + name);
    }
    const fromHash = (location.hash.match(/state=([\w-]+)/) || [])[1];
    select(states.includes(fromHash) ? fromHash : states[0]);
  }
})();
