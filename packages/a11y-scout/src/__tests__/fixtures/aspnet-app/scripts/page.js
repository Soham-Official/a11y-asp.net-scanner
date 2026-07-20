// ASP.NET fixture JS with intentional accessibility violations for scanner testing.

// 1. jQuery: string-injected <img> without alt
function renderIcon(container) {
  $(container).html('<img src="/icons/edit.png">');
}

// 2. jQuery: empty <button> in string
function showDeleteButton(container) {
  $(container).append('<button type="button" class="delete-btn"></button>');
}

// 3. jQuery: empty <a> in string
function buildNavLink(container) {
  $(container).prepend('<a href="/page" class="nav"></a>');
}

// 4. jQuery: <input> without aria-label
function addSearchBox(container) {
  $(container).html('<input type="text" name="q">');
}

// 5. aria-hidden applied dynamically (risk of hiding focusable content)
function hidePanel(el) {
  el.setAttribute('aria-hidden', 'true');
}

// 6. jQuery aria-hidden pattern
function collapseSection(selector) {
  $(selector).attr('aria-hidden', 'true');
}

// 7. Positive tabIndex — disrupts natural tab order
function bringToFront(el) {
  el.tabIndex = 5;
}

// 8. createElement without alt assignment
function createSpinner() {
  const img = document.createElement('img');
  img.src = '/spinner.gif';
  document.body.appendChild(img);
}

// 9. Native dialogs in critical flows
function confirmDelete() {
  return confirm('Delete this item?');
}

// 10. Focus moved on load/postback
function pageLoad() {
  document.getElementById('TxtName').focus();
}

// 11. Tab key suppression
function trapTab(event) {
  if (event.key === 'Tab') {
    event.preventDefault();
  }
}

document.addEventListener('keydown', function (event) {
  if (event.key === 'k') {
    openQuickJump();
  }
});

document.addEventListener('mouseover', function () {
  showTooltipOnlyOnHover();
});

document.addEventListener('focusin', function () {
  window.location = '/focus-redirect';
});

document.addEventListener('dragstart', function (event) {
  beginDrag(event);
});

setTimeout(function () {
  window.location = '/session-timeout';
}, 10000);

setInterval(function () {
  document.getElementById('status').textContent = 'Refreshing';
}, 15000);

document.addEventListener('pointermove', function (event) {
  handlePointerMove(event);
});

document.getElementById('readonlyStatus').value = 'Updated';

// ---- passes (should NOT fire) ----

// OK: img with alt
function renderLogo(container) {
  $(container).html('<img src="/logo.png" alt="Company logo">');
}

// OK: createElement with alt
function createCheckmark() {
  const img = document.createElement('img');
  img.alt = 'Done';
  img.src = '/check.gif';
  return img;
}

// OK: tabIndex = 0
function makeFocusable(el) {
  el.tabIndex = 0;
}
