'use strict';

// #340 [A15]: replace window.prompt / window.confirm for primary CRUD with
// in-app modals so flows still work when the browser blocks native dialogs
// (some embed contexts do) and so they're styleable + testable. Both helpers
// return Promises: input → string|null, confirm → boolean.
//
// HTML markup for #input-modal and #confirm-modal lives in public/index.html.
(function (global) {

  let _inputResolver = null;
  let _confirmResolver = null;

  function showInputModal({ title = 'Enter value', label = '', defaultValue = '', placeholder = '', okLabel = 'OK' } = {}) {
    return new Promise((resolve) => {
      _inputResolver = resolve;
      const modal = document.getElementById('input-modal');
      document.getElementById('input-modal-title').textContent = title;
      const labelEl = document.getElementById('input-modal-label');
      labelEl.textContent = label;
      labelEl.style.display = label ? '' : 'none';
      const field = document.getElementById('input-modal-field');
      field.value = defaultValue;
      field.placeholder = placeholder;
      const errEl = document.getElementById('input-modal-error');
      errEl.style.display = 'none'; errEl.textContent = '';
      document.getElementById('input-modal-ok').textContent = okLabel;
      modal.classList.add('visible');
      // Focus + select default text so users can immediately type a replacement.
      setTimeout(() => { field.focus(); field.select(); }, 0);
      // Submit on Enter; cancel on Escape.
      field.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitInputModal(); }
        else if (e.key === 'Escape') { e.preventDefault(); dismissInputModal(); }
      };
    });
  }

  function submitInputModal() {
    const field = document.getElementById('input-modal-field');
    const value = field.value;
    document.getElementById('input-modal').classList.remove('visible');
    field.onkeydown = null;
    if (_inputResolver) { _inputResolver(value); _inputResolver = null; }
  }

  function dismissInputModal() {
    const field = document.getElementById('input-modal-field');
    document.getElementById('input-modal').classList.remove('visible');
    if (field) field.onkeydown = null;
    if (_inputResolver) { _inputResolver(null); _inputResolver = null; }
  }

  function showConfirmModal({ title = 'Confirm', message = '', confirmLabel = 'Confirm', danger = false } = {}) {
    return new Promise((resolve) => {
      _confirmResolver = resolve;
      const modal = document.getElementById('confirm-modal');
      document.getElementById('confirm-modal-title').textContent = title;
      document.getElementById('confirm-modal-message').textContent = message;
      document.getElementById('confirm-modal-ok').textContent = confirmLabel;
      modal.classList.toggle('danger', !!danger);
      modal.classList.add('visible');
      // Focus the confirm button so Enter accepts; Escape cancels via doc handler.
      setTimeout(() => { document.getElementById('confirm-modal-ok').focus(); }, 0);
      document.onkeydown = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); dismissConfirmModal(); }
      };
    });
  }

  function acceptConfirmModal() {
    document.getElementById('confirm-modal').classList.remove('visible');
    document.onkeydown = null;
    if (_confirmResolver) { _confirmResolver(true); _confirmResolver = null; }
  }

  function dismissConfirmModal() {
    document.getElementById('confirm-modal').classList.remove('visible');
    document.onkeydown = null;
    if (_confirmResolver) { _confirmResolver(false); _confirmResolver = null; }
  }

  global.showInputModal = showInputModal;
  global.submitInputModal = submitInputModal;
  global.dismissInputModal = dismissInputModal;
  global.showConfirmModal = showConfirmModal;
  global.acceptConfirmModal = acceptConfirmModal;
  global.dismissConfirmModal = dismissConfirmModal;
})(typeof window !== 'undefined' ? window : globalThis);
